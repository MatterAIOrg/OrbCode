import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { ModelPicker } from "../src/ui/components/ModelPicker.js";
import type { GatewayEffort } from "../src/api/models.js";

async function renderPicker(currentId: string, modelEfforts?: Record<string, GatewayEffort>) {
  const picks: Array<[string, GatewayEffort | undefined]> = [];
  const screen = await testRender(
    <ModelPicker
      currentId={currentId}
      canUse400k
      canUseEidoBase
      canUseEidoPro
      canUseLumen
      modelEfforts={modelEfforts}
      onSelect={(id, effort) => picks.push([id, effort])}
      onCancel={() => {}}
    />,
    { width: 140, height: 40 },
  );
  return { screen, picks };
}

const press = async (screen: Awaited<ReturnType<typeof testRender>>, action: () => void) => {
  await act(async () => {
    action();
    await screen.flush();
  });
  await screen.renderOnce();
};

test("←/→ moves the effort for the highlighted model; enter saves both", async () => {
  const { screen, picks } = await renderPicker("zai/glm-5.3-flash");
  try {
    await screen.renderOnce();
    let frame = screen.captureCharFrame();
    assert.match(frame, /Effort Low · \[Medium\] · High · Max/);
    assert.match(frame, /←\/→ effort/);

    await press(screen, () => screen.mockInput.pressArrow("right"));
    await press(screen, () => screen.mockInput.pressArrow("right"));
    // Clamped at the top.
    await press(screen, () => screen.mockInput.pressArrow("right"));
    frame = screen.captureCharFrame();
    assert.match(frame, /Effort Low · Medium · High · \[Max\]/);

    await press(screen, () => screen.mockInput.pressArrow("left"));
    await press(screen, () => screen.mockInput.pressEnter());
    assert.deepEqual(picks, [["zai/glm-5.3-flash", "high"]]);
  } finally {
    act(() => screen.renderer.destroy());
  }
});

test("saved efforts are shown and models without the selector pick no effort", async () => {
  const { screen, picks } = await renderPicker("gpt-5.6-sol", { "zai/glm-5.3": "low" });
  try {
    await screen.renderOnce();
    const frame = screen.captureCharFrame();
    assert.match(frame, /GLM 5\.3 .*Low effort/);
    assert.doesNotMatch(frame, /←\/→ effort/);
    await press(screen, () => screen.mockInput.pressEnter());
    assert.deepEqual(picks, [["gpt-5.6-sol", undefined]]);
  } finally {
    act(() => screen.renderer.destroy());
  }
});
