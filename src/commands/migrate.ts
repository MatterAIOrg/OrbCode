/**
 * Migrate MCP server configurations from other CLI tools into OrbCode's
 * `~/.orbcode/settings.json` (user scope, `mcpServers` block).
 *
 * Detected sources:
 *   - Claude Code user-scope:   `~/.claude/settings.json` -> mcpServers
 *   - Claude Code (user, top of ~/.claude.json): same file, root `mcpServers`.
 *     Claude stores the user-scope servers here, at the file root, not under
 *     a per-project key. This is the most common location on a fresh install
 *     — `claude mcp add -s user …` writes to it.
 *   - Claude Code per-project:  `~/.claude.json` -> projects.<cwd>.mcpServers
 *     (and a fallback to the first project entry that has any servers, for
 *     mismatched cwd paths).
 *   - Claude Desktop:           `claude_desktop_config.json` (platform path)
 *
 * Both the TUI (`/migrate`) and the CLI (`orbcode mcp migrate`) call into this
 * module. The TUI lets the user pick a subset; the CLI either does a dry-run
 * preview or copies everything that doesn't conflict.
 *
 * Conflict policy: if a server with the same name already exists in the
 * destination, the incoming entry is silently dropped. The summary at the
 * end reports the skipped count.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getConfigDir, loadSettings } from "../config/settings.js";
import { isFigmaMcpServer } from "../mcp/figmaGuard.js";
import type {
  McpHttpServerConfig,
  McpServerConfig,
  McpSseServerConfig,
  McpStdioServerConfig,
} from "../mcp/types.js";

export type MigrationSourceId =
	| "claude-code-user"
	| "claude-code-json-user"
	| "claude-code-project"
	| "claude-desktop";

export interface MigrationSource {
  id: MigrationSourceId;
  /** Human-readable label for the picker. */
  label: string;
  /** Absolute path to the config file we read. */
  configPath: string;
  /** Servers found at that path, in the order they appear in the file. */
  servers: Record<string, McpServerConfig>;
}

export interface MigrationEntry {
  /** Stable key for checkbox state and the result summary. */
  key: string;
  source: MigrationSourceId;
  sourceLabel: string;
  name: string;
  config: McpServerConfig;
}

export interface MigrationResult {
  added: MigrationEntry[];
  skipped: { entry: MigrationEntry; reason: string }[];
}

/** A safe label for the picker (one per source). */
function sourceLabel(id: MigrationSourceId): string {
	switch (id) {
		case "claude-code-user":
			return "Claude Code (user)"
		case "claude-code-json-user":
			return "Claude Code (user, ~/.claude.json)"
		case "claude-code-project":
			return "Claude Code (this project)"
		case "claude-desktop":
			return "Claude Desktop"
	}
}

/** Cross-platform location of Claude Desktop's MCP config file. */
function claudeDesktopConfigPath(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  }
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  // Linux/WSL — best-effort XDG location; Claude Desktop doesn't have an
  // official Linux build, but some forks (e.g. open-source wrappers) use it.
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(xdg, "Claude", "claude_desktop_config.json");
}

function readJson(filePath: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a single MCP server config from an external source. We do not run
 * the full `normalizeServerConfig` from `mcp/config.ts` because it has side
 * effects (env expansion) and Claude's shape is already a subset of ours.
 * Only stdio / http / sse entries with the required fields survive.
 */
function normalizeExternalServer(raw: unknown): McpServerConfig | undefined {
  if (!isPlainObject(raw)) return undefined;
  const type = typeof raw.type === "string" ? raw.type : "stdio";

  if (type === "stdio") {
    if (typeof raw.command !== "string" || !raw.command.trim())
      return undefined;
    const config: McpStdioServerConfig = {
      type: "stdio",
      command: raw.command,
    };
    if (Array.isArray(raw.args)) {
      const args = raw.args.filter((a): a is string => typeof a === "string");
      if (args.length > 0) config.args = args;
    }
    if (isPlainObject(raw.env)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.env)) {
        if (typeof v === "string") env[k] = v;
      }
      if (Object.keys(env).length > 0) config.env = env;
    }
    return config;
  }

  if (type === "http" || type === "sse") {
    if (typeof raw.url !== "string" || !raw.url.trim()) return undefined;
    const config: McpHttpServerConfig | McpSseServerConfig = {
      type,
      url: raw.url,
    };
    if (isPlainObject(raw.headers)) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.headers)) {
        if (typeof v === "string") headers[k] = v;
      }
      if (Object.keys(headers).length > 0) config.headers = headers;
    }
    return config;
  }

  // `streamable-http` is Claude Code's preferred name for the modern HTTP
  // transport; OrbCode aliases it as "http".
  if (type === "streamable-http" || type === "streamable_http") {
    if (typeof raw.url !== "string" || !raw.url.trim()) return undefined;
    const config: McpHttpServerConfig = { type: "http", url: raw.url };
    if (isPlainObject(raw.headers)) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.headers)) {
        if (typeof v === "string") headers[k] = v;
      }
      if (Object.keys(headers).length > 0) config.headers = headers;
    }
    return config;
  }

  return undefined;
}

