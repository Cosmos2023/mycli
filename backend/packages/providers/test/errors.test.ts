import assert from "node:assert/strict";
import test from "node:test";
import * as providers from "../src/index.ts";

test("classifies authentication errors with a redacted public detail", () => {
	const failure = providers.classifyProviderError({
		status: 401,
		message: "bad key sk-secret-value",
		request_id: "req_1",
	});

	assert.equal(failure.code, "auth_error");
	assert.equal(failure.retryable, false);
	assert.equal(failure.message, "auth_error: provider authentication failed");
	assert.equal(
		providers.providerFailurePublicMessage(failure),
		"provider authentication failed: bad key [REDACTED] (status 401, request id: req_1)",
	);
	assert.doesNotMatch(JSON.stringify(failure.diagnostics), /sk-secret-value/);
	assert.deepEqual(providers.providerFailureToRuntimeFailure(failure), {
		code: "auth_error",
		message: "provider authentication failed",
		additionalDetails: "bad key [REDACTED] (status 401, request id: req_1)",
		retryable: false,
		diagnostics: { status: 401, request_id: "req_1" },
	});
});

test("suppresses redundant SDK empty-body text while retaining structured diagnostics", () => {
	const failure = providers.classifyProviderError({
		status: 401,
		message: "401 status code (no body)",
		request_id: "req_empty_body_1",
	});

	assert.equal(failure.publicDetail, undefined);
	assert.equal(
		providers.providerFailurePublicMessage(failure),
		"provider authentication failed (status 401, request id: req_empty_body_1)",
	);
	assert.deepEqual(providers.providerFailureToRuntimeFailure(failure), {
		code: "auth_error",
		message: "provider authentication failed",
		additionalDetails: "(status 401, request id: req_empty_body_1)",
		retryable: false,
		diagnostics: { status: 401, request_id: "req_empty_body_1" },
	});
});

test("classifies rate limits as retryable with bounded retry-after", () => {
	const failure = providers.classifyProviderError({
		status: 429,
		headers: { "retry-after": "2.5", authorization: "Bearer secret" },
	});

	assert.equal(failure.code, "rate_limited");
	assert.equal(failure.retryable, true);
	assert.equal(failure.retryAfterSeconds, 2.5);
});

test("honors millisecond, HTTP-date, and structured-message retry delays", () => {
	const milliseconds = providers.classifyProviderError({
		status: 429,
		headers: new Headers({ "retry-after": "9", "retry-after-ms": "1250" }),
	});
	assert.equal(milliseconds.retryAfterSeconds, 1.25);

	const pastDate = providers.classifyProviderError({
		status: 500,
		headers: { "Retry-After": "Thu, 01 Jan 1970 00:00:00 GMT" },
	});
	assert.equal(pastDate.retryable, true);
	assert.equal(pastDate.retryAfterSeconds, 0);

	for (const [message, expectedSeconds] of [
		["Rate limit reached. Please try again in 28ms.", 0.028],
		["Rate limit reached. Please try again in 1.898s.", 1.898],
		["Rate limit reached. Try again in 35 seconds.", 35],
	] as const) {
		const structuredMessage = providers.classifyProviderError({
			status: 429,
			error: { code: "rate_limit_exceeded", message },
		});
		assert.equal(structuredMessage.retryAfterSeconds, expectedSeconds);
	}
});

test("bounds explicit retry delays and ignores invalid values", () => {
	assert.equal(new providers.ProviderFailure({
		code: "provider_error",
		message: "retry later",
		retryable: true,
		retryAfterSeconds: 7_200,
	}).retryAfterSeconds, 3_600);
	assert.equal(new providers.ProviderFailure({
		code: "provider_error",
		message: "retry later",
		retryable: true,
		retryAfterSeconds: Number.NaN,
	}).retryAfterSeconds, undefined);
});

test("classifies invalid requests with safe nested diagnostics and a sanitized message", () => {
	const failure = providers.classifyProviderError({
		status: 400,
		request_id: "req_schema_1",
		error: {
			code: "invalid_function_parameters",
			type: "invalid_request_error",
			message: "private schema body sk-secret-value",
		},
	});

	assert.equal(failure.code, "invalid_request");
	assert.equal(failure.retryable, false);
	assert.deepEqual(failure.diagnostics, {
		status: 400,
		request_id: "req_schema_1",
		provider_error_code: "invalid_function_parameters",
		provider_error_type: "invalid_request_error",
	});
	assert.equal(
		providers.providerFailurePublicMessage(failure),
		"provider rejected the request: private schema body [REDACTED] (status 400, request id: req_schema_1)",
	);
	assert.doesNotMatch(JSON.stringify(failure.diagnostics), /private|secret|message/u);
});

test("classifies payload and media-type rejections as invalid requests", () => {
	for (const status of [413, 415]) {
		const failure = providers.classifyProviderError({ status });
		assert.equal(failure.code, "invalid_request");
		assert.equal(failure.retryable, false);
	}
});

