import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { CURSOR_MARKER, TUI, type Component } from "../src/tui-core/tui.ts";
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

class MutableCursorLine implements Component {
	constructor(
		private cursorCol: number,
		private text = "cursor",
		private cursorVisible = true,
	) {}

	setCursorCol(cursorCol: number): void {
		this.cursorCol = cursorCol;
	}

	setFrame(text: string, cursorVisible: boolean): void {
		this.text = text;
		this.cursorVisible = cursorVisible;
	}

	render(): string[] {
		if (!this.cursorVisible) return [this.text];
		return [
			`${this.text.slice(0, this.cursorCol)}${CURSOR_MARKER}${this.text.slice(this.cursorCol)}`,
		];
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

test("unchanged frames emit no terminal writes", async (t) => {
	const terminal = new HeadlessTerminal({ columns: 40, rows: 6 });
	const ui = new TUI(terminal);
	t.after(async () => {
		ui.stop();
		await terminal.flush();
		terminal.dispose();
	});
	ui.addChild(new MutableLines(["stable frame"]));
	ui.start();
	await renderFrame(ui, terminal);
	terminal.writes.length = 0;

	await renderFrame(ui, terminal);

	assert.equal(terminal.writes.length, 0);
});

test("unchanged native scrollback frames emit no terminal writes", async (t) => {
	const terminal = new HeadlessTerminal({
		columns: 40,
		rows: 6,
		nativeScrollback: true,
	});
	const ui = new TUI(terminal);
	t.after(async () => {
		ui.stop();
		await terminal.flush();
		terminal.dispose();
	});
	ui.addChild(new MutableLines(["stable native frame"]));
	ui.insertHistoryBeforeNextFrame(["committed history"]);
	ui.start();
	await renderFrame(ui, terminal);
	terminal.writes.length = 0;

	await renderFrame(ui, terminal);

	assert.equal(terminal.writes.length, 0);
});

test("hardware cursor movement still renders when frame cells are unchanged", async (t) => {
	const terminal = new HeadlessTerminal({ columns: 40, rows: 6 });
	const component = new MutableCursorLine(1);
	const ui = new TUI(terminal, true);
	t.after(async () => {
		ui.stop();
		await terminal.flush();
		terminal.dispose();
	});
	ui.addChild(component);
	ui.start();
	await renderFrame(ui, terminal);
	terminal.writes.length = 0;

	component.setCursorCol(4);
	await renderFrame(ui, terminal);

	assert.equal(terminal.writes.length, 1);
	assert.match(terminal.writes[0]!, /\x1b\[5G\x1b\[\?25h/u);
	assert.equal(terminal.visibleLines()[0], "cursor");
});

test("cursor position is reacquired after a marker-free content frame", async (t) => {
	const terminal = new HeadlessTerminal({ columns: 40, rows: 6 });
	const component = new MutableCursorLine(4);
	const ui = new TUI(terminal, false);
	t.after(async () => {
		ui.stop();
		await terminal.flush();
		terminal.dispose();
	});
	ui.addChild(component);
	ui.start();
	await renderFrame(ui, terminal);

	component.setFrame("changed", false);
	await renderFrame(ui, terminal);
	terminal.writes.length = 0;

	component.setFrame("changed", true);
	await renderFrame(ui, terminal);

	assert.equal(terminal.writes.length, 1);
	assert.match(terminal.writes[0]!, /\x1b\[5G\x1b\[\?25l/u);
	assert.equal(terminal.visibleLines()[0], "changed");
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

test("streaming repaint does not resend a stable line prefix", async (t) => {
	const terminal = new HeadlessTerminal({ columns: 80, rows: 6 });
	const prefix = "stable transcript prefix: ";
	const component = new MutableLines([`${prefix}working`]);
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

	component.setLines([`${prefix}working.`]);
	await renderFrame(ui, terminal);

	assert.equal(terminal.writes.length, 1);
	assert.doesNotMatch(terminal.writes[0]!, new RegExp(prefix, "u"));
	assert.equal(terminal.visibleLines()[0], `${prefix}working.`);
});

test("spinner repaint does not resend a stable line suffix", async (t) => {
	const terminal = new HeadlessTerminal({ columns: 80, rows: 6 });
	const suffix = " Working (24s · esc to interrupt)";
	const component = new MutableLines([`◒${suffix}`]);
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

	component.setLines([`◐${suffix}`]);
	await renderFrame(ui, terminal);

	assert.equal(terminal.writes.length, 1);
	assert.doesNotMatch(terminal.writes[0]!, /Working/u);
	assert.equal(terminal.visibleLines()[0], `◐${suffix}`);
});

test("native scrollback frame uses cell patches for streaming updates", async (t) => {
	const terminal = new HeadlessTerminal({
		columns: 80,
		rows: 4,
		nativeScrollback: true,
	});
	const prefix = "stable native prefix: ";
	const component = new MutableLines([`${prefix}working`]);
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
	terminal.writes.length = 0;

	component.setLines([`${prefix}working.`]);
	await renderFrame(ui, terminal);

	assert.equal(terminal.writes.length, 1);
	assert.doesNotMatch(terminal.writes[0]!, new RegExp(prefix, "u"));
	assert.equal(terminal.visibleLines()[0], `${prefix}working.`);
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
