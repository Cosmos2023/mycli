import assert from "node:assert/strict";
import test from "node:test";
import * as runtime from "../../src/index.ts";

type DecideRetry = (input: {
	readonly retryable: boolean;
	readonly eventsObserved: number;
	readonly allowAfterEvents?: boolean;
	readonly retriesUsed: number;
	readonly maxRetries: number;
	readonly retryAfterSeconds?: number;
	readonly random: () => number;
}) => { readonly shouldRetry: boolean; readonly attempt?: number; readonly delayMs?: number };

test("retry policy applies exponential jitter, clamping, and retry-after", () => {
	const decideRetry = Reflect.get(runtime, "decideRetry") as DecideRetry | undefined;
	assert.equal(typeof decideRetry, "function");

	assert.deepEqual(decideRetry!({
		retryable: true,
		eventsObserved: 0,
		retriesUsed: 0,
		maxRetries: 500,
		random: () => 0.5,
	}), { shouldRetry: true, attempt: 1, delayMs: 200 });
	assert.deepEqual(decideRetry!({
		retryable: true,
		eventsObserved: 0,
		retriesUsed: 1,
		maxRetries: 2,
		random: () => 1,
	}), { shouldRetry: true, attempt: 2, delayMs: 440 });
	assert.deepEqual(decideRetry!({
		retryable: true,
		eventsObserved: 0,
		retriesUsed: 0,
		maxRetries: 1,
		retryAfterSeconds: 1.25,
		random: () => 0,
	}), { shouldRetry: true, attempt: 1, delayMs: 1250 });
	assert.deepEqual(decideRetry!({
		retryable: true,
		eventsObserved: 0,
		retriesUsed: 0,
		maxRetries: 1,
		retryAfterSeconds: 7_200,
		random: () => 0,
	}), { shouldRetry: true, attempt: 1, delayMs: 3_600_000 });
	assert.deepEqual(decideRetry!({
		retryable: true,
		eventsObserved: 0,
		retriesUsed: 0,
		maxRetries: 1,
		retryAfterSeconds: Number.NaN,
		random: () => 0.5,
	}), { shouldRetry: true, attempt: 1, delayMs: 200 });
});

test("retry policy refuses exhausted, non-retryable, and post-event failures", () => {
	const decideRetry = Reflect.get(runtime, "decideRetry") as DecideRetry | undefined;
	assert.equal(typeof decideRetry, "function");
	for (const input of [
		{ retryable: false, eventsObserved: 0, retriesUsed: 0, maxRetries: 4 },
		{ retryable: true, eventsObserved: 1, retriesUsed: 0, maxRetries: 4 },
		{ retryable: true, eventsObserved: 0, retriesUsed: 4, maxRetries: 4 },
	]) {
		assert.deepEqual(decideRetry!({ ...input, random: () => 0.5 }), { shouldRetry: false });
	}
	assert.deepEqual(decideRetry!({
		retryable: true,
		eventsObserved: 1,
		allowAfterEvents: true,
		retriesUsed: 0,
		maxRetries: 1,
		random: () => 0.5,
	}), { shouldRetry: true, attempt: 1, delayMs: 200 });
});