test("classifies Anthropic response validation errors as non-retryable", () => {
	const failure = providers.classifyProviderError(Object.assign(
		new Error("raw provider body with secret"),
		{ name: "APIResponseValidationError" },
	));

	assert.equal(failure.code, "provider_error");
	assert.equal(failure.retryable, false);
	assert.equal(failure.message, "provider_error: provider response validation failed");
	assert.equal(providers.providerFailurePublicMessage(failure), "provider request failed");
	assert.doesNotMatch(JSON.stringify(failure.diagnostics), /secret/);
});

test("extracts a bounded structured response body and request id without exposing stacks", () => {
	const failure = providers.classifyProviderError({
		statusCode: 502,
		responseBody: JSON.stringify({
			error: {
				message: `temporary upstream failure token=private-token\n    at request (/Users/cosmos/app.ts:1:2)${"x".repeat(2_000)}`,
			},
		}),
		headers: new Headers({ "x-request-id": "req_body_1" }),
	});
	const message = providers.providerFailurePublicMessage(failure);

	assert.equal(failure.retryable, true);
	assert.match(message, /^provider request failed: temporary upstream failure token=\[REDACTED\]/u);
	assert.match(message, /\(status 502, request id: req_body_1\)$/u);
	assert.doesNotMatch(message, /private-token|\/Users|app\.ts|at request/u);
	assert.ok(message.length <= 1_100);
});

test("does not promote an ordinary local exception to public provider detail", () => {
	const failure = providers.classifyProviderError(new Error("internal adapter state at file:///private.ts:1:2"));

	assert.equal(failure.code, "provider_error");
	assert.equal(failure.retryable, false);
	assert.equal(providers.providerFailurePublicMessage(failure), "provider request failed");
});

test("classifies permission failures separately from authentication", () => {
	const failure = providers.classifyProviderError({
		status: 403,
		error: { message: "model access denied" },
	});

	assert.equal(failure.code, "permission_denied");
	assert.equal(failure.retryable, false);
	assert.equal(
		providers.providerFailurePublicMessage(failure),
		"provider access was denied: model access denied (status 403)",
	);
});

test("classifies context overflow before generic invalid requests", () => {
	const failure = providers.classifyProviderError({
		status: 400,
		error: {
			code: "context_window_exceeded",
			message: "maximum context length exceeded",
		},
	});

	assert.equal(failure.code, "context_window_exceeded");
	assert.equal(failure.retryable, false);
});

test("distinguishes exhausted quota from retryable rate limiting", () => {
	const failure = providers.classifyProviderError({
		status: 429,
		error: {
			code: "insufficient_quota",
			type: "insufficient_quota",
			message: "billing limit reached",
		},
	});

	assert.equal(failure.code, "quota_exceeded");
	assert.equal(failure.retryable, false);
	assert.equal(providers.providerFailurePublicMessage(failure), (
		"provider quota exceeded: billing limit reached (status 429)"
	));
});

test("classifies explicit overloads as retryable and preserves retry-after", () => {
	const failure = providers.classifyProviderError({
		status: 429,
		type: "overloaded_error",
		message: "temporarily overloaded",
		headers: { "retry-after": "3" },
	});

	assert.equal(failure.code, "server_overloaded");
	assert.equal(failure.retryable, true);
	assert.equal(failure.retryAfterSeconds, 3);
	assert.equal(
		providers.providerFailurePublicMessage(failure),
		"provider is overloaded: temporarily overloaded (status 429)",
	);
});

test("classifies SDK connection failures from bounded type and cause diagnostics", () => {
	const failure = providers.classifyProviderError(Object.assign(
		new Error("socket included private upstream text"),
		{
			name: "APIConnectionError",
			cause: { code: "ECONNRESET" },
		},
	));

	assert.equal(failure.code, "connection_error");
	assert.equal(failure.retryable, true);
	assert.deepEqual(failure.diagnostics, {
		transport_error_code: "ECONNRESET",
		transport_error_name: "APIConnectionError",
	});
	assert.equal(providers.providerFailurePublicMessage(failure), "provider connection failed");
});

test("uses SDK class identity for abort, validation, and explicit retryable errors", () => {
	class APIUserAbortError extends Error {}
	class APIResponseValidationError extends Error {}
	class RetryableError extends Error {}

	assert.equal(providers.classifyProviderError(new APIUserAbortError()).code, "interrupted");
	const validation = providers.classifyProviderError(new APIResponseValidationError("private body"));
	assert.equal(validation.code, "provider_error");
	assert.equal(validation.retryable, false);
	assert.equal(providers.providerFailurePublicMessage(validation), "provider request failed");
	const retryable = providers.classifyProviderError(new RetryableError("private middleware state"));
	assert.equal(retryable.code, "provider_error");
	assert.equal(retryable.retryable, true);
	assert.equal(providers.providerFailurePublicMessage(retryable), "provider request failed");
});
