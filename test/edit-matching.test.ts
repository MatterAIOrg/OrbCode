import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { fileEdit, multiFileEdit } from "../src/tools/executors/files.js"

function setup(content: string): { file: string; context: { cwd: string; setTodos: () => void }; read: () => string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-edit-"))
	const file = path.join(dir, "f.txt")
	fs.writeFileSync(file, content)
	return { file, context: { cwd: dir, setTodos: () => {} }, read: () => fs.readFileSync(file, "utf8") }
}

test("exact match still edits and reports no whitespace note", async () => {
	const { file, context, read } = setup("a\nb\nc\n")
	const res = await fileEdit({ file_path: file, old_string: "b", new_string: "B" }, context)
	assert.equal(res.isError, false)
	assert.equal(read(), "a\nB\nc\n")
	assert.doesNotMatch(res.text, /whitespace/)
})

test("duplicate exact match is still rejected", async () => {
	const { file, context, read } = setup("x\nx\n")
	const res = await fileEdit({ file_path: file, old_string: "x", new_string: "y" }, context)
	assert.equal(res.isError, true)
	assert.match(res.text, /matched 2 times/)
	assert.equal(read(), "x\nx\n")
})

test("LF old_string matches a CRLF file and the file stays pure CRLF", async () => {
	const { file, context, read } = setup("one\r\ntwo\r\nthree\r\n")
	const res = await fileEdit({ file_path: file, old_string: "one\ntwo", new_string: "uno\ndos\ndos-bis" }, context)
	assert.equal(res.isError, false)
	assert.equal(read(), "uno\r\ndos\r\ndos-bis\r\nthree\r\n")
})

test("single-line edit in a CRLF file with a multi-line replacement keeps CRLF", async () => {
	const { file, context, read } = setup("a\r\nb\r\nc\r\n")
	await fileEdit({ file_path: file, old_string: "b", new_string: "b1\nb2" }, context)
	assert.equal(read(), "a\r\nb1\r\nb2\r\nc\r\n")
})

test("space-indented old_string matches a tab-indented file and result uses tabs", async () => {
	const src = "function f() {\n\tif (x) {\n\t\treturn 1\n\t}\n}\n"
	const { file, context, read } = setup(src)
	const res = await fileEdit(
		{
			file_path: file,
			old_string: "    if (x) {\n        return 1\n    }",
			new_string: "    if (x) {\n        log()\n        return 2\n    }",
		},
		context,
	)
	assert.equal(res.isError, false)
	assert.match(res.text, /ignoring whitespace differences/)
	assert.equal(read(), "function f() {\n\tif (x) {\n\t\tlog()\n\t\treturn 2\n\t}\n}\n")
})

test("trailing-whitespace mismatch is tolerated", async () => {
	const { file, context, read } = setup("alpha   \nbeta\n")
	const res = await fileEdit({ file_path: file, old_string: "alpha\nbeta", new_string: "ALPHA\nBETA" }, context)
	assert.equal(res.isError, false)
	assert.equal(read(), "ALPHA\nBETA\n")
})

test("loose match that is ambiguous is rejected without editing", async () => {
	const src = "\tfoo()\n\tbar()\n---\n  foo()\n  bar()\n"
	const { file, context, read } = setup(src)
	const res = await fileEdit({ file_path: file, old_string: "foo()\nbar()", new_string: "x()" }, context)
	// "foo()\nbar()" never occurs verbatim (indent between the lines), so this goes loose and is ambiguous
	assert.equal(res.isError, true)
	assert.match(res.text, /multiple places/)
	assert.equal(read(), src)
})

test("not-found error shows the closest region with line numbers", async () => {
	const src =
		Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\nexport function computeTotal(items) {\n\treturn 0\n}\n"
	const { file, context, read } = setup(src)
	const res = await fileEdit(
		{ file_path: file, old_string: "export function computeTotals(items) {", new_string: "x" },
		context,
	)
	assert.equal(res.isError, true)
	assert.match(res.text, /old_string not found/)
	assert.match(res.text, /Closest match in the file/)
	assert.match(res.text, /21\|export function computeTotal\(items\) \{/)
	assert.equal(read(), src)
})

test("not-found error without any resemblance stays short", async () => {
	const { file, context } = setup("hello\nworld\n")
	const res = await fileEdit({ file_path: file, old_string: "zzzzqqqq", new_string: "x" }, context)
	assert.equal(res.isError, true)
	assert.equal(res.text.includes("Closest match"), false)
})

test("multi_file_edit applies tolerant matches and reports the note per edit", async () => {
	const { file, context, read } = setup("\tconst a = 1\n\tconst b = 2\n")
	const res = await multiFileEdit(
		{
			edits: [
				{ file_path: file, old_string: "const a = 1", new_string: "const a = 10" },
				{ file_path: file, old_string: "    const b = 2", new_string: "    const b = 20" },
			],
		},
		context,
	)
	assert.equal(res.isError, false)
	assert.equal(read(), "\tconst a = 10\n\tconst b = 20\n")
	assert.match(res.text, /ignoring whitespace differences/)
})
