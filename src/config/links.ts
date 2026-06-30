import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * Linked repositories.
 *
 * `/link` lets the user point this repo at other repos on their machine that
 * are coupled to it (a shared API, a client/server pair, a monorepo sibling
 * checked out separately, …). The links are persisted per-project and injected
 * into the agent's environment details so a change here can be checked for
 * impact on — or propagated to — the linked repos.
 */

export interface LinkedRepo {
	/** The folder path the user entered (absolute, `~/path`, or relative). */
	input: string
	/** Absolute filesystem path the input resolved to. */
	path: string
}

const MAX_AGENTS_CHARS = 4000
const MAX_LINKED_REPOS = 8
/** Where a linked repo's AGENTS.md might live, in precedence order. `.orbital`
 *  (the IDE extension's dir) and `.orbcode` are legacy locations, still read for
 *  backward compatibility and cross-tool linking. */
const AGENTS_LOCATIONS = [
	path.join(".orb", "AGENTS.md"),
	path.join(".orbital", "AGENTS.md"),
	path.join(".orbcode", "AGENTS.md"),
	"AGENTS.md",
]

function isDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory()
	} catch {
		return false
	}
}

/**
 * The repo-level OrbCode directory for shared, tool-neutral data like AGENTS.md
 * and links.json — always `.orb`. This is the folder the IDE and the CLI both
 * read/write, so they stay in sync.
 *
 * Note: this is deliberately NOT where machine settings live. Those stay put
 * (`~/.orbcode` and `<repo>/.orbcode/settings.json`); only the repo-level
 * AGENTS.md/links folder moved to `.orb`. Legacy `.orbcode/AGENTS.md` files are
 * still *read* (see the memory loader and AGENTS_LOCATIONS), but new files are
 * written here.
 */
export function resolveProjectDir(cwd: string): string {
	return path.join(cwd, ".orb")
}

function linksFilePath(cwd: string): string {
	return path.join(resolveProjectDir(cwd), "links.json")
}

/**
 * Read the linked repos for a project (empty array if none / unreadable).
 *
 * The schema is tolerant so links written by either tool work: each entry needs
 * only an `input` (the IDE extension may omit the resolved `path`); we fill the
 * `path` by resolving the input when it's missing.
 */
export function loadLinks(cwd = process.cwd()): LinkedRepo[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(linksFilePath(cwd), "utf8")) as {
			links?: Array<Partial<LinkedRepo>>
		}
		if (!Array.isArray(parsed.links)) return []
		const out: LinkedRepo[] = []
		for (const raw of parsed.links) {
			if (!raw) continue
			const input = typeof raw.input === "string" ? raw.input : typeof raw.path === "string" ? raw.path : undefined
			if (!input) continue
			const resolved = typeof raw.path === "string" ? raw.path : resolveLinkTarget(input)
			if (!resolved) continue
			out.push({ input, path: resolved })
		}
		return out
	} catch {
		return []
	}
}

function saveLinks(cwd: string, links: LinkedRepo[]): void {
	const file = linksFilePath(cwd)
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify({ links }, null, "\t") + "\n")
}

/**
 * Turn the folder path the user entered — absolute, `~/path`, or relative to
 * cwd — into an absolute filesystem path. Returns undefined for empty input.
 */
export function resolveLinkTarget(input: string): string | undefined {
	let value = input.trim()
	if (!value) return undefined
	if (value.startsWith("~/")) value = path.join(os.homedir(), value.slice(2))
	return path.resolve(value)
}

export interface LinkResult {
	ok: boolean
	message: string
}

/** Resolve, validate and persist a new link. Idempotent on the resolved path. */
export function addLink(cwd: string, input: string): LinkResult {
	const resolved = resolveLinkTarget(input)
	if (!resolved) return { ok: false, message: "Enter a folder path." }
	if (path.resolve(cwd) === resolved) return { ok: false, message: "Can't link a repo to itself." }
	if (!isDir(resolved)) return { ok: false, message: `Not a directory: ${resolved}` }

	const links = loadLinks(cwd)
	if (links.some((l) => l.path === resolved)) return { ok: false, message: "Already linked." }
	if (links.length >= MAX_LINKED_REPOS) {
		return { ok: false, message: `At most ${MAX_LINKED_REPOS} linked repos.` }
	}

	links.push({ input: input.trim(), path: resolved })
	saveLinks(cwd, links)
	return { ok: true, message: `Linked ${resolved}` }
}

/** Remove a link by its resolved path. */
export function removeLink(cwd: string, targetPath: string): void {
	const links = loadLinks(cwd).filter((l) => l.path !== targetPath)
	saveLinks(cwd, links)
}

/** First AGENTS.md found inside a linked repo, or undefined. */
function readLinkedAgents(repo: string): string | undefined {
	for (const rel of AGENTS_LOCATIONS) {
		try {
			const text = fs.readFileSync(path.join(repo, rel), "utf8")
			if (text.trim()) return text
		} catch {
			// try the next location
		}
	}
	return undefined
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max) + "\n… (truncated)"
}

/**
 * Render the linked-repos block for the agent's environment details. Returns ""
 * when nothing is linked. Each repo's AGENTS.md is pulled in (when present) so
 * the model knows the linked codebase without exploring it first.
 */
export function renderLinkedReposSection(cwd: string): string {
	const links = loadLinks(cwd).slice(0, MAX_LINKED_REPOS)
	if (links.length === 0) return ""

	const parts: string[] = [
		"## Linked Repositories",
		"",
		"This repository is linked to the repositories below — separate codebases on disk that are coupled to this one. When you change this repo, consider whether the change ripples into a linked repo: inspect the linked code for impact and, when relevant, propose (or make, if the user asks) the matching changes there. You can read and edit files in these repos directly by their absolute paths.",
		"",
	]
	for (const link of links) {
		const exists = isDir(link.path)
		parts.push(`### ${path.basename(link.path)} — \`${link.path}\`${exists ? "" : "  (path not found)"}`)
		if (!exists) {
			parts.push("")
			continue
		}
		const agents = readLinkedAgents(link.path)
		parts.push("")
		if (agents) {
			parts.push("Its AGENTS.md:")
			parts.push("")
			parts.push(truncate(agents.trim(), MAX_AGENTS_CHARS))
		} else {
			parts.push("(no AGENTS.md found — explore the repo directly if you need its structure)")
		}
		parts.push("")
	}
	return parts.join("\n")
}
