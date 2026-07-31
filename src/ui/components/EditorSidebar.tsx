import React, { useEffect, useMemo, useRef, useState } from "react";

import { COLORS } from "../../branding.js";
import { Box, Text, useInput } from "../primitives.js";
import type { EditorFileSelection } from "./FileViewer.js";
import {
  terminalFileIcon,
  terminalFolderIcon,
} from "../editor/fileIcons.js";
import {
  flattenWorkspace,
  readGitStatus,
  scanWorkspace,
  scanWorkspaceSubtree,
  searchWorkspaceText,
  statusForEntry,
  type GitFileStatus,
  type GlobalSearchResult,
  type VisibleWorkspaceEntry,
  type WorkspaceSnapshot,
} from "../editor/workspace.js";

export type EditorSidebarPanel = "explorer" | "search";
export type EditorFocus = "chat" | "tree" | "filter" | "search" | "viewer";

interface EditorSidebarProps {
  cwd: string;
  width: number;
  height: number;
  active: boolean;
  panel: EditorSidebarPanel;
  focus: EditorFocus;
  refreshKey?: unknown;
  onPanelChange: (panel: EditorSidebarPanel) => void;
  onFocusChange: (focus: EditorFocus) => void;
  onOpenFile: (file: EditorFileSelection) => void;
}

const EMPTY_SNAPSHOT: WorkspaceSnapshot = {
  rootName: "",
  entries: [],
  truncated: false,
};
const SEARCH_DEBOUNCE_MS = 180;

function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth === 1) return "…";
  return `${text.slice(0, maxWidth - 1)}…`;
}

function statusColor(status: GitFileStatus | "•" | undefined): string {
  if (status === "D") return COLORS.error;
  if (status === "U" || status === "A") return COLORS.success;
  if (status === "M" || status === "R") return COLORS.warning;
  return COLORS.dim;
}

function TextInputRow({
  value,
  placeholder,
  focused,
  width,
  onActivate,
}: {
  value: string;
  placeholder: string;
  focused: boolean;
  width: number;
  onActivate: () => void;
}) {
  const shown = value || placeholder;
  return (
    <Box
      width="100%"
      height={1}
      paddingLeft={1}
      backgroundColor={focused ? "$orbcode.selection" : undefined}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        onActivate();
      }}
    >
      <Text color={value ? COLORS.primary : COLORS.dim} wrap="truncate">
        ⌕ {truncate(shown, Math.max(1, width - 4))}
        {focused ? "▏" : ""}
      </Text>
    </Box>
  );
}

