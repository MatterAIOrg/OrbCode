import { fetchProfile, type AxonCodeWindowUsage } from "../auth/auth.js";
import { getAuthToken, loadSettings } from "../config/settings.js";

/**
 * `orbcode usage` — print plan usage windows and per-model usage.
 *
 * Shows the weekly/monthly plan windows and each tracked OSS model's share
 * of the shared plan pool as percentages (no credit amounts are exposed by
 * the backend for public consumption).
 */

const BAR_WIDTH = 20;

function bar(percentage: number): string {
  const filled = Math.round(
    (Math.max(0, Math.min(100, percentage)) / 100) * BAR_WIDTH,
  );
  return "[" + "█".repeat(filled) + " ".repeat(BAR_WIDTH - filled) + "]";
}

function formatPercentage(value: number | undefined): string {
  return `${Math.max(0, Math.min(100, value || 0)).toFixed(1)}%`;
}

function formatReset(iso: string | undefined): string {
  if (!iso) return "";
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return "";
  const diff = target - Date.now();
  if (diff <= 0) return "resets now";
  const sec = Math.floor(diff / 1000);
  const min = Math.floor(sec / 60);
  const hrs = Math.floor(min / 60);
  const days = Math.floor(hrs / 24);
  if (days >= 1) return `resets in ${days}d ${hrs % 24}h`;
  if (hrs >= 1) return `resets in ${hrs}h ${min % 60}m`;
  if (min >= 1) return `resets in ${min}m`;
  return "resets soon";
}

function printWindow(
  label: string,
  window: AxonCodeWindowUsage | undefined,
): void {
  if (!window) return;
  const reset = formatReset(window.resetsAt);
  console.log(
    `  ${label.padEnd(8)} ${formatPercentage(window.percentage).padStart(6)} used ${bar(window.percentage)}  ${reset}`,
  );
}

/** Handle `orbcode usage`. Returns the process exit code. */
export async function runUsageCommand(): Promise<number> {
  const settings = loadSettings();
  const token = getAuthToken(settings);
  if (!token) {
    console.error("Not logged in. Run `orbcode login` first.");
    return 1;
  }

  let profile;
  try {
    profile = await fetchProfile(token);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }

  const tiered = profile.tieredUsage;
  console.log(`Plan usage${profile.plan ? ` (${profile.plan})` : ""}`);
  if (tiered) {
    printWindow("Weekly", tiered.weekly);
    printWindow("Monthly", tiered.monthly);
  } else if (profile.usagePercentage !== undefined) {
    printWindow("Monthly", {
      used: 0,
      limit: 0,
      remaining: 0,
      percentage: profile.usagePercentage,
      resetsAt: profile.creditsResetDate ?? "",
      windowStart: "",
    });
  } else {
    console.log("  No usage data available.");
  }

  const modelUsage = profile.modelUsage ?? [];
  console.log("");
  if (modelUsage.length === 0) {
    console.log("Model usage: none recorded in this cycle yet.");
    return 0;
  }

  console.log("Model usage (share of the shared plan pool)");
  for (const entry of modelUsage) {
    const name = entry.model.padEnd(34);
    const multiplier = `${entry.multiplier}x cost`.padEnd(9);
    console.log(
      `  ${name} ${multiplier} weekly ${formatPercentage(entry.weeklyPercentage).padStart(6)}  monthly ${formatPercentage(entry.monthlyPercentage).padStart(6)}`,
    );
  }
  return 0;
}
