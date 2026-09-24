import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_RESULT_OUTPUT_MAX_CHARS } from "@mycli/core";
import {
	approxModelOutputTokens,
	boundModelOutput,
	canonicalToolResult,
	MODEL_OUTPUT_MAX_CHARS,
	MODEL_OUTPUT_MIN_CHARS,
	modelOutputMaxCharsFromTokens,
} from "../../src/tools/model-output-budget.ts";

test("model output below the budget is passed through unchanged", () => {
	const text = "line one\nline two";
	const result = boundModelOutput(text);

	assert.equal(result.text, text);
	assert.equal(result.truncated, false);
	assert.equal(result.originalChars, text.length);
	assert.equal(result.originalTokens, approxModelOutputTokens(text));
	assert.equal(result.totalLines, 2);
});

test("oversized output keeps head and tail and reports what was dropped", () => {
	const head = "HEAD".repeat(2_000);
	const middle = "MIDDLE".repeat(4_000);
	const tail = "TAIL".repeat(2_000);
	const result = boundModelOutput(`${head}${middle}${tail}`);

	assert.equal(result.truncated, true);
	assert.ok(result.text.length <= MODEL_OUTPUT_MAX_CHARS,
		`bounded output was ${result.text.length} characters`);
	assert.ok(result.text.startsWith("Warning: truncated output (original token count: "));
	assert.match(result.text, /\nTotal output lines: 1\n\n/u);
	assert.ok(result.text.includes("HEAD"));
	assert.ok(result.text.endsWith("TAIL"));
	assert.equal(result.text.includes("MIDDLE"), false);
	assert.match(result.text, /…\d+ chars truncated…/u);
	assert.equal(result.originalChars, head.length + middle.length + tail.length);
	assert.equal(result.originalTokens, approxModelOutputTokens(`${head}${middle}${tail}`));
});

test("truncation never splits a surrogate pair or exceeds the budget", () => {
	const emoji = "😀".repeat(4_000);
	for (const budget of [64, 65, 4_000, 4_001, 8_000]) {
		const result = boundModelOutput(emoji, budget);
		assert.ok(result.text.length <= budget, `budget ${budget} produced ${result.text.length}`);
		assert.equal(result.text.includes("\uFFFD"), false);
		// A lone surrogate would make the UTF-8 round trip lossy.
		assert.equal(Buffer.from(result.text, "utf8").toString("utf8"), result.text);
	}
});

test("a budget too small for the header still returns bounded text", () => {
	const result = boundModelOutput("x".repeat(20_000), 40);

	assert.equal(result.truncated, true);
	assert.ok(result.text.length <= 40);
	assert.ok(result.text.startsWith("Warning: truncated output"));
});

test("canonical tool results bound the output and keep media", () => {
	const image = {
		mediaType: "image/png",
		data: Buffer.from("fake", "utf8").toString("base64"),
	} as const;
	const result = canonicalToolResult({
		callId: "call-1",
		toolName: "docs_search",
		success: true,
		summary: "Searched docs",
		modelOutput: "y".repeat(TOOL_RESULT_OUTPUT_MAX_CHARS * 3),
		images: [image],
		metadata: Object.freeze({ example: true }),
	});

	assert.equal(result.callId, "call-1");
	assert.equal(result.toolName, "docs_search");
	assert.equal(result.success, true);
	assert.deepEqual(result.images, [image]);
	assert.ok(result.output.length <= TOOL_RESULT_OUTPUT_MAX_CHARS,
		`canonical output was ${result.output.length} characters`);
	assert.ok(result.output.startsWith("Warning: truncated output"));
});

test("canonical tool results leave ordinary output untouched", () => {
	const result = canonicalToolResult({
		callId: "call-2",
		toolName: "Read",
		success: true,
		summary: "Read file",
		modelOutput: "Read succeeded\nPath: README.md",
		metadata: Object.freeze({}),
	});

	assert.equal(result.output, "Read succeeded\nPath: README.md");
	assert.equal("images" in result, false);
});

test("the configured token threshold resolves to a bounded character budget", () => {
	assert.equal(modelOutputMaxCharsFromTokens(undefined), MODEL_OUTPUT_MAX_CHARS);
	assert.equal(modelOutputMaxCharsFromTokens(0), MODEL_OUTPUT_MAX_CHARS);
	assert.equal(modelOutputMaxCharsFromTokens(-5), MODEL_OUTPUT_MAX_CHARS);
	assert.equal(modelOutputMaxCharsFromTokens(1.5), MODEL_OUTPUT_MAX_CHARS);
	assert.equal(modelOutputMaxCharsFromTokens(100), 400);
	assert.equal(modelOutputMaxCharsFromTokens(1_000), 4_000);
	assert.equal(modelOutputMaxCharsFromTokens(8_000), MODEL_OUTPUT_MAX_CHARS);
	assert.equal(modelOutputMaxCharsFromTokens(1), MODEL_OUTPUT_MIN_CHARS);
});

test("an explicit budget bounds the canonical projection", () => {
	const result = canonicalToolResult({
		callId: "call-3",
		toolName: "docs_search",
		success: true,
		summary: "Searched docs",
		modelOutput: "z".repeat(5_000),
		metadata: Object.freeze({}),
	}, 400);

	assert.ok(result.output.length <= 400, `output was ${result.output.length} characters`);
	assert.ok(result.output.startsWith("Warning: truncated output"));
});
