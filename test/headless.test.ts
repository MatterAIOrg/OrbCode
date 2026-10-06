import assert from "node:assert/strict"
import test from "node:test"
import * as path from "node:path"

import { isOutputFileWrite } from "../src/headless.js"

const outputFile = path.join("out", "result.json")
const absolute = path.resolve(outputFile)

test("approves file_write to the output file however the path is spelled", () => {
	assert.equal(isOutputFileWrite(outputFile, "file_write", absolute), true)
	assert.equal(isOutputFileWrite(outputFile, "file_write", outputFile), true)
	assert.equal(isOutputFileWrite(outputFile, "file_write", `./${outputFile}`), true)
	assert.equal(isOutputFileWrite(absolute, "file_write", outputFile), true)
})

test("denies file_write to any other path", () => {
	assert.equal(isOutputFileWrite(outputFile, "file_write", path.join("out", "other.json")), false)
	// A substring/prefix match must not be enough.
	assert.equal(isOutputFileWrite(outputFile, "file_write", `${absolute}.bak`), false)
	assert.equal(isOutputFileWrite(outputFile, "file_write", path.join("out", "..", "result.json")), false)
})

test("denies tools other than file_write even on the output path", () => {
	assert.equal(isOutputFileWrite(outputFile, "execute_command", absolute), false)
	assert.equal(isOutputFileWrite(outputFile, "apply_diff", absolute), false)
})

test("denies everything when no output file is set or the path is empty", () => {
	assert.equal(isOutputFileWrite(undefined, "file_write", absolute), false)
	// An empty path would otherwise resolve to cwd.
	assert.equal(isOutputFileWrite(outputFile, "file_write", ""), false)
})
