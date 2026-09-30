/** node --import tsx bench/compare.ts <a.json> <b.json>  — per-arm medians/sums and per-task medians. */
import * as fs from "node:fs"
import type { RunMetrics } from "./run.js"

const load = (f: string) => JSON.parse(fs.readFileSync(f, "utf8")) as { label: string; results: RunMetrics[] }
const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b)
	const m = s.length >> 1
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const [a, b] = process.argv.slice(2).map(load)
const metrics: [string, (r: RunMetrics) => number][] = [
	["wall s", (r) => r.wallMs / 1000],
	["think s", (r) => r.reasoningMs / 1000],
	["ttft s", (r) => r.ttftMs / 1000],
	["stream s", (r) => r.streamMs / 1000],
	["steps", (r) => r.steps],
	["input k", (r) => r.inputTokens / 1000],
]
const pct = (x: number, y: number) => (x === 0 ? "n/a" : `${(((y - x) / x) * 100).toFixed(0)}%`)
console.log(`${"".padEnd(10)} ${a.label.padStart(10)} ${b.label.padStart(10)}   change   (median per run, all tasks)`)
for (const [name, f] of metrics) {
	const x = median(a.results.map(f))
	const y = median(b.results.map(f))
	console.log(`${name.padEnd(10)} ${x.toFixed(1).padStart(10)} ${y.toFixed(1).padStart(10)}   ${pct(x, y)}`)
}
const sum = (rs: RunMetrics[], f: (r: RunMetrics) => number) => rs.reduce((t, r) => t + f(r), 0)
console.log(`\npass: ${a.label} ${a.results.filter((r) => r.pass).length}/${a.results.length}  ${b.label} ${b.results.filter((r) => r.pass).length}/${b.results.length}`)
console.log(`total wall s: ${(sum(a.results, (r) => r.wallMs) / 1000).toFixed(0)} vs ${(sum(b.results, (r) => r.wallMs) / 1000).toFixed(0)}   total think s: ${(sum(a.results, (r) => r.reasoningMs) / 1000).toFixed(0)} vs ${(sum(b.results, (r) => r.reasoningMs) / 1000).toFixed(0)}`)
console.log("\nper task (median wall s / think s / steps):")
for (const id of [...new Set(a.results.map((r) => r.task))]) {
	const row = (x: { results: RunMetrics[] }) => {
		const rs = x.results.filter((r) => r.task === id)
		return `${median(rs.map((r) => r.wallMs / 1000)).toFixed(0).padStart(4)} / ${median(rs.map((r) => r.reasoningMs / 1000)).toFixed(0).padStart(3)} / ${median(rs.map((r) => r.steps)).toFixed(0)}`
	}
	console.log(`${id.padEnd(20)} ${row(a).padEnd(16)} ${row(b)}`)
}
