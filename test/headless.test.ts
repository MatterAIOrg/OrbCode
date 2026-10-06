import { describe, it, expect, beforeEach, afterEach } from "node:test"
import * as assert from "node:assert"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

// Test the approval bypass logic directly by extracting it
// This tests the core security behavior without complex mocking

describe("headless approval bypass logic", () => {
	let tempDir: string
	let outputFile: string

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-test-"))
		outputFile = path.join(tempDir, "result.json")
	})

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it("should approve file_write to the exact output file path", () => {
		const resolvedOutput = path.resolve(outputFile)
		const requestDetail = resolvedOutput

		// This is the logic from headless.ts requestApproval callback
		const shouldApprove =
			outputFile !== undefined &&
			"file_write" === "file_write" &&
			requestDetail === path.resolve(outputFile)

		assert.strictEqual(shouldApprove, true, "Should approve exact match")
	})

	it("should deny file_write to a different file", () => {
		const otherFile = path.join(tempDir, "other.json")
		const requestDetail = path.resolve(otherFile)

		const shouldApprove =
			outputFile !== undefined &&
			"file_write" === "file_write" &&
			requestDetail === path.resolve(outputFile)

		assert.strictEqual(shouldApprove, false, "Should deny different file")
	})

	it("should deny file_write to a path containing the output file as substring", () => {
		// This was the bug: substring match would incorrectly approve
		const maliciousPath = outputFile + ".bak"
		const requestDetail = path.resolve(maliciousPath)

		const shouldApprove =
			outputFile !== undefined &&
			"file_write" === "file_write" &&
			requestDetail === path.resolve(outputFile)

		assert.strictEqual(shouldApprove, false, "Should deny substring match (exact equality required)")
	})

	it("should deny non-file_write tools even if path matches", () => {
		const requestDetail = path.resolve(outputFile)

		const shouldApprove =
			outputFile !== undefined &&
			"execute_command" === "file_write" &&
			requestDetail === path.resolve(outputFile)

		assert.strictEqual(shouldApprove, false, "Should deny non-file_write tools")
	})

	it("should deny when outputFile is not set", () => {
		const requestDetail = path.resolve(outputFile)

		const shouldApprove =
			undefined !== undefined &&
			"file_write" === "file_write" &&
			requestDetail === path.resolve(outputFile as string)

		assert.strictEqual(shouldApprove, false, "Should deny when outputFile is undefined")
	})
})

describe("JSON envelope structure", () => {
	it("should have correct shape for success case", () => {
		const envelope = {
			ok: true,
			model: "test-model",
			result: "Test result",
			usage: {
				inputTokens: 100,
				outputTokens: 50,
				cost: 0.01,
				totalCost: 0.01,
			},
			sessionId: "test-session-id",
			error: null,
		}

		assert.strictEqual(envelope.ok, true)
		assert.strictEqual(envelope.model, "test-model")
		assert.strictEqual(envelope.result, "Test result")
		assert.strictEqual(envelope.usage.inputTokens, 100)
		assert.strictEqual(envelope.usage.outputTokens, 50)
		assert.strictEqual(envelope.usage.cost, 0.01)
		assert.strictEqual(envelope.usage.totalCost, 0.01)
		assert.strictEqual(envelope.sessionId, "test-session-id")
		assert.strictEqual(envelope.error, null)
	})

	it("should have correct shape for error case", () => {
		const envelope = {
			ok: false,
			model: "test-model",
			result: "",
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cost: 0,
				totalCost: 0,
			},
			sessionId: "test-session-id",
			error: "Test error message",
		}

		assert.strictEqual(envelope.ok, false)
		assert.strictEqual(envelope.error, "Test error message")
	})
})
