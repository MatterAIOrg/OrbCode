import assert from "node:assert/strict";
import { test } from "node:test";

import { parseToolCallArguments } from "../src/utils/jsonRepair.js";

test("passes valid JSON through without repair", () => {
  const parsed = parseToolCallArguments(
    '{"path": "src", "regex": "needle", "file_pattern": null}',
  );
  assert.deepEqual(parsed, {
    args: { path: "src", regex: "needle", file_pattern: null },
    repaired: false,
  });
  assert.deepEqual(parseToolCallArguments("   "), {
    args: {},
    repaired: false,
  });
});

test("quotes unquoted string values like globs and file names", () => {
  const raw =
    '{"path": "/Users/x/src/ui", "regex": "setUpdateInfo|updateCheck", "file_pattern": *.tsx, "max_results": 20, "context_lines": 2}';
  const parsed = parseToolCallArguments(raw);
  assert.equal(parsed?.repaired, true);
  assert.equal(parsed?.args.file_pattern, "*.tsx");
  assert.equal(parsed?.args.max_results, 20);
  assert.equal(parsed?.args.context_lines, 2);

  const bareName = parseToolCallArguments(
    '{"path": "src/ui", "regex": "x", "file_pattern": App.tsx}',
  );
  assert.equal(bareName?.repaired, true);
  assert.equal(bareName?.args.file_pattern, "App.tsx");
});

test("quotes unquoted keys", () => {
  const parsed = parseToolCallArguments('{path: "src", regex: "needle"}');
  assert.equal(parsed?.repaired, true);
  assert.deepEqual(parsed?.args, { path: "src", regex: "needle" });
});

test("converts single quotes and Python literals", () => {
  const parsed = parseToolCallArguments(
    "{'path': 'src', 'flag': True, 'missing': None}",
  );
  assert.equal(parsed?.repaired, true);
  assert.deepEqual(parsed?.args, { path: "src", flag: true, missing: null });
});

test("removes trailing commas and comments", () => {
  const parsed = parseToolCallArguments(
    '{"path": "src", // workspace directory\n"regex": "x",}',
  );
  assert.equal(parsed?.repaired, true);
  assert.deepEqual(parsed?.args, { path: "src", regex: "x" });

  const blocked = parseToolCallArguments('{"path": /* inline */ "src"}');
  assert.deepEqual(blocked?.args, { path: "src" });
});

test("closes JSON truncated mid-string or mid-structure", () => {
  const midString = parseToolCallArguments('{"path": "src", "regex": "needle');
  assert.equal(midString?.repaired, true);
  assert.deepEqual(midString?.args, { path: "src", regex: "needle" });

  const midObject = parseToolCallArguments(
    '{"path": "src", "regex": "needle", "nested": {"a": 1,',
  );
  assert.deepEqual(midObject?.args, {
    path: "src",
    regex: "needle",
    nested: { a: 1 },
  });

  const midValue = parseToolCallArguments('{"path": "src", "regex":');
  assert.deepEqual(midValue?.args, { path: "src", regex: null });
});

test("wraps braceless object bodies", () => {
  const parsed = parseToolCallArguments('path: "src", regex: "needle"');
  assert.equal(parsed?.repaired, true);
  assert.deepEqual(parsed?.args, { path: "src", regex: "needle" });
});

test("unwraps a single-object array", () => {
  const parsed = parseToolCallArguments('[{"path": "src"}]');
  assert.equal(parsed?.repaired, true);
  assert.deepEqual(parsed?.args, { path: "src" });
});

test("keeps numbers, URLs, and multi-word bare values intact", () => {
  const parsed = parseToolCallArguments(
    '{"limit": 20, "url": https://example.com/x, "command": git status}',
  );
  assert.equal(parsed?.repaired, true);
  assert.deepEqual(parsed?.args, {
    limit: 20,
    url: "https://example.com/x",
    command: "git status",
  });
});

test("repairs nested structures with bare tokens", () => {
  const parsed = parseToolCallArguments(
    "{edits: [{file_path: src/a.ts, old_string: x, new_string: y}]}",
  );
  assert.equal(parsed?.repaired, true);
  assert.deepEqual(parsed?.args, {
    edits: [{ file_path: "src/a.ts", old_string: "x", new_string: "y" }],
  });
});

test("returns null for unrecoverable input", () => {
  assert.equal(parseToolCallArguments("just some prose"), null);
  assert.equal(parseToolCallArguments('"a bare string"'), null);
  assert.equal(parseToolCallArguments("42"), null);
  assert.equal(parseToolCallArguments("null"), null);
});
