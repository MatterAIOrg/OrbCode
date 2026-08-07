import assert from "node:assert/strict"
import test from "node:test"

import {
  BUILTIN_AXON_MODELS,
  get200kAxonFallback,
  getGatewayModelId,
  is400kAxonModel,
} from "../src/api/models.js"

test("Axon Auto exposes 200K and 400K dynamic-pricing choices", () => {
	const auto200k = BUILTIN_AXON_MODELS["axon-auto-200k"]
	const auto400k = BUILTIN_AXON_MODELS["axon-auto-400k"]

	assert.equal(auto200k.contextWindow, 200_000)
	assert.equal(auto400k.contextWindow, 400_000)
	assert.equal(auto200k.pricingLabel, "dynamic pricing")
	assert.equal(auto400k.pricingLabel, "dynamic pricing")
	assert.equal(auto200k.free, false)
	assert.equal(auto400k.free, false)
	assert.equal(getGatewayModelId(auto200k), "axon-auto")
	assert.equal(getGatewayModelId(auto400k), "axon-auto")
})

test("Auto 400K uses the existing extended-context gate and fallback", () => {
	assert.equal(is400kAxonModel("axon-auto-400k"), true)
	assert.equal(is400kAxonModel("axon-auto-200k"), false)
	assert.equal(get200kAxonFallback("axon-auto-400k"), "axon-auto-200k")
})
