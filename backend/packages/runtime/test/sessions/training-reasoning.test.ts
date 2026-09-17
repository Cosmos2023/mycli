import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderReplayState } from "@mycli/core";
import { trainingReasoning } from "../../src/sessions/training/reasoning.ts";
import { TrainingRedactor } from "../../src/sessions/training/redaction.ts";

test("plaintext reasoning is extracted across replay formats without exporting signatures or encrypted data", () => {
	const cases: ReadonlyArray<{ state: ProviderReplayState; kind: "thinking" | "summary" }> = [
		{ state: { provider: "deepseek", value: { reasoningContent: "Reason step.\nAPI_KEY=test-secret" } }, kind: "thinking" },
		{ state: { provider: "anthropic", value: { thinkingBlocks: [{ thinking: "Reason step.\nAPI_KEY=test-secret", signature: "private" }] } }, kind: "thinking" },
		{ state: { provider: "openai", value: { transport: { api: "openai-responses" }, thinkingBlocks: [{ thinking: "Reason step.\nAPI_KEY=test-secret", thinkingSignature: "private" }] } }, kind: "summary" },
		{ state: { provider: "openai", value: { responsesNativeItems: [{ type: "reasoning", encrypted_content: "private", summary: [{ type: "summary_text", text: "Reason step.\nAPI_KEY=test-secret" }] }] } }, kind: "summary" },
	];
	for (const { state, kind } of cases) assert.deepEqual(trainingReasoning(state, new TrainingRedactor()), [{ kind, text: "Reason step.\nAPI_KEY=[REDACTED]" }]);
	assert.deepEqual(trainingReasoning({ provider: "openai", value: { thinkingSignature: "private", encrypted_content: "private", nested: { thinking: "must not guess" } } }, new TrainingRedactor()), []);
	assert.deepEqual(trainingReasoning({ provider: "anthropic", value: { thinkingBlocks: [{ thinking: "private", redacted: true }, { type: "redacted_thinking", thinking: "private" }] } }, new TrainingRedactor()), []);
});
