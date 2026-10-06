import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { VERSION } from "../branding.js";
import { getConfigDir, type OrbCodeSettings } from "../config/settings.js";
import { compareVersions, isGlobalInstall, type UpdateInfo } from "./updateCheck.js";

// Background updates stage each new version in its own directory,
// ~/.orbcode/versions/<version>/, and flip the one-line `current` pointer only
// after the install has been verified. bin/select-version.js reads that
// pointer on the next launch. The running install is never modified, so a
// failed or interrupted update leaves everything exactly as it was.
//
// The directory layout and marker names are shared with bin/select-version.js.

const execFileAsync = promisify(execFile);

/** Only auto-install releases that have been public this long, so a bad
 *  release can be caught (and superseded) before it reaches everyone. */
export const MIN_RELEASE_AGE_MS = 24 * 60 * 60 * 1_000;
/** After a failed install, stay quiet (and show the manual banner) this long. */
const FAILURE_BACKOFF_MS = 24 * 60 * 60 * 1_000;
/** Old version dirs are removed once they have been superseded this long. */
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;
const LOCK_STALE_MS = 30 * 60 * 1_000;
const REGISTRY_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1_000;
const VERIFY_TIMEOUT_MS = 60_000;

const PACKAGE_PATH = ["node_modules", "@matterailab", "orbcode"];
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const HEALTHY_MARKER = ".healthy";
const ATTEMPTS_MARKER = ".attempts";
const SUPERSEDED_MARKER = ".superseded";
const MAX_UNHEALTHY_LAUNCHES = 1;

export function getVersionsDir(): string {
  return path.join(getConfigDir(), "versions");
}

function versionDir(version: string): string {
  return path.join(getVersionsDir(), version);
}

function versionBin(dir: string): string {
  return path.join(dir, ...PACKAGE_PATH, "bin", "orbcode.js");
}

export function isVersionString(value: unknown): value is string {
  return typeof value === "string" && VERSION_RE.test(value);
}

export function readCurrentPointer(): string | null {
  try {
    const value = fs.readFileSync(path.join(getVersionsDir(), "current"), "utf8").trim();
    return isVersionString(value) ? value : null;
  } catch {
    return null;
  }
}

