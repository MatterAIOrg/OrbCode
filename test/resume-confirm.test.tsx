import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { ResumeConfirm, type ResumeDecision } from "../src/ui/components/ResumeConfirm.js";

test("resume confirm explains the cold-cache cost and defaults to Resume", async () => {
  const decisions: ResumeDecision[] = [];
  const screen = await testRender(
    <ResumeConfirm
      estimate={{
        idleMs: (24 * 60 + 77) * 60_000,
        contextTokens: 785_000,
        cost: 4.4,
        billsPlan: true,
        percent: 22,
        window: "weekly",
      }}
      onDecision={(d) => decisions.push(d)}
      onCancel={() => {}}
    />,
    { width: 140, height: 12 },
  );
  try {
    await screen.renderOnce();
    const frame = screen.captureCharFrame();
    assert.match(frame, /Resume this conversation\?/);
    assert.match(frame, /inactive for 1d 1h 17m and is 785k tokens long/);
    assert.match(frame, /22% of your weekly usage limit/);
    assert.match(frame, /❯ 1\. Resume/);
    assert.match(frame, /2\. Start a new conversation/);

    await act(async () => {
      screen.mockInput.pressArrow("down");
      await screen.flush();
    });
    await act(async () => {
      screen.mockInput.pressEnter();
      await screen.flush();
    });
    assert.deepEqual(decisions, ["new"]);
  } finally {
    act(() => screen.renderer.destroy());
  }
});
