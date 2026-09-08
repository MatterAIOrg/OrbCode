import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { useSelectionHandler } from "@opentui/react";

import { Box, Text } from "../src/ui/primitives.js";
import { InputBox } from "../src/ui/components/InputBox.js";
import { ScrollToBottomChip } from "../src/ui/components/ScrollToBottomChip.js";
import { Toast } from "../src/ui/components/Toast.js";
import { copyToClipboard } from "../src/utils/clipboard.js";
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
    { anchorToBottom: true, marginTop: -1 },
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

test("treats a raw linefeed as Shift+Enter in the composer", async () => {
  let submittedText: string | undefined;
  const screen = await testRender(
    <InputBox
      active
      width={80}
      slashCommands={[]}
      onSubmit={(prompt) => {
        submittedText = prompt.text;
      }}
      supportsImages
    />,
    { width: 80, height: 8, kittyKeyboard: true },
  );

  try {
    await act(async () => {
      await screen.mockInput.typeText("first");
      await screen.mockInput.pressKeys(["LINEFEED"]);
      await screen.mockInput.typeText("second");
      screen.mockInput.pressEnter();
      await screen.flush();
    });

    assert.equal(submittedText, "first\nsecond");
  } finally {
    act(() => screen.renderer.destroy());
  }
});

test("collapses multiline and large pastes into paste chips to avoid terminal overflow", async () => {
  let submittedText = "";
  const screen = await testRender(
    <InputBox
      active
      width={80}
      slashCommands={[]}
      onSubmit={(val) => {
        submittedText = typeof val === "string" ? val : val.text;
      }}
      supportsImages={false}
    />,
    { width: 80, height: 24 },
  );

  try {
    await screen.renderOnce();
    await act(async () => {
      screen.mockInput.pasteBracketedText("line 1\nline 2\nline 3\nline 4\nline 5");
      await new Promise((r) => setTimeout(r, 50));
      await screen.flush();
    });

    const frame = screen.captureCharFrame();
    assert.match(frame, /📋 line 1 line 2/);

    await act(async () => {
      screen.mockInput.pressEnter();
      await screen.flush();
    });

    assert.equal(submittedText, "line 1\nline 2\nline 3\nline 4\nline 5");
  } finally {
    act(() => screen.renderer.destroy());
  }
});

test("renders scroll-to-bottom chip when scrolled up in a task and clears on click", async () => {
  function TaskView() {
    const [scrollOffset, setScrollOffset] = useState(10);
    const inTask = true;
    const bottomControlsHeight = 3;
    return (
      <Box flexDirection="column" width={60} height={15} position="relative">
        <Box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
          <Text>Transcript content</Text>
        </Box>
        <Box height={bottomControlsHeight} borderStyle="round">
          <Text>Input</Text>
        </Box>
        {inTask && scrollOffset > 0 && (
          <Box
            position="absolute"
            bottom={bottomControlsHeight + 1}
            left={0}
            right={0}
            justifyContent="center"
            zIndex={10}
          >
            <ScrollToBottomChip
              scrollOffset={scrollOffset}
              width={60}
              onClick={() => setScrollOffset(0)}
            />
          </Box>
        )}
      </Box>
    );
  }

  const screen = await testRender(<TaskView />, { width: 60, height: 15 });
  try {
    await screen.renderOnce();
    let frame = screen.captureCharFrame();
    assert.match(frame, /↓ Scroll to bottom \(10\)/);

    // Click the chip
    await act(async () => {
      await screen.mockMouse.click(30, 9);
      await new Promise((r) => setTimeout(r, 50));
      await screen.flush();
    });

    frame = screen.captureCharFrame();
    assert.doesNotMatch(frame, /↓ Scroll to bottom/);
  } finally {
    act(() => screen.renderer.destroy());
  }
});

test("renders Toast component with success border and message", async () => {
  const screen = await testRender(
    <Toast message="✓ Text copied to clipboard" />,
    { width: 50, height: 5 },
  );
  try {
    await screen.renderOnce();
    const frame = screen.captureCharFrame();
    assert.match(frame, /✓ Text copied to clipboard/);
  } finally {
    act(() => screen.renderer.destroy());
  }
});

test("auto-copies selected text and displays toast notification on selection", async () => {
  let copiedText = "";
  function SelectionView() {
    const [toast, setToast] = useState<string | null>(null);
    useSelectionHandler((selection) => {
      const text = selection.getSelectedText();
      if (!text || text.trim().length === 0) return;
      copiedText = text;
      setToast("✓ Text copied to clipboard");
    });

    return (
      <Box flexDirection="column" width={60} height={10}>
        <Text>Selected sample text for clipboard</Text>
        {toast && (
          <Box position="absolute" top={1} right={2} zIndex={150}>
            <Toast message={toast} />
          </Box>
        )}
      </Box>
    );
  }

  const screen = await testRender(<SelectionView />, { width: 60, height: 10 });
  try {
    await screen.renderOnce();
    let frame = screen.captureCharFrame();
    assert.doesNotMatch(frame, /✓ Text copied/);

    // Select text by dragging across the line
    await act(async () => {
      await screen.mockMouse.drag(0, 0, 15, 0);
      await new Promise((r) => setTimeout(r, 50));
      await screen.flush();
    });

    frame = screen.captureCharFrame();
    assert.match(frame, /✓ Text copied to clipboard/);
    assert.ok(copiedText.length > 0);
  } finally {
    act(() => screen.renderer.destroy());
  }
});

test("copyToClipboard invokes OSC 52 on the renderer when provided", () => {
  let oscText = "";
  const mockRenderer = {
    copyToClipboardOSC52(text: string) {
      oscText = text;
      return true;
    },
  };
  const result = copyToClipboard("hello clipboard", mockRenderer);
  assert.equal(result, true);
  assert.equal(oscText, "hello clipboard");
});

test("renders Working spinner below streaming response text while busy", async () => {
  function StreamingView({
    busy,
    busyLabel,
    streamingText,
  }: {
    busy: boolean;
    busyLabel: string;
    streamingText: string;
  }) {
    const spinnerVisible = busy;
    return (
      <Box flexDirection="column" width={60} height={10}>
        {streamingText && (
          <Box marginTop={1}>
            <Text>
              <Text>● </Text>
              {streamingText}
            </Text>
          </Box>
        )}
        {spinnerVisible && (
          <Box marginTop={1}>
            <Spinner key={busyLabel} label={busyLabel} showTip />
          </Box>
        )}
      </Box>
    );
  }

  const screen = await testRender(
    <StreamingView
      busy={true}
      busyLabel="Working"
      streamingText="Streaming response content..."
    />,
    { width: 60, height: 10 },
  );

  try {
    await screen.renderOnce();
    const frame = screen.captureCharFrame();
    assert.match(frame, /● Streaming response content\.\.\./);
    assert.match(frame, /Working \(0s · esc to interrupt\)/);
  } finally {
    act(() => screen.renderer.destroy());
  }
});
