import assert from "node:assert/strict";
import test from "node:test";
import { markdownTheme } from "../src/components/markdown-theme.ts";
import { Markdown, type MarkdownTheme } from "../src/tui-core/components/markdown.ts";

function renderFresh(text: string, width: number): string[] {
	return new Markdown(text, 0, 0, markdownTheme()).render(width);
}

test("incremental markdown rendering matches a fresh render", () => {
	const width = 72;
	const cases = [
		{
			before: "# Heading\n\nStable paragraph.\n\nTail",
			after: "# Heading\n\nStable paragraph.\n\nTail with **bold** text.",
		},
		{
			before: "- one\n- two",
			after: "- one\n- two\n- three with `code`",
		},
		{
			before: "```ts\nconst answer = 42;\n```",
			after: "```ts\nconst answer = 42;\n```\n\nThe result is ready.",
		},
		{
			before: "> quoted line",
			after: "> quoted line\n> continued",
		},
		{
			before: "| Name | Value |\n| --- | --- |\n| one | 1 |",
			after: "| Name | Value |\n| --- | --- |\n| one | 1 |\n| two | 2 |",
		},
	];

	for (const { before, after } of cases) {
		const incremental = new Markdown(before, 0, 0, markdownTheme());
		incremental.render(width);
		incremental.setText(after);

		assert.deepEqual(incremental.render(width), renderFresh(after, width));
	}
});

test("incremental markdown rendering reuses stable token prefixes", () => {
	const baseTheme = markdownTheme();
	let headingRenders = 0;
	const countingTheme: MarkdownTheme = {
		...baseTheme,
		heading: (text) => {
			headingRenders += 1;
			return baseTheme.heading(text);
		},
	};
	const markdown = new Markdown("# Stable heading\n\nTail", 0, 0, countingTheme);
	markdown.render(80);
	const initialHeadingRenders = headingRenders;

	markdown.setText("# Stable heading\n\nTail extended with more text");
	markdown.render(80);

	assert.ok(initialHeadingRenders > 0);
	assert.equal(headingRenders, initialHeadingRenders);
});

test("incremental markdown invalidates references resolved by appended definitions", () => {
	const before = "See [docs][guide].\n\nTail paragraph.";
	const after = `${before}\n\n[guide]: https://example.com`;
	const markdown = new Markdown(before, 0, 0, markdownTheme());
	markdown.render(80);

	markdown.setText(after);

	assert.deepEqual(markdown.render(80), renderFresh(after, 80));
});

test("changing width invalidates incremental markdown token layout", () => {
	const markdown = new Markdown("# Stable heading\n\nA paragraph that wraps at narrow widths.", 0, 0, markdownTheme());
	markdown.render(80);
	markdown.setText("# Stable heading\n\nA paragraph that wraps at narrow widths. More text.");

	assert.deepEqual(markdown.render(32), renderFresh("# Stable heading\n\nA paragraph that wraps at narrow widths. More text.", 32));
});

test("markdown tail rendering matches slicing a full render", () => {
	const markdown = new Markdown(
		"# Heading\n\nParagraph with **bold** text.\n\n```ts\nconst answer = 42;\n```\n\nFinal line.",
		1,
		1,
		markdownTheme(),
	);
	const full = markdown.render(48);

	for (const maxRows of [0, 1, 3, 8, full.length, full.length + 4]) {
		const tail = markdown.renderTail(48, maxRows);
		assert.equal(tail.totalLines, full.length);
		assert.deepEqual(tail.lines, maxRows === 0 ? [] : full.slice(-maxRows));
	}
});
