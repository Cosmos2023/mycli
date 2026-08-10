import assert from "node:assert/strict";
import test from "node:test";
import { diffTerminalLine, TerminalLineDiffer } from "../src/tui-core/screen-buffer.ts";
import { snapshotTerminalCells } from "../src/tui-core/utils.ts";

test("terminal line diff preserves a stable prefix", () => {
	const patch = diffTerminalLine("status: working", "status: working.", 40);
	assert.ok(patch);
	assert.equal(patch.column, 15);
	assert.doesNotMatch(patch.content, /status: working/u);
	assert.match(patch.content, /\./u);
});

test("terminal line diff preserves a stable suffix", () => {
	const patch = diffTerminalLine(
		"status: ◒ Working (24s · esc to interrupt)",
		"status: ◐ Working (24s · esc to interrupt)",
		80,
	);

	assert.ok(patch);
	assert.equal(patch.column, 8);
	assert.match(patch.content, /◐/u);
	assert.doesNotMatch(patch.content, /Working/u);
	assert.doesNotMatch(patch.content, /\x1b\[K/u);
});

test("terminal line diff preserves a stable suffix after a wide cell", () => {
	const patch = diffTerminalLine("状态：北京 → 上海", "状态：南京 → 上海", 40);

	assert.ok(patch);
	assert.equal(patch.column, 6);
	assert.match(patch.content, /南/u);
	assert.doesNotMatch(patch.content, /京|上海/u);
	assert.doesNotMatch(patch.content, /\x1b\[K/u);
});

test("terminal line diff detects style-only cell changes", () => {
	const patch = diffTerminalLine(
		"\x1b[31mred\x1b[0m stable",
		"\x1b[32mred\x1b[0m stable",
		20,
	);
	assert.ok(patch);
	assert.equal(patch.column, 0);
	assert.match(patch.content, /\x1b\[32mred/u);
	assert.doesNotMatch(patch.content, /stable|\x1b\[K/u);
});

test("terminal line diff backs up across a wide-cell continuation", () => {
	const patch = diffTerminalLine("A你B", "A好B", 20);
	assert.ok(patch);
	assert.equal(patch.column, 1);
	assert.match(patch.content, /好/u);
	assert.doesNotMatch(patch.content, /B|\x1b\[K/u);
});

test("terminal line diff skips semantically equal SGR encodings", () => {
	const patch = diffTerminalLine("\x1b[1;31mtext", "\x1b[31;1mtext", 20);
	assert.deepEqual(patch, { column: 4, content: "" });
});

test("terminal line diff falls back for cursor control sequences", () => {
	assert.equal(diffTerminalLine("before", "\x1b[2Gafter", 20), null);
	assert.equal(diffTerminalLine("before", "\x1b[2Aafter", 20), null);
});

test("retained terminal line diff reuses the previous frame snapshot", () => {
	let snapshotCalls = 0;
	const differ = new TerminalLineDiffer(4, (line) => {
		snapshotCalls += 1;
		return snapshotTerminalCells(line);
	});

	assert.match(differ.diff("working", "working.", 20)?.content ?? "", /\./u);
	assert.match(differ.diff("working.", "working..", 20)?.content ?? "", /\./u);

	assert.equal(snapshotCalls, 3);
});

test("retained terminal line diff bounds cached snapshots", () => {
	let snapshotCalls = 0;
	const differ = new TerminalLineDiffer(2, (line) => {
		snapshotCalls += 1;
		return snapshotTerminalCells(line);
	});

	differ.diff("one", "two", 20);
	differ.diff("two", "three", 20);
	differ.diff("three", "one", 20);

	assert.equal(snapshotCalls, 4);
});

test("retained terminal line diff rejects an invalid cache bound", () => {
	let snapshotCalls = 0;
	const differ = new TerminalLineDiffer(Number.NaN, (line) => {
		snapshotCalls += 1;
		return snapshotTerminalCells(line);
	});

	for (let index = 1; index <= 256; index += 1) {
		differ.diff(`line ${index - 1}`, `line ${index}`, 20);
	}
	differ.diff("line 256", "line 0", 20);

	assert.equal(snapshotCalls, 258);
});
