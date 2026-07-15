import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { resolveProjectDir } from "../config/links.js"
import type {
	InstalledPlugin,
	InstalledPluginMetadata,
	MarketplaceJson,
	MarketplacePlugin,
	PluginInventory,
	PluginSource,
} from "./types.js"

export const OFFICIAL_MARKETPLACE_NAME = "claude-plugins-official"
export const OFFICIAL_MARKETPLACE_URL =
	"https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json"

const OFFICIAL_REPO_URL = "https://github.com/anthropics/claude-plugins-official.git"
const METADATA_FILE = ".orb-plugin.json"
const GIT_TIMEOUT_MS = 120_000

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readJson(filePath: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>
	} catch {
		return undefined
	}
}

export function pluginAuthor(plugin: MarketplacePlugin): string | undefined {
	if (typeof plugin.author === "string") return plugin.author
	return plugin.author?.name
}

export async function fetchOfficialMarketplace(): Promise<MarketplaceJson> {
	const response = await fetch(OFFICIAL_MARKETPLACE_URL)
	if (!response.ok) throw new Error(`Failed to fetch marketplace: ${response.statusText}`)
	const marketplace = (await response.json()) as MarketplaceJson
	if (!marketplace || !Array.isArray(marketplace.plugins)) {
		throw new Error("The official marketplace returned an invalid catalog.")
	}
	return marketplace
}

function validatePluginName(name: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
		throw new Error(`Invalid plugin name "${name}".`)
	}
}

function resolveInside(root: string, relativePath: string): string {
	const resolvedRoot = path.resolve(root)
	const target = path.resolve(resolvedRoot, relativePath)
	if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
		throw new Error(`Plugin source path escapes its repository: ${relativePath}`)
	}
	return target
}

interface GitSource {
	url: string
	revision: string
	subdir: string
}

function resolveGitSource(source: PluginSource): GitSource {
	if (typeof source === "string") {
		return {
			url: OFFICIAL_REPO_URL,
			revision: "main",
			subdir: source.replace(/^\.\//, ""),
		}
	}
	if (source.source === "npm") {
		throw new Error("npm-packaged plugins are not supported yet.")
	}
	if (source.source === "github") {
		if (!source.repo || !/^[^/]+\/[^/]+$/.test(source.repo)) {
			throw new Error("Invalid GitHub plugin source.")
		}
		return {
			url: `https://github.com/${source.repo}.git`,
			revision: source.sha || source.commit || source.ref || "HEAD",
			subdir: source.path || "",
		}
	}
	if (!source.url) throw new Error("Plugin source is missing its git URL.")
	return {
		url: source.url,
		revision: source.sha || source.commit || source.ref || "HEAD",
		subdir: source.source === "git-subdir" ? source.path || "" : source.path || "",
	}
}

function runGit(args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			args,
			{
				timeout: GIT_TIMEOUT_MS,
				maxBuffer: 4 * 1024 * 1024,
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			},
			(error, _stdout, stderr) => {
				if (!error) {
					resolve()
					return
				}
				const detail = String(stderr || error.message).trim()
				reject(new Error(detail || "git failed while downloading the plugin"))
			},
		)
	})
}

function isInside(root: string, target: string): boolean {
	const resolvedRoot = path.resolve(root)
	const resolvedTarget = path.resolve(target)
	return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep)
}

/** Dereference a marketplace-internal symlink into the plugin cache. */
function copyDereferenced(source: string, destination: string, allowedRoot: string, seen = new Set<string>()): void {
	const realSource = fs.realpathSync(source)
	if (!isInside(allowedRoot, realSource) || seen.has(realSource)) return
	const nextSeen = new Set(seen).add(realSource)
	const stat = fs.statSync(realSource)
	if (stat.isDirectory()) {
		fs.mkdirSync(destination, { recursive: true })
		for (const entry of fs.readdirSync(realSource)) {
			copyDereferenced(path.join(realSource, entry), path.join(destination, entry), allowedRoot, nextSeen)
		}
		return
	}
	if (!stat.isFile()) return
	fs.mkdirSync(path.dirname(destination), { recursive: true })
	fs.copyFileSync(realSource, destination)
	fs.chmodSync(destination, stat.mode)
}

