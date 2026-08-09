import assert from "node:assert/strict";
import test from "node:test";
import { diffTerminalLine } from "../src/tui-core/screen-buffer.ts";

test("terminal line diff preserves a stable prefix", () => {
	const patch = diffTerminalLine("status: working", "status: working.", 40);
	assert.ok(patch);
	assert.equal(patch.column, 15);
	assert.doesNotMatch(patch.content, /status: working/u);
	assert.match(patch.content, /\./u);
});

test("terminal line diff detects style-only cell changes", () => {
	const patch = diffTerminalLine("\x1b[31mred\x1b[0m", "\x1b[32mred\x1b[0m", 20);
	assert.ok(patch);
	assert.equal(patch.column, 0);
	assert.match(patch.content, /\x1b\[32mred/u);
});

test("terminal line diff backs up across a wide-cell continuation", () => {
	const patch = diffTerminalLine("A你B", "A好B", 20);
	assert.ok(patch);
	assert.equal(patch.column, 1);
	assert.match(patch.content, /好B/u);
});

test("terminal line diff skips semantically equal SGR encodings", () => {
	const patch = diffTerminalLine("\x1b[1;31mtext", "\x1b[31;1mtext", 20);
	assert.deepEqual(patch, { column: 4, content: "" });
});

test("terminal line diff falls back for cursor control sequences", () => {
	assert.equal(diffTerminalLine("before", "\x1b[2Gafter", 20), null);
	assert.equal(diffTerminalLine("before", "\x1b[2Aafter", 20), null);
});
