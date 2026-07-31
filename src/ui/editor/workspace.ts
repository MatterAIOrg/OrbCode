import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { searchFilesWithRipgrep } from "../../tools/executors/searchFiles/ripgrep.js";
import { createSearchFingerprint } from "../../tools/executors/searchFiles/types.js";
import type { SearchMatch } from "../../tools/executors/searchFiles/types.js";

const execFileAsync = promisify(execFile);

const COLLAPSED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  "__pycache__",
  ".venv",
  "venv",
]);

export type WorkspaceEntryKind = "file" | "directory";

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: WorkspaceEntryKind;
  /** Large/generated directories remain visible but are not traversed. */
  collapsed: boolean;
  children: WorkspaceEntry[];
}

export interface WorkspaceSnapshot {
  rootName: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

export interface VisibleWorkspaceEntry {
  entry: WorkspaceEntry;
  depth: number;
}

export type GitFileStatus = "M" | "A" | "D" | "R" | "U";

export type GlobalSearchResult = SearchMatch;

const DEFAULT_MAX_ENTRIES = 12_000;
const DEFAULT_MAX_VIEWER_BYTES = 2 * 1024 * 1024;

export type WorkspaceFileContent =
  | {
      kind: "text";
      path: string;
      size: number;
      lines: string[];
      truncated: boolean;
    }
  | {
      kind: "binary";
      path: string;
      size: number;
      truncated: false;
    }
  | {
      kind: "error";
      path: string;
      message: string;
    };

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function compareEntries(a: WorkspaceEntry, b: WorkspaceEntry): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/**
 * Builds one immutable workspace tree. Generated dependency/build directories
 * are represented in the explorer but deliberately left collapsed so opening
 * editor mode stays bounded on large repositories.
 */
export async function scanWorkspace(
  root: string,
  maxEntries = DEFAULT_MAX_ENTRIES,
): Promise<WorkspaceSnapshot> {
  let entriesSeen = 0;
  let truncated = false;

  async function scanDirectory(
    absoluteDirectory: string,
    relativeDirectory: string,
  ): Promise<WorkspaceEntry[]> {
    if (entriesSeen >= maxEntries) {
      truncated = true;
      return [];
    }

    let dirents;
    try {
      dirents = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    } catch {
      return [];
    }

    const entries: WorkspaceEntry[] = [];
    for (const dirent of dirents) {
      if (entriesSeen >= maxEntries) {
        truncated = true;
        break;
      }
      // The .git implementation directory is noise in an editor explorer.
      if (dirent.name === ".git") continue;

      entriesSeen += 1;
      const relativePath = toPosix(
        path.join(relativeDirectory, dirent.name),
      );
      const isDirectory = dirent.isDirectory();
      const collapsed =
        isDirectory && COLLAPSED_DIRECTORY_NAMES.has(dirent.name);
      const entry: WorkspaceEntry = {
        name: dirent.name,
        path: relativePath,
        kind: isDirectory ? "directory" : "file",
        collapsed,
        children: [],
      };
      if (isDirectory && !collapsed) {
        entry.children = await scanDirectory(
          path.join(absoluteDirectory, dirent.name),
          relativePath,
        );
      }
      entries.push(entry);
    }
    entries.sort(compareEntries);
    return entries;
  }

  return {
    rootName: path.basename(path.resolve(root)) || path.resolve(root),
    entries: await scanDirectory(path.resolve(root), ""),
    truncated,
  };
}

function prefixEntries(
  entries: WorkspaceEntry[],
  prefix: string,
): WorkspaceEntry[] {
  return entries.map((entry) => ({
    ...entry,
    path: `${prefix}/${entry.path}`,
    children: prefixEntries(entry.children, prefix),
  }));
}

/**
 * Expands a directory that the initial scan intentionally left lazy (for
 * example node_modules). The smaller cap prevents one click from flooding the
 * terminal while still making every directory genuinely expandable.
 */
export async function scanWorkspaceSubtree(
  root: string,
  relativeDirectory: string,
  maxEntries = 2_000,
): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
  const absoluteDirectory = path.resolve(root, relativeDirectory);
  const relative = path.relative(path.resolve(root), absoluteDirectory);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    relative === ""
  ) {
    return { entries: [], truncated: false };
  }
  const snapshot = await scanWorkspace(absoluteDirectory, maxEntries);
  return {
    entries: prefixEntries(snapshot.entries, toPosix(relativeDirectory)),
    truncated: snapshot.truncated,
  };
}

