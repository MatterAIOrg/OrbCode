import React from "react";
import { Box, Text } from "ink";

import { COLORS } from "../../branding.js";
import { getModel } from "../../api/models.js";
import type { AxonCodeTieredUsage } from "../../auth/auth.js";

export type ApprovalMode = "ask" | "edits" | "auto";

const MODE_LABELS: Record<ApprovalMode, string> = {
  ask: "⏵ ask before changes",
  edits: "⏵⏵ accept edits on",
  auto: "⏵⏵⏵ auto-approve on",
};

function formatRelativeTime(isoStr?: string): string {
  if (!isoStr) return "???";
  const now = Date.now();
  const target = new Date(isoStr).getTime();
  if (Number.isNaN(target)) return "???";
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
  title?: string;
  plan?: string;
  usagePercentage?: number;
  tieredUsage?: AxonCodeTieredUsage;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/**
 * Formats the 5hr window as "5hr limit XX% · resets <relative>".
 * Returns null when tiered usage is unavailable so the line can be hidden.
 */
function fiveHourSummary(tu: AxonCodeTieredUsage | undefined): string | null {
  if (!tu?.fiveHour) return null;
  const { percentage, resetsAt } = tu.fiveHour;
  return `5hr limit ${Math.round(percentage)}% · resets ${formatRelativeTime(resetsAt)}`;
}

export function StatusBar({
  modelId,
  contextTokens,
  totalCost: _totalCost,
  state,
  approvalMode,
  busy,
  title,
  plan: _plan,
  usagePercentage: _usagePercentage,
  tieredUsage,
}: StatusBarProps) {
  const model = getModel(modelId);
  const contextPct = Math.min(
    100,
    Math.round((contextTokens / model.contextWindow) * 100),
  );
  const fiveHourLine = fiveHourSummary(tieredUsage);
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text dimColor>
          <Text color={approvalMode === "ask" ? undefined : COLORS.warning}>
            {MODE_LABELS[approvalMode]}
          </Text>
          {" (shift+tab to cycle)"}
          {busy && " · esc to interrupt"}
          {state ? <Text color={COLORS.thinking}> · {state}</Text> : null}
        </Text>
        <Text dimColor>
          {title ? `${truncate(title, 32)} · ` : ""}
          {model.name} · ctx {contextTokens.toLocaleString()} ({contextPct}%)
        </Text>
      </Box>
      {fiveHourLine && (
        <Box justifyContent="flex-end">
          <Text dimColor>{fiveHourLine}</Text>
        </Box>
      )}
    </Box>
  );
}
