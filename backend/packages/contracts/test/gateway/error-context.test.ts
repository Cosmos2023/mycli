import assert from "node:assert/strict";
import test from "node:test";
import { createErrorContext, parseGatewayEvent, parseGatewayResult, projectGatewayErrorData, projectGatewayErrorPayload } from "../../src/index.ts";

const context = createErrorContext({ reason: "transport.timed_out", source: "provider",
	scope: { kind: "provider_attempt", id: "attempt:1" }, outcome: { state: "failed", effects: "none" },
});
const attempt = {
	eventId: "event:1", attemptId: "attempt:1", retryChainId: "request:1", sessionId: "session:1", turnId: "turn:1",
	requestId: "request:1", provider: "openai", model: "gpt-test", source: "worker", committedAt: "2026-09-10T00:00:00Z",
	sequence: 2, attempt: 1, state: "failed", observedAt: "2026-09-10T00:00:00Z",
	policy: { requestMaxRetries: 1, streamMaxRetries: 1 }, requestRetriesUsed: 0, streamRetriesUsed: 0,
	failure: { code: "connection_error", message: "connection failed", retryable: true, errorContext: context },
};

test("unknown optional attempt context cannot invalidate an otherwise authoritative terminal event", () => {
	const future = { ...attempt, failure: { ...attempt.failure, errorContext: { ...context, version: 2 } } };
	const event = parseGatewayEvent({ jsonrpc: "2.0", method: "provider.attempt.updated", params: {
		session_id: "session:1", turn_id: "turn:1", record: future,
	} });
	assert.equal(event.method, "provider.attempt.updated");
	if (event.method !== "provider.attempt.updated") return;
	assert.equal(event.params.record.failure?.errorContext, undefined);
	assert.equal(event.params.record.failure?.diagnostics?.error_context_invalid, true);
	assert.equal(event.params.record.state, "failed");
	assert.throws(() => parseGatewayEvent({ ...event, params: { ...event.params, turn_id: "wrong-turn" } }));
	const page = parseGatewayResult("provider.attempts.load", { session_id: "session:1", records: [future], has_more: false });
	assert.equal(page.records[0]?.failure?.errorContext, undefined);
});

test("legacy projection removes known nested extensions while preserving user payloads", () => {
	const result = { session_id: "session:1", items: [{ id: "error:1", type: "error", text: "failed", folded: false,
		metadata: { error_context: context, provider_attempt: { failure: attempt.failure }, user_data: { error_context: "user value" } },
		tool_record: { error_context: context },
	}], provider_attempts: [attempt] };
	const legacy = projectGatewayErrorPayload("transcript.load", result, "legacy") as typeof result;
	assert.equal(legacy.items[0]?.metadata.error_context, undefined);
	assert.equal(legacy.items[0]?.metadata.provider_attempt.failure.errorContext, undefined);
	assert.equal(legacy.items[0]?.tool_record.error_context, undefined);
	assert.equal(legacy.provider_attempts[0]?.failure.errorContext, undefined);
	assert.equal(legacy.items[0]?.metadata.user_data.error_context, "user value");
	assert.deepEqual(result.provider_attempts[0]?.failure.errorContext, context);
});

test("malformed error context degrades safely on turn events and tool records", () => {
	const event = parseGatewayEvent({ jsonrpc: "2.0", method: "turn.failed", params: {
		client_turn_id: "client:1", turn_id: "turn:1", code: "connection_error", message: "failed",
		error_context: { ...context, reason: "future.reason" }, recovery_actions: ["retry"],
	} });
	assert.ok(event.method === "turn.failed");
	assert.equal(event.params.error_context, undefined);
	assert.equal(event.params.error_context_invalid, true);
	assert.equal(event.params.recovery_actions, undefined);
});

test("legacy projection removes version-1 recovery actions and optional-context markers", () => {
	const data = { error_context: context, error_context_invalid: true, recovery_actions: ["inspect_execution", "select_compatible_model", "run_doctor"] };
	const expected = { recovery_actions: ["run_doctor"] };
	assert.deepEqual(projectGatewayErrorData(data, "legacy"), expected);
	assert.deepEqual(projectGatewayErrorData({ error_context_invalid: true, recovery_actions: data.recovery_actions }, "legacy"), expected);
	assert.deepEqual(projectGatewayErrorPayload("gateway.error", { code: "internal_error", message: "failed", ...data }, "legacy"), {
		code: "internal_error", message: "failed", ...expected,
	});
	assert.deepEqual(data.error_context, context);
});