/** VS Code-style loose matching for the explorer's filename filter. */
export function matchesFileFilter(target: string, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  const normalizedTarget = target.toLowerCase();
  if (normalizedTarget.includes(normalizedQuery)) return true;

  let queryIndex = 0;
  for (
    let targetIndex = 0;
    targetIndex < normalizedTarget.length &&
    queryIndex < normalizedQuery.length;
    targetIndex += 1
  ) {
    if (normalizedTarget[targetIndex] === normalizedQuery[queryIndex]) {
      queryIndex += 1;
    }
  }
  return queryIndex === normalizedQuery.length;
}

export function flattenWorkspace(
  entries: WorkspaceEntry[],
  expanded: ReadonlySet<string>,
  filter = "",
): VisibleWorkspaceEntry[] {
  const visible: VisibleWorkspaceEntry[] = [];
  const hasFilter = filter.trim().length > 0;

  function visit(entry: WorkspaceEntry, depth: number): boolean {
    const rowIndex = visible.length;
    const ownMatch = matchesFileFilter(entry.path, filter);
    visible.push({ entry, depth });

    let descendantMatches = false;
    const shouldVisitChildren =
      entry.kind === "directory" &&
      !entry.collapsed &&
      (hasFilter || expanded.has(entry.path));
    if (shouldVisitChildren) {
      for (const child of entry.children) {
        descendantMatches = visit(child, depth + 1) || descendantMatches;
      }
    }

    const matches = ownMatch || descendantMatches;
    if (hasFilter && !matches) visible.splice(rowIndex);
    return matches;
  }

  for (const entry of entries) visit(entry, 0);
  return visible;
}

function badgeForStatusCode(code: string): GitFileStatus | undefined {
  if (code === "??") return "U";
  if (code.includes("U") || code === "AA" || code === "DD") return "U";
  if (code.includes("D")) return "D";
  if (code.includes("R")) return "R";
  if (code.includes("A") || code.includes("C")) return "A";
  if (code.includes("M") || code.includes("T")) return "M";
  return undefined;
}

/** Parses `git status --porcelain=v1 -z`, including its extra rename field. */
export function parseGitStatus(output: string): Map<string, GitFileStatus> {
  const statuses = new Map<string, GitFileStatus>();
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    if (code === "!!") continue;
    const badge = badgeForStatusCode(code);
    const currentPath = toPosix(record.slice(3));
    if (badge && currentPath) statuses.set(currentPath, badge);
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return statuses;
}

export async function readGitStatus(
  cwd: string,
): Promise<Map<string, GitFileStatus>> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 3_000,
      },
    );
    return parseGitStatus(stdout);
  } catch {
    return new Map();
  }
}

/** Extracts current-file line numbers from zero-context unified-diff hunks. */
export function parseGitChangedLines(diff: string): Set<number> {
  const changed = new Set<number>();
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      changed.add(newLine);
      newLine += 1;
    } else if (line.startsWith(" ")) {
      newLine += 1;
    } else if (
      line.startsWith("diff ") ||
      line.startsWith("---") ||
      line.startsWith("index ")
    ) {
      inHunk = false;
    }
  }
  return changed;
}

function allLineNumbers(lineCount: number): Set<number> {
  const lines = new Set<number>();
  for (let line = 1; line <= Math.max(0, Math.floor(lineCount)); line += 1) {
    lines.add(line);
  }
  return lines;
}

/**
 * Returns lines in the working-tree file that differ from HEAD. Comparing
 * directly with HEAD combines staged and unstaged edits into the exact content
 * shown by the viewer. New and untracked files have no base, so every current
 * line is considered added.
 */
