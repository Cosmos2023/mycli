import assert from "node:assert/strict";
import test from "node:test";
import { formatArgumentPreview, parseToolArguments } from "../../src/policy/tool-arguments.ts";

test("argument previews render scalar pairs and drop unparseable JSON", () => {
	assert.equal(formatArgumentPreview(parseToolArguments('{"script":"print(1)","cwd":"/repo"}')), "script=print(1) · cwd=/repo");
	assert.equal(formatArgumentPreview(parseToolArguments("not-json")), undefined);
	assert.equal(formatArgumentPreview(parseToolArguments("{}")), undefined);
	assert.equal(formatArgumentPreview(parseToolArguments("[]")), undefined);
});

test("argument previews cap entries and long values", () => {
	const preview = formatArgumentPreview(parseToolArguments(JSON.stringify({
		a: 1, b: 2, c: 3, d: 4, e: 5,
	}))) ?? "";
	assert.equal(preview, "a=1 · b=2 · c=3 · d=4 · +1 more");
	const long = formatArgumentPreview({ query: "x".repeat(80) }) ?? "";
	assert.ok(long.length <= "query=".length + 48);
	assert.match(long, /…$/u);
	assert.equal(formatArgumentPreview({ nested: { ok: true } }), 'nested={"ok":true}');
});
