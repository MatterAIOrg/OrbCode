import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { EffortPicker, effortSliderLayout, type EffortScope } from "../src/ui/components/EffortPicker.js";
import type { GatewayEffort } from "../src/api/models.js";

const LEVELS: GatewayEffort[] = ["low", "medium", "high", "max"];

test("slider layout pins the ends and puts the marker over the selected label", () => {
  const { width, starts, line } = effortSliderLayout(LEVELS, 2);
  assert.equal(starts[0], 0);
  assert.equal(starts[3] + "max".length, width);
  assert.equal(line.length, width);
  // ▲ sits inside the "high" label's span.
  const marker = line.indexOf("▲");
  assert.ok(marker >= starts[2] && marker < starts[2] + "high".length);
});

async function renderPicker(current: GatewayEffort) {
  const picks: Array<[GatewayEffort, EffortScope]> = [];
  let cancelled = false;
  const screen = await testRender(
    <EffortPicker
      modelName="GLM 5.3"
      levels={LEVELS}
      current={current}
      onSelect={(effort, scope) => picks.push([effort, scope])}
      onCancel={() => {
        cancelled = true;
      }}
    />,
    { width: 100, height: 12 },
  );
  const press = async (action: () => void) => {
    await act(async () => {
      action();
      await screen.flush();
    });
    await screen.renderOnce();
  };
  return { screen, picks, press, wasCancelled: () => cancelled };
}

test("renders Faster/Smarter, the track and the levels; ←/→ then Enter saves", async () => {
  const { screen, picks, press } = await renderPicker("medium");
  try {
    await screen.renderOnce();
    const frame = screen.captureCharFrame();
    assert.match(frame, /Effort · GLM 5\.3/);
    assert.match(frame, /Faster\s+Smarter/);
    assert.match(frame, /─+▲─+/);
    assert.match(frame, /low\s+medium\s+high\s+max/);
    assert.match(frame, /←\/→ to adjust · Enter to confirm · s for this session only · Esc to cancel/);

    await press(() => screen.mockInput.pressArrow("right"));
    await press(() => screen.mockInput.pressArrow("right"));
    await press(() => screen.mockInput.pressArrow("right")); // clamped at max
    await press(() => screen.mockInput.pressEnter());
    assert.deepEqual(picks, [["max", "saved"]]);
  } finally {
    act(() => screen.renderer.destroy());
  }
});

test("s applies to this session only; Esc cancels", async () => {
  const first = await renderPicker("high");
  try {
    await first.screen.renderOnce();
    await first.press(() => first.screen.mockInput.pressArrow("left"));
    await first.press(() => first.screen.mockInput.pressKey("s"));
    assert.deepEqual(first.picks, [["medium", "session"]]);
  } finally {
    act(() => first.screen.renderer.destroy());
  }

  const second = await renderPicker("low");
  try {
    await second.screen.renderOnce();
    await second.press(() => second.screen.mockInput.pressEscape());
    // A lone Esc is held back briefly in case it starts an escape sequence.
    await second.press(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    await second.press(() => {});
    assert.equal(second.wasCancelled(), true);
    assert.deepEqual(second.picks, []);
  } finally {
    act(() => second.screen.renderer.destroy());
  }
});
