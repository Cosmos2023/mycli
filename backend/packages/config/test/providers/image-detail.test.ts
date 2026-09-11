import assert from "node:assert/strict";
import test from "node:test";
import { canRequestOriginalImageDetail } from "../../src/index.ts";

test("original image detail is admitted only for known capable Responses models", () => {
	for (const model of ["gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.4-2026-03-05"]) {
		assert.equal(canRequestOriginalImageDetail({ protocol: "responses", model }), true);
		assert.equal(canRequestOriginalImageDetail({ protocol: "chat_completions", model }), false);
	}
	for (const model of ["gpt-5.2", "unknown", "gpt-5.4-custom", undefined]) {
		assert.equal(canRequestOriginalImageDetail({ protocol: "responses", model }), false);
	}
});
