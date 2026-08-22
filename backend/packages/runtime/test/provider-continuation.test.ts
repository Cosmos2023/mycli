import assert from "node:assert/strict";
import test from "node:test";
import {
	buildProviderRequestSignature,
	ProviderContinuationCoordinator,
	selectProviderContinuation,
	type PersistedProviderContinuation,
} from "../src/provider-continuation.ts";

const MATCH = {
	protocol: "responses" as const,
	requestSignature: "sha256:request",
	requestInput: [
		{ type: "user", text: "current" },
		{ type: "assistant", text: "tool call" },
		{ type: "tool_result", output: "done" },
	],
	model: "gpt-test",
	historyBoundary: "turn-1",
};

test("selects a Responses continuation only when every boundary matches", () => {
	assert.deepEqual(selectProviderContinuation({
		...MATCH,
		persisted: eligibleState(),
	}), {
		kind: "responses_continuation",
		responseId: "resp-1",
	});
});

test("Chat always replays canonical history", () => {
	assert.deepEqual(selectProviderContinuation({
		...MATCH,
		protocol: "chat_completions",
		persisted: eligibleState(),
	}), {
		kind: "canonical_replay",
		reason: "chat_replay",
	});
});

test("rejects missing, ineligible, malformed, and mismatched continuation state", () => {
	assert.deepEqual(selectProviderContinuation({ ...MATCH }), {
		kind: "canonical_replay",
		reason: "missing_state",
	});
	assert.deepEqual(selectProviderContinuation({
		...MATCH,
		persisted: { ...eligibleState(), eligible: false, failure_reason: "provider_rejected" },
	}), {
		kind: "canonical_replay",
		reason: "ineligible",
	});
	assert.deepEqual(selectProviderContinuation({ ...MATCH, persisted: { eligible: true } }), {
		kind: "canonical_replay",
		reason: "malformed_state",
	});
	assert.deepEqual(selectProviderContinuation({
		...MATCH,
		persisted: {
			...eligibleState(),
			request_input: Array.from({ length: 4097 }, () => ({ type: "user" })),
		},
	}), {
		kind: "canonical_replay",
		reason: "malformed_state",
	});
	for (const persisted of [
		{ ...eligibleState(), request_signature: "sha256:other" },
		{ ...eligibleState(), model: "gpt-other" },
		{ ...eligibleState(), history_boundary: "turn-other" },
	]) {
		assert.deepEqual(selectProviderContinuation({ ...MATCH, persisted }), {
			kind: "canonical_replay",
			reason: "state_mismatch",
		});
	}
	assert.deepEqual(selectProviderContinuation({
		...MATCH,
		requestInput: [
			{ type: "user", text: "current" },
			{ type: "assistant", text: "different output" },
			{ type: "tool_result", output: "done" },
		],
		persisted: eligibleState(),
	}), {
		kind: "canonical_replay",
		reason: "state_mismatch",
	});
	assert.deepEqual(selectProviderContinuation({
		...MATCH,
		requestInput: [
			{ type: "user", text: "current" },
			{ type: "assistant", text: "tool call" },
		],
		persisted: eligibleState(),
	}), {
		kind: "canonical_replay",
		reason: "state_mismatch",
	});
});

test("builds a stable request signature and changes it with provider-visible settings", () => {
	const base = {
		provider: "openai" as const,
		protocol: "responses" as const,
		model: "gpt-test",
		instructions: "You are mycli.",
		reasoningEffort: "medium" as const,
		tools: [{
			id: "builtin:Read",
			name: "Read",
			description: "Read a file.",
			inputSchema: {
				required: ["file_path"],
				properties: { file_path: { type: "string" } },
				type: "object",
			},
		}],
	};
	const reordered = {
		...base,
		tools: [{
			...base.tools[0]!,
			inputSchema: {
				type: "object",
				properties: { file_path: { type: "string" } },
				required: ["file_path"],
			},
		}],
	};

	assert.equal(buildProviderRequestSignature(base), buildProviderRequestSignature(reordered));
	assert.notEqual(
		buildProviderRequestSignature(base),
		buildProviderRequestSignature({ ...base, model: "gpt-other" }),
	);
	assert.notEqual(
		buildProviderRequestSignature(base),
		buildProviderRequestSignature({ ...base, store: false }),
	);
	assert.notEqual(
		buildProviderRequestSignature(base),
		buildProviderRequestSignature({
			...base,
			developerInstructions: ["Use the review role."],
		}),
	);
});

