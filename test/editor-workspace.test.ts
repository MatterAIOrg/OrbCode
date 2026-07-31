import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  terminalFileIcon,
  terminalFolderIcon,
} from "../src/ui/editor/fileIcons.js";
import {
  flattenWorkspace,
  matchesFileFilter,
  parseGitChangedLines,
  parseGitStatus,
  readGitChangedLines,
  readWorkspaceFile,
  scanWorkspace,
  scanWorkspaceSubtree,
  searchWorkspaceText,
  statusForEntry,
  type WorkspaceEntry,
} from "../src/ui/editor/workspace.js";

const execFileAsync = promisify(execFile);

test("maps current-side Git diff hunks to viewer line numbers", () => {
  assert.deepEqual(
    [...parseGitChangedLines(
      [
        "@@ -2 +2,2 @@",
        "-before",
        "+after",
        "+inserted",
        "@@ -8,2 +9,0 @@",
        "-removed",
        "-also removed",
      ].join("\n"),
    )],
    [2, 3],
  );
});

test("combines staged and unstaged Git changes for viewer highlighting", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "orbcode-git-lines-"));
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
    await fs.writeFile(path.join(cwd, "tracked.ts"), "one\nbefore\nthree\n");
    await execFileAsync("git", ["add", "tracked.ts"], { cwd });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd });

    assert.deepEqual(
      [...(await readGitChangedLines(cwd, "tracked.ts", 3))],
      [],
    );

    await fs.writeFile(
      path.join(cwd, "tracked.ts"),
      "one\nafter\nthree\ninserted\n",
    );
    await execFileAsync("git", ["add", "tracked.ts"], { cwd });
    await fs.writeFile(
      path.join(cwd, "tracked.ts"),
      "one\nafter staged\nthree\ninserted\n",
    );
    assert.deepEqual(
      [...(await readGitChangedLines(cwd, "tracked.ts", 4))],
      [2, 4],
    );

    await fs.writeFile(path.join(cwd, "untracked.ts"), "first\nsecond");
    assert.deepEqual(
      [...(await readGitChangedLines(cwd, "untracked.ts", 2))],
      [1, 2],
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("resolves Explorer icons with MatterCode's Material Icon Theme mapping", () => {
  assert.deepEqual(
    [
      terminalFileIcon("src/index.ts").materialIcon,
      terminalFileIcon("src/App.tsx").materialIcon,
      terminalFileIcon("package.json").materialIcon,
      terminalFileIcon("vite.config.ts").materialIcon,
      terminalFileIcon(".gitignore").materialIcon,
    ],
    ["typescript", "react_ts", "nodejs", "vite", "git"],
  );
  assert.notEqual(
    terminalFileIcon("index.ts").glyph,
    terminalFileIcon("index.js").glyph,
  );
  assert.equal(terminalFolderIcon("src").materialIcon, "folder-src");
  assert.notEqual(
    terminalFolderIcon("src").glyph,
    terminalFolderIcon("src", true).glyph,
  );
});

test("scans hidden project folders while bounding generated directories", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "orbcode-editor-"));
  try {
    await fs.mkdir(path.join(cwd, ".git"));
    await fs.mkdir(path.join(cwd, ".github", "workflows"), {
      recursive: true,
    });
    await fs.mkdir(path.join(cwd, "node_modules", "large-package"), {
      recursive: true,
    });
    await fs.mkdir(path.join(cwd, "src"));
    await fs.writeFile(path.join(cwd, ".github", "workflows", "ci.yml"), "ci");
    await fs.writeFile(path.join(cwd, "node_modules", "large-package", "x.js"), "x");
    await fs.writeFile(path.join(cwd, "src", "index.ts"), "export {}");

    const snapshot = await scanWorkspace(cwd);
    assert.equal(snapshot.entries.some((entry) => entry.name === ".git"), false);

    const github = snapshot.entries.find((entry) => entry.name === ".github");
    assert(github);
    assert.equal(github.children[0]?.name, "workflows");
    assert.equal(github.children[0]?.children[0]?.name, "ci.yml");

    const dependencies = snapshot.entries.find(
      (entry) => entry.name === "node_modules",
    );
    assert(dependencies);
    assert.equal(dependencies.collapsed, true);
    assert.deepEqual(dependencies.children, []);

    const expandedDependencies = await scanWorkspaceSubtree(
      cwd,
      "node_modules",
    );
    assert.equal(expandedDependencies.entries[0]?.path, "node_modules/large-package");
    assert.equal(
      expandedDependencies.entries[0]?.children[0]?.path,
      "node_modules/large-package/x.js",
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("filters files fuzzily and retains their ancestor folders", () => {
  const index: WorkspaceEntry = {
    name: "index.ts",
    path: "src/editor/index.ts",
    kind: "file",
    collapsed: false,
    children: [],
  };
  const tree: WorkspaceEntry[] = [
    {
      name: "src",
      path: "src",
      kind: "directory",
      collapsed: false,
      children: [
        {
          name: "editor",
          path: "src/editor",
          kind: "directory",
          collapsed: false,
          children: [index],
        },
      ],
    },
    {
      name: "README.md",
      path: "README.md",
      kind: "file",
      collapsed: false,
      children: [],
    },
  ];

  assert.equal(matchesFileFilter("src/editor/index.ts", "edidx"), true);
  assert.deepEqual(
    flattenWorkspace(tree, new Set(), "index").map(({ entry }) => entry.path),
    ["src", "src/editor", "src/editor/index.ts"],
  );
  assert.deepEqual(
    flattenWorkspace(tree, new Set(["src"])).map(({ entry }) => entry.path),
    ["src", "src/editor", "README.md"],
  );
});

test("parses Git badges and aggregates changed descendants on folders", () => {
  const statuses = parseGitStatus(
    " M src/edited.ts\0?? src/new.ts\0R  renamed.ts\0old.ts\0 D removed.ts\0",
  );
  assert.deepEqual(Object.fromEntries(statuses), {
    "src/edited.ts": "M",
    "src/new.ts": "U",
    "renamed.ts": "R",
    "removed.ts": "D",
  });

  const src: WorkspaceEntry = {
    name: "src",
    path: "src",
    kind: "directory",
    collapsed: false,
    children: [],
  };
  assert.equal(statusForEntry(src, statuses), "•");
});

test("global workspace search treats the query as literal text", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "orbcode-search-"));
  try {
    await fs.mkdir(path.join(cwd, "src"));
    await fs.mkdir(path.join(cwd, ".github"));
    await fs.writeFile(
      path.join(cwd, "src", "math.ts"),
      [
        "export const one = a+b;",
        "export const two = a+b;",
        "export const three = a+b;",
        "export const four = a+b;",
      ].join("\n"),
    );
    await fs.writeFile(path.join(cwd, ".github", "config.yml"), "value: a+b\n");
    const results = await searchWorkspaceText(cwd, "a+b");
    assert.equal(
      results.filter((result) => result.file === "src/math.ts").length,
      4,
    );
    assert.equal(
      results.some((result) => result.file === ".github/config.yml"),
      true,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("loads bounded text previews and rejects non-text or escaping paths", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "orbcode-viewer-"));
  try {
    await fs.writeFile(path.join(cwd, "notes.txt"), "first\nsecond\nthird");
    await fs.writeFile(
      path.join(cwd, "image.bin"),
      Buffer.from([0, 1, 2, 3]),
    );

    const text = await readWorkspaceFile(cwd, "notes.txt", 8);
    assert.equal(text.kind, "text");
    if (text.kind === "text") {
      assert.deepEqual(text.lines, ["first", "se"]);
      assert.equal(text.truncated, true);
    }

    const binary = await readWorkspaceFile(cwd, "image.bin");
    assert.equal(binary.kind, "binary");

    const escaping = await readWorkspaceFile(cwd, "../outside.txt");
    assert.equal(escaping.kind, "error");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
