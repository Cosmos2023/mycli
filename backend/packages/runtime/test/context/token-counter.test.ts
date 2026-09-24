import assert from "node:assert/strict";
import test from "node:test";
import { TOKEN_COUNT_WINDOW_CHARS, TokenCounter } from "../../src/context/token-counter.ts";

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

test("counts literal tokenizer markers in documents as ordinary text", () => {
	const counter = new TokenCounter();
	assert.equal(counter.count("<|endoftext|>"), 7);
	assert.equal(counter.count("<|endofprompt|>"), 7);
	assert.equal(counter.count("Document literal: <|endoftext|>"), 10);
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

function recordingCounter(calls: string[]): TokenCounter {
	return new TokenCounter({
		maxCache: 0,
		loadEncoder: () => ({
			encode: (text) => {
				calls.push(text);
				return [...text].map((_, index) => index);
			},
		}),
	});
}

test("keeps ordinary text and whitespace-free JSON in one exact call", () => {
	const calls: string[] = [];
	const counter = recordingCounter(calls);
	const source = "const value = 1;\n".repeat(200);
	const json = JSON.stringify(Array.from({ length: 600 }, (_, index) => ({ index, name: "item" + index })));

	assert.equal(counter.count(source), source.length);
	assert.equal(counter.count(json), json.length);
	assert.equal(calls.length, 2);
	assert.deepEqual(calls, [source, json]);
});

test("bounds every encoder call and hands over the text unchanged", () => {
	const calls: string[] = [];
	const counter = recordingCounter(calls);
	const text = "中".repeat(5_000);

	assert.equal(counter.count(text), 5_000);
	assert.ok(calls.length > 1, "expected the run to be counted in several windows");
	for (const call of calls) {
		assert.ok(call.length <= TOKEN_COUNT_WINDOW_CHARS, `window of ${call.length} exceeds the bound`);
	}
	assert.equal(calls.join(""), text);
});

test("never splits a surrogate pair when a window has to be cut", () => {
	const calls: string[] = [];
	const counter = recordingCounter(calls);
	const text = "😀".repeat(2_000);

	assert.equal(counter.count(text), 2_000);
	assert.equal(calls.join(""), text);
	for (const call of calls) {
		assert.ok(call.length <= TOKEN_COUNT_WINDOW_CHARS, `window of ${call.length} exceeds the bound`);
	}
});

test("counts an unbroken CJK run without stalling", () => {
	const counter = new TokenCounter({ maxCache: 0 });
	// Python o200k_base counts this string as 8100 tokens; one unguarded encode
	// call takes about 97 seconds and the windowed count stays within 2%.
	const text = "这是一个用于测试的中文句子内容".repeat(900).slice(0, 13_500);

	const started = performance.now();
	const tokens = counter.count(text);
	const elapsed = performance.now() - started;

	assert.ok(Math.abs(tokens - 8_100) / 8_100 < 0.02, `expected within 2% of 8100 tokens, received ${tokens}`);
	assert.ok(elapsed < 10_000, `expected a bounded count, took ${elapsed.toFixed(0)}ms`);
});
