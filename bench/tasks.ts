import { spawnSync } from "node:child_process"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

export interface TaskContext {
	dir: string
	/** Final assistant answer (attempt_completion result or last text). */
	answer: string
}

export interface Verdict {
	pass: boolean
	detail: string
}

export interface BenchTask {
	id: string
	kind: "fix" | "refactor" | "feature" | "question" | "trivial" | "multi-file" | "legacy-edit" | "big-repo" | "long-feature"
	prompt: string
	/** Inject the planted inventory bugs into the fixture before the run. */
	bugs?: boolean
	/** Add the CRLF + tab-indented legacy module to the fixture. */
	legacy?: boolean
	/** Add the large generated module tree (one buggy module) to the fixture. */
	big?: boolean
	verify(ctx: TaskContext): Verdict
}

function run(dir: string, args: string[]): { ok: boolean; out: string } {
	const r = spawnSync("node", args, { cwd: dir, encoding: "utf8", timeout: 60_000 })
	return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-600) }
}

function npmTest(dir: string): Verdict {
	const r = run(dir, ["--test"])
	return { pass: r.ok, detail: r.ok ? "tests pass" : `tests fail: ${r.out.replace(/\s+/g, " ").slice(-240)}` }
}

/** Run a hidden test file that the agent never saw, against the agent's result. */
function hiddenTest(dir: string, name: string, source: string): Verdict {
	const file = path.join(dir, `${name}.hidden.test.js`)
	fs.writeFileSync(file, source)
	const r = run(dir, ["--test", file])
	fs.rmSync(file, { force: true })
	return { pass: r.ok, detail: r.ok ? "hidden test passes" : `hidden test fails: ${r.out.replace(/\s+/g, " ").slice(-240)}` }
}

function sha(file: string): string {
	return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex")
}

function all(...verdicts: Verdict[]): Verdict {
	const failed = verdicts.filter((v) => !v.pass)
	return failed.length === 0
		? { pass: true, detail: verdicts.map((v) => v.detail).join("; ") }
		: { pass: false, detail: failed.map((v) => v.detail).join("; ") }
}

function grepCount(dir: string, pattern: RegExp): number {
	let count = 0
	const walk = (d: string) => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			if (entry.name === ".git" || entry.name === "node_modules") continue
			const abs = path.join(d, entry.name)
			if (entry.isDirectory()) walk(abs)
			else if (pattern.test(fs.readFileSync(abs, "utf8"))) count++
		}
	}
	walk(dir)
	return count
}

// Hash of the pristine test file, so "fix the bug" can't be satisfied by editing the test.
let pristineInventoryTestHash = ""
export function setPristineHashes(dir: string): void {
	pristineInventoryTestHash = sha(path.join(dir, "test/inventory.test.js"))
}

/** Every line ending in `file` is CRLF (no bare LF) and no line is space-indented. */
function isPureCrlfWithTabs(file: string): boolean {
	const text = fs.readFileSync(file, "utf8")
	const bareLf = /(^|[^\r])\n/.test(text)
	const spaceIndented = /(^|\n)( {2,})\S/.test(text.replace(/\r/g, ""))
	return !bareLf && !spaceIndented
}

