import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
import { boundedUiText, safeErrorMessage } from "../src/safe-ui-text.ts";

test("safe UI text removes terminal controls, stack frames, secrets, and the home path", () => {
	const secret = "sk-abcdefghijklmnop";
	const value = [
		`\u001b[31mRequest failed\u001b[0m Authorization: Bearer private-bearer apiKey=${secret}`,
		`at submit (${homedir()}/mycli.ts:12:4)`,
		`${homedir()}/workspace is unavailable`,
	].join("\n");

	const result = boundedUiText(value, "fallback");

	assert.match(result, /^Request failed/u);
	assert.match(result, /Authorization=\[REDACTED\]/u);
	assert.doesNotMatch(result, /private-bearer|sk-abcdefghijklmnop|mycli\.ts:12|\u001b/u);
	assert.match(result, /~\/workspace is unavailable/u);
});

test("safe error messages use a stable fallback for non-errors and stack-only text", () => {
	assert.equal(safeErrorMessage("raw internal failure", "Request failed."), "Request failed.");
	assert.equal(
		safeErrorMessage(new Error("at render (/workspace/tui.ts:10:2)"), "Request failed."),
		"Request failed.",
	);
});
