import assert from "node:assert/strict";
import test from "node:test";
import {
	canonicalRuntimeFailureMessage,
	canonicalTurnFailureMessage,
	isRuntimeErrorCode,
	RUNTIME_ERROR_CODES,
	RUNTIME_RETRY_AFTER_MAX_SECONDS,
	runtimeErrorNoticeSeverity,
	runtimeErrorPublicMessage,
	runtimeErrorRecoveryHint,
	runtimeRetryStatusText,
	sanitizeRuntimeErrorDetail,
	turnFailureNotice,
} from "../src/index.ts";

test("runtime error taxonomy owns every public message", () => {
	assert.deepEqual(RUNTIME_ERROR_CODES, [
		"config_error",
		"auth_error",
		"permission_denied",
		"invalid_request",
		"provider_error",
		"connection_error",
		"response_stream_error",
		"server_overloaded",
		"rate_limited",
		"quota_exceeded",
		"context_window_exceeded",
		"retry_exhausted",
		"persistence_error",
		"interrupted",
		"unsupported_capability",
		"tool_budget_exceeded",
		"tool_protocol_error",
	]);
	assert.equal(runtimeErrorPublicMessage("auth_error"), "provider authentication failed");
	assert.equal(runtimeErrorPublicMessage("connection_error"), "provider connection failed");
	assert.equal(runtimeErrorPublicMessage("server_overloaded"), "provider is overloaded");
	assert.equal(
		runtimeErrorPublicMessage("unsupported_capability"),
		"provider requested an unsupported capability",
	);
	assert.equal(isRuntimeErrorCode("provider_error"), true);
	assert.equal(isRuntimeErrorCode("internal_error"), false);
	assert.equal(runtimeErrorNoticeSeverity("server_overloaded"), "warning");
	assert.equal(runtimeErrorNoticeSeverity("auth_error"), "error");
	assert.deepEqual(
		Object.fromEntries(RUNTIME_ERROR_CODES.flatMap((code) => {
			const hint = runtimeErrorRecoveryHint(code);
			return hint ? [[code, hint]] : [];
		})),
		{
			config_error: "Update the provider configuration, then retry.",
			auth_error: "Check the configured provider credentials.",
			permission_denied: "Check that the account can access this model.",
			rate_limited: "Wait for the cooldown, then retry.",
			quota_exceeded: "Check the provider billing plan or quota.",
			context_window_exceeded: "Compact this conversation or start a new session.",
		},
	);
	assert.equal(runtimeErrorRecoveryHint("provider_error"), undefined);
	assert.equal(RUNTIME_RETRY_AFTER_MAX_SECONDS, 3_600);
});

test("retry status text distinguishes reconnection from other recovery", () => {
	assert.equal(runtimeRetryStatusText("connection_error", 1, 4), "Reconnecting... 1/4");
	assert.equal(runtimeRetryStatusText("response_stream_error", 2, 5), "Reconnecting... 2/5");
	assert.equal(runtimeRetryStatusText("server_overloaded", 1, 4), "Retrying... 1/4");
	assert.equal(runtimeRetryStatusText("rate_limited", 2, 1), "Retrying... 2/2");
});

test("turn failure messages accept only the canonical prefix and redact public detail", () => {
	const raw = "provider request failed: Invalid schema token=private-value\n    at request (/Users/cosmos/app.ts:1:2)";

	assert.equal(
		canonicalTurnFailureMessage("provider_error", raw),
		"provider request failed: Invalid schema token=[REDACTED]",
	);
	assert.equal(
		turnFailureNotice("provider_error", raw),
		"Provider request failed: Invalid schema token=[REDACTED].",
	);
});

test("turn failure messages reject arbitrary exception text", () => {
	assert.equal(
		canonicalTurnFailureMessage("provider_error", "private upstream response"),
		"provider request failed",
	);
	assert.equal(turnFailureNotice("provider_error", "private upstream response"), "Provider request failed.");
	assert.equal(
		canonicalTurnFailureMessage("provider_error", "provider request failed malicious detail"),
		"provider request failed",
	);
});

test("runtime failure sanitization is shared by provider and terminal projections", () => {
	const raw = "Invalid schema token=private-value\n    at request (/Users/cosmos/app.ts:1:2)";
	assert.equal(sanitizeRuntimeErrorDetail(raw), "Invalid schema token=[REDACTED]");
	assert.equal(
		canonicalRuntimeFailureMessage("provider_error", `provider request failed: ${raw}`),
		"provider request failed: Invalid schema token=[REDACTED]",
	);
	assert.equal(
		canonicalRuntimeFailureMessage("unknown_error", "unknown_error: private"),
		"provider request failed",
	);
});

test("runtime failure sanitization removes redundant SDK empty-body status text", () => {
	assert.equal(
		sanitizeRuntimeErrorDetail("401 status code (no body) (status 401, request id: req_1)"),
		"(status 401, request id: req_1)",
	);
	assert.equal(sanitizeRuntimeErrorDetail("401 status code (no body)"), undefined);
	assert.equal(
		sanitizeRuntimeErrorDetail("401 status code (no body) with useful context"),
		"401 status code (no body) with useful context",
	);
});