test("keeps prompt-cache compatibility independent of timeline growth and continuation state", () => {
	const visible = {
		provider: "openai" as const,
		protocol: "responses" as const,
		model: "gpt-test",
		instructions: "You are mycli.",
		promptCacheKey: "cache-key",
		tools: [],
	};
	const firstSignature = buildProviderRequestSignature({
		...visible,
		contextPrefixSha256: "a".repeat(64),
	});
	const extendedSignature = buildProviderRequestSignature({
		...visible,
		contextPrefixSha256: "b".repeat(64),
	});

	assert.equal(extendedSignature, firstSignature);
	assert.deepEqual(selectProviderContinuation({
		...MATCH,
		requestSignature: firstSignature,
	}), {
		kind: "canonical_replay",
		reason: "missing_state",
	});
	assert.deepEqual(selectProviderContinuation({
		...MATCH,
		requestSignature: firstSignature,
		persisted: {
			...eligibleState(),
			request_signature: firstSignature,
		},
	}), {
		kind: "responses_continuation",
		responseId: "resp-1",
	});
});

test("persists safe completions and explicit invalidation", () => {
	const persisted: unknown[] = [];
	const coordinator = new ProviderContinuationCoordinator({
		sessionId: "session-1",
		initialState: eligibleState(),
		persist: (state) => { persisted.push(state); },
	});

	coordinator.recordSafeCompletion({
		...MATCH,
		responseId: "resp-2",
		requestInput: [{ type: "user", text: "current" }],
		responseOutput: [{ type: "assistant", text: "done" }],
	});
	assert.deepEqual(coordinator.select({
		...MATCH,
		requestInput: [
			{ type: "user", text: "current" },
			{ type: "assistant", text: "done" },
			{ type: "user", text: "next" },
		],
	}), {
		kind: "responses_continuation",
		responseId: "resp-2",
	});
	assert.deepEqual(persisted.at(-1), {
		response_id: "resp-2",
		request_signature: "sha256:request",
		request_input: [{ type: "user", text: "current" }],
		response_output: [{ type: "assistant", text: "done" }],
		eligible: true,
		failure_reason: null,
		session_id: "session-1",
		protocol: "responses",
		model: "gpt-test",
		history_boundary: "turn-1",
	});

	coordinator.invalidate("provider_rejected");
	assert.deepEqual(coordinator.select(MATCH), {
		kind: "canonical_replay",
		reason: "ineligible",
	});
	assert.deepEqual(persisted.at(-1), {
		response_id: null,
		request_signature: "sha256:request",
		request_input: [],
		response_output: [],
		eligible: false,
		failure_reason: "provider_rejected",
		session_id: "session-1",
		protocol: "responses",
		model: "gpt-test",
		history_boundary: "turn-1",
	});
});

test("clears malformed or cross-session initial state on first selection", () => {
	for (const initialState of [
		{ eligible: true },
		{ ...eligibleState(), session_id: "another-session" },
	]) {
		const persisted: unknown[] = [];
		const coordinator = new ProviderContinuationCoordinator({
			sessionId: "session-1",
			initialState,
			persist: (state) => { persisted.push(state); },
		});

		assert.deepEqual(coordinator.select(MATCH), {
			kind: "canonical_replay",
			reason: "malformed_state",
		});
		assert.equal((persisted[0] as Record<string, unknown>).eligible, false);
		assert.equal((persisted[0] as Record<string, unknown>).failure_reason, "malformed_state");
	}
});

test("marks oversized continuation input ineligible instead of persisting an invalid record", () => {
	const persisted: PersistedProviderContinuation[] = [];
	const coordinator = new ProviderContinuationCoordinator({
		sessionId: "session-1",
		persist: (state) => { persisted.push(state); },
	});

	coordinator.recordSafeCompletion({
		...MATCH,
		responseId: "resp-large",
		requestInput: Array.from({ length: 4097 }, () => ({ type: "user" })),
		responseOutput: [],
	});

	assert.equal(persisted[0]?.eligible, false);
	assert.equal(persisted[0]?.failure_reason, "continuation_input_too_large");
	assert.deepEqual(persisted[0]?.request_input, []);
});

function eligibleState() {
	return {
		response_id: "resp-1",
		request_signature: "sha256:request",
		request_input: [{ type: "user", text: "current" }],
		response_output: [{ type: "assistant", text: "tool call" }],
		eligible: true,
		failure_reason: null,
		session_id: "session-1",
		protocol: "responses" as const,
		model: "gpt-test",
		history_boundary: "turn-1",
	};
}