export function EditorSidebar({
  cwd,
  width,
  height,
  active,
  panel,
  focus,
  refreshKey,
  onPanelChange,
  onFocusChange,
  onOpenFile,
}: EditorSidebarProps) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(EMPTY_SNAPSHOT);
  const [gitStatuses, setGitStatuses] = useState<Map<string, GitFileStatus>>(
    () => new Map(),
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const filterRef = useRef("");
  const searchQueryRef = useRef("");
  const [searchResults, setSearchResults] = useState<GlobalSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedPath, setSelectedPath] = useState("");
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const refreshGeneration = useRef(0);

  const refresh = () => {
    const generation = ++refreshGeneration.current;
    void Promise.all([scanWorkspace(cwd), readGitStatus(cwd)]).then(
      ([nextSnapshot, nextStatuses]) => {
        if (generation !== refreshGeneration.current) return;
        setSnapshot(nextSnapshot);
        setGitStatuses(nextStatuses);
      },
    );
  };

  useEffect(() => {
    refresh();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [cwd, refreshKey]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearching(false);
      setSearchResults([]);
      setSelectedSearchIndex(0);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void searchWorkspaceText(cwd, searchQuery)
        .then((results) => {
          if (cancelled) return;
          setSearchResults(results);
          setSelectedSearchIndex(0);
        })
        .catch(() => {
          if (!cancelled) setSearchResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [cwd, searchQuery]);

  const treeRows = useMemo(
    () => flattenWorkspace(snapshot.entries, expanded, filter),
    [snapshot.entries, expanded, filter],
  );
  const selectedTreeIndex = Math.max(
    0,
    treeRows.findIndex(({ entry }) => entry.path === selectedPath),
  );
  const explorerVisibleRows = Math.max(1, height - 7);
  const searchVisibleResults = Math.max(1, Math.floor((height - 7) / 2));
  const maxTreeOffset = Math.max(0, treeRows.length - explorerVisibleRows);
  const maxSearchOffset = Math.max(
    0,
    searchResults.length - searchVisibleResults,
  );
  const effectiveOffset = Math.min(
    scrollOffset,
    panel === "explorer" ? maxTreeOffset : maxSearchOffset,
  );

  const ensureVisible = (
    index: number,
    visibleCount: number,
    maximumOffset: number,
  ) => {
    setScrollOffset((current) => {
      if (index < current) return index;
      if (index >= current + visibleCount) {
        return Math.min(maximumOffset, index - visibleCount + 1);
      }
      return Math.min(current, maximumOffset);
    });
  };

  const toggleEntry = (row: VisibleWorkspaceEntry) => {
    setSelectedPath(row.entry.path);
    onFocusChange("tree");
    if (row.entry.kind !== "directory") {
      onOpenFile({ path: row.entry.path, line: 1 });
      return;
    }
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(row.entry.path)) next.delete(row.entry.path);
      else next.add(row.entry.path);
      return next;
    });
    if (
      row.entry.collapsed &&
      row.entry.children.length === 0 &&
      !loadingDirectories.has(row.entry.path)
    ) {
      const directoryPath = row.entry.path;
      setLoadingDirectories((current) => new Set(current).add(directoryPath));
      void scanWorkspaceSubtree(cwd, directoryPath)
        .then(({ entries, truncated }) => {
          function replaceChildren(
            currentEntries: WorkspaceSnapshot["entries"],
          ): WorkspaceSnapshot["entries"] {
            return currentEntries.map((entry) => {
              if (entry.path === directoryPath) {
                return {
                  ...entry,
                  collapsed: false,
                  children: entries,
                };
              }
              if (entry.children.length === 0) return entry;
              return { ...entry, children: replaceChildren(entry.children) };
            });
          }
          setSnapshot((current) => ({
            ...current,
            entries: replaceChildren(current.entries),
            truncated: current.truncated || truncated,
          }));
        })
        .finally(() => {
          setLoadingDirectories((current) => {
            const next = new Set(current);
            next.delete(directoryPath);
            return next;
          });
        });
    }
  };

  const chooseSearchResult = (index: number) => {
    const result = searchResults[index];
    if (!result) return;
    setSelectedSearchIndex(index);
    setSelectedPath(result.file);
    onOpenFile({
      path: result.file,
      line: result.line,
      column: result.column,
    });
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        if (focus === "filter" && filter) {
          filterRef.current = "";
          setFilter("");
        } else if (focus === "search" && searchQuery) {
          searchQueryRef.current = "";
          setSearchQuery("");
        } else onFocusChange("chat");
        return;
      }

      if (focus === "filter" || focus === "search") {
        const setValue = focus === "filter" ? setFilter : setSearchQuery;
        const valueRef =
          focus === "filter" ? filterRef : searchQueryRef;
        if (key.backspace || key.delete) {
          const next = valueRef.current.slice(0, -1);
          valueRef.current = next;
          setValue(next);
          setScrollOffset(0);
          return;
        }
        if (key.ctrl && input === "a") {
          valueRef.current = "";
          setValue("");
          setScrollOffset(0);
          return;
        }
        if (focus === "search" && (key.upArrow || key.downArrow)) {
          const direction = key.upArrow ? -1 : 1;
          const next = Math.max(
            0,
            Math.min(searchResults.length - 1, selectedSearchIndex + direction),
          );
          setSelectedSearchIndex(next);
          ensureVisible(next, searchVisibleResults, maxSearchOffset);
          return;
        }
        if (focus === "search" && key.return) {
          chooseSearchResult(selectedSearchIndex);
          return;
        }
        if (!key.ctrl && !key.meta && !key.tab && input) {
          const next =
            valueRef.current + input.replace(/[\r\n]/g, "");
          valueRef.current = next;
          setValue(next);
          setScrollOffset(0);
        }
        return;
      }

      if (focus !== "tree" || treeRows.length === 0) return;
      if (key.upArrow || key.downArrow) {
        const direction = key.upArrow ? -1 : 1;
        const next = Math.max(
          0,
          Math.min(treeRows.length - 1, selectedTreeIndex + direction),
        );
        setSelectedPath(treeRows[next].entry.path);
        ensureVisible(next, explorerVisibleRows, maxTreeOffset);
        return;
      }
      const selected = treeRows[selectedTreeIndex];
      if (key.return || key.rightArrow) {
        if (selected.entry.kind === "file") {
          onOpenFile({ path: selected.entry.path, line: 1 });
          return;
        }
        if (
          selected.entry.kind === "directory" &&
          !expanded.has(selected.entry.path)
        ) {
          toggleEntry(selected);
        }
        return;
      }
      if (key.leftArrow) {
        if (
          selected.entry.kind === "directory" &&
          expanded.has(selected.entry.path)
        ) {
          toggleEntry(selected);
          return;
        }
        const slash = selected.entry.path.lastIndexOf("/");
        if (slash !== -1) setSelectedPath(selected.entry.path.slice(0, slash));
      }
    },
    { isActive: active && focus !== "chat" },
  );

  const changedCount = gitStatuses.size;
  const visibleTreeRows = treeRows.slice(
    effectiveOffset,
    effectiveOffset + explorerVisibleRows,
  );
  const visibleSearchResults = searchResults.slice(
    effectiveOffset,
    effectiveOffset + searchVisibleResults,
  );

  return (
    <Box
      flexDirection="column"
      width={width}
      height="100%"
      flexShrink={0}
      borderStyle="single"
      border={["right"]}
      borderColor={COLORS.dim}
      backgroundColor="$orbcode.panel"
      shouldFill
      overflow="hidden"
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        if (focus === "chat") onFocusChange("tree");
      }}
      onMouseScroll={(event) => {
        if (!event.scroll) return;
        const direction = event.scroll.direction;
        if (direction !== "up" && direction !== "down") return;
        const maximum = panel === "explorer" ? maxTreeOffset : maxSearchOffset;
        setScrollOffset((current) =>
          Math.max(
            0,
            Math.min(
              maximum,
              current +
                (direction === "down" ? 1 : -1) *
                  Math.max(1, event.scroll!.delta) *
                  2,
            ),
          ),
        );
        event.stopPropagation();
        event.preventDefault();
      }}
    >
      <Box height={1} width="100%" paddingLeft={1}>
        <Text bold>{panel === "explorer" ? "EXPLORER" : "SEARCH"}</Text>
      </Box>
      <Box height={1} width="100%" paddingLeft={1}>
        <Box
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            onPanelChange("explorer");
            onFocusChange("tree");
            setScrollOffset(0);
          }}
        >
          <Text
            color={panel === "explorer" ? COLORS.accent : COLORS.dim}
            bold={panel === "explorer"}
          >
            FILES
          </Text>
        </Box>
        <Text color={COLORS.dim}> </Text>
        <Box
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            onPanelChange("search");
            onFocusChange("search");
            setScrollOffset(0);
          }}
        >
          <Text
            color={panel === "search" ? COLORS.accent : COLORS.dim}
            bold={panel === "search"}
          >
            SEARCH
          </Text>
        </Box>
        <Text color={COLORS.dim}>
          {changedCount > 0 ? `  Δ${changedCount}` : ""}
        </Text>
        <Box
          marginLeft={1}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            refresh();
          }}
        >
          <Text color={COLORS.dim}>↻</Text>
        </Box>
      </Box>

      {panel === "explorer" ? (
        <>
          <Box height={1} width="100%" paddingLeft={1}>
            <Text bold>▾ </Text>
            <Text
              color={terminalFolderIcon(snapshot.rootName, true).color}
              bold
            >
              {terminalFolderIcon(snapshot.rootName, true).glyph}
            </Text>
            <Text bold wrap="truncate">
              {" "}
              {truncate(snapshot.rootName.toUpperCase(), width - 6)}
            </Text>
          </Box>
          <TextInputRow
            value={filter}
            placeholder="Filter files (Ctrl+P)"
            focused={focus === "filter"}
            width={width}
            onActivate={() => onFocusChange("filter")}
          />
          <Box
            flexDirection="column"
            flexGrow={1}
            minHeight={0}
            overflow="hidden"
          >
            {visibleTreeRows.map((row) => {
              const isSelected = row.entry.path === selectedPath;
              const status = statusForEntry(row.entry, gitStatuses);
              const isExpanded =
                filter.trim().length > 0 || expanded.has(row.entry.path);
              const chevron =
                row.entry.kind === "directory"
                  ? loadingDirectories.has(row.entry.path)
                    ? "…"
                    : isExpanded
                      ? "▾"
                      : "▸"
                  : " ";
              const icon =
                row.entry.kind === "directory"
                  ? terminalFolderIcon(row.entry.path, isExpanded)
                  : terminalFileIcon(row.entry.path);
              const indent = " ".repeat(Math.min(12, row.depth * 2));
              const suffix = status ?? "";
              const nameWidth = Math.max(
                1,
                width - indent.length - suffix.length - 7,
              );
              return (
                <Box
                  key={row.entry.path}
                  height={1}
                  width="100%"
                  paddingLeft={1}
                  backgroundColor={
                    isSelected ? "$orbcode.selection" : undefined
                  }
                  onMouseDown={(event) => {
                    if (event.button !== 0) return;
                    event.stopPropagation();
                    toggleEntry(row);
                  }}
                >
                  <Text color={row.entry.collapsed ? COLORS.dim : undefined}>
                    {indent}
                    {chevron}{" "}
                  </Text>
                  <Text color={icon.color}>{icon.glyph}</Text>
                  <Text color={row.entry.collapsed ? COLORS.dim : undefined}>
                    {" "}
                    {truncate(row.entry.name, nameWidth)}
                  </Text>
                  {status && (
                    <Box marginLeft="auto">
                      <Text color={statusColor(status)} bold>
                        {suffix}
                      </Text>
                    </Box>
                  )}
                </Box>
              );
            })}
            {treeRows.length === 0 && (
              <Box paddingLeft={1}>
                <Text color={COLORS.dim}>
                  {snapshot.rootName ? "No matching files" : "Loading files…"}
                </Text>
              </Box>
            )}
          </Box>
          <Box height={1} width="100%" paddingLeft={1}>
            <Text color={COLORS.dim} wrap="truncate">
              {snapshot.truncated
                ? "Tree truncated · click ↻ to refresh"
                : focus === "tree"
                  ? "↑↓ navigate · Enter open"
                  : "Ctrl+Shift+F global search"}
            </Text>
          </Box>
        </>
      ) : (
        <>
          <TextInputRow
            value={searchQuery}
            placeholder="Search text (Ctrl+Shift+F)"
            focused={focus === "search"}
            width={width}
            onActivate={() => onFocusChange("search")}
          />
          <Box height={1} width="100%" paddingLeft={1}>
            <Text color={COLORS.dim} wrap="truncate">
              {searching
                ? "Searching…"
                : searchQuery
                  ? `${searchResults.length} result${searchResults.length === 1 ? "" : "s"}`
                  : "Search across workspace files"}
            </Text>
          </Box>
          <Box
            flexDirection="column"
            flexGrow={1}
            minHeight={0}
            overflow="hidden"
          >
            {visibleSearchResults.map((result, visibleIndex) => {
              const resultIndex = effectiveOffset + visibleIndex;
              const isSelected = resultIndex === selectedSearchIndex;
              const icon = terminalFileIcon(result.file);
              return (
                <Box
                  key={`${result.file}:${result.line}:${result.column}`}
                  flexDirection="column"
                  width="100%"
                  height={2}
                  paddingLeft={1}
                  backgroundColor={
                    isSelected ? "$orbcode.selection" : undefined
                  }
                  onMouseDown={(event) => {
                    if (event.button !== 0) return;
                    event.stopPropagation();
                    onFocusChange("search");
                    chooseSearchResult(resultIndex);
                  }}
                >
                  <Box width="100%" height={1}>
                    <Text color={icon.color}>{icon.glyph} </Text>
                    <Text color={COLORS.accent} wrap="truncate">
                      {truncate(
                        `${result.file}:${result.line}:${result.column}`,
                        width - 5,
                      )}
                    </Text>
                  </Box>
                  <Text color={COLORS.dim} wrap="truncate">
                    {truncate(result.text.trim(), width - 3)}
                  </Text>
                </Box>
              );
            })}
            {!searching && searchQuery && searchResults.length === 0 && (
              <Box paddingLeft={1}>
                <Text color={COLORS.dim}>No results</Text>
              </Box>
            )}
          </Box>
          <Box height={1} width="100%" paddingLeft={1}>
            <Text color={COLORS.dim} wrap="truncate">
              ↑↓ results · Enter select · Esc close
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}
