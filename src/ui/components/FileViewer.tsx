import React, { useEffect, useMemo, useRef, useState } from "react";

import { COLORS } from "../../branding.js";
import { Box, Text, useInput } from "../primitives.js";
import { terminalFileIcon } from "../editor/fileIcons.js";
import {
  readGitChangedLines,
  readWorkspaceFile,
  type WorkspaceFileContent,
} from "../editor/workspace.js";

export interface EditorFileSelection {
  path: string;
  line?: number;
  column?: number;
}

interface FileViewerProps {
  cwd: string;
  file: EditorFileSelection;
  width: number;
  height: number;
  active: boolean;
  focused: boolean;
  refreshKey?: unknown;
  onFocus: () => void;
  onClose: () => void;
}

function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth === 1) return "…";
  return `${text.slice(0, maxWidth - 1)}…`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function expandTabs(line: string): string {
  let column = 0;
  let expanded = "";
  for (const character of line) {
    if (character === "\t") {
      const spaces = 2 - (column % 2);
      expanded += " ".repeat(spaces);
      column += spaces;
    } else {
      expanded += character;
      column += 1;
    }
  }
  return expanded;
}

function codeColor(line: string): string | undefined {
  const trimmed = line.trimStart();
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("#")
  ) {
    return COLORS.dim;
  }
  if (
    /^(import|export|interface|type|class|function|const|let|var)\b/.test(
      trimmed,
    )
  ) {
    return COLORS.accent;
  }
  return undefined;
}

