import assert from "node:assert/strict"
import test from "node:test"

import {
  BUILTIN_AXON_MODELS,
  get232kAxonFallback,
  getGatewayModelId,
  is400kAxonModel,
} from "../src/api/models.js"

test("Axon Auto exposes 232K and 400K dynamic-pricing choices", () => {
	const autoDefault = BUILTIN_AXON_MODELS["axon-auto-232k"]
	const auto400k = BUILTIN_AXON_MODELS["axon-auto-400k"]

	assert.equal(autoDefault.contextWindow, 232_000)
	assert.equal(auto400k.contextWindow, 400_000)
	assert.equal(autoDefault.pricingLabel, "dynamic pricing")
	assert.equal(auto400k.pricingLabel, "dynamic pricing")
	assert.equal(autoDefault.free, false)
	assert.equal(auto400k.free, false)
	assert.equal(getGatewayModelId(autoDefault), "axon-auto")
	assert.equal(getGatewayModelId(auto400k), "axon-auto")
})

test("Auto 400K uses the existing extended-context gate and fallback", () => {
	assert.equal(is400kAxonModel("axon-auto-400k"), true)
	assert.equal(is400kAxonModel("axon-auto-232k"), false)
	assert.equal(get232kAxonFallback("axon-auto-400k"), "axon-auto-232k")
})

test("Axon Eido 3.2 Flash exposes a 400K variant through the same gates", () => {
	const flash400k = BUILTIN_AXON_MODELS["axon-eido-3.2-flash-400k"]

	assert.equal(flash400k.contextWindow, 400_000)
	assert.equal(flash400k.maxOutputTokens, 64_000)
	assert.equal(getGatewayModelId(flash400k), "axon-eido-3.2-flash")
	assert.equal(is400kAxonModel("axon-eido-3.2-flash-400k"), true)
	assert.equal(is400kAxonModel("axon-eido-3.2-flash"), false)
	// The default-tier Flash option uses the bare id (no "-232k" suffix), so the
	// fallback must map to that exact id rather than the generic -232k form.
	assert.equal(get232kAxonFallback("axon-eido-3.2-flash-400k"), "axon-eido-3.2-flash")
})
