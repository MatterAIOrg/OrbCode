import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import React, { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { Box, Text } from "../src/ui/primitives.js";
import { InputBox } from "../src/ui/components/InputBox.js";
import { EditorSidebar } from "../src/ui/components/EditorSidebar.js";
import { FileViewer } from "../src/ui/components/FileViewer.js";
import { PaneResizeHandle } from "../src/ui/components/PaneResizeHandle.js";
import {
  Spinner,
  TIP_DELAY_MS,
} from "../src/ui/components/Spinner.js";
import {
  getTranscriptPlacement,
  TranscriptViewport,
} from "../src/ui/components/TranscriptViewport.js";

const execFileAsync = promisify(execFile);

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

test("expands editor directories with a mouse click", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "orbcode-sidebar-"));
  await fs.mkdir(path.join(cwd, "src"));
  await fs.writeFile(path.join(cwd, "src", "index.ts"), "export {}");
  let openedPath = "";
  const screen = await testRender(
    <EditorSidebar
      cwd={cwd}
      width={34}
      height={12}
      active
      panel="explorer"
      focus="tree"
      refreshKey={0}
      onPanelChange={() => {}}
      onFocusChange={() => {}}
      onOpenFile={(file) => {
        openedPath = file.path;
      }}
    />,
    { width: 34, height: 12 },
  );

  try {
    await screen.renderOnce();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await screen.flush();
    });
    await screen.renderOnce();
    assert.match(screen.captureCharFrame(), /▸  src/);
    assert.doesNotMatch(screen.captureCharFrame(), /index\.ts/);
    const srcRow = screen
      .captureCharFrame()
      .split("\n")
      .findIndex((row) => row.includes("▸  src"));
    assert.notEqual(srcRow, -1);

    await act(async () => {
      await screen.mockMouse.click(10, srcRow);
      await screen.flush();
    });
    await screen.renderOnce();
    assert.match(screen.captureCharFrame(), /▾  src/);
    assert.match(screen.captureCharFrame(), / index\.ts/);
    assert.doesNotMatch(screen.captureCharFrame(), /TS index\.ts/);
    const fileRow = screen
      .captureCharFrame()
      .split("\n")
      .findIndex((row) => row.includes("index.ts"));
    assert.notEqual(fileRow, -1);

    await act(async () => {
      await screen.mockMouse.click(8, fileRow);
      await screen.flush();
    });
    assert.equal(openedPath, "src/index.ts");
  } finally {
    act(() => screen.renderer.destroy());
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("opens a searched line in the middle-pane file viewer", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "orbcode-viewer-ui-"));
  const source = Array.from(
    { length: 24 },
    (_, index) => `const line${index + 1} = ${index + 1};`,
  ).join("\n");
  await fs.writeFile(path.join(cwd, "source.ts"), source);
  const screen = await testRender(
    <FileViewer
      cwd={cwd}
      file={{ path: "source.ts", line: 18 }}
      width={42}
      height={10}
      active
      focused
      refreshKey={0}
      onFocus={() => {}}
      onClose={() => {}}
    />,
    { width: 42, height: 10 },
  );

  try {
    await screen.renderOnce();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await screen.flush();
    });
    await screen.renderOnce();
    assert.match(screen.captureCharFrame(), / source\.ts/);
    assert.match(screen.captureCharFrame(), /18 │const line18 = 18;/);
    assert.match(screen.captureCharFrame(), /Ln 18\/24/);
    assert.doesNotMatch(screen.captureCharFrame(), /1 │const line1 = 1;/);
  } finally {
    act(() => screen.renderer.destroy());
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("highlights Git-changed lines in the file viewer", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "orbcode-viewer-diff-"));
  try {
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.name", "OrbCode Test"], {
      cwd,
    });
    await execFileAsync(
      "git",
      ["config", "user.email", "orbcode@example.invalid"],
      { cwd },
    );
    await fs.writeFile(
      path.join(cwd, "changed.ts"),
      "const stable = true;\nconst before = true;\n",
    );
    await execFileAsync("git", ["add", "changed.ts"], { cwd });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd });
    await fs.writeFile(
      path.join(cwd, "changed.ts"),
      "const stable = true;\nconst changed = true;\n",
    );

    const screen = await testRender(
      <FileViewer
        cwd={cwd}
        file={{ path: "changed.ts", line: 1 }}
        width={42}
        height={8}
        active
        focused
        refreshKey={0}
        onFocus={() => {}}
        onClose={() => {}}
      />,
      { width: 42, height: 8 },
    );

    try {
      await screen.renderOnce();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await screen.flush();
      });
      await screen.renderOnce();
      assert.match(screen.captureCharFrame(), /2 \+const changed = true;/);
      assert.match(screen.captureCharFrame(), /1 changed/);
      assert.match(screen.captureCharFrame(), /1 │const stable = true;/);
    } finally {
      act(() => screen.renderer.destroy());
    }
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("opens global-search results at their matching line", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "orbcode-search-ui-"));
  await fs.writeFile(path.join(cwd, "result.ts"), "first\nfind-this\nthird");
  let openedFile: { path: string; line?: number } | undefined;
  const screen = await testRender(
    <EditorSidebar
      cwd={cwd}
      width={38}
      height={12}
      active
      panel="search"
      focus="search"
      refreshKey={0}
      onPanelChange={() => {}}
      onFocusChange={() => {}}
      onOpenFile={(file) => {
        openedFile = file;
      }}
    />,
    { width: 38, height: 12 },
  );

  try {
    await screen.renderOnce();
    await act(async () => {
      await screen.mockInput.typeText("find-this");
      await screen.flush();
    });
    await screen.renderOnce();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await screen.flush();
    });
    await screen.renderOnce();
    assert.match(screen.captureCharFrame(), / result\.ts:2:1/);
    const resultRow = screen
      .captureCharFrame()
      .split("\n")
      .findIndex((row) => row.includes("result.ts:2:1"));
    assert.notEqual(resultRow, -1);

    await act(async () => {
      await screen.mockMouse.click(8, resultRow);
      await screen.flush();
    });
    assert.deepEqual(openedFile, {
      path: "result.ts",
      line: 2,
      column: 1,
    });
  } finally {
    act(() => screen.renderer.destroy());
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("resizes editor panes by drag or wheel and resets by right-click", async () => {
  let resizedBy = 0;
  let reset = false;
  let lastDragX: number | null = null;
  const screen = await testRender(
    <Box
      flexDirection="row"
      width={30}
      height={4}
      onMouseDrag={(event) => {
        if (lastDragX === null) return;
        resizedBy += event.x - lastDragX;
        lastDragX = event.x;
      }}
      onMouseDragEnd={() => {
        lastDragX = null;
      }}
    >
      <Box width={10} height="100%" backgroundColor="#111111" shouldFill />
      <PaneResizeHandle
        onDragStart={(x) => {
          lastDragX = x;
        }}
        onResize={(delta) => {
          resizedBy += delta;
        }}
        onReset={() => {
          reset = true;
        }}
      />
      <Box flexGrow={1} height="100%" backgroundColor="#222222" shouldFill />
    </Box>,
    { width: 30, height: 4 },
  );

  try {
    await screen.renderOnce();
    await act(async () => {
      await screen.mockMouse.drag(10, 1, 15, 1);
      await screen.flush();
    });
    assert.equal(resizedBy, 5);

    await act(async () => {
      await screen.mockMouse.scroll(10, 1, "up");
      await screen.flush();
    });
    assert.equal(resizedBy, 7);

    await act(async () => {
      await screen.mockMouse.click(10, 1, 2);
      await screen.flush();
    });
    assert.equal(reset, true);
  } finally {
    act(() => screen.renderer.destroy());
  }
});
