import assert from "node:assert/strict"
import test from "node:test"

import { isReadOnlyCommand } from "../src/tools/readOnlyCommand.js"

test("search, list and inspect commands are read-only", () => {
	for (const command of [
		`rg -n "foo" src/`,
		`rg -n "=>" src -g '*.ts'`,
		`rg --files src | head -50`,
		`grep -rn "a|b" . --include='*.ts' 2>/dev/null`,
		`find . -name '*.ts' -not -path '*/node_modules/*'`,
		`ls -la src/ && pwd`,
		`cd src && rg -l TODO | wc -l`,
		`git status --short`,
		`git diff --stat; git log --oneline -20`,
		`cat package.json | jq .version`,
	]) {
		assert.equal(isReadOnlyCommand(command), true, command)
	}
})

test("anything that writes, runs code or is unrecognised is not read-only", () => {
	for (const command of [
		``,
		`rm -rf node_modules`,
		`echo hi > file.txt`,
		`cat a >> b`,
		`rg foo | xargs rm`,
		`find . -name '*.log' -delete`,
		`find . -exec rm {} \;`,
		`rg --pre ./evil.sh foo`,
		`sort -o out.txt in.txt`,
		`ls $(rm -rf /)`,
		"ls `whoami`",
		`git commit -m x`,
		`git -c core.pager=evil log`,
		`git diff --output=out.patch`,
		`ls; rm file`,
		`ls && npm install`,
		`sed -i s/a/b/ file`,
		`FOO=1 rg x`,
		`cat <<EOF\nhi\nEOF`,
		`ls "unterminated`,
	]) {
		assert.equal(isReadOnlyCommand(command), false, command)
	}
})

test("shell selection prefers a bash-compatible shell", async () => {
	const { getShell, isCmdShell } = await import("../src/utils/shell.js")
	if (process.platform !== "win32") assert.match(getShell(), /(bash|zsh|sh)$/)
	assert.equal(isCmdShell("C:\\Windows\\System32\\cmd.exe"), true)
	assert.equal(isCmdShell("/bin/bash"), false)
})
