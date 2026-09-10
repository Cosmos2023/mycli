import assert from "node:assert/strict";
import test from "node:test";
import {
	projectAgentWorkerToolResult,
} from "../../src/index.ts";

test("persists complete tool output before returning a bounded Worker projection", async () => {
	const persisted: string[] = [];
	const result = await projectAgentWorkerToolResult({
		sessionId: "session-1",
		turnId: "turn-1",
		attemptId: "attempt-1",
		result: Object.freeze({
			callId: "call-1",
			toolName: "Shell",
			success: true,
			modelOutput: "abcdefghij",
			summary: "ran",
			metadata: Object.freeze({}),
		}),
		maxChars: 4,
		artifacts: {
			persist: async (input) => {
				persisted.push(input.output);
				return "artifact:attempt-1";
			},
		},
	});

	assert.deepEqual(persisted, ["abcdefghij"]);
	assert.equal(result.modelOutput, "abcd");
	assert.deepEqual(result.metadata, {
		model_output_truncated: true,
		model_output_omitted_chars: 6,
		artifact_reference: "artifact:attempt-1",
	});
});
