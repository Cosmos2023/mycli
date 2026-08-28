import assert from "node:assert/strict";
import test from "node:test";
import { RUNTIME_ERROR_CODES } from "@mycli/contracts";
import { runtimeErrorStopReason } from "../src/runtime-error-stop-reason.ts";

test("maps every canonical runtime error to a durable stop reason", () => {
	assert.equal(new Set(RUNTIME_ERROR_CODES.map(runtimeErrorStopReason)).size, RUNTIME_ERROR_CODES.length);
	assert.equal(runtimeErrorStopReason("auth_error"), "auth_failed");
	assert.equal(runtimeErrorStopReason("provider_error"), "model_error");
	assert.equal(runtimeErrorStopReason("response_stream_error"), "response_stream_error");
	assert.equal(runtimeErrorStopReason(undefined), "runtime_error");
});
