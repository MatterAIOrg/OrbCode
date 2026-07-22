import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

import { readFile } from "../src/tools/executors/files.js"
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
