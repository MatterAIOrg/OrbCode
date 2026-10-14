import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { testRender } from "@opentui/react/test-utils";

import { act } from "react"
import { Box, Text, getLinkUrlAt } from "../src/ui/primitives.js";
import { markdownRowCount, renderMarkdown } from "../src/ui/markdown.js";
import { RowView } from "../src/ui/components/rows.js";

/** Render markdown into a fixed-width frame and return its lines, trailing blanks dropped. */
async function render(markdown: string, width = 80, maxWidth = width) {
  const screen = await testRender(
    <Box flexDirection="column" width={width} height={30}>
      <Text>{renderMarkdown(markdown, maxWidth)}</Text>
    </Box>,
    { width, height: 30 },
  );
  try {
    await screen.renderOnce();
    const lines = screen
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd());
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  } finally {
    act(() => screen.renderer.destroy());
  }
}

const isGridLine = (line: string) => /^[│├╭╰]/.test(line);

/** Column positions of every border character on a line. */
const borderColumns = (line: string) =>
  [...line].flatMap((char, index) => ("│├┼┤╭┬╮╰┴╯".includes(char) ? [index] : []));

const TABLE = [
  "| | SFT objective | RL/DPO objective |",
  "|---|---|---|",
  "| Full weights | Heavy, needs offload | Very hard on 24 GB |",
  "| LoRA | ✅ Easy, fast | ✅ Feasible (DPO easy, GRPO slow) |",
].join("\n");

const WIDE = [
  "| File | Change |",
  "|---|---|",
  "| src/ui/markdown.tsx | Table block detection, delimiter and alignment parsing, column fitting |",
  "| src/ui/components/rows.tsx | Passes the available width to renderMarkdown |",
].join("\n");

test("renders a markdown table as a bordered grid at its natural width", async () => {
  const lines = await render(TABLE);
  const table = lines.filter(isGridLine);

  assert.equal(table.length, 6, `expected a 6-line grid, got:\n${lines.join("\n")}`);
  assert.match(table[0], /^╭─+┬─+┬─+╮$/);
  assert.match(table[1], /^│ {14}│ SFT objective {8}│ RL\/DPO objective {18}│$/);
  assert.match(table[2], /^├─+┼─+┼─+┤$/);
  assert.match(table[3], /^│ Full weights │ Heavy, needs offload │ Very hard on 24 GB\s+│$/);
  assert.match(table[4], /^│ LoRA {9}│ ✅ Easy, fast\s+│ ✅ Feasible \(DPO easy, GRPO slow\) │$/);
  assert.match(table[5], /^╰─+┴─+┴─+╯$/);
  assert.ok(table[0].length < 80, "a narrow table should not stretch to the full width");
  assert.doesNotMatch(lines.join("\n"), /\|/);
});

test("aligns every border column across the grid", async () => {
  const lines = await render(WIDE);
  const borders = lines.filter(isGridLine).map(borderColumns);

  for (const columns of borders) assert.deepEqual(columns, borders[0]);
});

test("honours the separator row's alignment markers", async () => {
  const lines = await render(["| left | center | right |", "|:---|:---:|---:|", "| a | b | c |"].join("\n"));

  assert.equal(lines[1], "│ left │ center │ right │");
  assert.equal(lines[3], "│ a    │   b    │     c │");
});

test("keeps pipe rows that have no separator row as plain text", async () => {
  const lines = await render("a | b\nc | d");

  assert.deepEqual(lines, ["a | b", "c | d"]);
});

test("keeps a prose line with a pipe above a table as prose", async () => {
  const lines = await render(["Pick a | b below", "| h1 | h2 |", "|---|---|", "| x | y |"].join("\n"));

  assert.equal(lines[0], "Pick a | b below");
  assert.equal(lines[1], "╭────┬────╮");
  assert.equal(lines[2], "│ h1 │ h2 │");
  assert.equal(lines[4], "│ x  │ y  │");
});

test("shows the header of a table whose body has not streamed in yet", async () => {
  const lines = await render("| h1 | h2 |\n|---|---|");

  assert.deepEqual(lines, ["╭────┬────╮", "│ h1 │ h2 │", "╰────┴────╯"]);
});

test("wraps cells of a table wider than the available space", async () => {
  const lines = await render(WIDE, 50);
  const table = lines.filter(isGridLine);

  for (const line of table) assert.ok(line.length <= 50, `line overflows: ${line}`);
  for (const line of table) assert.deepEqual(borderColumns(line), borderColumns(table[0]));
  const text = table.map((line) => line.replace(/[│├┼┤╭┬╮╰┴╯─]/g, " ")).join(" ").replace(/\s+/g, " ");
  assert.match(text, /src\/ui\/markdown\.tsx Table block detection, delimiter and alignment parsing, column fitting/);
  assert.equal(lines.length, markdownRowCount(WIDE, 50, 50));
});

test("strips inline markers from cells without eating underscores", async () => {
  const lines = await render("| file | note |\n|---|---|\n| `src/my_file.ts` | **bold** and [docs](https://x.dev) |");

  assert.equal(lines[3], "│ src/my_file.ts │ bold and docs https://x.dev │");
});

