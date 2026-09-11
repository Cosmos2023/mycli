import assert from "node:assert/strict";
import test from "node:test";
import { createErrorContext, errorSummary, parseProviderAttemptRecord, parseProviderAttemptUpdate, ContractValidationError } from "../src/index.ts";
import type { ProviderAttemptUpdate } from "../src/index.ts";

const NOW = "2026-09-07T00:00:00.000Z";
const START: ProviderAttemptUpdate = {
	sequence: 1, attempt: 1, state: "started", observedAt: NOW,
	policy: { requestMaxRetries: 2, streamMaxRetries: 2 },
	requestRetriesUsed: 0, streamRetriesUsed: 0,
};

test("provider attempts are bounded and reject contradictory budget and state fields", () => {
	assert.deepEqual(parseProviderAttemptUpdate(START), START);
	for (const patch of [
		{ attempt: 2 }, { sequence: 1001 }, { observedAt: "2026-02-30T00:00:00Z" },
		{ unknown: true }, { state: "failed" }, { state: "scheduled" }, { state: "recovered" },
		{ requestRetriesUsed: -1 }, { resetOutput: true }, { retryAt: NOW },
		{ policy: { requestMaxRetries: 101, streamMaxRetries: 2 } },
	]) assert.throws(() => parseProviderAttemptUpdate({ ...START, ...patch }), ContractValidationError);
});

test("provider attempt failure parsing redacts details and retains only safe diagnostics", () => {
	const result = parseProviderAttemptUpdate({
		...START, sequence: 2, state: "failed",
		failure: {
			code: "server_overloaded", message: "unsafe arbitrary message",
			additionalDetails: "busy token=super-secret Bearer private-value",
			retryable: true,
			diagnostics: { status: 503, upstream_code: "overloaded", request_id: "req-1", raw_body: "private" },
		},
	});
	assert.equal(result.failure?.message, "provider is overloaded");
	assert.equal(result.failure?.additionalDetails?.includes("super-secret"), false);
	assert.deepEqual(result.failure?.diagnostics, { status: 503, upstream_code: "overloaded", request_id: "req-1" });
	assert.throws(() => parseProviderAttemptUpdate({
		...result, failure: { ...result.failure, code: "invented", retryable: true },
	}), ContractValidationError);
});

test("record parsing validates metadata independently from the update", () => {
	const input = {
		...START, eventId: "event-1", attemptId: "attempt-1", retryChainId: "request-1",
		sessionId: "session-1", turnId: "turn-1", requestId: "request-1",
		provider: "openai", model: "gpt-test", source: "worker", committedAt: NOW,
	};
	assert.equal(parseProviderAttemptRecord(input).requestId, "request-1");
	assert.throws(() => parseProviderAttemptUpdate(input), ContractValidationError);
	assert.throws(() => parseProviderAttemptRecord({ ...input, apiKey: "secret" }), ContractValidationError);
});

test("attempt failures retain concrete causes and quarantine incompatible optional context", () => {
	const errorContext = createErrorContext({
		reason: "capability.image_input_unsupported", source: "provider",
		scope: { kind: "provider_attempt", id: "attempt:image" },
		outcome: { state: "not_started", effects: "none" },
		details: { model: "deepseek-v4-flash", input_origin: "history" },
	});
	const input = { ...START, sequence: 2, state: "failed", failure: {
		code: "unsupported_capability", message: "legacy capability text", retryable: false, errorContext,
	} };
	const failure = parseProviderAttemptUpdate(input).failure!;
	assert.deepEqual(failure.errorContext, errorContext);
	assert.equal(failure.message, errorSummary(errorContext));
	const future = parseProviderAttemptUpdate({ ...input, failure: {
		...input.failure, errorContext: { ...errorContext, version: 2 },
	} });
	assert.equal(future.state, "failed");
	assert.equal(future.failure?.errorContext, undefined);
	assert.equal(future.failure?.diagnostics?.error_context_invalid, true);
});
