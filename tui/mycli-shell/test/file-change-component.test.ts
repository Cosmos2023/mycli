import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderUnifiedDiff } from "../src/components/diff-renderer.ts";
import { highlightDiffCode } from "../src/components/syntax-highlight.ts";
import { visibleWidth } from "../src/tui-core/utils.ts";


function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}


function renderThemeFixture(env: NodeJS.ProcessEnv): string {
	const fixture = fileURLToPath(new URL("./fixtures/render-file-change-theme.ts", import.meta.url));
	const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/esm/index.mjs", import.meta.url));
	const result = spawnSync(process.execPath, ["--import", tsx, fixture], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}


function backgroundSequenceFor(text: string, needle: string): string {
	const line = text.split("\n").find((candidate) => stripAnsi(candidate).includes(needle)) ?? "";
	return line.match(/\x1b\[(?:4[0-7]|10[0-7]|48;(?:2|5);[^m]+)m/)?.[0] ?? "";
}


test("diff renderer numbers old and new lines independently", () => {
	const lines = renderUnifiedDiff(
		"--- src/app.py:before\n+++ src/app.py:after\n@@ -24,2 +24,2 @@\n-old\n+new\n context\n",
		{ width: 80, indent: 4, language: "py" },
	).map(stripAnsi);
	const output = lines.join("\n");

	assert.match(output, /24 - old/);
	assert.match(output, /24 \+ new/);
	assert.match(output, /25   context/);
	assert.doesNotMatch(output, /---|\+\+\+/);
});


test("diff renderer keeps every visual row within CJK terminal width", () => {
	const lines = renderUnifiedDiff(
		"--- a.txt:before\n+++ a.txt:after\n@@ -1 +1 @@\n-旧值🙂\n+新值🙂\n",
		{ width: 18, indent: 2 },
	);

	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 18, `${stripAnsi(line)} exceeds width`);
	}
});


test("diff renderer wraps long code under the code column", () => {
	const lines = renderUnifiedDiff(
		"--- a.py:before\n+++ a.py:after\n@@ -1 +1 @@\n-short\n+abcdefghijklmnopqrstuvwxyz0123456789\n",
		{ width: 22, indent: 2, language: "py" },
	).map(stripAnsi);
	const firstAddedIndex = lines.findIndex((line) => line.includes("abcdefgh"));

	assert.ok(firstAddedIndex >= 0);
	assert.match(lines[firstAddedIndex] ?? "", /1 \+ /);
	assert.doesNotMatch(lines[firstAddedIndex + 1] ?? "", /1 \+ /);
	for (const line of lines) assert.ok(visibleWidth(line) <= 22);
});


test("diff renderer shows an explicit omission marker", () => {
	const lines = renderUnifiedDiff(
		"--- a.py:before\n+++ a.py:after\n@@ -1,2 +1,2 @@\n-old\n... 20 lines / 400 chars omitted ...\n+new\n",
		{ width: 60, indent: 2 },
	).map(stripAnsi);

	assert.equal(lines.some((line) => line.includes("20 lines / 400 chars omitted")), true);
});


test("malformed diff falls back to bounded preformatted rows", () => {
	const lines = renderUnifiedDiff("not a unified diff\n+still visible", {
		width: 30,
		indent: 2,
	}).map(stripAnsi);

	assert.deepEqual(lines, ["  not a unified diff", "  +still visible"]);
});


test("added and removed rows use distinct full-line backgrounds", () => {
	const dark = renderThemeFixture({
		MYCLI_TUI_THEME: "dark",
		MYCLI_TUI_COLOR: "always",
		COLORTERM: "truecolor",
	});
	const removedLine = dark
		.split("\n")
		.find((line) => stripAnsi(line).includes("- value =")) ?? "";
	const addedLine = dark
		.split("\n")
		.find((line) => stripAnsi(line).includes("+ value =")) ?? "";

	assert.match(removedLine, /\x1b\[48;2;[^m]+m/);
	assert.match(addedLine, /\x1b\[48;2;[^m]+m/);
	assert.notEqual(
		backgroundSequenceFor(dark, "- value ="),
		backgroundSequenceFor(dark, "+ value ="),
	);
});


test("light theme keeps syntax and context code readable", () => {
	const light = renderThemeFixture({
		MYCLI_TUI_THEME: "light",
		MYCLI_TUI_COLOR: "always",
		COLORTERM: "truecolor",
	});
	const contextLine = light
		.split("\n")
		.find((line) => stripAnsi(line).includes("context = \"visible\"")) ?? "";

	assert.match(stripAnsi(light), /value = "new"/);
	assert.match(stripAnsi(contextLine), /context = "visible"/);
	assert.match(contextLine, /\x1b\[38;2;/);
	assert.match(light, /\x1b\[48;2;/);
});


test("NO_COLOR preserves labels line numbers and diff signs", () => {
	const plain = renderThemeFixture({
		NO_COLOR: "1",
		MYCLI_TUI_COLOR: "never",
		COLORTERM: "",
	});

	assert.doesNotMatch(plain, /\x1b\[/);
	assert.match(plain, /Edited src\/app\.py \(\+1 -1\)/);
	assert.match(plain, /24 - value = "old"/);
	assert.match(plain, /24 \+ value = "new"/);
});


test("256-color and 16-color backgrounds avoid truecolor escapes", () => {
	const color256 = renderThemeFixture({
		COLORTERM: "",
		TERM: "xterm-256color",
		MYCLI_TUI_COLOR: "always",
	});
	assert.match(color256, /\x1b\[48;5;/);
	assert.doesNotMatch(color256, /\x1b\[48;2;/);

	const color16 = renderThemeFixture({
		COLORTERM: "",
		TERM: "xterm",
		MYCLI_TUI_COLOR: "always",
	});
	assert.match(color16, /\x1b\[(?:4[0-7]|10[0-7])m/);
	assert.doesNotMatch(color16, /\x1b\[(?:38|48);(?:2|5);/);
});


test("syntax highlighting skips diffs above two thousand lines", () => {
	const code = "value = \"plain\"";
	assert.equal(highlightDiffCode(code, "py", 2_001), code);
});
