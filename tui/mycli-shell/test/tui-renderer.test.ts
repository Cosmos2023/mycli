import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { TUI, type Component } from "../src/tui-core/tui.ts";
import { HeadlessTerminal } from "./support/headless-terminal.ts";

class MutableLines implements Component {
	constructor(private lines: string[]) {}

	setLines(lines: string[]): void {
		this.lines = lines;
	}

	render(): string[] {
		return [...this.lines];
	}

	invalidate(): void {}
}

async function renderFrame(ui: TUI, terminal: HeadlessTerminal): Promise<void> {
	ui.requestRender();
	await delay(25);
	await terminal.flush();
}

test("renderer removes the stale tail when a line becomes shorter", async (t) => {
	const terminal = new HeadlessTerminal({ columns: 40, rows: 6 });
	const component = new MutableLines(["response is still streaming"]);
	const ui = new TUI(terminal);
	t.after(async () => {
		ui.stop();
		await terminal.flush();
		terminal.dispose();
	});
	ui.addChild(component);
	ui.start();
	await renderFrame(ui, terminal);

	component.setLines(["done"]);
	await renderFrame(ui, terminal);

	assert.equal(terminal.visibleLines()[0], "done");
});

test("renderer clears rows removed from a shrinking frame", async (t) => {
	const terminal = new HeadlessTerminal({ columns: 40, rows: 6 });
	const component = new MutableLines(["one", "two", "three", "four"]);
	const ui = new TUI(terminal);
	t.after(async () => {
		ui.stop();
		await terminal.flush();
		terminal.dispose();
	});
	ui.addChild(component);
	ui.start();
	await renderFrame(ui, terminal);

	component.setLines(["one", "two"]);
	await renderFrame(ui, terminal);

	assert.deepEqual(terminal.visibleLines().slice(0, 4), ["one", "two", "", ""]);
});

test("native scrollback contains committed history but never mutable frame rows", async (t) => {
	const terminal = new HeadlessTerminal({
		columns: 40,
		rows: 4,
		scrollback: 100,
		nativeScrollback: true,
	});
	const component = new MutableLines(["mutable 1", "mutable 2", "mutable 3", "mutable 4"]);
	const ui = new TUI(terminal);
	t.after(async () => {
		ui.stop();
		await terminal.flush();
		terminal.dispose();
	});
	ui.addChild(component);
	ui.insertHistoryBeforeNextFrame(["committed history"]);
	ui.start();
	await renderFrame(ui, terminal);

	component.setLines(["mutable 2", "mutable 3", "mutable 4", "mutable 5"]);
	await renderFrame(ui, terminal);

	assert.ok(terminal.historyLines().includes("committed history"));
	assert.equal(terminal.historyLines().filter((line) => line.includes("mutable")).length, 0);
	assert.deepEqual(terminal.visibleLines(), ["mutable 2", "mutable 3", "mutable 4", "mutable 5"]);
});

test("coalesced streaming updates leave only the newest frame visible", async (t) => {
	const terminal = new HeadlessTerminal({ columns: 40, rows: 6 });
	const component = new MutableLines(["token"]);
	const ui = new TUI(terminal);
	t.after(async () => {
		ui.stop();
		await terminal.flush();
		terminal.dispose();
	});
	ui.addChild(component);
	ui.start();
	await renderFrame(ui, terminal);

	for (const text of ["token one", "token one two", "final answer"]) {
		component.setLines([text]);
		ui.requestRender();
	}
	await delay(25);
	await terminal.flush();

	assert.equal(terminal.visibleLines()[0], "final answer");
});

test("a frame update is emitted as one synchronized terminal write", async (t) => {
	const terminal = new HeadlessTerminal({ columns: 40, rows: 6 });
	const component = new MutableLines(["before"]);
	const ui = new TUI(terminal);
	t.after(async () => {
		ui.stop();
		await terminal.flush();
		terminal.dispose();
	});
	ui.addChild(component);
	ui.start();
	await renderFrame(ui, terminal);
	terminal.writes.length = 0;

	component.setLines(["after"]);
	await renderFrame(ui, terminal);

	assert.equal(terminal.writes.length, 1);
	assert.match(terminal.writes[0]!, /^\x1b\[\?2026h/);
	assert.match(terminal.writes[0]!, /\x1b\[\?25l\x1b\[\?2026l$/);
});

test("renderer coalesces updates while terminal output is backpressured", async (t) => {
	const terminal = new HeadlessTerminal({ columns: 40, rows: 6 });
	const component = new MutableLines(["before"]);
	const ui = new TUI(terminal);
	t.after(async () => {
		ui.stop();
		await terminal.flush();
		terminal.dispose();
	});
	ui.addChild(component);
	ui.start();
	await renderFrame(ui, terminal);
	terminal.writes.length = 0;
	terminal.setOutputBackpressured(true);

	for (const text of ["queued one", "queued two", "latest state"]) {
		component.setLines([text]);
		ui.requestRender();
	}
	await delay(25);
	assert.equal(terminal.writes.length, 0);

	terminal.setOutputBackpressured(false);
	await delay(25);
	await terminal.flush();
	assert.equal(terminal.writes.length, 1);
	assert.equal(terminal.visibleLines()[0], "latest state");
});

test("shortening CJK and emoji content leaves no orphaned wide cells", async (t) => {
	const terminal = new HeadlessTerminal({ columns: 40, rows: 6 });
	const component = new MutableLines(["处理中：北京 🚄 上海"]);
	const ui = new TUI(terminal);
	t.after(async () => {
		ui.stop();
		await terminal.flush();
		terminal.dispose();
	});
	ui.addChild(component);
	ui.start();
	await renderFrame(ui, terminal);

	component.setLines(["完成 ✅"]);
	await renderFrame(ui, terminal);

	assert.equal(terminal.visibleLines()[0], "完成 ✅");
});