/** Read a `mcpServers` block, skipping any entry that fails to normalize. */
function readMcpServers(filePath: string): Record<string, McpServerConfig> {
  const json = readJson(filePath);
  if (!json) return {};
  const block = json.mcpServers;
  if (!isPlainObject(block)) return {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(block)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    const config = normalizeExternalServer(raw);
    if (config && !isFigmaMcpServer(name, config)) out[name] = config;
  }
  return out;
}

/** Pull the user-scope MCP servers Claude Code stores at the top level of
 *  `~/.claude.json`. This is where `claude mcp add -s user …` writes — the
 *  root `mcpServers` block on the same file that also holds per-project
 *  entries under `projects.<path>`. */
function readClaudeCodeRootServers(): Record<string, McpServerConfig> {
	const json = readJson(path.join(os.homedir(), ".claude.json"))
	if (!json) return {}
	return readMcpServersFromObject(json)
}

/** Pull the per-project MCP servers Claude Code stores in `~/.claude.json`. */
function readClaudeCodeProjectServers(): Record<string, McpServerConfig> {
  const json = readJson(path.join(os.homedir(), ".claude.json"));
  if (!json) return {};
  const projects = json.projects;
  if (!isPlainObject(projects)) return {};
  const cwd = process.cwd();
  // Prefer the cwd entry, fall back to the first project entry that has
  // any servers (helps when the cwd path doesn't match exactly, e.g. a
  // symlinked or differently-cased home directory).
  const entries = Object.entries(projects).filter(
    (entry): entry is [string, Record<string, unknown>] =>
      isPlainObject(entry[1]),
  );
  const direct = entries.find(([projectPath]) => projectPath === cwd);
  const fallback = entries.find(([, project]) =>
    isPlainObject(project.mcpServers),
  );
  const target = direct ?? fallback;
  if (!target) return {};
  return readMcpServersFromObject(target[1]);
}

/** Same as `readMcpServers` but takes a pre-parsed object. */
function readMcpServersFromObject(
  obj: Record<string, unknown>,
): Record<string, McpServerConfig> {
  const block = obj.mcpServers;
  if (!isPlainObject(block)) return {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(block)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    const config = normalizeExternalServer(raw);
    if (config && !isFigmaMcpServer(name, config)) out[name] = config;
  }
  return out;
}

