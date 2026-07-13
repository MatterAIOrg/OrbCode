import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, test } from "node:test"

import {
	droppedAttachmentPaths,
	formatAttachmentContext,
	parseAttachments,
} from "../src/attachments.js"

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orbcode-attachments-"))
	temporaryDirectories.push(directory)
	return directory
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

test("recognizes quoted and shell-escaped dropped file paths without consuming prose", async () => {
	const directory = await temporaryDirectory()
	const first = path.join(directory, "report (final).csv")
	const second = path.join(directory, "notes.txt")
	await fs.writeFile(first, "name,value\nalpha,1\n")
	await fs.writeFile(second, "hello")

	assert.deepEqual(droppedAttachmentPaths(`'${first}' '${second}'`, directory), [first, second])
	assert.deepEqual(droppedAttachmentPaths(first.replace(/([\\\s()])/g, "\\$1"), directory), [first])
	assert.deepEqual(droppedAttachmentPaths("please review this report", directory), [])
})

test("extracts text documents and validates image contents", async () => {
	const directory = await temporaryDirectory()
	const csv = path.join(directory, "data.csv")
	const png = path.join(directory, "pixel.png")
	const fakePng = path.join(directory, "fake.png")
	await fs.writeFile(csv, "name,value\nalpha,1\n")
	await fs.writeFile(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	await fs.writeFile(fakePng, "not an image")

	const result = await parseAttachments([csv, png, fakePng])
	assert.equal(result.attachments.length, 2)
	assert.equal(result.attachments[0]?.kind, "document")
	assert.match(result.attachments[0]?.kind === "document" ? result.attachments[0].text : "", /alpha,1/)
	assert.equal(result.attachments[1]?.kind, "image")
	assert.match(result.attachments[1]?.kind === "image" ? result.attachments[1].dataUrl : "", /^data:image\/png;base64,/)
	assert.match(result.errors[0] ?? "", /contents do not match/)
})

test("bounds extracted text and formats document context", async () => {
	const directory = await temporaryDirectory()
	const textFile = path.join(directory, "large.txt")
	await fs.writeFile(textFile, `start-${"x".repeat(210_000)}-end`)

	const result = await parseAttachments([textFile])
	const attachment = result.attachments[0]
	assert.equal(attachment?.kind, "document")
	if (!attachment || attachment.kind !== "document") return
	assert.equal(attachment.truncated, true)
	assert.ok(attachment.text.length <= 200_000)
	assert.match(attachment.text, /attachment content truncated/)
	assert.match(formatAttachmentContext([attachment]), /<attached_file name="large.txt">/)
})