test("renders inline markdown once in prose and list items", async () => {
  const lines = await render("Use `foo` and **bar** here\n- item with `code` and *em*\n1. step **one**");

  assert.deepEqual(lines, ["Use foo and bar here", "• item with code and em", "1. step one"]);
});

test("leaves surrounding markdown untouched", async () => {
  const markdown = ["## Results", "", TABLE, "", "- done"].join("\n");
  const lines = await render(markdown);

  assert.equal(lines[0], "Results");
  assert.equal(lines[1], "");
  assert.match(lines[2], /^╭/);
  assert.match(lines[7], /^╰/);
  assert.equal(lines[8], "");
  assert.equal(lines[9], "• done");
  assert.equal(lines.length, markdownRowCount(markdown, 80, 80));
});

test("attaches clickable OSC 8 link URLs to markdown links, autolinks, bare URLs, code, and tables", async () => {
  const markdown = [
    "Visit [Docs](https://matterai.so/docs) or [Wiki](https://en.wikipedia.org/wiki/Foo_(bar)).",
    "Autolink: <https://orbcode.dev/auto> and bare https://orbcode.dev/bare, plus (see http://localhost:3000/test).",
    "Inline code `https://orbcode.dev/inline` and **https://orbcode.dev/bold**",
    "```bash",
    "curl https://orbcode.dev/code-block",
    "```",
    "| Name | Link |",
    "|---|---|",
    "| Portal | https://orbcode.dev/very/long/table/url/path/that/wraps |",
  ].join("\n");

  const screen = await testRender(
    <Box flexDirection="column" width={44} height={30}>
      <Text>{renderMarkdown(markdown, 44)}</Text>
    </Box>,
    { width: 44, height: 30 },
  );
  try {
    await screen.renderOnce();
    const boxRenderable = screen.renderer.root.getChildren()[0] as any;
    const textRenderable = boxRenderable.getChildren()[0] as any;
    const linkedChunks = textRenderable.textNode
      .toChunks()
      .filter((chunk: any) => chunk.link?.url)
      .map((chunk: any) => ({ text: chunk.text, url: chunk.link.url }));

    const urls = new Set(linkedChunks.map((c: { text: string; url: string }) => c.url));
    assert.deepEqual(
      urls,
      new Set([
        "https://matterai.so/docs",
        "https://en.wikipedia.org/wiki/Foo_(bar)",
        "https://orbcode.dev/auto",
        "https://orbcode.dev/bare",
        "http://localhost:3000/test",
        "https://orbcode.dev/inline",
        "https://orbcode.dev/bold",
        "https://orbcode.dev/code-block",
        "https://orbcode.dev/very/long/table/url/path/that/wraps",
      ]),
      "every wrapped fragment inside a narrow table cell should retain the full target href without emitting a truncated prefix URL",
    );

    // Ensure malformed markdown links with long unclosed parens run in linear time (no ReDoS).
    const startMs = performance.now();
    renderMarkdown(`[Docs](https://example.com/${"a".repeat(80)}`, 80);
    assert.ok(performance.now() - startMs < 50, "unclosed markdown link should parse in linear time");
  } finally {
    act(() => screen.renderer.destroy());
  }
});

test("renders clickable links inside attempt_completion bordered row", async () => {
  const completionText =
    "Deployed preview at https://preview.matterai.so/deployments/1234567890/inspect and [PR #42](https://github.com/MatterAIOrg/OrbCode/pull/42).";
  const screen = await testRender(
    <Box flexDirection="column" width={50} height={20}>
      <RowView
        row={{ id: "c1", kind: "completion", text: completionText }}
        width={50}
      />
    </Box>,
    { width: 50, height: 20 },
  );
  try {
    await screen.renderOnce();
    const outerBox = screen.renderer.root.getChildren()[0] as any;
    const completionBox = outerBox.getChildren()[0] as any;
    const bodyText = completionBox.getChildren()[1] as any;
    const linkedChunks = bodyText.textNode
      .toChunks()
      .filter((chunk: any) => chunk.link?.url)
      .map((chunk: any) => ({ text: chunk.text, url: chunk.link.url }));

    assert.deepEqual(linkedChunks, [
      {
        text: "https://preview.matterai.so/deployments/1234567890/inspect",
        url: "https://preview.matterai.so/deployments/1234567890/inspect",
      },
      {
        text: "PR #42",
        url: "https://github.com/MatterAIOrg/OrbCode/pull/42",
      },
      {
        text: "https://github.com/MatterAIOrg/OrbCode/pull/42",
        url: "https://github.com/MatterAIOrg/OrbCode/pull/42",
      },
    ]);

    const resolvedCellUrls = new Set<string>();
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 50; x++) {
        const url = getLinkUrlAt(screen.renderer, x, y);
        if (url) resolvedCellUrls.add(url);
      }
    }
    assert.deepEqual(
      resolvedCellUrls,
      new Set([
        "https://preview.matterai.so/deployments/1234567890/inspect",
        "https://github.com/MatterAIOrg/OrbCode/pull/42",
      ]),
    );
  } finally {
    act(() => screen.renderer.destroy());
  }
});

