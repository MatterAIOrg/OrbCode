import React, { useState } from "react";
import * as os from "node:os";
import { Box, Text } from "../primitives.js";
import { COLORS } from "../../branding.js";
import {
  readBackgroundOutputTail,
  type BackgroundCommand,
} from "../../tools/executors/backgroundCommands.js";

/** Shells shown before the panel collapses into a "… N more" line. */
const MAX_VISIBLE = 4;
/** Each shell renders a title row, a metadata row and an output-tail row. */
const LINES_PER_SHELL = 3;
const STOP_TAG = "[stop]";
const COLLAPSE_TAG = "[collapse]";

function fit(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 1) return text.slice(0, Math.max(0, maxWidth));
  return text.slice(0, maxWidth - 1) + "…";
}

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function shortenPath(p: string): string {
  const home = os.homedir();
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

function lastOutputLine(id: string): string {
  const lines = readBackgroundOutputTail(id, 2048)
    // Progress bars redraw with \r; keep only the latest frame.
    .split(/\r?\n/)
    .map((line) => line.split("\r").pop() ?? "")
    .map((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/** Status-bar label for the running shells, e.g. "2 shells running". */
export function backgroundShellsLabel(count: number): string {
  return `${count} shell${count === 1 ? "" : "s"} running`;
}

/** Rows the expanded panel occupies, for the bottom-stack height budget. */
export function backgroundShellsHeight(count: number): number {
  if (count === 0) return 0;
  const visible = Math.min(MAX_VISIBLE, count);
  // header + shells + overflow line + bottom margin
  return 1 + visible * LINES_PER_SHELL + (count > MAX_VISIBLE ? 1 : 0) + 1;
}

export interface BackgroundShellsProps {
  shells: BackgroundCommand[];
  width: number;
  onStop: (id: string) => void;
  onCollapse: () => void;
}

/** Expanded view of the running background shells started by the agent,
 *  each with a stop action. Collapsed, they show as a count in the status
 *  bar; finished shells drop out (the agent is told about them instead). */
export function BackgroundShells({
  shells,
  width,
  onStop,
  onCollapse,
}: BackgroundShellsProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const now = Date.now();
  const header = `Background shells (${shells.length}) · ctrl+b to collapse`;

  return (
    <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
      <Box flexDirection="row">
        <Text color={COLORS.dim} bold>
          {fit(header, Math.max(8, width - COLLAPSE_TAG.length - 2))}
        </Text>
        <Text
          color={hovered === "__collapse" ? COLORS.accent : COLORS.primary}
          bold={hovered === "__collapse"}
          selectable={false}
          onMouseDown={(event) => {
            event.stopPropagation?.();
            onCollapse();
          }}
          onMouseMove={(event) => {
            event.stopPropagation?.();
            if (hovered !== "__collapse") setHovered("__collapse");
          }}
        >
          {` ${COLLAPSE_TAG}`}
        </Text>
      </Box>
      {shells.slice(0, MAX_VISIBLE).map((shell) => {
        const isHovered = hovered === shell.id;
        const prefix = "● ";
        const suffix = ` · ${formatElapsed(now - shell.startedAt)}`;
        const commandWidth = Math.max(
          8,
          width - 4 - prefix.length - suffix.length - STOP_TAG.length,
        );
        const meta = [
          shell.pid ? `pid ${shell.pid}` : null,
          shortenPath(shell.cwd),
          shell.id,
        ]
          .filter(Boolean)
          .join(" · ");
        const output = lastOutputLine(shell.id);

        return (
          <Box key={shell.id} flexDirection="column">
            <Box flexDirection="row">
              <Text color={COLORS.warning}>{prefix}</Text>
              <Text color={isHovered ? COLORS.accent : undefined} bold>
                {fit(shell.command.replace(/\s*\n\s*/g, " ↵ "), commandWidth)}
              </Text>
              <Text color={COLORS.dim}>{suffix}</Text>
              <Text
                color={isHovered ? COLORS.accent : COLORS.error}
                bold={isHovered}
                selectable={false}
                onMouseDown={(event) => {
                  event.stopPropagation?.();
                  onStop(shell.id);
                }}
                onMouseMove={(event) => {
                  event.stopPropagation?.();
                  if (hovered !== shell.id) setHovered(shell.id);
                }}
              >
                {` ${STOP_TAG}`}
              </Text>
            </Box>
            <Text color={COLORS.dim} wrap="truncate">
              {fit(`  ${meta}`, width - 2)}
            </Text>
            <Text color={COLORS.dim} italic wrap="truncate">
              {fit(`  ${output ? `› ${output}` : "(no output yet)"}`, width - 2)}
            </Text>
          </Box>
        );
      })}
      {shells.length > MAX_VISIBLE && (
        <Text color={COLORS.dim}>
          {` … ${shells.length - MAX_VISIBLE} more`}
        </Text>
      )}
    </Box>
  );
}