/** Harder tasks: tricky file formats, a large tree, and a long multi-layer change. */
export const EXTENDED_TASKS: BenchTask[] = [
	{
		id: "legacy-edit",
		kind: "legacy-edit",
		legacy: true,
		prompt:
			"In src/legacy/orders.js make two changes: `orderTotal` must never return a negative amount (clamp at 0 when a coupon exceeds the total), and `describeOrder` must say \"1 line\" (singular) instead of \"1 lines\". Keep the file's existing formatting conventions.",
		verify: ({ dir }) => {
			const file = path.join(dir, "src/legacy/orders.js")
			return all(
				hiddenTest(
					dir,
					"legacy",
					`import assert from "node:assert/strict"
import { test } from "node:test"
import { describeOrder, orderTotal } from "./src/legacy/orders.js"
test("legacy", () => {
	assert.equal(orderTotal({ lines: [{ priceCents: 100, qty: 1 }], coupon: { cents: 500 } }), 0)
	assert.equal(orderTotal({ lines: [{ priceCents: 100, qty: 3 }], coupon: { cents: 50 } }), 250)
	assert.equal(describeOrder({ id: 7, lines: [1] }), "Order 7: 1 line")
	assert.equal(describeOrder({ id: 7, lines: [1, 2] }), "Order 7: 2 lines")
})
`,
				),
				{
					pass: isPureCrlfWithTabs(file),
					detail: isPureCrlfWithTabs(file) ? "CRLF + tabs preserved" : "line endings or indentation were corrupted",
				},
			)
		},
	},
	{
		id: "big-repo-bug",
		kind: "big-repo",
		big: true,
		prompt: "`node --test test/gen.test.js` fails for one of the buckets. Find the root cause in the source and fix it (do not modify the tests).",
		verify: ({ dir }) => npmTest(dir),
	},
	{
		id: "long-feature",
		kind: "long-feature",
		prompt:
			"Add warehouse support to the inventory library: (1) items get a required `warehouse` field validated by a new `validateWarehouse` in src/utils/validate.js (format `W-` plus two digits, e.g. `W-01`); `Inventory.add` must throw `invalid warehouse: <value>` for anything else. (2) Add `Inventory.byWarehouse(code)` returning the items stored in that warehouse. (3) The report gets a right-aligned 'WH' column right after the Name column. (4) Update the sample data in src/cli.js and the README example to include warehouses. (5) Update the existing tests so they pass with the new required field, and add tests for validation, byWarehouse and the report column.",
		verify: ({ dir }) =>
			all(
				hiddenTest(
					dir,
					"warehouse",
					`import assert from "node:assert/strict"
import { test } from "node:test"
import { Inventory } from "./src/inventory.js"
import { renderReport } from "./src/report.js"
import { validateWarehouse } from "./src/utils/validate.js"
test("warehouse", () => {
	assert.equal(validateWarehouse("W-01"), true)
	assert.equal(validateWarehouse("W-1"), false)
	assert.equal(validateWarehouse("X-01"), false)
	const inv = new Inventory()
	inv.add({ sku: "AB-100", name: "widget", category: "tools", priceCents: 100, quantity: 2, warehouse: "W-01" })
	inv.add({ sku: "CD-200", name: "gadget", category: "tools", priceCents: 50, quantity: 4, warehouse: "W-02" })
	assert.deepEqual(inv.byWarehouse("W-02").map((i) => i.sku), ["CD-200"])
	assert.throws(
		() => inv.add({ sku: "EF-300", name: "c", category: "toys", priceCents: 1, quantity: 1, warehouse: "bad" }),
		/invalid warehouse: bad/,
	)
	assert.match(renderReport(inv), /WH/)
	assert.match(renderReport(inv), /W-01/)
})
`,
				),
				npmTest(dir),
				(() => {
					const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8")
					const cli = fs.readFileSync(path.join(dir, "src/cli.js"), "utf8")
					const ok = /warehouse/i.test(readme) && /warehouse/.test(cli)
					return { pass: ok, detail: ok ? "README and cli updated" : "README or cli.js not updated" }
				})(),
			),
	},
]

