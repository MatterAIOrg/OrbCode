import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import type { AttachmentSummary } from "../attachments.js"
import { getConfigDir } from "../config/settings.js"

/** A file as it was before the first edit made since a checkpoint. */
export interface CheckpointFile {
	/** absolute path of the edited file */
	path: string
	/** name of the backup holding its previous content; absent when the file did not exist yet */
	backup?: string
}

/**
 * A rewind point, recorded at the start of every user turn: where that turn's
 * messages begin, plus the pre-edit content of every file the agent changed
 * from then on (until the next checkpoint).
 */
export interface Checkpoint {
	id: string
	/** what the user typed, so a rewind can put it back in the prompt */
	text: string
	attachments?: AttachmentSummary[]
	/** length of `messages` before this turn's user message */
	messageIndex: number
	/** length of the display transcript before this turn's user entry */
	transcriptIndex: number
	/** todo list as it stood before this turn */
	todos: string
	files: CheckpointFile[]
}

export type RewindMode = "both" | "conversation" | "code"

export interface RewindResult {
	text: string
	attachments?: AttachmentSummary[]
	todos: string
	restoredFiles: string[]
	failedFiles: string[]
}

export interface RewindPoint {
	id: string
	text: string
	attachments?: AttachmentSummary[]
	/** files the agent changed in this turn or any later one */
	changedFiles: string[]
}

function fileHistoryDir(sessionId: string): string {
	return path.join(getConfigDir(), "file-history", sessionId)
}

/**
 * Remember `filePath`'s current content under `checkpoint`, unless it already
 * holds an earlier copy. Called right before the agent writes the file.
 * Best-effort: a failed backup only means that file can't be restored.
 */
export function snapshotFile(sessionId: string, checkpoint: Checkpoint, filePath: string): void {
	if (checkpoint.files.some((file) => file.path === filePath)) return
	let content: Buffer
	try {
		content = fs.readFileSync(filePath)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") checkpoint.files.push({ path: filePath })
		return
	}
	try {
		const dir = fileHistoryDir(sessionId)
		fs.mkdirSync(dir, { recursive: true })
		const backup = `${crypto.createHash("sha1").update(filePath).digest("hex").slice(0, 16)}-${checkpoint.id}`
		fs.writeFileSync(path.join(dir, backup), content, { mode: 0o600 })
		checkpoint.files.push({ path: filePath, backup })
	} catch {
		// Unwritable history dir: skip this file rather than block the edit.
	}
}

/** Every distinct file changed by these checkpoints. */
export function changedFilePaths(checkpoints: Checkpoint[]): string[] {
	return [...new Set(checkpoints.flatMap((checkpoint) => checkpoint.files.map((file) => file.path)))]
}

/**
 * Put every file the given checkpoints touched back to its content before the
 * earliest of them changed it. Files that did not exist then are deleted.
 */
export function restoreFiles(
	sessionId: string,
	checkpoints: Checkpoint[],
): { restored: string[]; failed: string[] } {
	const restored: string[] = []
	const failed: string[] = []
	const seen = new Set<string>()
	for (const checkpoint of checkpoints) {
		for (const file of checkpoint.files) {
			if (seen.has(file.path)) continue
			seen.add(file.path)
			try {
				if (file.backup === undefined) {
					fs.rmSync(file.path, { force: true })
				} else {
					fs.mkdirSync(path.dirname(file.path), { recursive: true })
					fs.writeFileSync(file.path, fs.readFileSync(path.join(fileHistoryDir(sessionId), file.backup)))
				}
				restored.push(file.path)
			} catch {
				failed.push(file.path)
			}
		}
	}
	return { restored, failed }
}

/** Delete the backup files held by these checkpoints. */
export function deleteBackups(sessionId: string, checkpoints: Checkpoint[]): void {
	for (const checkpoint of checkpoints) {
		for (const file of checkpoint.files) {
			if (file.backup === undefined) continue
			try {
				fs.rmSync(path.join(fileHistoryDir(sessionId), file.backup), { force: true })
			} catch {
				// leftover backups are harmless
			}
		}
	}
}
