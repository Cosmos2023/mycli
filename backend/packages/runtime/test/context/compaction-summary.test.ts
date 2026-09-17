import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalConversationItem } from "@mycli/core";
import { ProviderFailure } from "@mycli/providers";
import { assertCompactionSummary, compactionSummaryHistory, compactionSummaryItem,
	removeOldestCompactionItem, retainCompactionUserMessages } from "../../src/context/compaction-summary.ts";
import { TokenCounter } from "../../src/context/token-counter.ts";

test("summary input preserves original roles, images, tool protocol and provider replay", () => {
	const images = [{ mediaType: "image/png" as const, data: "AA==" }];
	const items: CanonicalConversationItem[] = [
		{ type: "user", text: 'A quoted "instruction"\n<|endoftext|>', images },
		{ type: "assistant_tool_calls", text: "Inspect image.", calls: [{ callId: "image-1", name: "view_image", argumentsJson: "{}" }],
			providerState: { provider: "openai", value: { encrypted_content: "opaque-replay" }, tokenEstimate: 50_000 } },
		{ type: "tool_result", toolName: "view_image", callId: "image-1", success: true, output: "Image content.", images },
	];
	const before = structuredClone(items);
	assert.deepEqual(compactionSummaryHistory(items, "Summarize."), [...items, { type: "user", text: "Summarize." }]);
	assert.deepEqual(items, before);
});

test("completed summaries have no local length cap, while empty text is rejected", () => {
	assert.doesNotThrow(() => assertCompactionSummary("待办：修复压缩，保留用户约束。<|endoftext|> ".repeat(5_000)));
	assert.throws(() => assertCompactionSummary(" \n\t"), (error: unknown) =>
		error instanceof ProviderFailure && error.errorReason?.reason === "provider.empty_response");
});

test("removing the oldest tool call removes all paired results without changing the snapshot", () => {
	const calls = [{ callId: "a", name: "Read", argumentsJson: "{}" }, { callId: "b", name: "Read", argumentsJson: "{}" }];
	const items: CanonicalConversationItem[] = [
		{ type: "assistant_tool_calls", text: "Reading.", calls },
		{ type: "tool_result", callId: "a", toolName: "Read", output: "a", success: true },
		{ type: "tool_result", callId: "b", toolName: "Read", output: "b", success: true },
		{ type: "user", text: "Continue." },
	];
	const before = structuredClone(items);
	assert.deepEqual(removeOldestCompactionItem(items), [items[3]]);
	assert.deepEqual(items, before);
	assert.deepEqual(removeOldestCompactionItem([items[1]!, items[0]!, items[2]!, items[3]!]), [
		{ type: "assistant_tool_calls", text: "Reading.", calls: [calls[1]] }, items[2], items[3],
	]);
});

test("retention keeps recent user text, omits old summaries and bounds the boundary message", () => {
	const counter = new TokenCounter();
	const recent = "请继续修复当前错误。";
	const older = "开始👩🏽‍💻" + "历史约束和上下文 ".repeat(1_000) + "最后的决定✅";
	const items: CanonicalConversationItem[] = [
		{ type: "user", text: "oldest" }, { type: "user", text: older },
		{ type: "assistant", text: "Old output." }, compactionSummaryItem("Old summary."),
		{ type: "user", text: recent, images: [{ mediaType: "image/png", data: "AA==" }] },
	];
	const retained = retainCompactionUserMessages(items, counter, 120);
	assert.equal(retained.length, 2);
	assert.deepEqual(retained[1], { type: "user", text: recent });
	const boundary = retained[0];
	assert.ok(boundary?.type === "user");
	assert.match(boundary.text, /truncated during compaction/u);
	assert.ok(boundary.text.startsWith("开始"));
	assert.ok(boundary.text.endsWith("最后的决定✅"));
	assert.ok(boundary.text.isWellFormed());
	assert.ok(counter.count(boundary.text) + counter.count(recent) <= 120);
	assert.doesNotMatch(JSON.stringify(retained), /oldest|Old output|Old summary/u);
	assert.deepEqual(retainCompactionUserMessages(items, counter, 0), []);
});

test("the default retained user budget is 20000 tokens and does not cap the summary", () => {
	const counter = new TokenCounter();
	const text = "user ".repeat(25_000);
	const retained = retainCompactionUserMessages([{ type: "user", text }], counter);
	assert.equal(retained.length, 1);
	assert.ok(retained[0]?.type === "user");
	const tokens = counter.count(retained[0].text);
	assert.ok(tokens > 19_900 && tokens <= 20_000);
	assert.ok(compactionSummaryItem(text).text.endsWith(text));
});