/** Copy a checked-out plugin using Claude's safe cache-style symlink rules. */
function copyPluginTree(
	sourceRoot: string,
	destinationRoot: string,
	current = sourceRoot,
	allowedRoot = sourceRoot,
): void {
	fs.mkdirSync(destinationRoot, { recursive: true })
	for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
		if (entry.name === ".git") continue
		const sourcePath = path.join(current, entry.name)
		const relative = path.relative(sourceRoot, sourcePath)
		const destinationPath = path.join(destinationRoot, relative)
		const stat = fs.lstatSync(sourcePath)
		if (stat.isSymbolicLink()) {
			const link = fs.readlinkSync(sourcePath)
			const target = path.resolve(path.dirname(sourcePath), link)
			if (isInside(sourceRoot, target)) {
				fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
				fs.symlinkSync(link, destinationPath)
			} else if (isInside(allowedRoot, target) && fs.existsSync(target)) {
				copyDereferenced(target, destinationPath, allowedRoot)
			}
			continue
		}
		if (stat.isDirectory()) {
			copyPluginTree(sourceRoot, destinationRoot, sourcePath, allowedRoot)
			continue
		}
		if (!stat.isFile()) continue
		fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
		fs.copyFileSync(sourcePath, destinationPath)
		fs.chmodSync(destinationPath, stat.mode)
	}
}

function metadataFor(plugin: MarketplacePlugin, marketplace: string): InstalledPluginMetadata {
	return {
		schemaVersion: 1,
		name: plugin.name,
		marketplace,
		description: plugin.description,
		author: pluginAuthor(plugin),
		category: plugin.category,
		homepage: plugin.homepage,
		version: plugin.version,
		source: plugin.source,
		skills: plugin.skills,
		commands: plugin.commands,
		agents: plugin.agents,
		hooks: plugin.hooks,
		mcpServers: plugin.mcpServers,
		strict: plugin.strict,
		installedAt: new Date().toISOString(),
	}
}

/** Install the complete plugin bundle at its pinned marketplace revision. */
export async function installMarketplacePlugin(
	plugin: MarketplacePlugin,
	cwd = process.cwd(),
	marketplace = OFFICIAL_MARKETPLACE_NAME,
): Promise<InstalledPlugin> {
	validatePluginName(plugin.name)
	const source = resolveGitSource(plugin.source)
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-plugin-"))
	const checkout = path.join(tempRoot, "repo")
	const pluginsDir = path.join(resolveProjectDir(cwd), "plugins")
	const staging = path.join(pluginsDir, `.${plugin.name}.install-${process.pid}-${Date.now()}`)
	const destination = path.join(pluginsDir, plugin.name)
	const backup = path.join(pluginsDir, `.${plugin.name}.backup-${process.pid}-${Date.now()}`)

	try {
		await runGit(["init", "--quiet", checkout])
		await runGit(["-C", checkout, "remote", "add", "origin", source.url])
		await runGit(["-C", checkout, "fetch", "--quiet", "--depth", "1", "origin", source.revision])
		await runGit(["-C", checkout, "checkout", "--quiet", "--detach", "FETCH_HEAD"])

		const pluginRoot = resolveInside(checkout, source.subdir)
		if (!fs.existsSync(pluginRoot) || !fs.statSync(pluginRoot).isDirectory()) {
			throw new Error(`Plugin source directory was not found: ${source.subdir || "."}`)
		}

		fs.mkdirSync(pluginsDir, { recursive: true })
		copyPluginTree(pluginRoot, staging, pluginRoot, checkout)
		fs.writeFileSync(
			path.join(staging, METADATA_FILE),
			JSON.stringify(metadataFor(plugin, marketplace), null, "\t") + "\n",
		)

		if (fs.existsSync(destination)) fs.renameSync(destination, backup)
		try {
			fs.renameSync(staging, destination)
		} catch (error) {
			if (fs.existsSync(backup)) fs.renameSync(backup, destination)
			throw error
		}
		fs.rmSync(backup, { recursive: true, force: true })
		return readInstalledPlugin(destination)
	} finally {
		fs.rmSync(staging, { recursive: true, force: true })
		fs.rmSync(tempRoot, { recursive: true, force: true })
	}
}

