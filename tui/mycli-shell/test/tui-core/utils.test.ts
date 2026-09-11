import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import { visibleWidth, wrapTextWithAnsi } from "../../src/tui-core/utils.ts";

test("visible width ignores OSC and APC string control sequences", () => {
	const hyperlink = "\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
	const applicationCommand = "\x1b_cursor-marker\x1b\\text";

	assert.equal(visibleWidth(hyperlink), 4);
	assert.equal(visibleWidth(applicationCommand), 4);
});

test("Chinese text fills the remaining row before continuing", () => {
	assert.deepEqual(wrapTextWithAnsi("abc \u4e2d\u6587\u8fde\u7eed\u6587\u672c\u5185\u5bb9", 10), [
		"abc \u4e2d\u6587\u8fde",
		"\u7eed\u6587\u672c\u5185\u5bb9",
	]);
	assert.deepEqual(wrapTextWithAnsi("abc\u4e2d\u6587def\u4e2d\u6587", 8), [
		"abc\u4e2d\u6587", "def\u4e2d\u6587",
	]);
});

test("Chinese punctuation stays with its adjacent text", () => {
	assert.deepEqual(wrapTextWithAnsi("\u7532\u4e59\u4e19\u4e01\uff0c\u620a\u5df1", 8), [
		"\u7532\u4e59\u4e19", "\u4e01\uff0c\u620a\u5df1",
	]);
	assert.deepEqual(wrapTextWithAnsi("\u7532\u4e59\u4e19\uff08\u4e01\u620a\uff09\u5df1", 8), [
		"\u7532\u4e59\u4e19", "\uff08\u4e01\u620a\uff09", "\u5df1",
	]);
});

test("Unicode wrapping preserves grapheme clusters and ANSI at their boundaries", () => {
	const emoji = "\u{1f469}\u200d\u{1f4bb}";
	const source = `ab\u4e2d\u6587${emoji}\u7532\u4e59e\x1b[31m\u0301\x1b[0m\u4e19\u4e01`;
	const lines = wrapTextWithAnsi(source, 7);
	assert.equal(lines.map(stripVTControlCharacters).join(""), stripVTControlCharacters(source));
	assert.ok(lines.every((line) => visibleWidth(line) <= 7));
	assert.ok(lines.some((line) => line.includes(emoji)));
	assert.ok(lines.some((line) => stripVTControlCharacters(line).includes("e\u0301")));
});

test("Unicode wrapping keeps OSC 8 links active on every continuation", () => {
	for (const terminator of ["\x07", "\x1b\\"]) {
		const open = `\x1b]8;;https://example.com${terminator}`;
		const close = `\x1b]8;;${terminator}`;
		const label = "\u4e2d\u6587\u94fe\u63a5\u5185\u5bb9";
		const lines = wrapTextWithAnsi(`ab ${open}\x1b[31m${label}\x1b[0m${close}`, 7);
		assert.deepEqual(lines.map(stripVTControlCharacters), ["ab \u4e2d\u6587", "\u94fe\u63a5\u5185", "\u5bb9"]);
		for (const line of lines) {
			assert.ok(line.includes(open));
			assert.ok(line.endsWith(close));
			assert.ok(line.includes("\x1b[31m"));
		}
	}
});

test("ASCII words, paths, URLs, and explicit newlines retain their wrapping", () => {
	assert.deepEqual(wrapTextWithAnsi("one two three four", 10), ["one two", "three four"]);
	assert.deepEqual(wrapTextWithAnsi("See src/long-file.ts next", 18), ["See", "src/long-file.ts", "next"]);
	assert.deepEqual(wrapTextWithAnsi("See https://example.com next", 22), ["See", "https://example.com", "next"]);
	assert.deepEqual(wrapTextWithAnsi("left\nright", 20), ["left", "right"]);
});
