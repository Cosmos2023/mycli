import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintSubmission } from "../src/index.ts";

test("submission fingerprint is deterministic and secret-free", () => {
	const firstInput = {
		message: "hello",
		modelOverride: "gpt-test",
		reasoningEffort: "low",
		apiKey: "secret-one",
	};
	const secondInput = {
		reasoningEffort: "low",
		apiKey: "secret-two",
		modelOverride: "gpt-test",
		message: "hello",
	};
	const first = fingerprintSubmission(firstInput);
	const second = fingerprintSubmission(secondInput);

	assert.match(first, /^sha256:[0-9a-f]{64}$/);
	assert.equal(first, second);
});

test("submission fingerprint changes with behavior-affecting input", () => {
	assert.notEqual(
		fingerprintSubmission({ message: "first" }),
		fingerprintSubmission({ message: "second" }),
	);
});
