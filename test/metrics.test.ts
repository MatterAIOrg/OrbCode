import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
	getGitHead,
	normalizeGitRemote,
	observeGitCommits,
} from "../src/api/metrics.js"

test("normalizes Git remotes without leaking credentials", () => {
	assert.equal(
		normalizeGitRemote("https://user:secret@github.com/acme/widget.git?token=bad#fragment"),
		"https://github.com/acme/widget.git",
	)
	assert.equal(
		normalizeGitRemote("git@github.com:acme/widget.git"),
		"https://github.com/acme/widget.git",
	)
})

test("observes descendant commits and their numstat totals", () => {
	const repo = mkdtempSync(path.join(tmpdir(), "orbcode-metrics-"))
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo })
		execFileSync("git", ["config", "user.name", "Metrics Test"], { cwd: repo })
		execFileSync("git", ["config", "user.email", "metrics@example.com"], { cwd: repo })
		writeFileSync(path.join(repo, "sample.ts"), "one\n")
		execFileSync("git", ["add", "sample.ts"], { cwd: repo })
		execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repo })

		const baseline = getGitHead(repo)
		assert.ok(baseline)
		writeFileSync(path.join(repo, "sample.ts"), "one\ntwo\nthree\n")
		execFileSync("git", ["add", "sample.ts"], { cwd: repo })
		execFileSync("git", ["commit", "-q", "-m", "add lines"], { cwd: repo })

		const observed = observeGitCommits(repo, baseline)
		assert.equal(observed.commits.length, 1)
		assert.equal(observed.commits[0].linesAdded, 2)
		assert.equal(observed.commits[0].linesDeleted, 0)
		assert.match(observed.commits[0].timestamp, /^\d{4}-\d{2}-\d{2}T/)
	} finally {
		rmSync(repo, { recursive: true, force: true })
	}
})
