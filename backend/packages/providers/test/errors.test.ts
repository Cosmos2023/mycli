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

test("preserves safe nested provider diagnostics without retaining the upstream message", () => {
	const failure = providers.classifyProviderError({
		status: 400,
		request_id: "req_schema_1",
		error: {
			code: "invalid_function_parameters",
			type: "invalid_request_error",
			message: "private schema body sk-secret-value",
		},
	});

	assert.equal(failure.code, "provider_error");
	assert.equal(failure.retryable, false);
	assert.deepEqual(failure.diagnostics, {
		status: 400,
		request_id: "req_schema_1",
		provider_error_code: "invalid_function_parameters",
		provider_error_type: "invalid_request_error",
	});
	assert.doesNotMatch(JSON.stringify(failure.diagnostics), /private|secret|message/u);
});

test("classifies Anthropic response validation errors as non-retryable", () => {
	const failure = providers.classifyProviderError(Object.assign(
		new Error("raw provider body with secret"),
		{ name: "APIResponseValidationError" },
	));

	assert.equal(failure.code, "provider_error");
	assert.equal(failure.retryable, false);
	assert.equal(failure.message, "provider_error: provider response validation failed");
	assert.doesNotMatch(JSON.stringify(failure.diagnostics), /secret/);
});
