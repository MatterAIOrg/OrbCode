import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import type { RewindMode, RewindPoint } from "../src/core/checkpoints.js";
import { RewindPicker } from "../src/ui/components/RewindPicker.js";

const points: RewindPoint[] = [
  { id: "a", text: "add a login form", changedFiles: ["/w/login.tsx", "/w/app.tsx"] },
  { id: "b", text: "explain the router", changedFiles: ["/w/app.tsx"] },
  { id: "c", text: "just chatting", changedFiles: [] },
];

async function renderPicker() {
  const selected: [string, RewindMode][] = [];
  let cancelled = 0;
  const screen = await testRender(
    <RewindPicker
      points={points}
      onSelect={(point, mode) => selected.push([point.id, mode])}
      onCancel={() => cancelled++}
    />,
    { width: 100, height: 20 },
  );
  const press = async (key: "pressArrow" | "pressEnter" | "pressEscape", arg?: "up" | "down") => {
    await act(async () => {
      if (key === "pressArrow") screen.mockInput.pressArrow(arg!);
      else screen.mockInput[key]();
      // A lone Esc is held back briefly in case it starts an escape sequence.
      if (key === "pressEscape") await new Promise((resolve) => setTimeout(resolve, 100));
      await screen.flush();
    });
    await screen.renderOnce();
  };
  return { screen, selected, press, cancelled: () => cancelled };
}

test("rewind picker lists user messages with their code changes and a current row", async () => {
  const { screen } = await renderPicker();
  try {
    await screen.renderOnce();
    const frame = screen.captureCharFrame();
    assert.match(frame, /Restore the code and\/or conversation/);
    assert.match(frame, /add a login form/);
    assert.match(frame, /2 files changed/);
    assert.match(frame, /1 file changed/);
    assert.match(frame, /No code changes/);
    assert.match(frame, /❯ \(current\)/);
  } finally {
    act(() => screen.renderer.destroy());
  }
});

test("a message with no code changes rewinds the conversation straight away", async () => {
  const { screen, selected, press } = await renderPicker();
  try {
    await screen.renderOnce();
    await press("pressArrow", "up"); // current -> "just chatting"
    await press("pressEnter");
    assert.deepEqual(selected, [["c", "conversation"]]);
  } finally {
    act(() => screen.renderer.destroy());
  }
});

test("a message with code changes asks what to restore", async () => {
  const { screen, selected, press } = await renderPicker();
  try {
    await screen.renderOnce();
    await press("pressArrow", "up");
    await press("pressArrow", "up"); // "explain the router"
    await press("pressEnter");
    const frame = screen.captureCharFrame();
    assert.match(frame, /Restore code and conversation/);
    assert.match(frame, /Restore conversation/);
    assert.match(frame, /Restore code\b/);
    assert.match(frame, /Never mind/);
    assert.deepEqual(selected, []);

    await press("pressArrow", "down"); // -> Restore conversation
    await press("pressEnter");
    assert.deepEqual(selected, [["b", "conversation"]]);
  } finally {
    act(() => screen.renderer.destroy());
  }
});

test("escape steps back from the restore menu, then cancels the picker", async () => {
  const { screen, press, cancelled } = await renderPicker();
  try {
    await screen.renderOnce();
    await press("pressArrow", "up");
    await press("pressArrow", "up");
    await press("pressEnter");
    assert.match(screen.captureCharFrame(), /Never mind/);
    await press("pressEscape");
    assert.doesNotMatch(screen.captureCharFrame(), /Never mind/);
    assert.equal(cancelled(), 0);
    await press("pressEscape");
    assert.equal(cancelled(), 1);
  } finally {
    act(() => screen.renderer.destroy());
  }
});

test("prompt: double Esc on an empty prompt opens rewind, and a rewind prefills the message", async () => {
  const { InputBox } = await import("../src/ui/components/InputBox.js");
  let doubleEscapes = 0;
  const props = {
    active: true,
    width: 80,
    slashCommands: [],
    onSubmit: () => {},
    supportsImages: false,
    onDoubleEscape: () => doubleEscapes++,
  };
  const screen = await testRender(<InputBox {...props} prefill={null} />, { width: 80, height: 8 });
  const escape = async () => {
    await act(async () => {
      screen.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await screen.flush();
    });
  };
  try {
    await screen.renderOnce();
    await escape();
    assert.equal(doubleEscapes, 0);
    await escape();
    assert.equal(doubleEscapes, 1);

    await act(async () => {
      await screen.mockInput.typeText("draft");
      await screen.flush();
    });
    await escape(); // clears the draft instead of counting as the first Esc
    await escape();
    assert.equal(doubleEscapes, 1);
  } finally {
    act(() => screen.renderer.destroy());
  }

  const second = await testRender(
    <InputBox {...props} prefill={{ id: 1, text: "add a login form" }} />,
    { width: 80, height: 8 },
  );
  try {
    await second.renderOnce();
    await act(async () => {
      await second.flush();
    });
    await second.renderOnce();
    assert.match(second.captureCharFrame(), /add a login form/);
  } finally {
    act(() => second.renderer.destroy());
  }
});