/** Discover every available migration source on the current machine. */
export function discoverSources(): MigrationSource[] {
  const sources: MigrationSource[] = [];

  const claudeCodeUserPath = path.join(
    os.homedir(),
    ".claude",
    "settings.json",
  );
  const claudeCodeUserServers = readMcpServers(claudeCodeUserPath);
  if (Object.keys(claudeCodeUserServers).length > 0) {
    sources.push({
      id: "claude-code-user",
      label: sourceLabel("claude-code-user"),
      configPath: claudeCodeUserPath,
      servers: claudeCodeUserServers,
    });
  }

  // ~/.claude.json can hold entries in two layers: the root mcpServers block
  // (user-scope, written by `claude mcp add -s user …`) and per-project
  // entries under `projects.<path>.mcpServers`. Both can define a server with
  // the same name; Claude treats the per-project one as the override. To
  // avoid showing the same name twice in the picker, we collect both layers
  // and drop any project-layer name that the root layer also has.
  const claudeCodeJsonPath = path.join(os.homedir(), ".claude.json");
  const rootServers = readClaudeCodeRootServers();
  const projectServers = readClaudeCodeProjectServers();
  const rootNames = new Set(Object.keys(rootServers));

  if (Object.keys(rootServers).length > 0) {
    sources.push({
      id: "claude-code-json-user",
      label: sourceLabel("claude-code-json-user"),
      configPath: claudeCodeJsonPath,
      servers: rootServers,
    });
  }

  if (Object.keys(projectServers).length > 0) {
    const deduped: Record<string, McpServerConfig> = {}
    for (const [name, cfg] of Object.entries(projectServers)) {
      if (rootNames.has(name)) continue
      deduped[name] = cfg
    }
    if (Object.keys(deduped).length > 0) {
      sources.push({
        id: "claude-code-project",
        label: sourceLabel("claude-code-project"),
        configPath: claudeCodeJsonPath,
        servers: deduped,
      })
    }
  }

  const claudeDesktopPath = claudeDesktopConfigPath();
  const claudeDesktopServers = readMcpServers(claudeDesktopPath);
  if (Object.keys(claudeDesktopServers).length > 0) {
    sources.push({
      id: "claude-desktop",
      label: sourceLabel("claude-desktop"),
      configPath: claudeDesktopPath,
      servers: claudeDesktopServers,
    });
  }

  return sources;
}

/** Flatten all sources into a single checklist. Stable order: source first,
 *  then server name. */
export function listMigrationEntries(): MigrationEntry[] {
  const entries: MigrationEntry[] = [];
  for (const source of discoverSources()) {
    for (const [name, config] of Object.entries(source.servers)) {
      entries.push({
        key: `${source.id}::${name}`,
        source: source.id,
        sourceLabel: source.label,
        name,
        config,
      });
    }
  }
  return entries;
}

/** Short summary of a server for the picker / dry-run output. */
export function describeEntry(entry: MigrationEntry): string {
  const cfg = entry.config;
  if (cfg.type === "http" || cfg.type === "sse") {
    return `${cfg.type} ${cfg.url}`;
  }
  const args = cfg.args ?? [];
  return `stdio ${cfg.command}${args.length ? " " + args.join(" ") : ""}`;
}

/** True when `name` already exists in the user-scope mcpServers block of
 *  OrbCode's settings. This is the only conflict that matters — the CLI and
 *  TUI both target user scope. */
function destinationHas(name: string): boolean {
  const settings = loadSettings();
  return Boolean(settings.mcpServers && name in settings.mcpServers);
}

/**
 * Apply a set of migration entries to `~/.orbcode/settings.json` (user scope).
 * Returns the new entries plus the entries that were skipped (with a reason).
 */
export function applyMigration(entries: MigrationEntry[]): MigrationResult {
  const filePath = path.join(getConfigDir(), "settings.json");
  const existing = readJson(filePath) ?? {};
  const servers = isPlainObject(existing.mcpServers)
    ? { ...(existing.mcpServers as Record<string, McpServerConfig>) }
    : {};

  const added: MigrationEntry[] = [];
  const skipped: { entry: MigrationEntry; reason: string }[] = [];

  for (const entry of entries) {
    if (isFigmaMcpServer(entry.name, entry.config)) {
      skipped.push({
        entry,
        reason: "external Figma MCPs are disabled; use the native figma_fetch tool",
      });
      continue;
    }
    if (entry.name in servers) {
      skipped.push({
        entry,
        reason: "already exists in ~/.orbcode/settings.json",
      });
      continue;
    }
    if (destinationHas(entry.name)) {
      // Race-safe double-check: the in-memory snapshot is the source of
      // truth at write time, so if it changed between our read and now
      // we still skip.
      skipped.push({
        entry,
        reason: "already exists in ~/.orbcode/settings.json",
      });
      continue;
    }
    servers[entry.name] = entry.config;
    added.push(entry);
  }

  if (added.length > 0) {
    existing.mcpServers = servers;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(existing, null, "\t") + "\n", {
      mode: 0o600,
    });
  }

  return { added, skipped };
}
