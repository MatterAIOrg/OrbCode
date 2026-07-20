import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { Box, Text } from "../src/ui/primitives.js";
import {
  Spinner,
  TIP_DELAY_MS,
} from "../src/ui/components/Spinner.js";
import {
  getTranscriptPlacement,
  TranscriptViewport,
} from "../src/ui/components/TranscriptViewport.js";

test("keeps initial actions directly below the intro", () => {
  assert.deepEqual(
    getTranscriptPlacement({
      contentHeight: 40,
      introHeaderOnly: false,
      introTopMargin: 2,
      scrollOffset: 0,
      transcriptHeight: 14,
    }),
    { anchorToBottom: false, marginTop: 2 },
  );
});

test("bottom-anchors only after the transcript exceeds the viewport", () => {
  assert.deepEqual(
    getTranscriptPlacement({
      contentHeight: 20,
      introHeaderOnly: false,
      introTopMargin: 2,
      scrollOffset: 0,
      transcriptHeight: 21,
    }),
    { anchorToBottom: true, marginTop: 0 },
  );
});

test("delays slash-command tips on the thinking indicator", async () => {
  const screen = await testRender(
    <Box flexDirection="column" width={100} height={3}>
      <Spinner label="Thinking" showTip />
    </Box>,
    { width: 100, height: 3 },
  );

  try {
    await screen.renderOnce();
    const frame = screen.captureCharFrame();

    assert.match(frame, /Thinking \(0s · esc to interrupt\)/);
    assert.doesNotMatch(frame, /└── TIP: /);
    assert.equal(TIP_DELAY_MS, 2_000);
  } finally {
    act(() => screen.renderer.destroy());
  }
});

test("keeps the wrapped live response above the composer", async () => {
  const finalResponse =
    "● Pushed to main as 51610d9. The local commits rebased cleanly onto the remote sitemap update and went up. Working tree is clean and in sync with origin/main.";
  const transcript = [
    "Execute Command git pull --rebase --autostash origin main && git push origin main",
    "From github.com:MatterAIOrg/matter-website",
    "branch main -> FETCH_HEAD",
    "Rebasing (1/1)",
    "Successfully rebased and updated refs/heads/main.",
    "To github.com:MatterAIOrg/matter-website.git",
    "fb0ac03..51610d9 main -> main",
    "… (7 lines)",
    finalResponse,
  ].join("\n");

  const screen = await testRender(
    <Box flexDirection="column" width={54} height={14}>
      <TranscriptViewport anchorToBottom>
        <Box flexDirection="column" flexShrink={0}>
          <Text>{transcript}</Text>
        </Box>
      </TranscriptViewport>
      <Box flexDirection="column" height={4} flexShrink={0}>
        <Text>{"INPUT\nSTATUS"}</Text>
      </Box>
    </Box>,
    { width: 54, height: 14 },
  );

  try {
    await screen.renderOnce();
    const rows = screen.captureCharFrame().split("\n");
    const finalRow = rows.findIndex((row) => row.includes("origin/main."));
    const composerRow = rows.findIndex((row) => row.includes("INPUT"));

    assert.notEqual(finalRow, -1);
    assert.notEqual(composerRow, -1);
    assert.equal(finalRow, composerRow - 1);
  } finally {
    act(() => screen.renderer.destroy());
  }
});
