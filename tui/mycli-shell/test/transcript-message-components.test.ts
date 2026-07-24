import assert from "node:assert/strict";
import test from "node:test";
import {
	renderTranscriptMessageLines,
	transcriptMessageContentWidth,
} from "../src/components/transcript-message-layout.ts";
import { visibleWidth } from "../src/tui-core/utils.ts";

test("transcript message layout applies a role marker and hanging indent", () => {
	const lines = renderTranscriptMessageLines(["alpha", "beta"], 10, "› ");

	assert.equal(lines[0]?.trimEnd(), "› alpha");
	assert.equal(lines[1]?.trimEnd(), "  beta");
	assert.equal(lines.every((line) => visibleWidth(line) === 10), true);
});

test("transcript message layout reserves exactly two terminal cells", () => {
	assert.equal(transcriptMessageContentWidth(80), 78);
	assert.equal(transcriptMessageContentWidth(2), 1);
	assert.equal(transcriptMessageContentWidth(1), 1);
});
