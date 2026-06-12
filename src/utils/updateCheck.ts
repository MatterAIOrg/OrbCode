import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

import { getConfigDir } from "../config/settings.js";

const execFileAsync = promisify(execFile);

/** Network timeout when hitting the npm registry. Kept short so it never blocks startup. */
const REGISTRY_TIMEOUT_MS = 3_000;

/** Don't re-hit npm more than once per TTL window. */
const CACHE_TTL_MS = 60 * 60 * 1_000; // 1 hour

/** Hit the npm registry to learn what the latest published version is. */
export async function fetchLatestNpmVersion(
  pkg: string,
  timeoutMs: number = REGISTRY_TIMEOUT_MS,
): Promise<string | null> {
  // encodeURIComponent turns "@matterailab/orbcode" into "@matterailab%2Forbcode",
  // which is the form the registry URL expects for scoped packages.
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compare two semver strings (X.Y.Z, optionally with a pre-release suffix).
 * Returns -1 if a < b, 0 if equal, 1 if a > b. Non-numeric segments fall back
 * to lexicographic compare so "0.1.4-beta" sorts before "0.1.4".
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const [aMain, aPre] = splitVersion(a);
  const [bMain, bPre] = splitVersion(b);
  for (let i = 0; i < 3; i++) {
    const ai = aMain[i] ?? 0;
    const bi = bMain[i] ?? 0;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  // A version with no pre-release is greater than one with one.
  if (aPre === bPre) return 0;
  if (aPre === "") return 1;
  if (bPre === "") return -1;
  return aPre < bPre ? -1 : 1;
}

function splitVersion(v: string): [number[], string] {
  const [main, pre = ""] = v.split("-", 2);
  const parts = main.split(".").map((p) => {
    const n = Number.parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
  while (parts.length < 3) parts.push(0);
  return [parts, pre];
}

interface CachedCheck {
  checkedAt: number;
  latest: string | null;
}

function getCachePath(): string {
  return path.join(getConfigDir(), "update-check.json");
}

function readCache(): CachedCheck | null {
  try {
    const raw = fs.readFileSync(getCachePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<CachedCheck>;
    if (typeof parsed.checkedAt !== "number") return null;
    return { checkedAt: parsed.checkedAt, latest: parsed.latest ?? null };
  } catch {
    return null;
  }
}

function writeCache(latest: string | null): void {
  try {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      getCachePath(),
      JSON.stringify({ checkedAt: Date.now(), latest } satisfies CachedCheck),
      { mode: 0o600 },
    );
  } catch {
    // best-effort; a missing cache just means we'll hit the registry again next launch
  }
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** True when we couldn't determine the latest version (offline, registry down, etc.). */
  unknown: boolean;
}

/**
 * Resolve whether a newer version is available, using a short-lived cache so
 * we don't hammer the npm registry on every launch.
 */
export async function getUpdateInfo(
  pkg: string,
  current: string,
): Promise<UpdateInfo> {
  const cached = readCache();
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return makeResult(current, cached.latest);
  }
  const latest = await fetchLatestNpmVersion(pkg);
  if (latest !== null) writeCache(latest);
  return makeResult(current, latest);
}

function makeResult(current: string, latest: string | null): UpdateInfo {
  if (latest === null) {
    return { current, latest: null, updateAvailable: false, unknown: true };
  }
  return {
    current,
    latest,
    updateAvailable: compareVersions(current, latest) < 0,
    unknown: false,
  };
}

/** Invalidate the cached "latest" so the next launch re-checks. */
export function clearUpdateCache(): void {
  try {
    fs.unlinkSync(getCachePath());
  } catch {
    // ignore
  }
}

/** Run `npm install -g <pkg>@latest` and return the exit code (0 = success). */
export function runNpmUpdate(pkg: string): Promise<number> {
  return new Promise((resolve) => {
    // On Windows, npm is a .cmd shim; spawning it directly fails without shell:true.
    const isWin = process.platform === "win32";
    const child = spawn("npm", ["install", "-g", `${pkg}@latest`], {
      stdio: "inherit",
      shell: isWin,
    });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(typeof code === "number" ? code : 1));
  });
}

/**
 * Detect whether the running CLI is inside a global npm install, so the
 * update command can surface a friendlier message for local/dev installs.
 */
export function isGlobalInstall(): boolean {
  // argv[1] is whatever the shell handed to node, which is the *symlink* path
  // (`<prefix>/bin/orbcode`) for a global npm install — not the real file. We
  // have to resolve symlinks; otherwise the `node_modules/@matterailab/...`
  // substring never appears and a perfectly valid global install looks local.
  const here = resolveEntrypoint();
  return /node_modules[\\/]@matterailab[\\/]orbcode/.test(here);
}

function resolveEntrypoint(): string {
  const argvPath = process.argv[1];
  if (argvPath) {
    try {
      return fs.realpathSync(argvPath);
    } catch {
      // fall through to import.meta.url
    }
  }
  // import.meta.url is the real file:// URL of the running module, which
  // already points inside node_modules for a global install.
  if (typeof import.meta.url === "string" && import.meta.url) {
    return import.meta.url;
  }
  return "";
}

/** Best-effort: run `npm root -g` so we can show the install location. */
export async function getGlobalInstallRoot(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("npm", ["root", "-g"], {
      shell: process.platform === "win32",
    });
    const trimmed = stdout.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}
