import assert from "node:assert/strict";
import test from "node:test";
import { parseGatewayEvent, parseGatewayParams, parseGatewayResult, type ProviderAttemptRecord } from "../../src/index.ts";

test("gateway attempt records validate ownership and semantic state before delivery", () => {
	const record = failedRecord();
	const params = { session_id: "session-1", turn_id: "turn-1", record };
	const direct = parseGatewayEvent({ jsonrpc: "2.0", method: "provider.attempt.updated", params });
	const envelope = parseGatewayEvent({ jsonrpc: "2.0", method: "runtime.event", params: {
		version: 1, sequence: 1, type: "provider.attempt.updated", payload: params, timestamp: 1,
		session_id: "session-1", generation: 1, turn_id: "turn-1",
	} });
	assert.doesNotMatch(JSON.stringify([direct, envelope]), /private-secret/u);
	assert.match(JSON.stringify(direct), /REDACTED/u);
	assert.throws(() => parseGatewayEvent({ jsonrpc: "2.0", method: "provider.attempt.updated", params: { ...params, turn_id: "other" } }));
	assert.throws(() => parseGatewayEvent({ jsonrpc: "2.0", method: "provider.attempt.updated", params: {
		...params, record: { ...record, state: "completed" },
	} }));
	assert.throws(() => parseGatewayResult("provider.attempts.load", {
		session_id: "other", records: [record], has_more: false,
	}));
});

test("attempt history queries are bounded and require a request for sequence pagination", () => {
	assert.deepEqual(parseGatewayParams("provider.attempts.load", { request_id: "request-1", after_sequence: 2, limit: 100 }),
		{ request_id: "request-1", after_sequence: 2, limit: 100 });
	assert.deepEqual(parseGatewayParams("provider.attempts.load", { before_event_id: "event-1", limit: 100 }),
		{ before_event_id: "event-1", limit: 100 });
	for (const params of [{ limit: 501 }, { limit: 0 }, { after_sequence: 1 }, { secret: "private-secret" },
		{ before_event_id: "event-1", request_id: "request-1" }, { before_event_id: "event-1", after_sequence: 1 }]) {
		assert.throws(() => parseGatewayParams("provider.attempts.load", params));
	}
	const loaded = parseGatewayResult("transcript.load", {
		session_id: "session-1", items: [], next_before: null, provider_attempts: [failedRecord()], provider_attempts_truncated: false,
	});
	assert.equal(loaded.provider_attempts?.length, 1);
	assert.doesNotMatch(JSON.stringify(loaded), /private-secret/u);
});

function failedRecord(): ProviderAttemptRecord {
	return {
		eventId: "event-1", attemptId: "attempt-1", retryChainId: "request-1", requestId: "request-1",
		sessionId: "session-1", turnId: "turn-1", provider: "openai", model: "gpt-test", source: "worker",
		sequence: 1, attempt: 1, state: "failed", policy: { requestMaxRetries: 2, streamMaxRetries: 2 },
		requestRetriesUsed: 0, streamRetriesUsed: 0, observedAt: "2026-09-07T08:00:00Z", committedAt: "2026-09-07T08:00:00Z",
		failure: { code: "response_stream_error", message: "Stream failed", retryable: true,
			additionalDetails: "stream_read_error token=private-secret", diagnostics: { provider_error_code: "stream_read_error" } },
	};
}
