import assert from "node:assert/strict";
import test from "node:test";
import { markdownTheme } from "../src/components/shared/markdown-theme.ts";
import { Markdown } from "../src/tui-core/components/markdown.ts";
import { MAX_MATH_BYTES, maskMath, renderDisplayMath, renderInlineMath } from "../src/tui-core/components/math.ts";

function render(text: string, width = 72): string[] {
	return new Markdown(text, 0, 0, markdownTheme()).render(width).map((line) => line.trimEnd());
}

test("inline math renders a bounded Unicode subset and keeps unsupported source", () => {
	assert.equal(renderInlineMath("E = mc^2"), "E = mc²");
	assert.equal(renderInlineMath("\\alpha_1 + \\beta"), "α₁ + β");
	assert.equal(renderInlineMath("\\mathbb{R}^n"), "ℝⁿ");
	assert.equal(renderInlineMath("\\frac{a}{b}"), "a/b");
	assert.equal(renderInlineMath("\\sqrt{x+1}"), "√(x + 1)");
	assert.equal(renderInlineMath("x^{n+1}"), "x^(n + 1)");
	assert.equal(renderInlineMath("\\sum_{i=1}^{n}"), "∑_(i = 1)ⁿ");
	assert.equal(renderInlineMath("\\sum_{i=1}^{n} i^2"), "∑_(i = 1)ⁿ i²");
	// Anything outside the subset stays available as literal source instead of a wrong render.
	assert.equal(renderInlineMath("\\notacommand{x}"), undefined);
	assert.equal(renderInlineMath(""), undefined);
	assert.equal(renderInlineMath("x".repeat(MAX_MATH_BYTES + 1)), undefined);
});

test("display math lays out fractions, radicals and operator limits on multiple rows", () => {
	assert.deepEqual(renderDisplayMath("\\frac{a}{b}"), ["a", "─", "b"]);
	assert.deepEqual(renderDisplayMath("\\sqrt{x+1}"), ["√(x + 1)"]);
	assert.deepEqual(renderDisplayMath("\\sum_{i=1}^{n} i^2"), ["  n", "  ∑  i²", "i = 1"]);
	// Compact Unicode stays preferred; a script with operators keeps the stacked layout.
	assert.deepEqual(renderDisplayMath("x^2"), ["x²"]);
	assert.deepEqual(renderDisplayMath("x^{n+1}"), [" n + 1", "x"]);
	assert.deepEqual(renderDisplayMath("a = b + c"), ["a = b + c"]);
	assert.equal(renderDisplayMath("\\begin{aligned} a &= b \\end{aligned}"), undefined);
});

test("masking protects TeX escapes and leaves prose and code literal", () => {
	const masked = maskMath("value $\\{a\\}$ and $x \\\\ y$ end");
	assert.equal(masked.replacements.length, 2);
	assert.equal(masked.text.includes("\\{"), false);
	assert.equal(masked.pending, false);
	for (const literal of [
		"cost is $5 and $10 today",
		"shell $HOME and $PATH variables",
		"`$x_1$` stays literal",
		"$USD$ and $123$",
	]) assert.deepEqual(maskMath(literal).replacements, [], literal);
	assert.equal(maskMath("```\necho $HOME\n```").replacements.length, 0);
	assert.equal(maskMath("open $x").pending, true);
});

test("markdown renders inline and display math without rewriting other content", () => {
	assert.deepEqual(render("Energy is $E = mc^2$ exactly."), ["Energy is E = mc² exactly."]);
	assert.deepEqual(render("Use $\\alpha_1$ and $\\mathbb{R}^n$ here."), ["Use α₁ and ℝⁿ here."]);
	assert.deepEqual(render("$$\n\\frac{a}{b}\n$$"), ["a", "─", "b"]);
	assert.deepEqual(render("- item with $a_1$\n- plain"), ["- item with a₁", "- plain"]);
	assert.deepEqual(render("## Heading with $x^2$"), ["Heading with x²"]);
	assert.deepEqual(render("| a | b |\n| --- | --- |\n| $x_1$ | plain |"),
		["┌────┬───────┐", "│ a  │ b     │", "├────┼───────┤", "│ x₁ │ plain │", "└────┴───────┘"]);
	// Prose, code spans and unsupported commands are never rewritten.
	assert.deepEqual(render("Cost is $5 and $10 today."), ["Cost is $5 and $10 today."]);
	assert.deepEqual(render("Code `$x_1$` stays literal."), ["Code $x_1$ stays literal."]);
	assert.deepEqual(render("Unsupported $\\notacommand{x}$ stays literal."),
		["Unsupported $\\notacommand{x}$ stays literal."]);
	assert.deepEqual(render("```sh\necho $HOME\n```"), ["```sh", "  echo $HOME", "```"]);
});

test("streaming math updates match a fresh render", () => {
	const width = 72;
	for (const [before, after] of [
		["Energy $E = mc", "Energy $E = mc^2$ done"],
		["Intro\n\n$$\\frac{a}", "Intro\n\n$$\\frac{a}{b}$$"],
		["Plain text", "Plain text with $\\alpha$ math"],
		["Cost is $5", "Cost is $5 and $10 today"],
	] as const) {
		const markdown = new Markdown(before, 0, 0, markdownTheme());
		markdown.render(width);
		markdown.setText(after);
		assert.deepEqual(markdown.render(width).map((line) => line.trimEnd()), render(after, width), after);
	}
});
