import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILTIN_AXON_MODELS,
  DEFAULT_MODEL_ID,
  canUse400kContext,
  canUseEidoBaseModels,
  canUseEidoProModels,
  canUseLumenModels,
  get232kAxonFallback,
  getGatewayModelId,
  is400kAxonModel,
  isEidoBaseAxonModel,
  isEidoProAxonModel,
  isLumenAxonModel,
} from "../src/api/models.js";

for (const tier of ["pro", "base"] as const) {
  test(`Axon Eido 3.2 ${tier} exposes default and 400k local options`, () => {
    const baseId =
      tier === "pro" ? "axon-eido-3.2-code-pro" : "axon-eido-3.2-code";
    const modelDefault = BUILTIN_AXON_MODELS[`${baseId}-232k`];
    const model400k = BUILTIN_AXON_MODELS[`${baseId}-400k`];

    assert.equal(modelDefault.contextWindow, 232000);
    assert.equal(model400k.contextWindow, 400000);
    assert.equal(getGatewayModelId(modelDefault), baseId);
    assert.equal(getGatewayModelId(model400k), baseId);

    const sharedMetadata = ({
      id: _id,
      name: _name,
      contextWindow: _contextWindow,
      ...metadata
    }: typeof modelDefault) => metadata;

    assert.deepEqual(sharedMetadata(modelDefault), sharedMetadata(model400k));
  });
}

test("Axon Auto is the default model", () => {
  assert.equal(DEFAULT_MODEL_ID, "axon-auto-232k");
});

test("400k context is limited to Pro Plus and Ultra plans", () => {
  for (const plan of ["Pro Plus", "pro_plus", "pro-plus", "ULTRA"]) {
    assert.equal(canUse400kContext(plan), true);
  }
  for (const plan of [undefined, "free", "Pro", "Enterprise"]) {
    assert.equal(canUse400kContext(plan), false);
  }
});

test("Axon Lumen 4 exposes 232k and 400k local options", () => {
  const baseId = "axon-lumen-4-code";
  const modelDefault = BUILTIN_AXON_MODELS[`${baseId}-232k`];
  const model400k = BUILTIN_AXON_MODELS[`${baseId}-400k`];

  assert.equal(modelDefault.contextWindow, 232000);
  assert.equal(model400k.contextWindow, 400000);
  assert.equal(getGatewayModelId(modelDefault), baseId);
  assert.equal(getGatewayModelId(model400k), baseId);
});

test("restricted Axon models map to their default-context variants", () => {
  assert.equal(is400kAxonModel("axon-eido-3.2-code-400k"), true);
  assert.equal(is400kAxonModel("axon-lumen-4-code-400k"), true);
  assert.equal(is400kAxonModel("third-party-model-400k"), false);
  assert.equal(
    get232kAxonFallback("axon-lumen-4-code-400k"),
    "axon-lumen-4-code-232k",
  );
  assert.equal(
    get232kAxonFallback("axon-eido-3.2-code-pro-400k"),
    "axon-eido-3.2-code-pro-232k",
  );
  assert.equal(
    get232kAxonFallback("axon-eido-3.2-code-400k"),
    "axon-eido-3.2-code-232k",
  );
});

test("Lumen models are limited to Pro Plus and Ultra plans", () => {
  for (const plan of ["Pro Plus", "pro_plus", "pro-plus", "ULTRA"]) {
    assert.equal(canUseLumenModels(plan), true);
  }
  for (const plan of [undefined, "free", "Pro", "Enterprise"]) {
    assert.equal(canUseLumenModels(plan), false);
  }
});

test("isLumenAxonModel identifies every Lumen variant", () => {
  assert.equal(isLumenAxonModel("axon-lumen-4-code-232k"), true);
  assert.equal(isLumenAxonModel("axon-lumen-4-code-400k"), true);
  assert.equal(isLumenAxonModel("axon-eido-3.2-code-pro-232k"), false);
  assert.equal(isLumenAxonModel("axon-eido-3.2-flash"), false);
});

test("Eido 3 Pro models are limited to Pro and above plans", () => {
  for (const plan of ["Pro", "pro", "Pro Plus", "pro_plus", "ULTRA"]) {
    assert.equal(canUseEidoProModels(plan), true);
  }
  for (const plan of [undefined, "free", "Enterprise"]) {
    assert.equal(canUseEidoProModels(plan), false);
  }
});

test("isEidoProAxonModel identifies every Eido Pro variant", () => {
  assert.equal(isEidoProAxonModel("axon-eido-3.2-code-pro-232k"), true);
  assert.equal(isEidoProAxonModel("axon-eido-3.2-code-pro-400k"), true);
  assert.equal(isEidoProAxonModel("axon-eido-3.2-code-232k"), false);
  assert.equal(isEidoProAxonModel("axon-lumen-4-code-232k"), false);
});

test("Eido 3.2 Code (base) models are limited to Pro and above plans", () => {
  for (const plan of ["Pro", "pro", "Pro Plus", "pro_plus", "ULTRA"]) {
    assert.equal(canUseEidoBaseModels(plan), true);
  }
  for (const plan of [undefined, "free", "Enterprise"]) {
    assert.equal(canUseEidoBaseModels(plan), false);
  }
});

test("isEidoBaseAxonModel identifies base variants but not Pro", () => {
  assert.equal(isEidoBaseAxonModel("axon-eido-3.2-code-232k"), true);
  assert.equal(isEidoBaseAxonModel("axon-eido-3.2-code-400k"), true);
  assert.equal(isEidoBaseAxonModel("axon-eido-3.2-code-pro-232k"), false);
  assert.equal(isEidoBaseAxonModel("axon-eido-3.2-code-pro-400k"), false);
  assert.equal(isEidoBaseAxonModel("axon-eido-3.2-flash"), false);
  assert.equal(isEidoBaseAxonModel("axon-lumen-4-code-232k"), false);
  assert.equal(isEidoBaseAxonModel("axon-auto-232k"), false);
});

test("the 232K Flash is the only option unlocked on the Free plan", () => {
  // Every other built-in Axon id must be locked on Free: Code/Code Pro
  // through the Base/Pro gates, Lumen through the Lumen gate, every 400K
  // variant (including Flash-400K) through the 400K gate.
  assert.equal(is400kAxonModel("axon-eido-3.2-flash-400k"), true);
  for (const id of [
    "axon-eido-3.2-code-232k",
    "axon-eido-3.2-code-400k",
    "axon-eido-3.2-code-pro-232k",
    "axon-eido-3.2-code-pro-400k",
    "axon-eido-3.2-flash-400k",
    "axon-lumen-4-code-232k",
    "axon-lumen-4-code-400k",
    "axon-auto-400k",
  ]) {
    const lockedOnFree =
      (is400kAxonModel(id) && !canUse400kContext("free")) ||
      (isEidoBaseAxonModel(id) && !canUseEidoBaseModels("free")) ||
      (isEidoProAxonModel(id) && !canUseEidoProModels("free")) ||
      (isLumenAxonModel(id) && !canUseLumenModels("free"));
    assert.equal(lockedOnFree, true, `${id} must be locked on the Free plan`);
  }
  // And the 232K Flash itself is the exception: no plan gate applies, so it
  // stays unlocked on Free.
  assert.equal(isEidoBaseAxonModel("axon-eido-3.2-flash"), false);
  assert.equal(isEidoProAxonModel("axon-eido-3.2-flash"), false);
  assert.equal(isLumenAxonModel("axon-eido-3.2-flash"), false);
  assert.equal(is400kAxonModel("axon-eido-3.2-flash"), false);
});
