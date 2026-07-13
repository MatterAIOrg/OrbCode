import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

import mammoth from "mammoth"
import { PDFParse } from "pdf-parse"
import readXlsxFile from "read-excel-file/node"

const MAX_ATTACHMENT_COUNT = 20
const MAX_SOURCE_FILE_BYTES = 10 * 1024 * 1024
const MAX_SOURCE_BYTES_TOTAL = 25 * 1024 * 1024
const MAX_EXTRACTED_CHARACTERS_PER_FILE = 200_000
const MAX_EXTRACTED_CHARACTERS_TOTAL = 500_000

const IMAGE_MIME_TYPES: Record<string, string> = {
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
}

const DOCUMENT_EXTENSIONS = new Set([
	".csv",
	".docx",
	".json",
	".log",
	".md",
	".pdf",
	".text",
	".tsv",
	".txt",
	".xlsx",
	".xml",
	".yaml",
	".yml",
])

export interface AttachmentSummary {
	name: string
	kind: "document" | "image"
	truncated?: boolean
}

interface BaseAttachment extends AttachmentSummary {
	path: string
	size: number
}

export interface DocumentAttachment extends BaseAttachment {
	kind: "document"
	text: string
}

export interface ImageAttachment extends BaseAttachment {
	kind: "image"
	dataUrl: string
	mediaType: string
}

export type Attachment = DocumentAttachment | ImageAttachment

export interface SubmittedPrompt {
	text: string
	attachments: Attachment[]
}

export interface ParseAttachmentsResult {
	attachments: Attachment[]
	errors: string[]
}

/** Open the host operating system's native file chooser. */
export async function pickAttachmentPaths(cwd: string): Promise<string[]> {
	let output: string | null | undefined
	if (process.platform === "darwin") {
		const script = [
			'set startFolder to POSIX file (system attribute "ORBCODE_PICKER_CWD")',
			'set chosenFiles to choose file with prompt "Attach files to OrbCode" default location startFolder with multiple selections allowed',
			'set selectedPaths to ""',
			'repeat with chosenFile in chosenFiles',
			'  set selectedPaths to selectedPaths & POSIX path of chosenFile & linefeed',
			'end repeat',
			'return selectedPaths',
		].join("\n")
		output = await runPickerCommand("osascript", ["-e", script], cwd)
	} else if (process.platform === "win32") {
		const script = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"$picker = New-Object System.Windows.Forms.OpenFileDialog",
			"$picker.Multiselect = $true",
			"$picker.Title = 'Attach files to OrbCode'",
			"$picker.InitialDirectory = $env:ORBCODE_PICKER_CWD",
			"$picker.Filter = 'Supported files|*.csv;*.docx;*.json;*.log;*.md;*.pdf;*.text;*.tsv;*.txt;*.xlsx;*.xml;*.yaml;*.yml;*.jpeg;*.jpg;*.png;*.webp|All files|*.*'",
			"if ($picker.ShowDialog() -eq 'OK') { $picker.FileNames -join \"`n\" }",
		].join("; ")
		output = await runPickerCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], cwd)
	} else if (process.platform === "linux") {
		output = await runPickerCommand(
			"zenity",
			[
				"--file-selection",
				"--multiple",
				"--separator=\n",
				"--title=Attach files to OrbCode",
				`--filename=${cwd}${path.sep}`,
				"--file-filter=Supported files | *.csv *.docx *.json *.log *.md *.pdf *.text *.tsv *.txt *.xlsx *.xml *.yaml *.yml *.jpeg *.jpg *.png *.webp",
			],
			cwd,
		)
		if (output === undefined) {
			output = await runPickerCommand(
				"kdialog",
				[
					"--getopenfilename",
					cwd,
					"*.csv *.docx *.json *.log *.md *.pdf *.text *.tsv *.txt *.xlsx *.xml *.yaml *.yml *.jpeg *.jpg *.png *.webp",
					"--multiple",
					"--separate-output",
					"--title",
					"Attach files to OrbCode",
				],
				cwd,
			)
		}
	} else {
		throw new Error(`File picker is not supported on ${process.platform}`)
	}

	if (output === undefined) {
		throw new Error("No supported system file picker was found")
	}
	if (output === null) return []
	return output
		.split(/\r?\n/)
		.map((filePath) => filePath.trim())
		.filter(Boolean)
		.map((filePath) => path.resolve(filePath))
}

