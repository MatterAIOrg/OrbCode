import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

import { fileEdit, fileWrite, readFile } from "../src/tools/executors/files.js"
import read_file_schema from "../src/tools/schemas/read_file.js"
import { describeToolCall } from "../src/tools/index.js"

test("read_file schema accepts batched files array", () => {
	assert.equal(read_file_schema.function.name, "read_file")
	assert.deepEqual(read_file_schema.function.parameters.required, ["files"])
})

test("readFile executes single file and batched file region reads", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-test-"))
	const file1 = path.join(tmpDir, "file1.txt")
	const file2 = path.join(tmpDir, "file2.txt")

	const lines1 = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n")
	const lines2 = Array.from({ length: 50 }, (_, i) => `content ${i + 1}`).join("\n")

	fs.writeFileSync(file1, lines1)
	fs.writeFileSync(file2, lines2)

	const context = { cwd: tmpDir, setTodos: () => {} }

	// Single region via args.files
	const res1 = await readFile(
		{
			files: [{ file_path: "file2.txt" }],
		},
		context,
	)
	assert.equal(res1.isError, false)
	assert.match(res1.text, /content 1/)
	assert.match(res1.text, /content 50/)

	// Batched multi-region call
	const res2 = await readFile(
		{
			files: [
				{ file_path: "file1.txt", offset: 1, limit: 250 },
				{ file_path: "file2.txt", offset: 10, limit: 200 },
			],
		},
		context,
	)
	assert.equal(res2.isError, false)
	assert.match(res2.text, /--- file1.txt \(lines 1-250 of 300\) ---/)
	assert.match(res2.text, /--- file2.txt \(lines 10-50 of 50\) ---/)

	// Backward-compatible single file_path argument
	const res3 = await readFile(
		{
			file_path: "file2.txt",
			offset: 1,
			limit: 10,
		},
		context,
	)
	assert.equal(res3.isError, false)
	assert.match(res3.text, /content 1/)

	// Test describeToolCall summary for single and batched files
	assert.equal(
		describeToolCall("read_file", { files: [{ file_path: "src/index.ts" }] }),
		"src/index.ts",
	)
	assert.equal(
		describeToolCall("read_file", {
			files: [{ file_path: "src/index.ts" }, { file_path: "src/utils.ts" }],
		}),
		"2 regions across 2 files",
	)

	fs.rmSync(tmpDir, { recursive: true, force: true })
})

test("readFile caps characters, not just lines (minified files, many files per call)", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-test-"))
	// One 2 MB line: the 1000-line limit alone would return all of it.
	fs.writeFileSync(path.join(tmpDir, "bundle.min.js"), "x".repeat(2_000_000))
	// 1000 lines of 300 chars: well under the line limit, over the char cap.
	fs.writeFileSync(path.join(tmpDir, "wide.txt"), Array.from({ length: 1000 }, (_, i) => `${i} ${"w".repeat(300)}`).join("\n"))
	const context = { cwd: tmpDir, setTodos: () => {} }

	const minified = await readFile({ files: [{ file_path: "bundle.min.js" }] }, context)
	assert.ok(minified.text.length < 110_000, `got ${minified.text.length} chars`)
	assert.match(minified.text, /Line 1 alone exceeds 100000 characters and was cut off/)

	const wide = await readFile({ files: [{ file_path: "wide.txt" }] }, context)
	assert.ok(wide.text.length < 110_000)
	assert.match(wide.text, /Output capped at 100000 characters; showing through line \d+\. Use offset\/limit/)
	// Whole lines only: the last shown line is complete.
	const shown = wide.text.split("\n\n(")[0].split("\n")
	assert.match(shown.at(-1)!, /w{300}$/)

	const batch = await readFile(
		{ files: [{ file_path: "wide.txt" }, { file_path: "bundle.min.js" }, { file_path: "wide.txt", offset: 1, limit: 10 }] },
		context,
	)
	assert.ok(batch.text.length < 215_000, `got ${batch.text.length} chars`)
	assert.match(batch.text, /Skipped wide\.txt: this call reached its 200000-character limit/)
})

test("fileWrite and fileEdit reject a missing file_path or a directory target", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-test-"))
	const context = { cwd: tmpDir, setTodos: () => {} }

	const missing = await fileWrite({ content: "hello" }, context)
	assert.equal(missing.isError, true)
	assert.match(missing.text, /file_path is missing/)
	assert.doesNotMatch(missing.text, /EISDIR/)

	fs.mkdirSync(path.join(tmpDir, "sub"))
	const dir = await fileWrite({ file_path: "sub", content: "hello" }, context)
	assert.equal(dir.isError, true)
	assert.match(dir.text, /is a directory/)

	const edit = await fileEdit({ old_string: "a", new_string: "b" }, context)
	assert.equal(edit.isError, true)
	assert.match(edit.text, /file_path is missing/)

	const ok = await fileWrite({ file_path: "sub/new.txt", content: "hello" }, context)
	assert.equal(ok.isError, undefined)
	assert.equal(fs.readFileSync(path.join(tmpDir, "sub/new.txt"), "utf8"), "hello")
})
