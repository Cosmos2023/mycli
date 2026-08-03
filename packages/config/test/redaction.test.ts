import assert from "node:assert/strict";
import test from "node:test";
import { redactValue } from "../src/index.ts";

test("redacts nested credential fields and bearer text", () => {
	assert.deepEqual(redactValue({
		apiKey: "secret",
		headers: { Authorization: "Bearer token-value", Accept: "application/json" },
		message: "request failed with Bearer another-token",
	}), {
		apiKey: "[REDACTED]",
		headers: { Authorization: "[REDACTED]", Accept: "application/json" },
		message: "request failed with Bearer [REDACTED]",
	});
});
