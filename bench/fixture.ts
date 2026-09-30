import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

/** A small ESM inventory library (no dependencies) that the benchmark tasks edit. */
export const FIXTURE_FILES: Record<string, string> = {
	"package.json": JSON.stringify({ name: "inventory-demo", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",

	"README.md": `# inventory-demo

Tiny inventory library.

\`\`\`js
import { Inventory } from "./src/inventory.js"
import { formatPrice } from "./src/money.js"

const inv = new Inventory()
inv.add({ sku: "AB-100", name: "widget", category: "tools", priceCents: 1250, quantity: 4 })
console.log(formatPrice(inv.total())) // $50.00
\`\`\`

Run \`npm test\` to run the tests. \`node src/cli.js\` prints a stock report.
`,

	"src/money.js": `/** Format an integer number of cents as a display price. */
export function formatPrice(cents) {
	const sign = cents < 0 ? "-" : ""
	const abs = Math.abs(cents)
	const dollars = Math.floor(abs / 100)
	const rest = String(abs % 100).padStart(2, "0")
	return \`\${sign}$\${dollars}.\${rest}\`
}

export function parsePrice(text) {
	const cleaned = text.replace(/[^0-9.]/g, "")
	return Math.round(parseFloat(cleaned) * 100)
}
`,

	"src/pricing.js": `/** Apply a percentage discount (0-100) to a price in cents. */
export function applyDiscount(cents, pct) {
	if (pct < 0 || pct > 100) throw new RangeError("pct must be between 0 and 100")
	return Math.round(cents * (1 - pct / 100))
}

export function addTax(cents, rate) {
	return Math.round(cents * (1 + rate))
}
`,

	"src/utils/strings.js": `export function titleCase(text) {
	return text.replace(/\\b\\w/g, (c) => c.toUpperCase())
}

export function padRight(text, width) {
	return text.length >= width ? text : text + " ".repeat(width - text.length)
}

export function padLeft(text, width) {
	return text.length >= width ? text : " ".repeat(width - text.length) + text
}
`,

	"src/utils/validate.js": `const SKU_PATTERN = /^[A-Z]{2}-\\d{3}$/

export function validateSku(sku) {
	return SKU_PATTERN.test(sku)
}

export function assertPositiveInt(value, label) {
	if (!Number.isInteger(value) || value < 0) {
		throw new TypeError(\`\${label} must be a non-negative integer\`)
	}
}
`,

	"src/inventory.js": `import { assertPositiveInt, validateSku } from "./utils/validate.js"

export class Inventory {
	constructor() {
		/** @type {Map<string, {sku: string, name: string, category: string, priceCents: number, quantity: number}>} */
		this.items = new Map()
	}

	add(item) {
		if (!validateSku(item.sku)) throw new Error(\`invalid sku: \${item.sku}\`)
		assertPositiveInt(item.priceCents, "priceCents")
		assertPositiveInt(item.quantity, "quantity")
		const existing = this.items.get(item.sku)
		if (existing) {
			existing.quantity += item.quantity
		} else {
			this.items.set(item.sku, { ...item })
		}
	}

	remove(sku, quantity) {
		const item = this.items.get(sku)
		if (!item) throw new Error(\`unknown sku: \${sku}\`)
		if (quantity > item.quantity) throw new Error("not enough stock")
		item.quantity -= quantity
		if (item.quantity === 0) this.items.delete(sku)
	}

	get(sku) {
		return this.items.get(sku)
	}

	list() {
		return [...this.items.values()]
	}

	/** Total value of all stock, in cents. */
	total() {
		let sum = 0
		for (const item of this.items.values()) {
			sum += item.priceCents * item.quantity
		}
		return sum
	}

	/** Items whose quantity is strictly below the threshold. */
	lowStock(threshold) {
		return this.list().filter((item) => item.quantity < threshold)
	}
}
`,

	"src/report.js": `import { formatPrice } from "./money.js"
import { padLeft, padRight, titleCase } from "./utils/strings.js"

export const LOW_STOCK_THRESHOLD = 5

export function renderReport(inventory) {
	const lines = [padRight("SKU", 10) + padRight("Name", 16) + padLeft("Qty", 5) + padLeft("Price", 10)]
	for (const item of inventory.list()) {
		lines.push(
			padRight(item.sku, 10) +
				padRight(titleCase(item.name), 16) +
				padLeft(String(item.quantity), 5) +
				padLeft(formatPrice(item.priceCents), 10),
		)
	}
	lines.push("")
	lines.push("Total: " + formatPrice(inventory.total()))
	const low = inventory.lowStock(LOW_STOCK_THRESHOLD)
	if (low.length > 0) {
		lines.push("Low stock: " + low.map((item) => item.sku).join(", "))
	}
	return lines.join("\\n")
}
`,

	"src/cli.js": `import { Inventory } from "./inventory.js"
import { renderReport } from "./report.js"

const inventory = new Inventory()
inventory.add({ sku: "AB-100", name: "widget", category: "tools", priceCents: 1250, quantity: 4 })
inventory.add({ sku: "CD-200", name: "gadget", category: "tools", priceCents: 999, quantity: 12 })
inventory.add({ sku: "EF-300", name: "gizmo", category: "toys", priceCents: 500, quantity: 20 })

console.log(renderReport(inventory))
`,

	"src/index.js": `export { Inventory } from "./inventory.js"
export { formatPrice, parsePrice } from "./money.js"
export { applyDiscount, addTax } from "./pricing.js"
export { renderReport } from "./report.js"
`,

	"test/money.test.js": `import assert from "node:assert/strict"
import { test } from "node:test"

import { formatPrice, parsePrice } from "../src/money.js"

test("formatPrice formats cents", () => {
	assert.equal(formatPrice(1234), "$12.34")
	assert.equal(formatPrice(5), "$0.05")
	assert.equal(formatPrice(-250), "-$2.50")
})

test("parsePrice parses text", () => {
	assert.equal(parsePrice("$12.34"), 1234)
})
`,

	"test/pricing.test.js": `import assert from "node:assert/strict"
import { test } from "node:test"

import { addTax, applyDiscount } from "../src/pricing.js"

test("applyDiscount", () => {
	assert.equal(applyDiscount(1000, 10), 900)
	assert.throws(() => applyDiscount(1000, 101), RangeError)
})

test("addTax", () => {
	assert.equal(addTax(1000, 0.2), 1200)
})
`,

	"test/inventory.test.js": `import assert from "node:assert/strict"
import { test } from "node:test"

import { Inventory } from "../src/inventory.js"

function sample() {
	const inv = new Inventory()
	inv.add({ sku: "AB-100", name: "widget", category: "tools", priceCents: 1000, quantity: 3 })
	inv.add({ sku: "CD-200", name: "gadget", category: "toys", priceCents: 250, quantity: 8 })
	return inv
}

test("add merges quantities", () => {
	const inv = sample()
	inv.add({ sku: "AB-100", name: "widget", category: "tools", priceCents: 1000, quantity: 2 })
	assert.equal(inv.get("AB-100").quantity, 5)
})

test("remove deletes empty items", () => {
	const inv = sample()
	inv.remove("CD-200", 8)
	assert.equal(inv.get("CD-200"), undefined)
})

test("total is price times quantity", () => {
	assert.equal(sample().total(), 3 * 1000 + 8 * 250)
})

test("lowStock is strictly below threshold", () => {
	const inv = sample()
	assert.deepEqual(inv.lowStock(3).map((i) => i.sku), [])
	assert.deepEqual(inv.lowStock(4).map((i) => i.sku), ["AB-100"])
})
`,

	"test/report.test.js": `import assert from "node:assert/strict"
import { test } from "node:test"

import { Inventory } from "../src/inventory.js"
import { renderReport } from "../src/report.js"

test("report shows total", () => {
	const inv = new Inventory()
	inv.add({ sku: "AB-100", name: "widget", category: "tools", priceCents: 1000, quantity: 10 })
	assert.match(renderReport(inv), /Total: \\$100\\.00/)
})
`,
}

/** Bugs injected for the fix task: total() ignores quantity, lowStock is off by one. */
function injectBugs(dir: string): void {
	const file = path.join(dir, "src/inventory.js")
	const src = fs
		.readFileSync(file, "utf8")
		.replace("sum += item.priceCents * item.quantity", "sum += item.priceCents")
		.replace("item.quantity < threshold", "item.quantity <= threshold")
	fs.writeFileSync(file, src)
}

/** A legacy module with CRLF line endings and tab indentation, like many real repos. */
const LEGACY_ORDERS = [
	"export function orderTotal(order) {",
	"\tlet total = 0",
	"\tfor (const line of order.lines) {",
	"\t\ttotal += line.priceCents * line.qty",
	"\t}",
	"\tif (order.coupon) {",
	"\t\ttotal = total - order.coupon.cents",
	"\t}",
	"\treturn total",
	"}",
	"",
	"export function describeOrder(order) {",
	'\treturn "Order " + order.id + ": " + order.lines.length + " lines"',
	"}",
	"",
].join("\r\n")

function addLegacy(dir: string): void {
	fs.mkdirSync(path.join(dir, "src/legacy"), { recursive: true })
	fs.writeFileSync(path.join(dir, "src/legacy/orders.js"), LEGACY_ORDERS)
	fs.writeFileSync(
		path.join(dir, "test/orders.test.js"),
		[
			'import assert from "node:assert/strict"',
			'import { test } from "node:test"',
			'import { describeOrder, orderTotal } from "../src/legacy/orders.js"',
			"",
			'test("orderTotal sums lines", () => {',
			"\tassert.equal(orderTotal({ lines: [{ priceCents: 100, qty: 2 }] }), 200)",
			"})",
			"",
			'test("describeOrder counts lines", () => {',
			'\tassert.match(describeOrder({ id: 1, lines: [1, 2] }), /2 lines/)',
			"})",
			"",
		].join("\n"),
	)
}

/** Number of generated modules in the big fixture, and the one carrying the bug. */
export const BIG_MODULES = 40
export const BIG_BUG_MODULE = 27

/**
 * Many similar generated modules plus one test that exercises all of them, with a
 * bug in a single module: finding it means running the tests and tracing the
 * failure through a large tree instead of a handful of files.
 */
function addBig(dir: string): void {
	fs.mkdirSync(path.join(dir, "src/gen"), { recursive: true })
	const exports: string[] = []
	for (let k = 0; k < BIG_MODULES; k++) {
		const sign = k === BIG_BUG_MODULE ? "-" : "+"
		const filler = Array.from(
			{ length: 6 },
			(_, j) =>
				`/** Helper ${j} for bucket ${k}: clamps a value into the bucket range. */\nfunction clamp${j}(value) {\n\tconst low = ${k * 10 + j}\n\tconst high = low + 1000\n\treturn Math.min(high, Math.max(low, value))\n}\n`,
		).join("\n")
		fs.writeFileSync(
			path.join(dir, `src/gen/mod${k}.js`),
			`// Scoring rules for bucket ${k}.\nconst WEIGHT = ${k + 1}\n\n${filler}\n/** Normalize one raw value for bucket ${k}. */\nexport function normalize${k}(value) {\n\treturn value * 2 ${sign} ${k}\n}\n\n/** Weighted score of a list of raw values for bucket ${k}. */\nexport function score${k}(values) {\n\treturn values.reduce((sum, value) => sum + normalize${k}(value) * WEIGHT, 0)\n}\n\nexport const unused${k} = [clamp0, clamp1, clamp2, clamp3, clamp4, clamp5]\n`,
		)
		exports.push(`export { score${k} } from "./mod${k}.js"`)
	}
	fs.writeFileSync(path.join(dir, "src/gen/index.js"), exports.join("\n") + "\n")
	const cases = Array.from({ length: BIG_MODULES }, (_, k) => `\t[${k}, score${k}, ${(k + 1) * (12 + 3 * k)}],`).join("\n")
	const names = Array.from({ length: BIG_MODULES }, (_, k) => `score${k}`).join(", ")
	fs.writeFileSync(
		path.join(dir, "test/gen.test.js"),
		`import assert from "node:assert/strict"\nimport { test } from "node:test"\nimport { ${names} } from "../src/gen/index.js"\n\nconst cases = [\n${cases}\n]\n\nfor (const [k, fn, expected] of cases) {\n\ttest(\`bucket \${k} scores [1, 2, 3]\`, () => {\n\t\tassert.equal(fn([1, 2, 3]), expected)\n\t})\n}\n`,
	)
}

export interface FixtureOptions {
	/** Inject the planted inventory bugs. */
	bugs?: boolean
	/** Add the CRLF + tab-indented legacy module. */
	legacy?: boolean
	/** Add the large generated module tree with one buggy module. */
	big?: boolean
}

/** Write the fixture into `dir` and commit it so the agent sees a clean git repo. */
export function createFixture(dir: string, options: FixtureOptions = {}): void {
	for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
		const abs = path.join(dir, rel)
		fs.mkdirSync(path.dirname(abs), { recursive: true })
		fs.writeFileSync(abs, content)
	}
	if (options.bugs) injectBugs(dir)
	if (options.legacy) addLegacy(dir)
	if (options.big) addBig(dir)
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@example.com", ...args], {
			cwd: dir,
			stdio: "ignore",
		})
	git("init", "-q", "-b", "main")
	git("add", "-A")
	git("commit", "-q", "-m", "initial")
}