export function attachmentSummary(attachment: Attachment): AttachmentSummary {
	return {
		name: attachment.name,
		kind: attachment.kind,
		...(attachment.truncated ? { truncated: true } : {}),
	}
}

export function isSupportedAttachmentPath(filePath: string): boolean {
	const extension = path.extname(filePath).toLowerCase()
	return extension in IMAGE_MIME_TYPES || DOCUMENT_EXTENSIONS.has(extension)
}

/**
 * Terminal emulators implement file drag-and-drop by pasting one or more paths.
 * Only consume the input when every pasted token is an existing supported file,
 * so ordinary pasted prose remains ordinary prompt text.
 */
export function droppedAttachmentPaths(input: string, cwd: string): string[] {
	const cleanInput = input.replace(/\u001b\[200~/g, "").replace(/\u001b\[201~/g, "").trim()
	if (!cleanInput) return []

	const tokens = splitShellPaths(cleanInput)
	if (tokens.length === 0) return []

	const resolved = tokens.map((token) => resolvePathToken(token, cwd))
	if (
		resolved.some((filePath) => {
			try {
				return !isSupportedAttachmentPath(filePath) || !fs.statSync(filePath).isFile()
			} catch {
				return true
			}
		})
	) {
		return []
	}

	return resolved
}

export async function parseAttachments(
	filePaths: string[],
	existing: Attachment[] = [],
): Promise<ParseAttachmentsResult> {
	const attachments: Attachment[] = []
	const errors: string[] = []
	const existingPaths = new Set(existing.map((attachment) => attachment.path))
	let totalSourceBytes = existing.reduce((total, attachment) => total + attachment.size, 0)
	let totalExtractedCharacters = existing.reduce(
		(total, attachment) => total + (attachment.kind === "document" ? attachment.text.length : 0),
		0,
	)

	for (const filePath of filePaths) {
		const name = path.basename(filePath)
		try {
			if (existing.length + attachments.length >= MAX_ATTACHMENT_COUNT) {
				throw new Error(`Only ${MAX_ATTACHMENT_COUNT} attachments can be added to one message`)
			}
			if (existingPaths.has(filePath) || attachments.some((attachment) => attachment.path === filePath)) {
				throw new Error("File is already attached")
			}
			if (!isSupportedAttachmentPath(filePath)) {
				throw new Error(`Unsupported file type ${path.extname(filePath) || "(none)"}`)
			}

			const stat = await fs.promises.stat(filePath)
			if (!stat.isFile()) throw new Error("Only files can be attached")
			if (stat.size > MAX_SOURCE_FILE_BYTES) {
				throw new Error("File is larger than the 10 MB attachment limit")
			}
			if (totalSourceBytes + stat.size > MAX_SOURCE_BYTES_TOTAL) {
				throw new Error("The 25 MB total attachment limit has been reached")
			}

			const extension = path.extname(filePath).toLowerCase()
			const buffer = await fs.promises.readFile(filePath)
			const mediaType = IMAGE_MIME_TYPES[extension]
			if (mediaType) {
				validateImageSignature(buffer, extension)
				attachments.push({
					kind: "image",
					name,
					path: filePath,
					size: stat.size,
					mediaType,
					dataUrl: `data:${mediaType};base64,${buffer.toString("base64")}`,
				})
				totalSourceBytes += stat.size
				continue
			}

			const extracted = await extractDocumentText(buffer, extension)
			if (!extracted.trim()) throw new Error("No extractable text was found")
			const remainingCharacters = MAX_EXTRACTED_CHARACTERS_TOTAL - totalExtractedCharacters
			if (remainingCharacters <= 0) {
				throw new Error("The 500,000 character attachment limit has been reached")
			}
			const characterLimit = Math.min(MAX_EXTRACTED_CHARACTERS_PER_FILE, remainingCharacters)
			const text = truncateExtractedText(extracted, characterLimit)
			attachments.push({
				kind: "document",
				name,
				path: filePath,
				size: stat.size,
				text,
				truncated: text.length < extracted.length,
			})
			totalSourceBytes += stat.size
			totalExtractedCharacters += text.length
		} catch (error) {
			errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	return { attachments, errors }
}

export function formatAttachmentContext(attachments: Attachment[]): string {
	const documents = attachments.filter((attachment): attachment is DocumentAttachment => attachment.kind === "document")
	if (documents.length === 0) return ""
	return [
		"<attached_files>",
		...documents.map((document) => {
			const safeName = document.name.replace(/[\r\n"]/g, " ")
			return `<attached_file name="${safeName}">\n${document.text}\n</attached_file>`
		}),
		"</attached_files>",
	].join("\n")
}

function resolvePathToken(token: string, cwd: string): string {
	if (token.startsWith("file://")) {
		try {
			return fileURLToPath(token)
		} catch {
			return token
		}
	}
	const expanded = token === "~" || token.startsWith("~/") ? path.join(process.env.HOME ?? cwd, token.slice(2)) : token
	return path.resolve(cwd, expanded)
}

function splitShellPaths(input: string): string[] {
	const tokens: string[] = []
	let current = ""
	let quote: "'" | '"' | null = null

	for (let index = 0; index < input.length; index++) {
		const character = input[index]
		if (quote) {
			if (character === quote) quote = null
			else current += character
			continue
		}
		if (character === "'" || character === '"') {
			quote = character
			continue
		}
		if (character === "\\" && index + 1 < input.length) {
			current += input[++index]
			continue
		}
		if (/\s/.test(character)) {
			if (current) tokens.push(current)
			current = ""
			continue
		}
		current += character
	}
	if (current) tokens.push(current)
	return quote ? [] : tokens
}

async function extractDocumentText(buffer: Buffer, extension: string): Promise<string> {
	switch (extension) {
		case ".pdf": {
			const parser = new PDFParse({ data: buffer })
			try {
				return (await parser.getText()).text
			} finally {
				await parser.destroy()
			}
		}
		case ".docx":
			return (await mammoth.extractRawText({ buffer })).value
		case ".xlsx": {
			const sheets = await readXlsxFile(buffer)
			return sheets
				.map(
					(sheet) =>
						`--- Sheet: ${sheet.sheet} ---\n${sheet.data
							.slice(0, 50_000)
							.map((row) => row.map(formatCellValue).join("\t").trimEnd())
							.filter(Boolean)
							.join("\n")}`,
				)
				.join("\n\n")
		}
		default:
			if (buffer.subarray(0, 8_192).includes(0)) throw new Error("File does not appear to contain plain text")
			return buffer.toString("utf8").replace(/^\uFEFF/, "")
	}
}

function formatCellValue(value: unknown): string {
	if (value === null || value === undefined) return ""
	if (value instanceof Date) return value.toISOString()
	return String(value).replace(/[\r\n]+/g, " ")
}

function truncateExtractedText(text: string, limit: number): string {
	if (text.length <= limit) return text
	const marker = "\n[...attachment content truncated...]\n"
	if (limit <= marker.length) return text.slice(0, limit)
	const contentLimit = limit - marker.length
	const startLength = Math.floor(contentLimit * 0.2)
	return text.slice(0, startLength) + marker + text.slice(-(contentLimit - startLength))
}

function validateImageSignature(buffer: Buffer, extension: string): void {
	const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
	const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	const isWebp =
		buffer.length >= 12 &&
		buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
		buffer.subarray(8, 12).toString("ascii") === "WEBP"
	if ((extension === ".png" && !isPng) || ((extension === ".jpg" || extension === ".jpeg") && !isJpeg) || (extension === ".webp" && !isWebp)) {
		throw new Error("File contents do not match the image extension")
	}
}

/** `undefined` means the executable is absent; `null` means the picker was cancelled. */
function runPickerCommand(command: string, args: string[], cwd: string): Promise<string | null | undefined> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: { ...process.env, ORBCODE_PICKER_CWD: cwd },
			stdio: ["ignore", "pipe", "pipe"],
		})
		let stdout = ""
		let stderr = ""
		child.stdout.setEncoding("utf8")
		child.stderr.setEncoding("utf8")
		child.stdout.on("data", (chunk: string) => {
			if (stdout.length < 1024 * 1024) stdout += chunk
		})
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < 16_384) stderr += chunk
		})
		child.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") resolve(undefined)
			else reject(error)
		})
		child.on("close", (code) => {
			if (code === 0) resolve(stdout)
			else if (code === 1) resolve(null)
			else reject(new Error(stderr.trim() || `File picker exited with code ${code ?? "unknown"}`))
		})
	})
}