export async function readGitChangedLines(
  cwd: string,
  relativePath: string,
  currentLineCount: number,
): Promise<Set<number>> {
  const resolvedRoot = path.resolve(cwd);
  const target = path.resolve(resolvedRoot, relativePath);
  if (!isWithinRoot(resolvedRoot, target) || target === resolvedRoot) {
    return new Set();
  }
  const normalizedPath = toPosix(path.relative(resolvedRoot, target));

  let statusOutput: string;
  try {
    ({ stdout: statusOutput } = await execFileAsync(
      "git",
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
        normalizedPath,
      ],
      {
        cwd: resolvedRoot,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 3_000,
      },
    ));
  } catch {
    // Opening a regular directory outside a Git worktree should not make every
    // file look newly added.
    return new Set();
  }

  const statusRecord = statusOutput.split("\0").find(Boolean);
  if (!statusRecord || statusRecord.length < 3) return new Set();
  const code = statusRecord.slice(0, 2);
  if (code === "!!") return new Set();
  if (
    code === "??" ||
    code.includes("A") ||
    code.includes("C") ||
    code.includes("U") ||
    code === "DD"
  ) {
    return allLineNumbers(currentLineCount);
  }

  try {
    const { stdout: diff } = await execFileAsync(
      "git",
      [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--unified=0",
        "HEAD",
        "--",
        normalizedPath,
      ],
      {
        cwd: resolvedRoot,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 3_000,
      },
    );
    const changed = parseGitChangedLines(diff);
    return new Set(
      [...changed].filter(
        (line) => line >= 1 && line <= Math.max(0, currentLineCount),
      ),
    );
  } catch {
    // A changed file without a resolvable HEAD (for example an initial commit)
    // has no reliable base. Treat its current contents as added.
    return allLineNumbers(currentLineCount);
  }
}

export function statusForEntry(
  entry: WorkspaceEntry,
  statuses: ReadonlyMap<string, GitFileStatus>,
): GitFileStatus | "•" | undefined {
  const exact = statuses.get(entry.path);
  if (exact) return exact;
  if (entry.kind === "directory") {
    const prefix = `${entry.path}/`;
    for (const changedPath of statuses.keys()) {
      if (changedPath.startsWith(prefix)) return "•";
    }
  }
  return undefined;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Literal workspace text search, backed by the same bundled rg as the agent. */
export async function searchWorkspaceText(
  cwd: string,
  query: string,
  maxResults = 80,
): Promise<GlobalSearchResult[]> {
  const normalized = query.trim();
  if (!normalized) return [];
  const regex = escapeRegex(normalized);
  const fingerprint = createSearchFingerprint(cwd, regex);
  const page = await searchFilesWithRipgrep(
    cwd,
    cwd,
    regex,
    undefined,
    {
      cursor: null,
      maxResults,
      contextLines: 0,
      fingerprint,
    },
    true,
    20,
  );
  return page.matches;
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  if (buffer.length === 0) return false;
  let controlBytes = 0;
  for (const byte of buffer) {
    const allowedWhitespace = byte === 9 || byte === 10 || byte === 13;
    if (!allowedWhitespace && (byte < 32 || byte === 127)) {
      controlBytes += 1;
    }
  }
  return controlBytes / buffer.length > 0.08;
}

/**
 * Loads a bounded, workspace-contained file for the read-only editor viewer.
 * Both lexical and real paths are checked so a symlink cannot escape the
 * workspace.
 */
export async function readWorkspaceFile(
  root: string,
  relativePath: string,
  maxBytes = DEFAULT_MAX_VIEWER_BYTES,
): Promise<WorkspaceFileContent> {
  const normalizedPath = toPosix(relativePath);
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  if (!isWithinRoot(resolvedRoot, target) || target === resolvedRoot) {
    return {
      kind: "error",
      path: normalizedPath,
      message: "File is outside the workspace.",
    };
  }

  try {
    const [realRoot, realTarget] = await Promise.all([
      fs.realpath(resolvedRoot),
      fs.realpath(target),
    ]);
    if (!isWithinRoot(realRoot, realTarget)) {
      return {
        kind: "error",
        path: normalizedPath,
        message: "File symlink resolves outside the workspace.",
      };
    }

    const stat = await fs.stat(realTarget);
    if (!stat.isFile()) {
      return {
        kind: "error",
        path: normalizedPath,
        message: "The selected path is not a file.",
      };
    }

    const bytesToRead = Math.min(
      stat.size,
      Math.max(1, Math.floor(maxBytes)),
    );
    const handle = await fs.open(realTarget, "r");
    let buffer: Buffer;
    try {
      buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        bytesToRead,
        0,
      );
      buffer = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }

    if (looksBinary(buffer)) {
      return {
        kind: "binary",
        path: normalizedPath,
        size: stat.size,
        truncated: false,
      };
    }

    const text = buffer
      .toString("utf8")
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n");
    return {
      kind: "text",
      path: normalizedPath,
      size: stat.size,
      lines: text.split("\n"),
      truncated: stat.size > buffer.length,
    };
  } catch (error) {
    return {
      kind: "error",
      path: normalizedPath,
      message:
        error instanceof Error ? error.message : "Unable to read the file.",
    };
  }
}
