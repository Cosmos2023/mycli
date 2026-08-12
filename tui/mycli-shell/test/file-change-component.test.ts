import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderUnifiedDiff } from "../src/components/diff-renderer.ts";
import { FileChangeComponent } from "../src/components/file-change.ts";
import { highlightDiffCode } from "../src/components/syntax-highlight.ts";
import type { MycliShellFileChange } from "../src/model.ts";
import { visibleWidth } from "../src/tui-core/utils.ts";


function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}


function renderThemeFixture(env: NodeJS.ProcessEnv): string {
	const fixture = fileURLToPath(new URL("./fixtures/render-file-change-theme.ts", import.meta.url));
	const result = spawnSync(process.execPath, ["--import", "tsx", fixture], {
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


function editedFileChange(overrides: Partial<MycliShellFileChange> = {}): MycliShellFileChange {
	return {
		id: "change-1",
		callId: "call-1",
		status: "success",
		summary: "Updated",
		files: [{
			version: 1,
			kind: "update",
			path: "src/app.py",
			diff: "@@ -24 +24 @@\n-old\n+new\n",
			addedLines: 1,
			removedLines: 1,
			truncated: false,
			omittedChars: 0,
			language: "py",
		}],
		...overrides,
	};
}


function renderFileChange(
	fileChange: MycliShellFileChange,
	width = 100,
	term = "xterm-256color",
): string[] {
	const previousTerm = process.env.TERM;
	process.env.TERM = term;
	try {
		return new FileChangeComponent(fileChange).render(width);
	} finally {
		if (previousTerm === undefined) delete process.env.TERM;
		else process.env.TERM = previousTerm;
	}
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
	assert.doesNotMatch(output, /@@ .* @@/);
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


test("file change component renders a single edited file without a tool card", () => {
	const output = stripAnsi(renderFileChange(editedFileChange()).join("\n"));

	assert.match(output, /^• Edited src\/app\.py \(\+1 -1\)/m);
	assert.match(output, /24 - old/);
	assert.match(output, /24 \+ new/);
	assert.doesNotMatch(output, /• Write(?:\s|$)|• Edit(?:\s|$)|⎿ Wrote/m);
});


test("file change component aggregates multiple files and renders operation labels", () => {
	const multi = editedFileChange({
		files: [
			{
				version: 1, kind: "add", path: "src/new.py", diff: "@@ -0,0 +1,2 @@\n+one\n+two\n",
				addedLines: 2, removedLines: 0, truncated: false, omittedChars: 0, language: "py",
			},
			{
				version: 1, kind: "delete", path: "src/old.py", diff: "@@ -1,2 +0,0 @@\n-one\n-two\n",
				addedLines: 0, removedLines: 2, truncated: false, omittedChars: 0, language: "py",
			},
			{
				version: 1, kind: "rename", previousPath: "src/a.py", path: "src/b.py", diff: "",
				addedLines: 0, removedLines: 0, truncated: false, omittedChars: 0, language: "py",
			},
		],
	});
	const output = stripAnsi(renderFileChange(multi).join("\n"));

	assert.match(output, /• Edited 3 files \(\+2 -2\)/);
	assert.match(output, /└ src\/new\.py \(\+2 -0\)/);
	assert.match(output, /└ src\/old\.py \(\+0 -2\)/);
	assert.match(output, /└ src\/a\.py -> src\/b\.py \(\+0 -0\)/);

	const added = stripAnsi(renderFileChange({
		...editedFileChange(),
		files: [{ ...editedFileChange().files[0]!, kind: "add", path: "src/new.py" }],
	}, 80).join("\n"));
	const deleted = stripAnsi(renderFileChange({
		...editedFileChange(),
		files: [{ ...editedFileChange().files[0]!, kind: "delete", path: "src/old.py" }],
	}, 80).join("\n"));
	const renamed = stripAnsi(renderFileChange({
		...editedFileChange(),
		files: [{ ...editedFileChange().files[0]!, kind: "rename", previousPath: "src/a.py", path: "src/b.py" }],
	}, 80).join("\n"));
	assert.match(added, /• Added src\/new\.py/);
	assert.match(deleted, /• Deleted src\/old\.py/);
	assert.match(renamed, /• Renamed src\/a\.py -> src\/b\.py/);
});


test("file change component renders unchanged failures and truncation explicitly", () => {
	const unchanged = stripAnsi(renderFileChange(editedFileChange({
		status: "unchanged",
		target: "src/app.py",
		files: [],
	}), 80).join("\n"));
	const failed = stripAnsi(renderFileChange(editedFileChange({
		status: "error",
		summary: "Failed to apply patch",
		error: "Expected lines were not found in src/app.py",
		files: [],
	}), 80).join("\n"));
	const truncated = stripAnsi(renderFileChange(editedFileChange({
		files: [{
			...editedFileChange().files[0]!,
			diff: "@@ -1 +1 @@\n-old\n... 20 lines / 400 chars omitted ...\n+new\n",
			truncated: true,
			omittedChars: 400,
		}],
	}), 80).join("\n"));

	assert.match(unchanged, /• No changes to src\/app\.py/);
	assert.match(failed, /× Failed to apply patch/);
	assert.match(failed, /└ Expected lines were not found in src\/app\.py/);
	assert.match(truncated, /20 lines \/ 400 chars omitted/);
});


test("file change component stays width safe and falls back to ASCII glyphs", () => {
	const change = editedFileChange({
		files: [{
			...editedFileChange().files[0]!,
			path: "src/这是一个很长的文件名🙂.py",
			diff: "@@ -1 +1 @@\n-旧值🙂很长很长很长\n+新值🙂很长很长很长\n",
		}],
	});
	const lines = renderFileChange(change, 40);
	for (const line of lines) assert.ok(visibleWidth(line) <= 40, stripAnsi(line));

	const plain = stripAnsi(renderFileChange(editedFileChange({
			status: "error",
			summary: "Failed to apply patch",
			error: "No match",
			files: [],
		}), 80, "dumb").join("\n"));
	const success = stripAnsi(renderFileChange(editedFileChange(), 80, "dumb").join("\n"));
	assert.match(plain, /x Failed to apply patch/);
	assert.match(plain, /\\ No match/);
	assert.match(success, /\* Edited src\/app\.py/);
});
