import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { Box } from "../src/ui/primitives.js";
import {
  appendRow,
  RowView,
  toolGroupHeading,
  type Row,
} from "../src/ui/components/rows.js";
import {
  formatElapsed,
  formatTokenCount,
  Spinner,
} from "../src/ui/components/Spinner.js";

let nextId = 0;
function tool(name: string, summary: string, extra: Partial<Extract<Row, { kind: "tool" }>> = {}): Row {
  return { kind: "tool", id: `t${nextId++}`, name, summary, resultPreview: "out", isError: false, ...extra };
}

function build(rows: Row[]): Row[] {
  return rows.reduce<Row[]>((acc, row) => appendRow(acc, row, false), []);
}

test("consecutive read-only tools collapse into one group row", () => {
  const rows = build([
    tool("read_file", "src/a.ts"),
    tool("search_files", "/foo/ in src"),
    tool("Bash", "git status --short"),
    tool("read_file", "3 regions across 2 files"),
  ]);
  assert.equal(rows.length, 1);
  const group = rows[0]!;
  assert.equal(group.kind, "tool-group");
  assert.equal(group.id, "t0", "the group keeps its first entry's id so its React key is stable");
  if (group.kind !== "tool-group") return;
  assert.equal(toolGroupHeading(group.tools), "Read 3 files, searched for 1 pattern, ran 1 command");
});

test("edits, errors, mutating commands and assistant text end the group", () => {
  const rows = build([
    tool("read_file", "src/a.ts"),
    tool("file_edit", "src/a.ts", { diff: "@@ -1 +1 @@\n-a\n+b" }),
    tool("read_file", "src/b.ts"),
    tool("read_file", "src/c.ts", { isError: true }),
    tool("Bash", "npm install"),
    { kind: "assistant", id: "x", text: "done" },
    tool("list_files", "src"),
  ]);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["tool-group", "tool", "tool-group", "tool", "tool", "assistant", "tool-group"],
  );
});

test("a collapsed group shows only the latest call under its heading", async () => {
  const [group] = build([tool("read_file", "src/a.ts"), tool("read_file", "src/b.ts")]);
  const screen = await testRender(
    <Box flexDirection="column" width={80} height={4}>
      <RowView row={group!} width={80} />
    </Box>,
    { width: 80, height: 4 },
  );
  try {
    await screen.renderOnce();
    const frame = screen.captureCharFrame();
    assert.match(frame, /● Read 2 files \(ctrl\+o to expand\)/);
    assert.match(frame, /⎿ src\/b\.ts/);
    assert.doesNotMatch(frame, /src\/a\.ts/);
  } finally {
    act(() => screen.renderer.destroy());
  }
});

test("the spinner shows turn-wide elapsed time and output tokens", async () => {
  const screen = await testRender(
    <Box flexDirection="column" width={100} height={2}>
      <Spinner label="Reading" startedAt={Date.now() - 133_000} tokensRef={{ current: 4_210 }} />
    </Box>,
    { width: 100, height: 2 },
  );
  try {
    await screen.renderOnce();
    assert.match(screen.captureCharFrame(), /Reading… \(2m 13s · ↓ 4\.2k tokens · esc to interrupt\)/);
  } finally {
    act(() => screen.renderer.destroy());
  }
});

test("elapsed and token formats", () => {
  assert.equal(formatElapsed(45_900), "45s");
  assert.equal(formatElapsed(3_840_000), "1h 4m");
  assert.equal(formatTokenCount(840), "840");
  assert.equal(formatTokenCount(1_250_000), "1.3M");
});
