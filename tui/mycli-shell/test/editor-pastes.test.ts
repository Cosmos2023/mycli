import assert from "node:assert/strict";
import test from "node:test";
import { Editor } from "../src/tui-core/components/editor.ts";
import { TUI } from "../src/tui-core/tui.ts";
import { getEditorTheme } from "../src/theme/theme.ts";
import { visibleWidth } from "../src/tui-core/utils.ts";
import { HeadlessTerminal } from "./support/headless-terminal.ts";

function editor(): Editor {
	return new Editor(new TUI(new HeadlessTerminal({ columns: 80, rows: 24 })), getEditorTheme());
}

function paste(target: Editor, text: string): void {
	target.handleInput(`\x1b[200~${text}\x1b[201~`);
}

test("ordinary input stays inline and long Unicode pastes expand fully on submit", () => {
	const target = editor();
	paste(target, "普通文字");
	assert.equal(target.getText(), "普通文字");
	target.setText("");
	paste(target, "😀".repeat(1000));
	assert.equal(target.getText(), "😀".repeat(1000));
	target.setText("");
	const content = "😀".repeat(1001);
	paste(target, content);
	assert.match(target.getText(), /^\[paste #\d+ 1001 chars\]$/u);
	for (const width of [8, 24, 80]) assert.ok(target.render(width).every((line) => visibleWidth(line) <= width));
	let submitted = "";
	target.onSubmit = (text) => { submitted = text; };
	target.handleInput("\r");
	assert.equal(submitted, content);
	assert.equal(target.getText(), "");
});

test("multiple pastes and surrounding text survive a draft round trip", () => {
	const target = editor();
	target.setText("before ");
	const first = "first\n".repeat(12);
	const second = "第二段".repeat(500);
	paste(target, first);
	target.insertTextAtCursor(" between ");
	paste(target, second);
	target.insertTextAtCursor(" after");
	const snapshot = target.getDraft();
	const restored = editor();
	restored.restoreDraft(snapshot);
	assert.equal(restored.getText(), target.getText());
	assert.deepEqual(restored.getCursor(), target.getCursor());
	assert.equal(restored.getExpandedText(), `before ${first} between ${second} after`);
});

test("expansion leaves marker-looking text inside pasted content literal", () => {
	const target = editor();
	target.restoreDraft({
		text: "[paste #1 1234 chars] / [paste #2 1234 chars]",
		pastes: [[1, "literal [paste #2 1234 chars] $&"], [2, "second"]],
		cursor: { line: 0, col: 0 },
	});
	assert.equal(target.getExpandedText(), "literal [paste #2 1234 chars] $& / second");
});

test("a new paste never binds an existing literal marker and remains atomic for undo", () => {
	const target = editor();
	target.setText("literal [paste #1 1234 chars] ");
	const content = "long text ".repeat(150);
	paste(target, content);
	assert.match(target.getText(), /\[paste #2 /u);
	assert.equal(target.getExpandedText(), `literal [paste #1 1234 chars] ${content}`);
	target.handleInput("\x7f");
	assert.equal(target.getDraft().pastes.length, 0);
	target.handleInput("\x1f");
	assert.equal(target.getExpandedText(), `literal [paste #1 1234 chars] ${content}`);
});

test("restoring another session replaces paste ownership and allocates fresh IDs", () => {
	const target = editor();
	paste(target, "A".repeat(1001));
	const first = target.getDraft();
	target.restoreDraft({ text: "", pastes: [], cursor: { line: 0, col: 0 } });
	paste(target, "B".repeat(1001));
	const second = target.getDraft();
	target.restoreDraft(first);
	paste(target, "C".repeat(1001));
	assert.equal(target.getExpandedText(), "A".repeat(1001) + "C".repeat(1001));
	target.restoreDraft(second);
	assert.equal(target.getExpandedText(), "B".repeat(1001));
});

test("full-text replacement and history cannot expand stale paste bindings", () => {
	const target = editor();
	const content = "source ".repeat(200);
	paste(target, content);
	const marker = target.getText();
	target.setText(`literal ${marker}`);
	assert.equal(target.getExpandedText(), `literal ${marker}`);
	target.handleInput("\x1f");
	assert.equal(target.getExpandedText(), content);
	target.handleInput("\x7f");
	assert.equal(target.getText(), "");
	target.addToHistory(`history ${marker}`);
	target.handleInput("\x1b[A");
	assert.equal(target.getExpandedText(), `history ${marker}`);
});
