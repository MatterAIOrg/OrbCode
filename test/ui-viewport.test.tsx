import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { Box, Text } from "../src/ui/primitives.js";
import { TranscriptViewport } from "../src/ui/components/TranscriptViewport.js";

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
