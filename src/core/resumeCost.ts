import type { AxonModel } from "../api/models.js"
import type { UsageEstimate } from "../auth/auth.js"
import type { SessionData } from "./sessions.js"

/**
 * How long the gateway keeps a conversation's prompt prefix cached. OrbCode
 * doesn't send `x-axon-extended-cache`, so the backend's 5-minute default
 * applies; Anthropic's prompt cache (direct `provider: "anthropic"`) also
 * defaults to 5 minutes. Past this, the next turn re-reads the whole context
 * at the uncached input price.
 */
export const PROMPT_CACHE_TTL_MS = 5 * 60_000

/** Ask before a cold resume that costs at least this share of the plan window… */
export const RESUME_CONFIRM_MIN_PERCENT = 1

/** …and before any cold resume this large, whatever it costs (slow and wasteful to re-read). */
export const RESUME_CONFIRM_MIN_TOKENS = 100_000

export interface ResumeCostEstimate {
	idleMs: number
	contextTokens: number
	/** Uncached input cost of the first resumed turn in USD, at the model's catalog price. */
	cost: number
	/** Whether that turn draws from the plan (vs. the user's own provider key). */
	billsPlan: boolean
	/** Plan-window share of that turn, from the backend's estimate. */
	percent?: number
	window?: "weekly" | "monthly"
}

/** Models served through the MatterAI gateway draw from the plan; BYO-key providers don't. */
export function billsPlan(model: AxonModel): boolean {
	return !model.provider || model.provider === "matterai" || model.provider === "axon"
}

/**
 * Estimate what the first turn of a resumed session will cost once its prompt
 * cache has expired. `share` is the backend's plan-window estimate for that
 * many uncached tokens (the profile API exposes percentages, not credit
 * limits, so the share can't be derived locally). Returns null when the cache
 * is still warm or the session holds no context.
 */
export function estimateResumeCost(
	session: Pick<SessionData, "updatedAt" | "contextTokens">,
	model: AxonModel,
	share?: UsageEstimate,
	plan?: string,
	now = Date.now(),
): ResumeCostEstimate | null {
	const idleMs = now - Date.parse(session.updatedAt)
	const contextTokens = session.contextTokens ?? 0
	if (!Number.isFinite(idleMs) || idleMs < PROMPT_CACHE_TTL_MS || contextTokens <= 0) return null
	const onPlan = billsPlan(model)
	const cost = contextTokens * model.inputPrice
	const estimate: ResumeCostEstimate = { idleMs, contextTokens, cost, billsPlan: onPlan }
	if (onPlan && share) {
		// Lite plans have no separate weekly allowance (the backend mirrors the
		// monthly limit into the weekly window), so call it monthly there.
		estimate.percent = share.weeklyPercentage
		estimate.window = plan === "lite" ? "monthly" : "weekly"
	}
	return estimate
}

/**
 * Whether to confirm a cold resume: always for a large context, otherwise
 * only when the plan share (known once the backend answers) is significant.
 */
export function shouldConfirmResume(estimate: ResumeCostEstimate | null): estimate is ResumeCostEstimate {
	if (!estimate) return false
	return (
		estimate.contextTokens >= RESUME_CONFIRM_MIN_TOKENS ||
		(estimate.percent ?? 0) >= RESUME_CONFIRM_MIN_PERCENT
	)
}

/** `1d 1h 17m`, `3h 5m`, `42m`. */
export function formatIdle(ms: number): string {
	const totalMinutes = Math.max(0, Math.floor(ms / 60_000))
	const days = Math.floor(totalMinutes / 1440)
	const hours = Math.floor((totalMinutes % 1440) / 60)
	const minutes = totalMinutes % 60
	const parts: string[] = []
	if (days) parts.push(`${days}d`)
	if (days || hours) parts.push(`${hours}h`)
	parts.push(`${minutes}m`)
	return parts.join(" ")
}

/** `785k`, `1.2M`, `950`. */
export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
	return String(tokens)
}

/** The sentence after "Resuming it will…", e.g. "use about 22% of your weekly usage limit". */
export function describeResumeCost(estimate: ResumeCostEstimate, estimating = false): string {
	if (estimate.percent !== undefined) {
		const pct = estimate.percent < 1 ? "<1" : String(Math.round(estimate.percent))
		return `use about ${pct}% of your ${estimate.window} usage limit`
	}
	// Your own provider key: there's no plan window, so show what it'll bill.
	if (!estimate.billsPlan && estimate.cost > 0) {
		return `cost about $${estimate.cost < 0.01 ? "0.01" : estimate.cost.toFixed(2)}`
	}
	return estimating
		? "re-read the full context without the prompt cache (checking your usage…)"
		: "re-read the full context without the prompt cache"
}
