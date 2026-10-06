import assert from "node:assert/strict"
import { test } from "node:test"

import type { AxonModel } from "../src/api/models.js"
import {
	describeResumeCost,
	estimateResumeCost,
	formatIdle,
	formatTokens,
	PROMPT_CACHE_TTL_MS,
	shouldConfirmResume,
} from "../src/core/resumeCost.js"

const NOW = Date.parse("2026-10-06T12:00:00Z")
const MINUTE = 60_000

function model(overrides: Partial<AxonModel> = {}): AxonModel {
	return {
		id: "m",
		name: "M",
		description: "",
		contextWindow: 1_000_000,
		maxOutputTokens: 64_000,
		supportsImages: true,
		inputPrice: 0.000005,
		outputPrice: 0.000025,
		free: false,
		...overrides,
	}
}

function session(minutesIdle: number, contextTokens: number) {
	return { updatedAt: new Date(NOW - minutesIdle * MINUTE).toISOString(), contextTokens }
}

const share = (weeklyPercentage: number) => ({ weeklyPercentage, monthlyPercentage: weeklyPercentage / 2 })

test("a warm cache needs no confirmation", () => {
	const estimate = estimateResumeCost(session(4, 800_000), model(), share(30), "pro", NOW)
	assert.equal(estimate, null)
	assert.equal(shouldConfirmResume(estimate), false)
	assert.notEqual(estimateResumeCost(session(PROMPT_CACHE_TTL_MS / MINUTE, 800_000), model(), share(30), "pro", NOW), null)
})

test("a cold resume reports the backend's weekly share", () => {
	const estimate = estimateResumeCost(session(24 * 60 + 77, 785_000), model(), share(21.6), "pro", NOW)
	assert.ok(estimate)
	assert.equal(estimate.percent, 21.6)
	assert.equal(estimate.window, "weekly")
	assert.equal(shouldConfirmResume(estimate), true)
	assert.equal(describeResumeCost(estimate), "use about 22% of your weekly usage limit")
})

test("lite plans call the (mirrored) window monthly", () => {
	const estimate = estimateResumeCost(session(30, 500_000), model(), share(12.5), "lite", NOW)
	assert.equal(estimate!.window, "monthly")
	assert.equal(describeResumeCost(estimate!), "use about 13% of your monthly usage limit")
})

test("plan-billed models never fall back to a dollar figure", () => {
	// Backend unreachable: no share. Big context still asks, without a $ amount.
	const estimate = estimateResumeCost(session(60, 150_000), model(), undefined, "pro", NOW)
	assert.equal(shouldConfirmResume(estimate), true)
	assert.equal(describeResumeCost(estimate!), "re-read the full context without the prompt cache")
	assert.equal(shouldConfirmResume(estimateResumeCost(session(60, 50_000), model(), undefined, "pro", NOW)), false)
})

test("own-provider-key models report dollars and ignore plan shares", () => {
	const estimate = estimateResumeCost(session(30, 100_000), model({ provider: "anthropic" }), share(40), "pro", NOW)
	assert.equal(estimate!.percent, undefined)
	assert.equal(describeResumeCost(estimate!), "cost about $0.50")
})

test("large cold contexts always ask, showing even a small share", () => {
	// 115k tokens on a cheap model: 0.2% of the week, still worth a prompt.
	const estimate = estimateResumeCost(session(60, 115_227), model(), share(0.2), "pro_plus", NOW)
	assert.equal(shouldConfirmResume(estimate), true)
	assert.equal(describeResumeCost(estimate!), "use about <1% of your weekly usage limit")
})

test("smaller cold contexts ask only when the share is significant", () => {
	assert.equal(shouldConfirmResume(estimateResumeCost(session(60, 50_000), model(), share(0.4), "pro", NOW)), false)
	assert.equal(shouldConfirmResume(estimateResumeCost(session(60, 50_000), model(), share(2), "pro", NOW)), true)
})

test("while the share loads, the prompt says so", () => {
	const estimate = estimateResumeCost(session(60, 150_000), model(), undefined, "pro", NOW)!
	assert.equal(
		describeResumeCost(estimate, true),
		"re-read the full context without the prompt cache (checking your usage…)",
	)
})

test("formatting", () => {
	assert.equal(formatIdle((24 * 60 + 77) * MINUTE), "1d 1h 17m")
	assert.equal(formatIdle(185 * MINUTE), "3h 5m")
	assert.equal(formatIdle(42 * MINUTE), "42m")
	assert.equal(formatIdle(24 * 60 * MINUTE), "1d 0h 0m")
	assert.equal(formatTokens(785_123), "785k")
	assert.equal(formatTokens(1_234_567), "1.2M")
	assert.equal(formatTokens(950), "950")
})
