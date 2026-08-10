import assert from "node:assert/strict";
import test from "node:test";
import { markdownTheme } from "../src/components/markdown-theme.ts";
import { Markdown, type MarkdownTheme } from "../src/tui-core/components/markdown.ts";

function renderFresh(text: string, width: number): string[] {
	return new Markdown(text, 0, 0, markdownTheme()).render(width);
}

function sourceTokens(markdown: Markdown): object[] {
	return (markdown as unknown as { cachedSourceTokens: object[] }).cachedSourceTokens;
}

function renderedTokens(markdown: Markdown): Array<{ lines: string[]; code?: object; paragraph?: object }> {
	return (markdown as unknown as {
		cachedTokens: Array<{ lines: string[]; code?: object; paragraph?: object }>;
	}).cachedTokens;
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

test("streaming plain paragraphs retain their final visual-line layout", () => {
	const before = Array.from({ length: 500 }, (_, index) => `word${index}`).join(" ");
	const after = `${before} with an incrementally wrapped suffix`;
	const markdown = new Markdown(before, 0, 0, markdownTheme());
	markdown.renderTail(52, 12);
	const paragraphEntry = renderedTokens(markdown)[0];
	const paragraphLines = paragraphEntry?.lines;

	markdown.setText(after);
	const incremental = markdown.renderTail(52, 12);
	const fresh = new Markdown(after, 0, 0, markdownTheme()).renderTail(52, 12);

	assert.ok(paragraphEntry?.paragraph);
	assert.equal(renderedTokens(markdown)[0], paragraphEntry);
	assert.equal(renderedTokens(markdown)[0]?.lines, paragraphLines);
	assert.deepEqual(incremental, fresh);
});

test("character-streamed paragraphs fall back across inline markdown transitions", () => {
	const target = [
		"Plain words, punctuation, 中文内容, and a verylongwordthatwrapsacrossrows. ",
		"Visit https://example.com, then use **bold** and `code`.",
	].join("");
	let source = "";
	const markdown = new Markdown(source, 0, 0, markdownTheme());

	for (const character of target) {
		source += character;
		markdown.setText(source);
		for (const width of [18, 41]) {
			const incremental = markdown.renderTail(width, 10);
			const fresh = new Markdown(source, 0, 0, markdownTheme()).renderTail(width, 10);
			assert.deepEqual(incremental, fresh, JSON.stringify({ source, width }));
		}
	}

	assert.equal(renderedTokens(markdown)[0]?.paragraph, undefined);
});

test("append-only markdown lexing retains stable source tokens", () => {
	const stablePrefix = Array.from(
		{ length: 500 },
		(_, index) => `Paragraph ${index} remains stable.`,
	).join("\n\n");
	const before = `${stablePrefix}\n\nTail`;
	const after = `${before} extended with more text`;
	const markdown = new Markdown(before, 0, 0, markdownTheme());
	markdown.renderTail(80, 40);
	const stableToken = sourceTokens(markdown)[0];

	markdown.setText(after);
	const incremental = markdown.renderTail(80, 40);
	const fresh = new Markdown(after, 0, 0, markdownTheme()).renderTail(80, 40);

	assert.equal(sourceTokens(markdown)[0], stableToken);
	assert.deepEqual(incremental, fresh);
});

test("append-only markdown reparses the prior content block across trailing space", () => {
	const before = "Stable paragraph.\n\n- one\n- two\n\n";
	const after = `${before}- nested continuation`;
	const markdown = new Markdown(before, 0, 0, markdownTheme());
	markdown.render(72);

	markdown.setText(after);

	assert.deepEqual(markdown.render(72), renderFresh(after, 72));
});

test("streaming open fences retain lexer prefixes and code layout", () => {
	const before = "# Stable\n\n```ts\nconst values = [1, 2]";
	const after = `${before};\nconst next = values.map((value) => value * 2);`;
	const markdown = new Markdown(before, 0, 0, markdownTheme());
	markdown.renderTail(52, 20);
	const stableHeading = sourceTokens(markdown)[0];
	const codeEntry = renderedTokens(markdown).at(-1);
	const codeLines = codeEntry?.lines;

	markdown.setText(after);
	const incremental = markdown.renderTail(52, 20);
	const fresh = new Markdown(after, 0, 0, markdownTheme()).renderTail(52, 20);

	assert.equal(sourceTokens(markdown)[0], stableHeading);
	assert.equal(renderedTokens(markdown).at(-1), codeEntry);
	assert.equal(renderedTokens(markdown).at(-1)?.lines, codeLines);
	assert.deepEqual(incremental, fresh);
});

test("streaming open fences render only the changed code suffix", () => {
	const baseTheme = markdownTheme();
	let codeLineRenders = 0;
	const countingTheme: MarkdownTheme = {
		...baseTheme,
		codeBlock: (text) => {
			codeLineRenders += 1;
			return baseTheme.codeBlock(text);
		},
	};
	const before = `\`\`\`ts\n${Array.from(
		{ length: 500 },
		(_, index) => `const value${index} = [${index}];`,
	).join("\n")}`;
	const markdown = new Markdown(before, 0, 0, countingTheme);
	markdown.renderTail(72, 20);
	const initialRenders = codeLineRenders;

	markdown.setText(`${before}\nconst finalValue = [500];`);
	markdown.renderTail(72, 20);

	assert.equal(initialRenders, 500);
	assert.equal(codeLineRenders - initialRenders, 2);
});

test("streaming fence closure falls back to full markdown tokenization", () => {
	const before = "# Stable\n\n```ts\nconst values = [1, 2]";
	const after = `${before}\n\`\`\`\n\nDone.`;
	const markdown = new Markdown(before, 0, 0, markdownTheme());
	markdown.render(72);
	const stableHeading = sourceTokens(markdown)[0];

	markdown.setText(after);

	assert.deepEqual(markdown.render(72), renderFresh(after, 72));
	assert.notEqual(sourceTokens(markdown)[0], stableHeading);
});

test("streaming fences distinguish inline markers and preserve fallback variants", () => {
	const cases = [
		{
			before: "```ts\nconst marker = \"```\";",
			after: "```ts\nconst marker = \"```\";\nconst ready = true;",
		},
		{
			before: "~~~js\nconst values = [1]",
			after: "~~~js\nconst values = [1]\nvalues.push(2)",
		},
		{
			before: "  ```ts\n  const value = 1",
			after: "  ```ts\n  const value = 1\n  const next = 2",
		},
		{
			before: "````ts\nconst value = 1",
			after: "````ts\nconst value = 1\n````~\n\nDone.",
		},
	];

	for (const { before, after } of cases) {
		const markdown = new Markdown(before, 0, 0, markdownTheme());
		markdown.render(48);
		markdown.setText(after);

		assert.deepEqual(markdown.render(48), renderFresh(after, 48));
	}
});

test("chunked fenced code streaming stays equal through closure", () => {
	let source = "# Stable\n\n```ts\n";
	const markdown = new Markdown(source, 0, 0, markdownTheme());
	markdown.render(44);
	const chunks = [
		"const values = [1, 2]",
		"\n",
		"\nconst doubled = values.map((value) => value * 2)",
		"\nconst marker = \"```\";",
		"\n",
		"```",
		"\n\nDone with **streaming**.",
	];

	for (const chunk of chunks) {
		source += chunk;
		markdown.setText(source);

		assert.deepEqual(markdown.render(44), renderFresh(source, 44));
		const incrementalTail = markdown.renderTail(44, 8);
		const freshTail = new Markdown(source, 0, 0, markdownTheme()).renderTail(44, 8);
		assert.deepEqual(incrementalTail, freshTail);
	}
});

test("highlighted and previewed code blocks keep the complete render fallback", () => {
	const before = "```ts\nconst one = 1;\nconst two = 2;";
	const after = `${before}\nconst three = 3;`;
	const baseTheme = markdownTheme();
	const highlightedTheme: MarkdownTheme = {
		...baseTheme,
		highlightCode: (code) => code.split("\n").map((line) => baseTheme.codeBlock(line.toUpperCase())),
	};
	const highlighted = new Markdown(before, 0, 0, highlightedTheme);
	highlighted.render(60);
	highlighted.setText(after);
	const highlightedFresh = new Markdown(after, 0, 0, highlightedTheme);
	const highlightedResult = highlighted.render(60);

	assert.equal(renderedTokens(highlighted).at(-1)?.code, undefined);
	assert.deepEqual(highlightedResult, highlightedFresh.render(60));

	const previewed = new Markdown(before, 0, 0, baseTheme, undefined, { codeBlockPreviewLines: 2 });
	previewed.render(60);
	previewed.setText(after);
	const previewedFresh = new Markdown(after, 0, 0, baseTheme, undefined, { codeBlockPreviewLines: 2 });
	const previewedResult = previewed.render(60);

	assert.equal(renderedTokens(previewed).at(-1)?.code, undefined);
	assert.deepEqual(previewedResult, previewedFresh.render(60));
});

test("incremental markdown invalidates references resolved by appended definitions", () => {
	const before = "See [docs][guide].\n\nTail paragraph.";
	const after = `${before}\n\n[guide]: https://example.com`;
	const markdown = new Markdown(before, 0, 0, markdownTheme());
	markdown.render(80);
	const unresolvedToken = sourceTokens(markdown)[0];

	markdown.setText(after);

	assert.deepEqual(markdown.render(80), renderFresh(after, 80));
	assert.notEqual(sourceTokens(markdown)[0], unresolvedToken);
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
