import assert from "node:assert/strict";
import test from "node:test";
import { TranscriptAreaComponent } from "../../../src/components/transcript/transcript-area.ts";
import type { Component } from "../../../src/tui-core/tui.ts";

class LinesComponent implements Component {
	constructor(private readonly lines: string[]) {}

	invalidate(): void {}

	render(): string[] {
		return this.lines;
	}
}

test("transcript area centres the return-to-bottom control over the last transcript row", () => {
	const area = new TranscriptAreaComponent(
		new LinesComponent(["a", "b", "c"]),
		new LinesComponent([]),
		() => 5,
		() => "Back to bottom",
	);

	const lines = area.render(40);

	assert.equal(lines.length, 5);
	assert.equal(lines[2]?.trim(), "Back to bottom");
	assert.equal(area.followControl?.row, 2);
	assert.equal(area.followControl?.startColumn, 13);
	assert.equal(area.followControl?.endColumn, 27);
});

test("transcript area hides the control when the label is unavailable", () => {
	const area = new TranscriptAreaComponent(
		new LinesComponent(["a", "b", "c"]),
		new LinesComponent([]),
		() => 5,
		() => undefined,
	);

	assert.equal(area.render(40)[2], "c");
	assert.equal(area.followControl, undefined);
});
