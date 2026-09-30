import assert from "node:assert/strict"
import test from "node:test"

import {
  get232kAxonFallback,
  is400kAxonModel,
} from "../src/api/models.js"

test("Auto 400K uses the existing extended-context gate and fallback", () => {
	assert.equal(is400kAxonModel("axon-auto-400k"), true)
	assert.equal(is400kAxonModel("axon-auto-232k"), false)
	assert.equal(get232kAxonFallback("axon-auto-400k"), "axon-auto-232k")
})