export function FileViewer({
  cwd,
  file,
  width,
  height,
  active,
  focused,
  refreshKey,
  onFocus,
  onClose,
}: FileViewerProps) {
  const [content, setContent] = useState<WorkspaceFileContent | null>(null);
  const [changedLines, setChangedLines] = useState<Set<number>>(
    () => new Set(),
  );
  const [activeLine, setActiveLine] = useState(Math.max(1, file.line ?? 1));
  const [scrollOffset, setScrollOffset] = useState(0);
  const [horizontalOffset, setHorizontalOffset] = useState(0);
  const loadGeneration = useRef(0);
  const activeLineRef = useRef(activeLine);
  const selectionKeyRef = useRef("");
  const bodyHeight = Math.max(1, height - 2);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    const selectionKey = `${file.path}:${file.line ?? 1}:${file.column ?? 1}`;
    const selectionChanged = selectionKeyRef.current !== selectionKey;
    selectionKeyRef.current = selectionKey;
    const requestedLine = selectionChanged
      ? Math.max(1, file.line ?? 1)
      : activeLineRef.current;
    setContent(null);
    setChangedLines(new Set());
    if (selectionChanged) {
      setHorizontalOffset(
        Math.max(
          0,
          (file.column ?? 1) -
            1 -
            Math.floor(Math.max(1, width - 8) / 3),
        ),
      );
    }
    void readWorkspaceFile(cwd, file.path).then((nextContent) => {
      if (generation !== loadGeneration.current) return;
      setContent(nextContent);
      if (nextContent.kind !== "text") {
        setActiveLine(1);
        setScrollOffset(0);
        return;
      }
      const line = Math.max(
        1,
        Math.min(nextContent.lines.length, requestedLine),
      );
      activeLineRef.current = line;
      setActiveLine(line);
      setScrollOffset(
        Math.max(
          0,
          Math.min(
            Math.max(0, nextContent.lines.length - bodyHeight),
            line - 1 - Math.floor(bodyHeight / 2),
          ),
        ),
      );
      void readGitChangedLines(
        cwd,
        file.path,
        nextContent.lines.length -
          (nextContent.lines.at(-1) === "" ? 1 : 0),
      ).then((nextChangedLines) => {
        if (generation === loadGeneration.current) {
          setChangedLines(nextChangedLines);
        }
      });
    });
    return () => {
      loadGeneration.current += 1;
    };
  }, [cwd, file.path, file.line, file.column, refreshKey]);

  useEffect(() => {
    activeLineRef.current = activeLine;
  }, [activeLine]);

  const lines = content?.kind === "text" ? content.lines : [];
  const maxScrollOffset = Math.max(0, lines.length - bodyHeight);
  const effectiveScrollOffset = Math.min(scrollOffset, maxScrollOffset);
  const lineNumberWidth = Math.max(2, String(Math.max(1, lines.length)).length);
  const codeWidth = Math.max(1, width - lineNumberWidth - 4);
  const maxLineWidth = useMemo(
    () =>
      lines.reduce(
        (longest, line) => Math.max(longest, expandTabs(line).length),
        0,
      ),
    [lines],
  );
  const maxHorizontalOffset = Math.max(0, maxLineWidth - codeWidth);
  const effectiveHorizontalOffset = Math.min(
    horizontalOffset,
    maxHorizontalOffset,
  );
  const visibleLines = lines.slice(
    effectiveScrollOffset,
    effectiveScrollOffset + bodyHeight,
  );
  const fileIcon = terminalFileIcon(file.path);

  const ensureLineVisible = (line: number) => {
    setScrollOffset((current) => {
      if (line - 1 < current) return line - 1;
      if (line > current + bodyHeight) {
        return Math.min(maxScrollOffset, line - bodyHeight);
      }
      return Math.min(current, maxScrollOffset);
    });
  };

  const moveActiveLine = (delta: number) => {
    if (lines.length === 0) return;
    const next = Math.max(1, Math.min(lines.length, activeLine + delta));
    setActiveLine(next);
    ensureLineVisible(next);
  };

  useInput(
    (input, key) => {
      if (key.escape || (key.ctrl && input === "w")) {
        onClose();
        return;
      }
      if (key.upArrow) {
        moveActiveLine(-1);
        return;
      }
      if (key.downArrow) {
        moveActiveLine(1);
        return;
      }
      if (key.pageUp) {
        moveActiveLine(-bodyHeight);
        return;
      }
      if (key.pageDown) {
        moveActiveLine(bodyHeight);
        return;
      }
      if (key.leftArrow) {
        setHorizontalOffset((current) => Math.max(0, current - 4));
        return;
      }
      if (key.rightArrow) {
        setHorizontalOffset((current) =>
          Math.min(maxHorizontalOffset, current + 4),
        );
      }
    },
    { isActive: active && focused },
  );

  return (
    <Box
      flexDirection="column"
      width={width}
      height="100%"
      flexShrink={0}
      borderStyle="single"
      border={["right"]}
      borderColor={focused ? COLORS.accent : COLORS.dim}
      backgroundColor="$orbcode.background"
      shouldFill
      overflow="hidden"
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        onFocus();
      }}
      onMouseScroll={(event) => {
        if (!event.scroll) return;
        const direction = event.scroll.direction;
        if (direction !== "up" && direction !== "down") return;
        setScrollOffset((current) =>
          Math.max(
            0,
            Math.min(
              maxScrollOffset,
              current +
                (direction === "down" ? 1 : -1) *
                  Math.max(1, event.scroll!.delta) *
                  3,
            ),
          ),
        );
        event.stopPropagation();
        event.preventDefault();
        onFocus();
      }}
    >
      <Box
        width="100%"
        height={1}
        paddingLeft={1}
        backgroundColor="$orbcode.panelRaised"
      >
        <Text color={fileIcon.color}>{fileIcon.glyph} </Text>
        <Text color={COLORS.accent} wrap="truncate">
          {truncate(file.path, Math.max(1, width - 7))}
        </Text>
        <Box
          marginLeft="auto"
          paddingRight={1}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            onClose();
          }}
        >
          <Text color={COLORS.dim}>×</Text>
        </Box>
      </Box>

      <Box
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        overflow="hidden"
      >
        {!content && (
          <Box paddingLeft={2} paddingTop={1}>
            <Text color={COLORS.dim}>Loading file…</Text>
          </Box>
        )}
        {content?.kind === "error" && (
          <Box flexDirection="column" paddingX={2} paddingTop={1}>
            <Text color={COLORS.error} bold>
              Unable to open file
            </Text>
            <Text color={COLORS.dim}>{content.message}</Text>
          </Box>
        )}
        {content?.kind === "binary" && (
          <Box flexDirection="column" paddingX={2} paddingTop={1}>
            <Text bold>Binary file preview unavailable</Text>
            <Text color={COLORS.dim}>{formatBytes(content.size)}</Text>
          </Box>
        )}
        {content?.kind === "text" &&
          visibleLines.map((line, visibleIndex) => {
            const lineNumber = effectiveScrollOffset + visibleIndex + 1;
            const selected = lineNumber === activeLine;
            const changed = changedLines.has(lineNumber);
            const expandedLine = expandTabs(line);
            const shownLine = expandedLine.slice(
              effectiveHorizontalOffset,
              effectiveHorizontalOffset + codeWidth,
            );
            return (
              <Box
                key={lineNumber}
                width="100%"
                height={1}
                backgroundColor={
                  changed
                    ? COLORS.diffAddedBackground
                    : selected
                      ? "$orbcode.selection"
                      : undefined
                }
                onMouseDown={(event) => {
                  if (event.button !== 0) return;
                  event.stopPropagation();
                  onFocus();
                  setActiveLine(lineNumber);
                }}
              >
                <Text
                  color={
                    changed
                      ? COLORS.success
                      : selected
                        ? COLORS.accent
                        : COLORS.dim
                  }
                  bold={selected}
                >
                  {String(lineNumber).padStart(lineNumberWidth)}
                  {changed ? " +" : " │"}
                </Text>
                <Text
                  color={changed ? COLORS.success : codeColor(line)}
                  wrap="truncate"
                >
                  {shownLine}
                </Text>
              </Box>
            );
          })}
      </Box>

      <Box
        width="100%"
        height={1}
        paddingLeft={1}
        backgroundColor="$orbcode.panelRaised"
      >
        <Text color={COLORS.dim} wrap="truncate">
          {content?.kind === "text"
            ? `Ln ${activeLine}/${lines.length}${changedLines.size > 0 ? ` · ${changedLines.size} changed` : ""}${effectiveHorizontalOffset > 0 ? ` · Col ${effectiveHorizontalOffset + 1}` : ""}${content.truncated ? " · preview truncated" : ""}`
            : content?.kind === "binary"
              ? `${formatBytes(content.size)} · binary`
              : focused
                ? "Esc close"
                : "Click to focus"}
        </Text>
      </Box>
    </Box>
  );
}
