import assert from "node:assert/strict";
import test from "node:test";
import { ShellOutputBuffer } from "../src/index.ts";

test("evicted cursors report omitted output without losing the tail", () => {
	const output = new ShellOutputBuffer({ maxChars: 5 });
	output.append("abcdef");
	assert.deepEqual(output.read(0), {
		text: "bcdef",
		nextCursor: 6,
		outputChars: 6,
		omittedChars: 1,
		cursorWasEvicted: true,
	});
	assert.equal(output.retained(), "bcdef");
});

test("absolute cursors return only unseen retained output", () => {
	const output = new ShellOutputBuffer({ maxChars: 5 });
	output.append("abc");
	assert.deepEqual(output.read(0), {
		text: "abc",
		nextCursor: 3,
		outputChars: 3,
		omittedChars: 0,
		cursorWasEvicted: false,
	});

	output.append("def");
	assert.deepEqual(output.read(3), {
		text: "def",
		nextCursor: 6,
		outputChars: 6,
		omittedChars: 0,
		cursorWasEvicted: false,
	});
	assert.deepEqual(output.read(99), {
		text: "",
		nextCursor: 6,
		outputChars: 6,
		omittedChars: 0,
		cursorWasEvicted: false,
	});
});

test("zero capacity counts every appended character as omitted", () => {
	const output = new ShellOutputBuffer({ maxChars: 0 });
	output.append("中a");
	assert.deepEqual(output.read(0), {
		text: "",
		nextCursor: 2,
		outputChars: 2,
		omittedChars: 2,
		cursorWasEvicted: true,
	});
	assert.throws(() => output.read(-1), RangeError);
	assert.throws(() => output.read(0.5), RangeError);
	assert.throws(() => new ShellOutputBuffer({ maxChars: -1 }), RangeError);
	assert.throws(() => new ShellOutputBuffer({ maxChars: 1.5 }), RangeError);
});
