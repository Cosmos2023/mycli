import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { terminalContent } from "../../src/transcript/terminal-content.ts";

test("external terminal content preserves SGR colors and normalizes progress into log lines", () => {
	const text = terminalContent("\x1b[31mred\x1b[0m\t10%\r20%\r\nfinished");
	assert.match(text, /\x1b\[31mred/u);
	assert.equal(stripVTControlCharacters(text), "red   10%\n20%\nfinished");
	assert.ok(text.endsWith("\x1b[0m"));
});

test("external terminal content consumes terminal commands and complete control-string payloads", () => {
	for (const sequence of [
		"\x1b[H\x1b[2J", "\x1b[?1049h", "\x1b[?25l", "\x1b[r", "\x1b7", "\x1b(0",
		"\x1b]52;c;clipboard-payload\x07", "\x1b]0;title-payload\x1b\\",
		"\x1b_Gimage-payload\x1b\\", "\x1bPprivate-payload\x1b\\",
		"\x9b2J", "\x9d52;c;clipboard-payload\x9c", "\x90private-payload\x9c",
		"\x00\x07\x08\x0b\x0c\x7f",
	]) {
		assert.equal(terminalContent(`before${sequence}after`), "beforeafter", JSON.stringify(sequence));
	}
});

test("incomplete external terminal sequences never reach a rendered frame", () => {
	for (const sequence of ["\x1b", "\x1b[", "\x1b[31", "\x1b]52;c;pending", "\x1bPpending"])
		assert.equal(terminalContent(`before${sequence}`), "before");
	assert.equal(terminalContent("\x1b[31\x1b[Hafter"), "after");
});
