import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { BashExecutionComponent } from "../../../src/components/transcript/bash-execution.ts";
import type { MycliShellBash } from "../../../src/model.ts";
import type { MycliShellShellOutputView } from "../../../src/transcript/shell-output-view.ts";

test("an expanded shell row renders stored output and offers the next page", () => {
	const cell = new BashExecutionComponent(bash(), Date.now, { view: view() });
	const rendered = cell.render(100);
	const text = stripAnsi(rendered.join("\n"));

	assert.match(text, /line two/u);
	assert.doesNotMatch(text, /preview only/u);
	assert.match(text, /90 chars omitted before this output/u);
	assert.match(text, /\+ 120 chars \(click to load more\)/u);

	const loadMoreRow = rendered.findIndex((line) => stripAnsi(line).includes("to load more)"));
	assert.ok(loadMoreRow >= 0, "expected a load-more row");
	assert.equal(cell.isLoadMoreRow(loadMoreRow, 100), true);
	assert.equal(cell.isDetailsToggleRow(loadMoreRow, 100), false);
});

test("a collapsed shell row keeps the transcript preview and offers no page load", () => {
	const cell = new BashExecutionComponent(bash({ expanded: false }), Date.now, { view: view() });
	const text = stripAnsi(cell.render(100).join("\n"));

	assert.match(text, /preview only/u);
	assert.doesNotMatch(text, /to load more\)/u);
});

test("an expanded shell row reports stored-output loading and failure", () => {
	const cell = new BashExecutionComponent(bash(), Date.now, { loading: true });
	assert.match(stripAnsi(cell.render(100).join("\n")), /Loading full output/u);

	cell.setShellOutput({ error: "session does not exist" });
	const text = stripAnsi(cell.render(100).join("\n"));
	assert.match(text, /Unable to load the full output: session does not exist/u);
	// The row falls back to the preview instead of going blank.
	assert.match(text, /preview only/u);
});

test("a fully loaded shell row hides the load-more affordance", () => {
	const cell = new BashExecutionComponent(bash(), Date.now, {
		view: view({ cursor: 5_000, nextAfterSequence: null, omittedBefore: 0 }),
	});
	const text = stripAnsi(cell.render(100).join("\n"));

	assert.match(text, /line two/u);
	assert.doesNotMatch(text, /to load more\)/u);
	assert.doesNotMatch(text, /chars omitted/u);
});

function bash(overrides: Partial<MycliShellBash> = {}): MycliShellBash {
	return {
		id: "shell-1",
		toolName: "Bash",
		command: "npm test",
		status: "success",
		shellId: "shell-1",
		expanded: true,
		outputPreview: "preview only",
		outputChars: 5_000,
		...overrides,
	};
}

function view(overrides: Partial<MycliShellShellOutputView> = {}): MycliShellShellOutputView {
	return {
		text: "line one\nline two\n",
		omittedBefore: 90,
		omittedInside: 0,
		cursor: 4_880,
		outputChars: 5_000,
		loadedChars: 18,
		nextAfterSequence: 4,
		...overrides,
	};
}
