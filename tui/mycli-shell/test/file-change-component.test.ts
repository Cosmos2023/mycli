import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderUnifiedDiff } from "../src/components/transcript/diff-renderer.ts";
import { FileChangeComponent } from "../src/components/transcript/file-change.ts";
import { highlightDiffCode } from "../src/components/shared/syntax-highlight.ts";
import type { MycliShellFileChange } from "../src/model.ts";
import { setUiGlyphMode, uiGlyphMode } from "../src/theme/terminal-style.ts";
import { theme } from "../src/theme/theme.ts";
import { TUI } from "../src/tui-core/tui.ts";
import { visibleWidth } from "../src/tui-core/utils.ts";
import { HeadlessTerminal } from "./support/headless-terminal.ts";


function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}


function renderThemeFixture(env: NodeJS.ProcessEnv): string {
	const fixture = fileURLToPath(new URL("./fixtures/render-file-change-theme.ts", import.meta.url));
	const childEnv = { ...process.env };
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete childEnv[key];
		else childEnv[key] = value;
	}
	const result = spawnSync(process.execPath, ["--import", "tsx", fixture], {
		encoding: "utf8",
		env: childEnv,
	});
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}


function backgroundSequenceFor(text: string, needle: string): string {
	const line = text.split("\n").find((candidate) => stripAnsi(candidate).includes(needle)) ?? "";
	return line.match(/\x1b\[(?:4[0-7]|10[0-7]|48;(?:2|5);[^m]+)m/)?.[0] ?? "";
}


function assertFullRowBackground(terminal: HeadlessTerminal, row: number, colored: boolean): void {
	const firstCell = terminal.visibleCell(row, 0);
	assert.ok(firstCell);
	assert.equal(firstCell.isBgDefault(), !colored);
	for (let column = 0; column < terminal.columns; column++) {
		const cell = terminal.visibleCell(row, column);
		assert.ok(cell);
		assert.equal(cell.getBgColorMode(), firstCell.getBgColorMode(), `row ${row}, column ${column}`);
		assert.equal(cell.getBgColor(), firstCell.getBgColor(), `row ${row}, column ${column}`);
	}
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
	const previousGlyphMode = uiGlyphMode();
	setUiGlyphMode(term === "dumb" ? "ascii" : "unicode");
	try {
		return new FileChangeComponent(fileChange).render(width);
	} finally {
		setUiGlyphMode(previousGlyphMode);
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


test("malformed diff expands tabs before wrapping fallback rows", () => {
	const lines = renderUnifiedDiff("\told\tvalue\n+\tnew", { width: 12, indent: 2 }).map(stripAnsi);

	assert.deepEqual(lines, ["     old", "  value", "  +   new"]);
});


test("diff backgrounds cover tabbed code, blank rows and wrapped continuations", async () => {
	const previousTheme = theme.name();
	const previousColorMode = theme.colorMode();
	try {
		for (const name of ["dark", "light"] as const) {
			theme.setName(name);
			for (const mode of ["truecolor", "256", "16", "none"] as const) {
				theme.setColorMode(mode);
				for (const width of [18, 22, 80]) {
					for (const sign of ["-", "+"]) {
						const hunk = sign === "-" ? "@@ -1,3 +0,0 @@" : "@@ -0,0 +1,3 @@";
						const lines = renderUnifiedDiff(
							`${hunk}\n${sign}\tconst value\t= \"代码 with spaces\";\t\n${sign}\t\t\n${sign}\n`,
							{ width, indent: 4, language: "ts" },
						);
						const terminal = new HeadlessTerminal({ columns: width, rows: lines.length + 2 });
						try {
							terminal.write([...lines, "after diff"].join("\r\n"));
							await terminal.flush();
							for (let row = 0; row < lines.length; row++) {
								assertFullRowBackground(terminal, row, mode !== "none");
								assert.equal(visibleWidth(lines[row]!), width);
							}
							assert.deepEqual(
								terminal.visibleLines().slice(0, lines.length + 1).map((line) => line.trimEnd()),
								[...lines.map((line) => stripAnsi(line).trimEnd()), "after diff"],
							);
							assertFullRowBackground(terminal, lines.length, false);
							if (mode === "none") assert.doesNotMatch(lines.join("\n"), /\x1b\[/);
						} finally {
							terminal.dispose();
						}
					}
				}
			}
		}
	} finally {
		theme.setName(previousTheme);
		theme.setColorMode(previousColorMode);
	}
});


test("file change backgrounds stay continuous through TUI updates and resize", async () => {
	const previousColorMode = theme.colorMode();
	theme.setColorMode("truecolor");
	try {
		for (const nativeScrollback of [false, true]) {
			const terminal = new HeadlessTerminal({ columns: 80, rows: 24, nativeScrollback });
			const change = editedFileChange();
			const component = new FileChangeComponent(change);
			const ui = new TUI(terminal);
			ui.addChild(component);
			ui.start();
			try {
				for (const [width, value] of [[80, "old"], [80, "a longer value with spaces"], [22, "new"]] as const) {
					component.updateFileChange({
						...change,
						files: [{ ...change.files[0]!, diff: `@@ -24 +24 @@\n-\tvalue\t= \"${value}\"\n+\tvalue\t= \"replacement\"\n` }],
					});
					if (terminal.columns !== width) terminal.resize(width, terminal.rows);
					ui.requestRender();
					await delay(25);
					await terminal.flush();
					const expected = component.render(width);
					const visibleLines = terminal.visibleLines();
					const frameStart = visibleLines.findLastIndex((line) => line.includes("Edited")) - 1;
					assert.ok(frameStart >= 0);
					for (let row = 2; row < expected.length; row++) {
						assertFullRowBackground(terminal, frameStart + row, true);
					}
					assert.deepEqual(
						visibleLines.slice(frameStart, frameStart + expected.length).map((line) => line.trimEnd()),
						expected.map((line) => stripAnsi(line).trimEnd()),
					);
				}
			} finally {
				ui.stop();
				await terminal.flush();
				terminal.dispose();
			}
		}
	} finally {
		theme.setColorMode(previousColorMode);
	}
});


test("added and removed rows use distinct full-line backgrounds", () => {
	const dark = renderThemeFixture({
		MYCLI_TUI_THEME: "dark",
		MYCLI_TUI_COLOR: "always",
		COLORTERM: "truecolor",
		NO_COLOR: undefined,
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
		NO_COLOR: undefined,
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
		MYCLI_TUI_COLOR: "always",
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
		NO_COLOR: undefined,
	});
	assert.match(color256, /\x1b\[48;5;/);
	assert.doesNotMatch(color256, /\x1b\[48;2;/);

	const color16 = renderThemeFixture({
		COLORTERM: "",
		TERM: "xterm",
		MYCLI_TUI_COLOR: "always",
		NO_COLOR: undefined,
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
	const header = stripAnsi(lines.find((line) => stripAnsi(line).includes("Edited")) ?? "");
	assert.match(header, /^• Edited .+ \(\+1 -1\)$/u);
	assert.equal(lines.some((line) => /^\s*\(\+1 -1\)\s*$/u.test(stripAnsi(line))), false);
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
