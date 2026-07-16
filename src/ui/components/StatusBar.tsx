import { execFileSync } from "node:child_process";
import React, { useMemo } from "react";
import { Box, Text } from "../primitives.js";

import { COLORS } from "../../branding.js";
import { getModel } from "../../api/models.js";
import type {
  AxonCodeTieredUsage,
  AxonCodeWindowUsage,
} from "../../auth/auth.js";

export type ApprovalMode = "ask" | "edits" | "auto";

const MODE_LABELS: Record<ApprovalMode, string> = {
  ask: "⏵ ask before changes",
  edits: "⏵⏵ accept edits on",
  auto: "⏵⏵⏵ auto-approve on",
};

const MODE_COLORS: Record<ApprovalMode, string | undefined> = {
  ask: COLORS.primary,
  edits: COLORS.warning,
  auto: COLORS.success,
};

function formatRelativeTime(isoStr?: string): string {
  if (!isoStr) return "on session start";
  const now = Date.now();
  const target = new Date(isoStr).getTime();
  if (Number.isNaN(target)) return "on session start";
  const diff = target - now;
  if (diff <= 0) return "now";
  const sec = Math.floor(diff / 1000);
  const min = Math.floor(sec / 60);
  const hrs = Math.floor(min / 60);
  const days = Math.floor(hrs / 24);
  if (days >= 1) return `${days}d`;
  if (hrs >= 1) return `${hrs}h${min % 60 > 0 ? ` ${min % 60}m` : ""}`;
  if (min >= 1) return `${min}m`;
  return "soon";
}

interface StatusBarProps {
  modelId: string;
  contextTokens: number;
  totalCost: number;
  state: string;
  approvalMode: ApprovalMode;
  busy: boolean;
  exitConfirmationActive: boolean;
  title?: string;
  plan?: string;
  usagePercentage?: number;
  tieredUsage?: AxonCodeTieredUsage;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function getCurrentBranch(): string | undefined {
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Picks the usage window that currently constrains the agent and formats it as
 * "<window> limit XX% · resets <relative>".
 *
 * The smallest window (weekly) is the one actively in use, so we show it by
 * default. We only escalate to a larger window once it has hit its cap (100%):
 * a capped larger window is the real blocker, since a smaller window resetting
 * won't unblock you until the larger one does. When several are capped, the
 * largest wins (it takes longest to recover).
 * Returns null when tiered usage is unavailable so the line can be hidden.
 */
function usageSummary(tu: AxonCodeTieredUsage | undefined): string | null {
  if (!tu) return null;
  // Largest-to-smallest, so `find` returns the largest capped window and the
  // last entry is the smallest available window.
  const windows: Array<{ label: string; usage?: AxonCodeWindowUsage }> = [
    { label: "monthly limit", usage: tu.monthly },
    { label: "weekly limit", usage: tu.weekly },
  ];
  const available = windows.filter(
    (w): w is { label: string; usage: AxonCodeWindowUsage } => Boolean(w.usage),
  );
  if (available.length === 0) return null;
  const binding =
    available.find((w) => w.usage.percentage >= 100) ??
    available[available.length - 1];
  const { percentage, resetsAt } = binding.usage;
  return `${binding.label} ${Math.round(percentage)}% · resets ${formatRelativeTime(resetsAt)}`;
}

export function StatusBar({
  modelId,
  contextTokens,
  totalCost: _totalCost,
  state,
  approvalMode,
  busy,
  exitConfirmationActive,
  title,
  plan: _plan,
  usagePercentage: _usagePercentage,
  tieredUsage,
}: StatusBarProps) {
  const model = getModel(modelId);
  // Refresh after each agent turn, which also catches branch switches made by
  // commands during that turn without spawning git for every streaming frame.
  const branch = useMemo(getCurrentBranch, [busy]);
  const contextPct = Math.min(
    100,
    Math.round((contextTokens / model.contextWindow) * 100),
  );
  const usageLine = usageSummary(tieredUsage);
  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="row" width="100%">
        <Box flexGrow={1} minWidth={0} overflow="hidden">
          {exitConfirmationActive ? (
            <Text color={COLORS.warning} bold wrap="truncate">
              Press Ctrl+D again to exit
              {branch && ` · ${truncate(branch, 24)}`}
            </Text>
          ) : (
            <Text color={COLORS.dim} wrap="truncate">
              <Text color={MODE_COLORS[approvalMode]} bold>
                {MODE_LABELS[approvalMode]}
              </Text>
              {" (⇧tab)"}
              {busy && " · esc to interrupt"}
              {branch && ` · ${truncate(branch, 24)}`}
            </Text>
          )}
        </Box>
        <Box
          flexShrink={0}
          maxWidth="60%"
          marginLeft={2}
          justifyContent="flex-end"
          overflow="hidden"
        >
          <Text color={COLORS.dim} wrap="truncate">
            {title ? `${truncate(title, 32)} · ` : ""}
            {model.name} · ctx {contextTokens.toLocaleString()} ({contextPct}%)
          </Text>
        </Box>
      </Box>
      {usageLine && (
        <Box flexDirection="row" width="100%" justifyContent="flex-end">
          <Text color={COLORS.dim} wrap="truncate">
            {usageLine}
          </Text>
        </Box>
      )}
    </Box>
  );
}
