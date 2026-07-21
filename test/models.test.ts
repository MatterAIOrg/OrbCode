import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILTIN_AXON_MODELS,
  DEFAULT_MODEL_ID,
  canUse400kContext,
  get200kAxonFallback,
  getGatewayModelId,
  is400kAxonModel,
} from "../src/api/models.js";

for (const tier of ["pro", "mini"] as const) {
  test(`Axon Eido 3 ${tier} exposes 200k and 400k local options`, () => {
    const baseId = `axon-eido-3-code-${tier}`;
    const model200k = BUILTIN_AXON_MODELS[`${baseId}-200k`];
    const model400k = BUILTIN_AXON_MODELS[`${baseId}-400k`];

    assert.equal(model200k.contextWindow, 200000);
    assert.equal(model400k.contextWindow, 400000);
    assert.equal(getGatewayModelId(model200k), baseId);
    assert.equal(getGatewayModelId(model400k), baseId);

    const sharedMetadata = ({
      id: _id,
      name: _name,
      contextWindow: _contextWindow,
      ...metadata
    }: typeof model200k) => metadata;

    assert.deepEqual(sharedMetadata(model200k), sharedMetadata(model400k));
  });
}

test("the 200k Mini option is the default", () => {
  assert.equal(DEFAULT_MODEL_ID, "axon-eido-3-code-mini-200k");
});

test("400k context is limited to Pro Plus and Ultra plans", () => {
  for (const plan of ["Pro Plus", "pro_plus", "pro-plus", "ULTRA"]) {
    assert.equal(canUse400kContext(plan), true);
  }
  for (const plan of [undefined, "free", "Pro", "Enterprise"]) {
    assert.equal(canUse400kContext(plan), false);
  }
});

test("restricted Axon models map to their 200k variants", () => {
  assert.equal(is400kAxonModel("axon-eido-3-code-mini-400k"), true);
  assert.equal(is400kAxonModel("third-party-model-400k"), false);
  assert.equal(
    get200kAxonFallback("axon-eido-3-code-pro-400k"),
    "axon-eido-3-code-pro-200k",
  );
});
