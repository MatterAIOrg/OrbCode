import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { SessionPicker } from "../src/ui/components/SessionPicker.js";
import type { SessionData } from "../src/core/sessions.js";

function session(id: string, title: string, cwd: string, minutesAgo: number): SessionData {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return {
    id,
    cwd,
    model: "m",
    title,
    createdAt: at,
    updatedAt: at,
    totalCost: 0,
    contextTokens: 0,
    todos: "",
    gitBranch: "main",
    sizeBytes: 1782580,
    messages: [{ role: "user", content: "hi" }],
  } as SessionData;
}

const HERE = "/work/app";
const here = [session("a", "fix login bug", HERE, 5)];
const everywhere = [session("b", "billing refactor", "/work/billing-service", 1), ...here];

async function renderPicker(props: Partial<React.ComponentProps<typeof SessionPicker>>) {
  const selected: SessionData[] = [];
  const screen = await testRender(
    <SessionPicker
      sessions={here}
      allSessions={everywhere}
      cwd={HERE}
      onSelect={(s) => selected.push(s)}
      onCancel={() => {}}
      {...props}
    />,
    { width: 110, height: 20 },
  );
  return { screen, selected };
}

test("resume picker lists this directory first and Tab switches to all directories", async () => {
  const { screen, selected } = await renderPicker({});
  try {
    await screen.renderOnce();
    let frame = screen.captureCharFrame();
    assert.match(frame, /this directory/);
    assert.match(frame, /fix login bug/);
    assert.match(frame, /5 minutes ago · main · 1\.7MB/);
    assert.doesNotMatch(frame, /billing refactor/);
    assert.match(frame, /tab all directories/);

    await act(async () => {
      screen.mockInput.pressTab();
      await screen.flush();
    });
    await screen.renderOnce();
    frame = screen.captureCharFrame();
    assert.match(frame, /all directories/);
    assert.match(frame, /billing refactor/);
    // Sessions from other directories show where they live; local ones don't.
    assert.match(frame, /1 minute ago · main · 1\.7MB · \/work\/billing-service/);
    assert.doesNotMatch(frame, /\/work\/app/);
    // Entries are separated by a blank line.
    assert.match(frame, /billing-service\s*│\n│\s*│\n│\s+fix login bug/);

    await act(async () => {
      screen.mockInput.pressEnter();
      await screen.flush();
    });
    assert.deepEqual(selected.map((s) => s.id), ["b"]);
  } finally {
    act(() => screen.renderer.destroy());
  }
});

test("resume picker opens on all directories when this directory has no sessions", async () => {
  const { screen } = await renderPicker({ sessions: [], initialShowAll: true });
  try {
    await screen.renderOnce();
    const frame = screen.captureCharFrame();
    assert.match(frame, /all directories/);
    assert.match(frame, /billing refactor/);
  } finally {
    act(() => screen.renderer.destroy());
  }
});

test("pickers without allSessions keep the old single-list behavior", async () => {
  const { screen } = await renderPicker({ allSessions: undefined });
  try {
    await screen.renderOnce();
    const frame = screen.captureCharFrame();
    assert.doesNotMatch(frame, /directories|tab /);
    assert.match(frame, /fix login bug/);
  } finally {
    act(() => screen.renderer.destroy());
  }
});

test("blank assistant content does not render an empty ● row", async () => {
  const { RowView } = await import("../src/ui/components/rows.js");
  const { Box } = await import("../src/ui/primitives.js");
  const screen = await testRender(
    <Box flexDirection="column">
      <RowView row={{ kind: "assistant", id: "blank", text: "\n\n  " } as never} width={60} />
      <RowView row={{ kind: "assistant", id: "real", text: "Done." } as never} width={60} />
    </Box>,
    { width: 60, height: 8 },
  );
  try {
    await screen.renderOnce();
    const frame = screen.captureCharFrame();
    assert.equal((frame.match(/●/g) ?? []).length, 1);
    assert.match(frame, /● Done\./);
  } finally {
    act(() => screen.renderer.destroy());
  }
});
