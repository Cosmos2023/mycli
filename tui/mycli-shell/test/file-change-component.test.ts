import assert from "node:assert/strict";
import test from "node:test";

import { renderUnifiedDiff } from "../src/components/diff-renderer.ts";
import { visibleWidth } from "../src/tui-core/utils.ts";


function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
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
