// Minimal unified-diff generator for showing file edits in the TUI.

type Op = { type: " " | "-" | "+"; text: string }

/** LCS-based line diff. Falls back to whole-block replace on very large inputs. */
function diffLines(oldLines: string[], newLines: string[]): Op[] {
	// Trim common prefix/suffix so the DP table only covers the changed middle.
	let start = 0
	while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
		start++
	}
	let oldEnd = oldLines.length
	let newEnd = newLines.length
	while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
		oldEnd--
		newEnd--
	}

	const a = oldLines.slice(start, oldEnd)
	const b = newLines.slice(start, newEnd)

	let middle: Op[]
	if (a.length * b.length > 1_000_000) {
		// Too large for DP; show as a block replace.
		middle = [
			...a.map((text): Op => ({ type: "-", text })),
			...b.map((text): Op => ({ type: "+", text })),
		]
	} else {
		// Standard LCS dynamic program.
		const rows = a.length + 1
		const cols = b.length + 1
		const table = new Uint32Array(rows * cols)
		for (let i = a.length - 1; i >= 0; i--) {
			for (let j = b.length - 1; j >= 0; j--) {
				table[i * cols + j] =
					a[i] === b[j]
						? table[(i + 1) * cols + j + 1] + 1
						: Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1])
			}
		}
		middle = []
		let i = 0
		let j = 0
		while (i < a.length && j < b.length) {
			if (a[i] === b[j]) {
				middle.push({ type: " ", text: a[i] })
				i++
				j++
			} else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
				middle.push({ type: "-", text: a[i] })
				i++
			} else {
				middle.push({ type: "+", text: b[j] })
				j++
			}
		}
		while (i < a.length) middle.push({ type: "-", text: a[i++] })
		while (j < b.length) middle.push({ type: "+", text: b[j++] })
	}

	return [
		...oldLines.slice(0, start).map((text): Op => ({ type: " ", text })),
		...middle,
		...oldLines.slice(oldEnd).map((text): Op => ({ type: " ", text })),
	]
}

/**
 * Produce unified-diff hunks (without file headers) for two file contents.
 * Returns "" when the contents are identical.
 */
export function unifiedDiff(oldText: string, newText: string, contextLines = 3): string {
	if (oldText === newText) return ""
	// An empty file is zero lines, not one empty line.
	const ops = diffLines(oldText === "" ? [] : oldText.split("\n"), newText === "" ? [] : newText.split("\n"))

	const out: string[] = []
	let oldLine = 1
	let newLine = 1
	let hunk: string[] = []
	let hunkOldStart = 1
	let hunkNewStart = 1
	let hunkOldCount = 0
	let hunkNewCount = 0
	let trailingContext = 0

	const flush = () => {
		if (hunk.length === 0) return
		// Drop context beyond the hunk's trailing window.
		const extra = Math.max(0, trailingContext - contextLines)
		if (extra > 0) {
			hunk = hunk.slice(0, hunk.length - extra)
			hunkOldCount -= extra
			hunkNewCount -= extra
		}
		out.push(`@@ -${hunkOldStart},${hunkOldCount} +${hunkNewStart},${hunkNewCount} @@`)
		out.push(...hunk)
		hunk = []
		hunkOldCount = 0
		hunkNewCount = 0
		trailingContext = 0
	}

	let pendingContext: string[] = []
	for (const op of ops) {
		if (op.type === " ") {
			if (hunk.length > 0) {
				hunk.push(` ${op.text}`)
				hunkOldCount++
				hunkNewCount++
				trailingContext++
				if (trailingContext > contextLines * 2) flush()
			} else {
				pendingContext.push(op.text)
				if (pendingContext.length > contextLines) pendingContext.shift()
			}
			oldLine++
			newLine++
		} else {
			if (hunk.length === 0) {
				hunkOldStart = oldLine - pendingContext.length
				hunkNewStart = newLine - pendingContext.length
				hunk = pendingContext.map((text) => ` ${text}`)
				hunkOldCount = pendingContext.length
				hunkNewCount = pendingContext.length
				pendingContext = []
			}
			trailingContext = 0
			hunk.push(`${op.type}${op.text}`)
			if (op.type === "-") {
				hunkOldCount++
				oldLine++
			} else {
				hunkNewCount++
				newLine++
			}
		}
	}
	flush()
	return out.join("\n")
}