export const TASKS: BenchTask[] = [
	{
		id: "fix-bugs",
		kind: "fix",
		bugs: true,
		prompt: "`npm test` has failing tests in test/inventory.test.js. Find and fix the bugs in the source code (do not modify the tests).",
		verify: ({ dir }) => {
			const untouched = sha(path.join(dir, "test/inventory.test.js")) === pristineInventoryTestHash
			return all({ pass: untouched, detail: untouched ? "tests untouched" : "test file was modified" }, npmTest(dir))
		},
	},
	{
		id: "rename",
		kind: "refactor",
		prompt: "Rename the function `formatPrice` to `formatCents` everywhere it is used or documented (source, tests and README).",
		verify: ({ dir }) => {
			const leftovers = grepCount(dir, /formatPrice/)
			const uses = grepCount(dir, /formatCents/)
			return all(
				{ pass: leftovers === 0, detail: leftovers === 0 ? "no formatPrice left" : `${leftovers} files still mention formatPrice` },
				{ pass: uses >= 4, detail: `${uses} files use formatCents` },
			)
		},
	},
	{
		id: "add-method",
		kind: "feature",
		prompt:
			"Add an `Inventory.byCategory()` method that returns an object mapping each category name to the total stock value of that category in cents (price times quantity). Add a test for it in test/inventory.test.js.",
		verify: ({ dir }) =>
			all(
				hiddenTest(
					dir,
					"by-category",
					`import assert from "node:assert/strict"
import { test } from "node:test"
import { Inventory } from "./src/inventory.js"
test("byCategory", () => {
	const inv = new Inventory()
	inv.add({ sku: "AB-100", name: "a", category: "tools", priceCents: 100, quantity: 2 })
	inv.add({ sku: "CD-200", name: "b", category: "tools", priceCents: 50, quantity: 4 })
	inv.add({ sku: "EF-300", name: "c", category: "toys", priceCents: 10, quantity: 3 })
	assert.deepEqual({ ...inv.byCategory() }, { tools: 400, toys: 30 })
})
`,
				),
				(() => {
					const src = fs.readFileSync(path.join(dir, "test/inventory.test.js"), "utf8")
					const added = /byCategory/.test(src)
					return { pass: added, detail: added ? "test added" : "no byCategory test added" }
				})(),
			),
	},
	{
		id: "question",
		kind: "question",
		prompt:
			"Answer briefly, without changing any files: which function decides which items are listed as low stock in the report, and what is the threshold value the report uses?",
		verify: ({ answer }) => {
			const hasFn = /lowStock/.test(answer)
			const hasNum = /\b5\b/.test(answer)
			return { pass: hasFn && hasNum, detail: hasFn && hasNum ? "answer correct" : `answer missing ${!hasFn ? "lowStock " : ""}${!hasNum ? "5" : ""}` }
		},
	},
	{
		id: "trivial-edit",
		kind: "trivial",
		prompt: "Change the currency symbol in the price formatter from $ to € (and update whatever tests and README examples depend on it).",
		verify: ({ dir }) =>
			all(
				hiddenTest(
					dir,
					"euro",
					`import assert from "node:assert/strict"
import { test } from "node:test"
import * as money from "./src/money.js"
test("euro", () => {
	const fn = money.formatPrice ?? money.formatCents
	assert.equal(fn(1234), "€12.34")
	assert.equal(fn(-250), "-€2.50")
})
`,
				),
				npmTest(dir),
			),
	},
	{
		id: "multi-file-feature",
		kind: "multi-file",
		prompt:
			"Add an optional `discountPct` field (default 0) to inventory items. `Inventory.add` should accept it, `Inventory.total()` should apply it to each item's price using the existing `applyDiscount` helper, and the report should show a new right-aligned 'Disc' column with the percentage (e.g. `10%`). Keep existing tests passing.",
		verify: ({ dir }) =>
			all(
				hiddenTest(
					dir,
					"discount",
					`import assert from "node:assert/strict"
import { test } from "node:test"
import { Inventory } from "./src/inventory.js"
import { renderReport } from "./src/report.js"
test("discount", () => {
	const inv = new Inventory()
	inv.add({ sku: "AB-100", name: "widget", category: "tools", priceCents: 1000, quantity: 2, discountPct: 10 })
	inv.add({ sku: "CD-200", name: "gadget", category: "tools", priceCents: 500, quantity: 1 })
	assert.equal(inv.total(), 900 * 2 + 500)
	const report = renderReport(inv)
	assert.match(report, /Disc/)
	assert.match(report, /10%/)
})
`,
				),
				npmTest(dir),
			),
	},
]
