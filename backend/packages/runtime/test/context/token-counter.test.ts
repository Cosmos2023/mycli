import assert from "node:assert/strict";
import test from "node:test";
import { TokenCounter } from "../../src/context/token-counter.ts";

const PYTHON_O200K_CORPUS = Object.freeze([
	{ name: "ascii", text: "hello world", tokens: 2 },
	{ name: "cjk", text: "你好，世界", tokens: 3 },
	{ name: "mixed", text: "OpenAI 编程助手 v2", tokens: 7 },
	{
		name: "code",
		text: "function add(a: number, b: number): number {\n\treturn a + b;\n}",
		tokens: 18,
	},
	{
		name: "tool output",
		text: "Read completed\nPath: packages/runtime/src/index.ts\nLines: 1-42",
		tokens: 17,
	},
]);

test("loads the encoder only when the first non-empty value is counted", () => {
	let loads = 0;
	const counter = new TokenCounter({
		loadEncoder: () => {
			loads += 1;
			return { encode: (text) => [...text].map((_, index) => index) };
		},
	});

	assert.equal(loads, 0);
	assert.equal(counter.count(""), 0);
	assert.equal(loads, 0);
	assert.equal(counter.count("abc"), 3);
	assert.equal(counter.count("def"), 3);
	assert.equal(loads, 1);
});

test("matches Python o200k_base counts for the fixed fixture corpus", () => {
	const counter = new TokenCounter();

	for (const fixture of PYTHON_O200K_CORPUS) {
		assert.equal(counter.count(fixture.text), fixture.tokens, fixture.name);
	}
});

test("uses the exact Python fallback estimate when encoder loading fails", () => {
	let loads = 0;
	const counter = new TokenCounter({
		loadEncoder: () => {
			loads += 1;
			throw new Error("unavailable");
		},
	});

	assert.equal(counter.count(""), 0);
	assert.equal(counter.count("abcd中"), 2);
	assert.equal(counter.count("abc😀"), 2);
	assert.equal(loads, 1);
});

test("caches encoder counts without retaining more than the configured bound", () => {
	let calls = 0;
	const counter = new TokenCounter({
		maxCache: 1,
		loadEncoder: () => ({
			encode: (text) => {
				calls += 1;
				return [...text].map((_, index) => index);
			},
		}),
	});

	assert.equal(counter.count("one"), 3);
	assert.equal(counter.count("one"), 3);
	assert.equal(calls, 1);
	assert.equal(counter.count("two"), 3);
	assert.equal(counter.count("one"), 3);
	assert.equal(calls, 3);
});
