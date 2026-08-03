import assert from "node:assert/strict";
import test from "node:test";
import * as providers from "../src/index.ts";

test("classifies authentication errors without leaking upstream text", () => {
	const classifyProviderError = Reflect.get(providers, "classifyProviderError") as ((
		error: unknown,
	) => Error & { code?: string; retryable?: boolean; diagnostics?: unknown }) | undefined;
	assert.equal(typeof classifyProviderError, "function");
	const failure = classifyProviderError!({
		status: 401,
		message: "bad key sk-secret-value",
		request_id: "req_1",
	});

	assert.equal(failure.code, "auth_error");
	assert.equal(failure.retryable, false);
	assert.equal(failure.message, "auth_error: provider authentication failed");
	assert.doesNotMatch(JSON.stringify(failure.diagnostics), /sk-secret-value/);
});

test("classifies rate limits as retryable with bounded retry-after", () => {
	const classifyProviderError = Reflect.get(providers, "classifyProviderError") as ((
		error: unknown,
	) => Error & { code?: string; retryable?: boolean; retryAfterSeconds?: number }) | undefined;
	assert.equal(typeof classifyProviderError, "function");
	const failure = classifyProviderError!({
		status: 429,
		headers: { "retry-after": "2.5", authorization: "Bearer secret" },
	});

	assert.equal(failure.code, "rate_limited");
	assert.equal(failure.retryable, true);
	assert.equal(failure.retryAfterSeconds, 2.5);
});