function readAttempts(dir: string): number {
  try {
    const n = Number.parseInt(fs.readFileSync(path.join(dir, ATTEMPTS_MARKER), "utf8"), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** A staged version that failed to start and never proved itself healthy. */
export function isBadVersion(version: string): boolean {
  const dir = versionDir(version);
  return !fs.existsSync(path.join(dir, HEALTHY_MARKER)) && readAttempts(dir) >= MAX_UNHEALTHY_LAUNCHES;
}

/** The staged-version directory this process is running from, if any. */
function getRunningVersionDir(): string | null {
  try {
    // dist/utils/autoUpdate.js -> package root
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const dir = path.resolve(packageRoot, ...PACKAGE_PATH.map(() => ".."));
    if (path.dirname(dir) !== path.resolve(getVersionsDir())) return null;
    return isVersionString(path.basename(dir)) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Record that this staged version started successfully, so the launcher keeps
 * using it. No-op for installs outside ~/.orbcode/versions.
 */
export function markRunningVersionHealthy(): void {
  const dir = getRunningVersionDir();
  if (!dir) return;
  try {
    fs.writeFileSync(path.join(dir, HEALTHY_MARKER), new Date().toISOString());
  } catch {
    // best-effort
  }
}

/** Why background updates are off for this process, or null when they're on. */
export function autoUpdateDisabledReason(settings: Pick<OrbCodeSettings, "autoUpdates">): string | null {
  const optOut = process.env.ORBCODE_DISABLE_AUTOUPDATE;
  if (optOut && optOut !== "0" && optOut !== "false") return "ORBCODE_DISABLE_AUTOUPDATE is set";
  if (process.env.CI) return "running in CI";
  if (settings.autoUpdates === false) return "autoUpdates is false in settings";
  if (!isGlobalInstall()) return "not a global install";
  if (!getNodePath()) return "no Node.js binary to verify updates with";
  return null;
}

/** The Node binary that runs bin/orbcode.js — what a real launch uses. */
function getNodePath(): string | null {
  if (process.env.ORBCODE_NODE_PATH) return process.env.ORBCODE_NODE_PATH;
  return process.versions.bun ? null : process.execPath;
}

/** Node version reported by the launcher's Node binary (not Bun's shim). */
async function getNodeVersion(nodePath: string): Promise<string | null> {
  if (!process.versions.bun && nodePath === process.execPath) return process.versions.node;
  try {
    const { stdout } = await execFileAsync(nodePath, ["-p", "process.versions.node"], { timeout: 10_000 });
    const v = stdout.trim();
    return isVersionString(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Only the `>=X[.Y[.Z]]` form OrbCode publishes is understood; anything else
 * counts as unsatisfied so we never stage a version we can't vouch for.
 */
export function satisfiesNodeEngine(range: string | undefined, nodeVersion: string): boolean {
  if (!range || !range.trim()) return true;
  const match = /^\s*>=\s*v?(\d+(?:\.\d+){0,2})\s*$/.exec(range);
  if (!match) return false;
  return compareVersions(nodeVersion, match[1]) >= 0;
}

interface ReleaseInfo {
  publishedAt: number | null;
  nodeEngine?: string;
  deprecated: boolean;
}

async function fetchReleaseInfo(pkg: string, version: string): Promise<ReleaseInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const doc = (await res.json()) as {
      time?: Record<string, string>;
      versions?: Record<string, { engines?: { node?: unknown }; deprecated?: unknown }>;
    };
    const manifest = doc.versions?.[version];
    if (!manifest) return null;
    const published = Date.parse(doc.time?.[version] ?? "");
    return {
      publishedAt: Number.isFinite(published) ? published : null,
      nodeEngine: typeof manifest.engines?.node === "string" ? manifest.engines.node : undefined,
      deprecated: manifest.deprecated !== undefined && manifest.deprecated !== false,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── lock ────────────────────────────────────────────────────────────────────

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Exclusive cross-process lock so concurrent sessions don't install at once. */
function acquireLock(): (() => void) | null {
  const lockPath = path.join(getVersionsDir(), ".lock");
  const token = `${process.pid}:${Date.now()}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, token, { flag: "wx" });
      return () => {
        try {
          if (fs.readFileSync(lockPath, "utf8") === token) fs.unlinkSync(lockPath);
        } catch {
          // ignore
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      try {
        const raw = fs.readFileSync(lockPath, "utf8");
        const [pidText, atText] = raw.split(":");
        const pid = Number(pidText);
        const at = Number(atText);
        const stale = !isPidAlive(pid) || !Number.isFinite(at) || Date.now() - at > LOCK_STALE_MS;
        if (!stale) return null;
        // Another process may have taken over the stale lock since we read it;
        // only remove the exact lock we judged stale.
        if (fs.readFileSync(lockPath, "utf8") !== raw) return null;
        fs.unlinkSync(lockPath);
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ── install / verify ────────────────────────────────────────────────────────

function npmInstall(pkg: string, version: string, cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      "npm",
      [
        "install",
        "--prefix",
        ".",
        "--no-audit",
        "--no-fund",
        "--no-save",
        "--no-package-lock",
        // The bundled Bun runtime is placed by its postinstall script.
        "--ignore-scripts=false",
        "--loglevel=error",
        `${pkg}@${version}`,
      ],
      { cwd, stdio: "ignore", shell: process.platform === "win32" },
    );
    const killChild = () => child.kill();
    const timer = setTimeout(killChild, INSTALL_TIMEOUT_MS);
    // An interrupted install only leaves a *.tmp dir, which the launcher
    // ignores and the next update removes.
    process.once("exit", killChild);
    const done = (reason: string | null) => {
      clearTimeout(timer);
      process.off("exit", killChild);
      resolve(reason);
    };
    child.once("error", (error) => done(`npm could not start: ${error.message}`));
    child.once("close", (code) => done(code === 0 ? null : `npm install exited with ${code}`));
  });
}

/**
 * Run the staged copy exactly the way a real launch would (Node launcher →
 * bundled Bun → dist) and require it to report the expected version, then
 * load its whole UI module graph via the hidden --self-test flag.
 */
async function verifyInstall(dir: string, version: string, nodePath: string): Promise<string | null> {
  const bin = versionBin(dir);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, ...PACKAGE_PATH, "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (pkg.version !== version) return `installed package reports ${String(pkg.version)}`;
  } catch {
    return "installed package.json is missing";
  }
  const options = {
    cwd: dir,
    timeout: VERIFY_TIMEOUT_MS,
    env: { ...process.env, ORBCODE_DELEGATED: "1", ORBCODE_NODE_PATH: nodePath },
  };
  try {
    const { stdout } = await execFileAsync(nodePath, [bin, "--version"], options);
    if (stdout.trim() !== version) return `--version printed "${stdout.trim()}"`;
  } catch (error) {
    return `--version failed: ${(error as Error).message}`;
  }
  try {
    const { stdout } = await execFileAsync(nodePath, [bin, "--self-test"], options);
    const lastLine = stdout.trim().split(/\r?\n/).pop();
    if (lastLine !== `ok ${version}`) return `--self-test printed "${lastLine ?? ""}"`;
  } catch (error) {
    return `--self-test failed: ${(error as Error).message}`;
  }
  return null;
}

/** rename() with retries — on Windows, scanners briefly lock fresh files. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
}

async function writeCurrentPointer(version: string): Promise<void> {
  const versionsDir = getVersionsDir();
  const tmp = path.join(versionsDir, `current.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${version}\n`);
  await renameWithRetry(tmp, path.join(versionsDir, "current"));
}

function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // best-effort; tried again on the next update
  }
}

/** Drop leftover *.tmp dirs and versions superseded more than a week ago. */
function pruneVersions(keep: Set<string>): void {
  const versionsDir = getVersionsDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(versionsDir, entry.name);
    if (entry.name.endsWith(".tmp")) {
      removeDir(dir);
      continue;
    }
    if (!isVersionString(entry.name) || keep.has(entry.name)) continue;
    let since: number;
    try {
      since = fs.statSync(path.join(dir, SUPERSEDED_MARKER)).mtimeMs;
    } catch {
      try {
        since = fs.statSync(dir).mtimeMs;
      } catch {
        continue;
      }
    }
    if (Date.now() - since > PRUNE_AFTER_MS) removeDir(dir);
  }
}

/**
 * Install `version` into its own directory, verify it, and point `current` at
 * it. Returns null on success or a reason string. Never touches the running
 * install; on any failure the pointer is left unchanged.
 */
export async function stageVersion(
  pkg: string,
  version: string,
  nodePath: string,
): Promise<string | null | "locked"> {
  const versionsDir = getVersionsDir();
  fs.mkdirSync(versionsDir, { recursive: true });
  const release = acquireLock();
  if (!release) return "locked";
  try {
    const finalDir = versionDir(version);
    const previous = readCurrentPointer();
    if (fs.existsSync(finalDir)) {
      if (isBadVersion(version)) return `v${version} failed to start previously`;
      if (!fs.existsSync(versionBin(finalDir))) removeDir(finalDir);
    }
    if (!fs.existsSync(finalDir)) {
      const tmpDir = `${finalDir}.tmp`;
      removeDir(tmpDir);
      fs.mkdirSync(tmpDir, { recursive: true });
      const installError = await npmInstall(pkg, version, tmpDir);
      if (installError) {
        removeDir(tmpDir);
        return installError;
      }
      const verifyError = await verifyInstall(tmpDir, version, nodePath);
      if (verifyError) {
        removeDir(tmpDir);
        return verifyError;
      }
      await renameWithRetry(tmpDir, finalDir);
    }
    await writeCurrentPointer(version);
    if (previous && previous !== version) {
      try {
        fs.writeFileSync(path.join(versionDir(previous), SUPERSEDED_MARKER), new Date().toISOString());
      } catch {
        // previous dir may already be gone
      }
    }
    pruneVersions(new Set([version, VERSION, ...(previous ? [previous] : [])]));
    return null;
  } catch (error) {
    return (error as Error).message;
  } finally {
    release();
  }
}

// ── orchestration ───────────────────────────────────────────────────────────

interface FailureRecord {
  at: number;
  version: string;
  reason: string;
}

function failurePath(): string {
  return path.join(getVersionsDir(), ".last-failure");
}

function readRecentFailure(): FailureRecord | null {
  try {
    const record = JSON.parse(fs.readFileSync(failurePath(), "utf8")) as FailureRecord;
    return Date.now() - record.at < FAILURE_BACKOFF_MS ? record : null;
  } catch {
    return null;
  }
}

function writeFailure(version: string, reason: string): void {
  try {
    fs.mkdirSync(getVersionsDir(), { recursive: true });
    fs.writeFileSync(failurePath(), JSON.stringify({ at: Date.now(), version, reason }));
  } catch {
    // best-effort
  }
}

function clearFailure(): void {
  try {
    fs.unlinkSync(failurePath());
  } catch {
    // ignore
  }
}

export interface UpdateNotice extends UpdateInfo {
  /** A newer version is staged and will run on the next launch. */
  stagedVersion?: string;
}

/**
 * Turn an npm version check into what the UI should show, staging the update
 * in the background when allowed. The manual "run orbcode update" banner only
 * appears when background updates are off or have failed.
 */
export async function resolveUpdateNotice(
  pkg: string,
  info: UpdateInfo,
  settings: Pick<OrbCodeSettings, "autoUpdates">,
): Promise<UpdateNotice> {
  try {
    if (autoUpdateDisabledReason(settings)) return info;
    const quiet: UpdateNotice = { ...info, updateAvailable: false };
    const staged = readCurrentPointer();
    const stagedNotice =
      staged && compareVersions(staged, info.current) > 0 && !isBadVersion(staged)
        ? { ...quiet, stagedVersion: staged }
        : null;
    const latest = info.latest;
    if (!info.updateAvailable || !latest) return stagedNotice ?? info;
    // Registry data becomes a path and an npm argument below.
    if (!isVersionString(latest)) return stagedNotice ?? quiet;
    if (staged && compareVersions(staged, latest) >= 0) return stagedNotice ?? info;
    if (readRecentFailure()) return info;

    const release = await fetchReleaseInfo(pkg, latest);
    // Registry hiccup or a pulled release: stay quiet and retry next launch.
    if (!release || release.deprecated || release.publishedAt === null) return stagedNotice ?? quiet;
    if (Date.now() - release.publishedAt < MIN_RELEASE_AGE_MS) return stagedNotice ?? quiet;

    const nodePath = getNodePath()!;
    const nodeVersion = await getNodeVersion(nodePath);
    if (!nodeVersion || !satisfiesNodeEngine(release.nodeEngine, nodeVersion)) return info;

    const error = await stageVersion(pkg, latest, nodePath);
    if (error === "locked") return stagedNotice ?? quiet;
    if (error) {
      writeFailure(latest, error);
      return info;
    }
    clearFailure();
    return { ...quiet, stagedVersion: latest };
  } catch {
    return info;
  }
}
