/**
 * Conservative detector for shell commands that only observe the workspace
 * (rg, grep, find, ls, cat, git status, ...). Such commands skip the approval
 * prompt and can run in parallel, which is what lets the Bash tool stand in
 * for dedicated search/list tools. A false negative just means a prompt; a false
 * positive would run something unreviewed, so anything unrecognised is rejected.
 */

const READ_ONLY_COMMANDS = new Set([
	"rg", "grep", "egrep", "fgrep", "find", "fd", "ls", "tree", "cat", "head", "tail", "wc", "file", "stat",
	"pwd", "echo", "sort", "uniq", "cut", "tr", "nl", "du", "df", "which", "basename", "dirname", "realpath",
	"diff", "jq", "column", "cd", "true", "git",
])

const READ_ONLY_GIT = new Set([
	"status", "diff", "log", "show", "blame", "ls-files", "ls-tree", "grep", "rev-parse", "rev-list", "describe",
	"shortlog", "cat-file", "diff-tree", "merge-base", "name-rev", "check-ignore",
])

/** Flags that make an otherwise read-only command run code or write files. */
const UNSAFE_FLAGS: Record<string, RegExp> = {
	find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
	fd: /^(-x|-X|--exec|--exec-batch)$/,
	rg: /^(--pre|--pre-glob|--hostname-bin)(=|$)/,
	sort: /^(-o|--output)(=|$)/,
	tree: /^-o$/,
	git: /^(--output|--ext-diff|--textconv|-O|--open-files-in-pager)(=|$)/,
}

/** Split on unquoted shell operators; null if the command uses anything that could hide a write or a nested command. */
function splitSegments(command: string): string[] | null {
	const segments: string[] = []
	let current = ""
	let quote: "'" | '"' | null = null
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]
		if (quote === "'") {
			if (ch === "'") quote = null
			current += ch
			continue
		}
		if (ch === "\\") {
			current += ch + (command[i + 1] ?? "")
			i++
			continue
		}
		if (ch === "`" || (ch === "$" && command[i + 1] === "(")) return null
		if (quote === '"') {
			if (ch === '"') quote = null
			current += ch
			continue
		}
		if (ch === "'" || ch === '"') {
			quote = ch
			current += ch
			continue
		}
		if (ch === "\n" || ch === "<" || ch === "(" || ch === ")" || ch === "{" || ch === "}") return null
		if (ch === ">") return null
		if (ch === "|" || ch === ";" || ch === "&") {
			// `||`, `&&`, `|&`: swallow the doubled operator.
			if (command[i + 1] === ch || (ch === "|" && command[i + 1] === "&")) i++
			segments.push(current)
			current = ""
			continue
		}
		current += ch
	}
	if (quote) return null
	segments.push(current)
	return segments
}

/** Words of a single segment with quotes removed (enough to inspect the command name and flags). */
function words(segment: string): string[] {
	const out: string[] = []
	for (const match of segment.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|((?:\\.|[^\s"'\\])+)/g)) {
		out.push(match[1] ?? match[2] ?? match[3] ?? "")
	}
	return out
}

export function isReadOnlyCommand(command: string): boolean {
	// Harmless redirections the model adds constantly; removed before looking for real ones.
	const cleaned = command
		.replace(/\s\d?>\s*\/dev\/null/g, " ")
		.replace(/\s2>&1/g, " ")
		.trim()
	if (!cleaned) return false
	const segments = splitSegments(cleaned)
	if (!segments) return false
	let sawCommand = false
	for (const segment of segments) {
		const w = words(segment)
		if (w.length === 0) continue
		const [name, ...rest] = w
		if (!READ_ONLY_COMMANDS.has(name)) return false
		sawCommand = true
		if (name === "git") {
			const sub = rest.find((arg) => !arg.startsWith("-"))
			if (!sub || !READ_ONLY_GIT.has(sub)) return false
			// `git -c core.pager=...` / `--exec-path` global options can run code.
			if (rest.some((arg) => arg === "-c" || arg.startsWith("--exec-path"))) return false
		}
		const unsafe = UNSAFE_FLAGS[name]
		if (unsafe && rest.some((arg) => unsafe.test(arg))) return false
	}
	return sawCommand
}
