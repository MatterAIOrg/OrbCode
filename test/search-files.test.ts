import assert from "node:assert/strict"
import { after, test } from "node:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
	createSearchFingerprint,
	disposeSearchFiles,
	formatSearchPage,
	parseSearchCursor,
	searchFiles,
	stripSearchPageMetadataForDisplay,
} from "../src/tools/executors/searchFiles.js"
import { describeToolCall } from "../src/tools/index.js"

const roots: string[] = []

async function fixture(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbcode-search-"))
	roots.push(root)
	await fs.mkdir(path.join(root, "src"))
	await fs.writeFile(path.join(root, "src", "alpha.ts"), "const needle = 1\nneedle += 1\n")
	await fs.writeFile(path.join(root, "src", "notes.md"), "needle in markdown\n")
	await fs.writeFile(path.join(root, "outside.ts"), "needle outside scope\n")
	return root
}

after(async () => {
	await disposeSearchFiles().catch(() => {})
	await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

test("uses FFF by default with compact file filtering", async () => {
	const cwd = await fixture()
	const result = await searchFiles(
		{ path: "src", regex: "needle", file_pattern: "*.ts", cursor: "null", max_results: 50, context_lines: 0 },
		{ cwd, token: "", getTodos: () => "", setTodos: () => {} },
	)

	assert.equal(result.isError, undefined)
	assert.match(result.text, /^Engine: fff/m)
	assert.match(result.text, /# src\/alpha\.ts/)
	assert.doesNotMatch(result.text, /notes\.md/)
	assert.doesNotMatch(result.text, /outside\.ts/)
})

test("continues native FFF pagination without dropping matches", async () => {
	const cwd = await fixture()
	await fs.writeFile(path.join(cwd, "src", "beta.ts"), "const needle = 2\n")
	const context = { cwd, token: "", getTodos: () => "", setTodos: () => {} }
	const args = {
		path: "src",
		regex: "needle",
		file_pattern: "*.ts",
		cursor: null as string | null,
		max_results: 1,
		context_lines: 0,
	}
	const first = await searchFiles(args, context)
	assert.match(first.text, /^Engine: fff/m)
	const cursor = /^Next cursor: (fff:\S+)$/m.exec(first.text)?.[1]
	assert.ok(cursor)

	const second = await searchFiles({ ...args, cursor }, context)
	assert.match(second.text, /^Engine: fff/m)
	assert.match(`${first.text}\n${second.text}`, /src\/alpha\.ts/)
	assert.match(`${first.text}\n${second.text}`, /src\/beta\.ts/)
})

test("treats route-directory metacharacters literally and anchors nested globs to path", async () => {
	const cwd = await fixture()
	await fs.mkdir(path.join(cwd, "src", "components"))
	await fs.writeFile(path.join(cwd, "src", "components", "plain.ts"), "const routeNeedle = true\n")
	const context = { cwd, token: "", getTodos: () => "", setTodos: () => {} }
	const normal = await searchFiles(
		{
			path: "src",
			regex: "routeNeedle",
			file_pattern: "components/*.ts",
			cursor: null,
			max_results: 50,
			context_lines: 0,
		},
		context,
	)
	assert.match(normal.text, /components\/plain\.ts/)

	const route = path.join(cwd, "src", "routes", "[id]")
	await fs.mkdir(path.join(route, "components"), { recursive: true })
	await fs.writeFile(path.join(route, "components", "view.ts"), "const routeNeedle = true\n")
	await fs.writeFile(path.join(route, "other.ts"), "const routeNeedle = false\n")

	const result = await searchFiles(
		{
			path: "src/routes/[id]",
			regex: "routeNeedle",
			file_pattern: "components/*.ts",
			cursor: null,
			max_results: 50,
			context_lines: 0,
		},
		context,
	)

	assert.equal(result.isError, undefined)
	assert.match(result.text, /^Engine: fff/m)
	assert.match(result.text, /components\/view\.ts/)
	assert.doesNotMatch(result.text, /other\.ts/)
})

test("binds opaque cursors to the originating search", () => {
	const fingerprint = createSearchFingerprint("/workspace/src", "needle", "*.ts")
	const cursor = `fff:42:${fingerprint}`
	assert.deepEqual(parseSearchCursor(cursor, fingerprint), { engine: "fff", offset: 42, fingerprint })
	assert.throws(
		() => parseSearchCursor(cursor, createSearchFingerprint("/workspace/src", "different", "*.ts")),
		/different path, regex, or file_pattern/,
	)
	assert.equal(parseSearchCursor(" NULL ", fingerprint), null)
	assert.throws(() => parseSearchCursor("none", fingerprint), /search is complete/)
})

test("rejects fractional result and context limits", async () => {
	const cwd = await fixture()
	const result = await searchFiles(
		{ path: "src", regex: "needle", file_pattern: "*.ts", cursor: null, max_results: 1.5, context_lines: 0 },
		{ cwd, token: "", getTodos: () => "", setTodos: () => {} },
	)
	assert.equal(result.isError, true)
	assert.match(result.text, /max_results must be an integer/)
})

test("ripgrep preserves ignores, normalized patterns, and path-relative nested globs", async () => {
	const cwd = await fixture()
	await fs.mkdir(path.join(cwd, ".git"))
	await fs.mkdir(path.join(cwd, "node_modules", "dep"), { recursive: true })
	await fs.mkdir(path.join(cwd, "components"))
	await fs.writeFile(path.join(cwd, ".gitignore"), "ignored.ts\n")
	await fs.writeFile(path.join(cwd, "ignored.ts"), "needle ignored\n")
	await fs.writeFile(path.join(cwd, "node_modules", "dep", "index.ts"), "needle dependency\n")
	await fs.writeFile(path.join(cwd, "components", "view.ts"), "needle component\n")
	const context = { cwd, token: "", getTodos: () => "", setTodos: () => {} }

	const allFingerprint = createSearchFingerprint(cwd, "needle", undefined)
	const all = await searchFiles(
		{
			path: ".",
			regex: "needle",
			file_pattern: null,
			cursor: `ripgrep:0:${allFingerprint}`,
			max_results: 50,
			context_lines: 0,
		},
		context,
	)
	assert.equal(all.isError, undefined)
	assert.match(all.text, /^Engine: ripgrep/m)
	assert.match(all.text, /components\/view\.ts/)
	assert.doesNotMatch(all.text, /ignored\.ts|node_modules/)

	const nestedPattern = "components/*.ts"
	const nestedFingerprint = createSearchFingerprint(cwd, "needle", nestedPattern)
	const nested = await searchFiles(
		{
			path: ".",
			regex: "needle",
			file_pattern: nestedPattern,
			cursor: `ripgrep:0:${nestedFingerprint}`,
			max_results: 50,
			context_lines: 0,
		},
		context,
	)
	assert.equal(nested.isError, undefined)
	assert.match(nested.text, /components\/view\.ts/)
	assert.doesNotMatch(nested.text, /src\/alpha\.ts/)

	const extensionPattern = "*.ts"
	const extensionFingerprint = createSearchFingerprint(cwd, "needle", extensionPattern)
	const extension = await searchFiles(
		{
			path: ".",
			regex: "needle",
			file_pattern: ".ts",
			cursor: `ripgrep:0:${extensionFingerprint}`,
			max_results: 50,
			context_lines: 0,
		},
		context,
	)
	assert.equal(extension.isError, undefined)
	assert.match(extension.text, /components\/view\.ts/)
	assert.doesNotMatch(extension.text, /ignored\.ts|notes\.md|node_modules/)
})

test("keeps generated-directory exclusions and negative globs consistent across engines", async () => {
	const cwd = await fixture()
	for (const directory of ["dist", "build", "out"]) {
		await fs.mkdir(path.join(cwd, directory))
		await fs.writeFile(path.join(cwd, directory, "generated.ts"), "excludedNeedle generated\n")
	}
	await fs.mkdir(path.join(cwd, "src", "components"))
	await fs.writeFile(path.join(cwd, "src", "keep.ts"), "excludedNeedle keep\nnegativeNeedle keep\n")
	await fs.writeFile(path.join(cwd, "src", "components", "skip.ts"), "negativeNeedle component\n")
	await fs.writeFile(path.join(cwd, "src", "negative.md"), "negativeNeedle markdown\n")
	const context = { cwd, token: "", getTodos: () => "", setTodos: () => {} }

	const fff = await searchFiles(
		{ path: ".", regex: "excludedNeedle", file_pattern: "*.ts", cursor: null, max_results: 50, context_lines: 0 },
		context,
	)
	assert.match(fff.text, /^Engine: fff/m)
	assert.match(fff.text, /src\/keep\.ts/)
	assert.doesNotMatch(fff.text, /dist|build|out/)

	const rgFingerprint = createSearchFingerprint(cwd, "excludedNeedle", "*.ts")
	const rg = await searchFiles(
		{
			path: ".",
			regex: "excludedNeedle",
			file_pattern: "*.ts",
			cursor: `ripgrep:0:${rgFingerprint}`,
			max_results: 50,
			context_lines: 0,
		},
		context,
	)
	assert.match(rg.text, /src\/keep\.ts/)
	assert.doesNotMatch(rg.text, /dist|build|out/)

	const explicitDist = await searchFiles(
		{ path: "dist", regex: "excludedNeedle", file_pattern: "*.ts", cursor: null, max_results: 50, context_lines: 0 },
		context,
	)
	assert.match(explicitDist.text, /^Engine: fff/m)
	assert.match(explicitDist.text, /dist\/generated\.ts/)
	const explicitDistFingerprint = createSearchFingerprint(path.join(cwd, "dist"), "excludedNeedle", "*.ts")
	const explicitDistRg = await searchFiles(
		{
			path: "dist",
			regex: "excludedNeedle",
			file_pattern: "*.ts",
			cursor: `ripgrep:0:${explicitDistFingerprint}`,
			max_results: 50,
			context_lines: 0,
		},
		context,
	)
	assert.match(explicitDistRg.text, /dist\/generated\.ts/)

	const pathNegation = await searchFiles(
		{
			path: "src",
			regex: "negativeNeedle",
			file_pattern: "!components/**",
			cursor: null,
			max_results: 50,
			context_lines: 0,
		},
		context,
	)
	assert.match(pathNegation.text, /^Engine: fff/m)
	assert.match(pathNegation.text, /src\/keep\.ts/)
	assert.doesNotMatch(pathNegation.text, /components\/skip\.ts/)

	const extensionNegation = "!*.md"
	const negationFingerprint = createSearchFingerprint(path.join(cwd, "src"), "negativeNeedle", extensionNegation)
	const rgNegation = await searchFiles(
		{
			path: "src",
			regex: "negativeNeedle",
			file_pattern: extensionNegation,
			cursor: `ripgrep:0:${negationFingerprint}`,
			max_results: 50,
			context_lines: 0,
		},
		context,
	)
	assert.match(rgNegation.text, /src\/keep\.ts/)
	assert.doesNotMatch(rgNegation.text, /negative\.md/)
})

test("ripgrep pagination preserves an adjacent match on the next page", async () => {
	const cwd = await fixture()
	const directory = path.join(cwd, "paging")
	await fs.mkdir(directory)
	await fs.writeFile(path.join(directory, "adjacent.ts"), "needle one\nneedle two\nend\n")
	const context = { cwd, token: "", getTodos: () => "", setTodos: () => {} }
	const fingerprint = createSearchFingerprint(directory, "needle", "*.ts")
	const args = {
		path: "paging",
		regex: "needle",
		file_pattern: "*.ts",
		cursor: `ripgrep:0:${fingerprint}` as string | null,
		max_results: 1,
		context_lines: 1,
	}

	const first = await searchFiles(args, context)
	assert.equal(first.isError, undefined)
	assert.match(first.text, /^Engine: ripgrep/m)
	assert.match(first.text, /> 1:1 /)
	const cursor = /^Next cursor: (\S+)$/m.exec(first.text)?.[1]
	assert.ok(cursor)

	const second = await searchFiles({ ...args, cursor }, context)
	assert.equal(second.isError, undefined)
	assert.match(second.text, /> 2:1 /)
})

test("makes completed searches and tool summaries unambiguous", () => {
	const completed = formatSearchPage({ engine: "fff", matches: [], nextCursor: null })
	assert.match(completed, /Next cursor: none \(search complete; do not continue\)/)
	assert.equal(stripSearchPageMetadataForDisplay(completed), "")
	const page = formatSearchPage({
		engine: "fff",
		matches: [{ file: "src/a.ts", line: 4, column: 2, text: "needle" }],
		nextCursor: { engine: "fff", offset: 2, fingerprint: "0123456789abcdef" },
	})
	const visiblePage = stripSearchPageMetadataForDisplay(page)
	assert.doesNotMatch(visiblePage, /Engine:|Matches:|Next cursor:/)
	assert.match(visiblePage, /# src\/a\.ts\n> 4:2 \| needle/)
	assert.equal(
		describeToolCall("search_files", { path: "src", regex: "eido", file_pattern: "*.ts" }),
		"/eido/ in src · *.ts",
	)
	assert.equal(describeToolCall("search_files", { path: "src", regex: "eido", file_pattern: "null" }), "/eido/ in src")
})

test("marks and safely drains an FFF continuation fallback during cleanup", async () => {
	const cwd = await fixture()
	await fs.writeFile(path.join(cwd, "space file.ts"), "needle spaced\n")
	const filePattern = "space *.ts"
	const fingerprint = createSearchFingerprint(cwd, "needle", filePattern)
	const pending = searchFiles(
		{
			path: ".",
			regex: "needle",
			file_pattern: filePattern,
			cursor: `fff:1:${fingerprint}`,
			max_results: 50,
			context_lines: 0,
		},
		{ cwd, token: "", getTodos: () => "", setTodos: () => {} },
	)
	const disposing = disposeSearchFiles()
	const result = await pending
	await disposing
	assert.equal(result.isError, undefined)
	assert.match(result.text, /^Engine: ripgrep/m)
	assert.match(result.text, /^Restarted: yes$/m)
	assert.match(result.text, /space file\.ts/)
})

test("can initialize FFF again after session cleanup", async () => {
	const cwd = await fixture()
	const args = { path: "src", regex: "needle", file_pattern: "*.ts", cursor: null, max_results: 50, context_lines: 0 }
	const context = { cwd, token: "", getTodos: () => "", setTodos: () => {} }
	const first = await searchFiles(args, context)
	assert.match(first.text, /^Engine: fff/m)
	await disposeSearchFiles()
	const second = await searchFiles(args, context)
	assert.match(second.text, /^Engine: fff/m)
})
