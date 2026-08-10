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

test("Axon Eido 3 Flash exposes a 400K variant through the same gates", () => {
	const flash400k = BUILTIN_AXON_MODELS["axon-eido-3-flash-400k"]

	assert.equal(flash400k.contextWindow, 400_000)
	assert.equal(flash400k.maxOutputTokens, 64_000)
	assert.equal(getGatewayModelId(flash400k), "axon-eido-3-flash")
	assert.equal(is400kAxonModel("axon-eido-3-flash-400k"), true)
	assert.equal(is400kAxonModel("axon-eido-3-flash"), false)
	// The 200K Flash option uses the bare id (no "-200k" suffix), so the
	// fallback must map to that exact id rather than the generic -200k form.
	assert.equal(get200kAxonFallback("axon-eido-3-flash-400k"), "axon-eido-3-flash")
})
