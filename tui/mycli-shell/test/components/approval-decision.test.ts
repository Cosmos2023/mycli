import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalDecisionComponent } from "../../src/components/transcript/approval-decision.ts";
import { uiGlyphs } from "../../src/theme/terminal-style.ts";

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, "");
}

function render(text: string, rejected: boolean): string[] {
	return new ApprovalDecisionComponent(text, rejected).render(80).map(stripAnsi);
}

test("approval decisions open with a blank line so the transcript gap is even", () => {
	const lines = render("You approved mycli to run npm run build this time", false);

	assert.equal(lines[0], "");
	assert.equal(lines[1]?.trimEnd(),
		`${uiGlyphs().success} You approved mycli to run npm run build this time`);
});

test("rejected decisions keep the same gap with a warning glyph", () => {
	const lines = render("You did not approve mycli to run rm -rf build", true);

	assert.equal(lines[0], "");
	assert.equal(lines[1]?.trimEnd(),
		`${uiGlyphs().warning} You did not approve mycli to run rm -rf build`);
});