function countMarkdownFiles(dir: string): number {
	let count = 0
	let entries: fs.Dirent[]
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true })
	} catch {
		return 0
	}
	for (const entry of entries) {
		const item = path.join(dir, entry.name)
		if (entry.isDirectory()) count += countMarkdownFiles(item)
		else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) count++
	}
	return count
}

function countSkillFiles(dir: string): number {
	let count = 0
	let entries: fs.Dirent[]
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true })
	} catch {
		return 0
	}
	for (const entry of entries) {
		const item = path.join(dir, entry.name)
		if (entry.isDirectory()) count += countSkillFiles(item)
		else if (entry.isFile() && entry.name === "SKILL.md") count++
	}
	return count
}

function mcpServerCount(pluginDir: string, metadata?: InstalledPluginMetadata): number {
	const manifest = readJson(path.join(pluginDir, ".claude-plugin", "plugin.json"))
	const candidates: unknown[] = [metadata?.mcpServers, manifest?.mcpServers]
	const mcpFile = readJson(path.join(pluginDir, ".mcp.json"))
	if (mcpFile?.mcpServers) candidates.push(mcpFile.mcpServers)
	let count = 0
	for (const candidate of candidates) {
		if (isPlainObject(candidate)) count += Object.keys(candidate).length
		if (typeof candidate === "string") {
			const custom = readJson(resolveInside(pluginDir, candidate))
			const servers = custom?.mcpServers ?? custom
			if (isPlainObject(servers)) count += Object.keys(servers).length
		}
	}
	return count
}

export function inspectPlugin(pluginDir: string, metadata?: InstalledPluginMetadata): PluginInventory {
	return {
		skills: countSkillFiles(path.join(pluginDir, "skills")) + (fs.existsSync(path.join(pluginDir, "SKILL.md")) ? 1 : 0),
		commands: countMarkdownFiles(path.join(pluginDir, "commands")),
		agents: countMarkdownFiles(path.join(pluginDir, "agents")),
		mcpServers: mcpServerCount(pluginDir, metadata),
		hooks: fs.existsSync(path.join(pluginDir, "hooks", "hooks.json")) ? 1 : 0,
	}
}

export function readInstalledPlugin(pluginDir: string): InstalledPlugin {
	const metadata = readJson(path.join(pluginDir, METADATA_FILE)) as InstalledPluginMetadata | undefined
	const manifest = readJson(path.join(pluginDir, ".claude-plugin", "plugin.json"))
	return {
		name: metadata?.name || (typeof manifest?.name === "string" ? manifest.name : path.basename(pluginDir)),
		description:
			metadata?.description || (typeof manifest?.description === "string" ? manifest.description : ""),
		author: metadata?.author,
		dir: pluginDir,
		metadata,
		inventory: inspectPlugin(pluginDir, metadata),
	}
}

export function installedPluginDirs(cwd = process.cwd()): string[] {
	const pluginsDir = path.join(resolveProjectDir(cwd), "plugins")
	try {
		return fs
			.readdirSync(pluginsDir, { withFileTypes: true })
			.filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith("."))
			.map((entry) => path.join(pluginsDir, entry.name))
	} catch {
		return []
	}
}

export function listInstalledPlugins(cwd = process.cwd()): InstalledPlugin[] {
	return installedPluginDirs(cwd).map(readInstalledPlugin).sort((a, b) => a.name.localeCompare(b.name))
}

export function uninstallPlugin(plugin: InstalledPlugin): void {
	fs.rmSync(plugin.dir, { recursive: true, force: true })
}
