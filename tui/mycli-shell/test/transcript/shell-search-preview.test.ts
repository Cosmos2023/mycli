import assert from "node:assert/strict";
import test from "node:test";
import { cachedShellSearchPreview, shellSearchPreview } from "../../src/transcript/shell-search-preview.ts";
import type { MycliShellBash } from "../../src/model.ts";

test("search previews separate quoted keywords and paths from ripgrep options", () => {
	assert.deepEqual(shellSearchPreview('rg -n -C 3 --glob "*.ts" "approval reason" src tests'), {
		kind: "search", queries: ["approval reason"], paths: ["src", "tests"],
	});
	assert.deepEqual(shellSearchPreview("/usr/bin/grep -Rin -e 'first' -e 'second' 'source files'"), {
		kind: "search", queries: ["first", "second"], paths: ["source files"],
	});
	assert.deepEqual(shellSearchPreview("rg -- --needle src"), {
		kind: "search", queries: ["--needle"], paths: ["src"],
	});
	assert.deepEqual(shellSearchPreview("rg --files -g '*.tsx' src"), {
		kind: "list", queries: [], paths: ["src"],
	});
	assert.deepEqual(shellSearchPreview("rg -e '' src"), {
		kind: "search", queries: [""], paths: ["src"],
	});
});

test("ambiguous and compound shell commands retain their original presentation", () => {
	for (const command of [
		"rg needle src | head -20", "rg needle src && npm test", "rg needle src > result.txt",
		"rg needle src\nprintf done", "rg $PATTERN src", 'rg "$(cat pattern)" src',
		"rg `cat pattern` src", "rg needle *.ts", "env rg needle src", "rg --pre helper needle src",
		"rg -f patterns.txt src", "rg --unknown value needle src", "rg", "rg --files -e needle",
		"grep --include '*.ts'", "rg needle src # comment", "npm test",
	]) assert.equal(shellSearchPreview(command), undefined, command);
	assert.equal(shellSearchPreview("rg needle src", "powershell"), undefined);
	assert.equal(shellSearchPreview("rg needle src", "cmd"), undefined);
	assert.equal(shellSearchPreview(`rg ${"a".repeat(8_192)}`), undefined);
});

test("literal shell symbols and CJK keywords remain intact", () => {
	assert.deepEqual(shellSearchPreview("rg -F '$HOME' src"), {
		kind: "search", queries: ["$HOME"], paths: ["src"],
	});
	assert.deepEqual(shellSearchPreview("rg '\u5ba1\u6279|\u7406\u7531' '\u6e90\u4ee3\u7801'"), {
		kind: "search", queries: ["\u5ba1\u6279|\u7406\u7531"], paths: ["\u6e90\u4ee3\u7801"],
	});
});

test("shared search previews invalidate on command or shell changes without caching execution status", () => {
	const shell: MycliShellBash = { id: "search", command: "rg needle src", status: "running", shellKind: "posix" };
	const preview = cachedShellSearchPreview(shell);
	assert.deepEqual(preview, { kind: "search", queries: ["needle"], paths: ["src"] });
	shell.status = "success";
	shell.outputPreview = "src/app.ts:10: needle";
	assert.equal(cachedShellSearchPreview(shell), preview);
	shell.command = "rg --files tests";
	assert.deepEqual(cachedShellSearchPreview(shell), { kind: "list", queries: [], paths: ["tests"] });
	shell.shellKind = "powershell";
	assert.equal(cachedShellSearchPreview(shell), undefined);
	shell.shellKind = "posix";
	assert.equal(cachedShellSearchPreview(shell)?.kind, "list");
	shell.command = "npm test";
	assert.equal(cachedShellSearchPreview(shell), undefined);
	shell.command = "grep next lib";
	assert.deepEqual(cachedShellSearchPreview(shell), { kind: "search", queries: ["next"], paths: ["lib"] });
});
