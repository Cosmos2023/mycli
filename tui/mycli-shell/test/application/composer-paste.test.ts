import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { MycliShellRuntime } from "../../src/application/shell-runtime.ts";
import type { MycliShellRuntimeOptions } from "../../src/application/runtime-options.ts";
import type { MycliShellState } from "../../src/model.ts";
import { HeadlessTerminal } from "../support/headless-terminal.ts";

function state(sessionId = "session-a", running = false): MycliShellState {
	return { sessionId, messages: [], tools: [], bash: [], footer: { cwd: "/repo", model: "test", turnRunning: running, liveState: running ? "Running" : "Idle" } };
}

function runtime(context: TestContext, options: Partial<MycliShellRuntimeOptions> = {}): MycliShellRuntime {
	const terminal = new HeadlessTerminal({ columns: 80, rows: 24 });
	const result = new MycliShellRuntime({ initialState: state(), terminal, ...options });
	context.after(async () => { await result.shutdown(); terminal.dispose(); });
	return result;
}

function paste(target: MycliShellRuntime, text: string): void {
	target.editor.handleInput(`\x1b[200~${text}\x1b[201~`);
}

test("Enter and running-turn follow-up deliver the complete pasted text", async (context) => {
	const submitted: string[] = [];
	const followUps: string[] = [];
	const target = runtime(context, { onSubmit: (text) => { submitted.push(text); }, onFollowUp: (text) => { followUps.push(text); } });
	const first = "用户完整输入\n".repeat(200);
	paste(target, first);
	target.editor.handleInput("\r");
	await setImmediate();
	assert.deepEqual(submitted, [first.trim()]);
	target.setState(state("session-a", true));
	const second = "follow up ".repeat(200);
	paste(target, second);
	target.editor.actionHandlers.get("app.message.followUp")!();
	await setImmediate();
	assert.deepEqual(followUps, [second.trim()]);
});

test("session switching preserves separate collapsed drafts and their raw content", (context) => {
	const target = runtime(context);
	const first = "A".repeat(2000);
	const second = "B".repeat(2000);
	paste(target, first);
	const display = target.editor.getText();
	target.setState(state("session-b"));
	assert.equal(target.editor.getText(), "");
	paste(target, second);
	target.setState(state("session-a"));
	assert.equal(target.editor.getText(), display);
	assert.equal(target.editor.getExpandedText(), first);
	target.setState(state("session-b"));
	assert.equal(target.editor.getExpandedText(), second);
});

test("dequeue merges the current paste as full text", async (context) => {
	const target = runtime(context, { onDequeueQueuedInput: () => ({ text: "queued" }) });
	const content = "content ".repeat(200);
	paste(target, content);
	target.editor.actionHandlers.get("app.message.dequeue")!();
	await setImmediate();
	assert.equal(target.editor.getExpandedText(), `queued\n\n${content.trim()}`);
});

test("dequeue keeps literal markers inside pasted content literal", async (context) => {
	const target = runtime(context, { onDequeueQueuedInput: () => ({ text: "queued" }) });
	const first = "first ".repeat(200);
	paste(target, first);
	const second = `literal ${target.editor.getText()} $& ` + "second ".repeat(200);
	paste(target, second);
	target.editor.actionHandlers.get("app.message.dequeue")!();
	await setImmediate();
	assert.equal(target.editor.getExpandedText(), `queued\n\n${first}${second.trim()}`);
});

test("rejected submission restores the folded draft to its original session", async (context) => {
	const gate = Promise.withResolvers<void>();
	const target = runtime(context, { onSubmit: () => gate.promise });
	const content = "session A ".repeat(200);
	paste(target, content);
	const display = target.editor.getText();
	target.editor.handleInput("\r");
	target.setState(state("session-b"));
	target.editor.setText("session B draft");
	gate.reject(new Error("submission rejected"));
	await setImmediate();
	assert.equal(target.editor.getText(), "session B draft");
	target.setState(state());
	assert.equal(target.editor.getText(), display);
	assert.equal(target.editor.getExpandedText(), content);
});

test("rejected submission preserves text typed while the request was pending", async (context) => {
	const gate = Promise.withResolvers<void>();
	const target = runtime(context, { onSubmit: () => gate.promise });
	const first = "first ".repeat(200);
	paste(target, first);
	target.editor.handleInput("\r");
	const next = "new draft ".repeat(200);
	paste(target, next);
	gate.reject(new Error("submission rejected"));
	await setImmediate();
	assert.equal(target.editor.getExpandedText(), `${first.trim()}\n\n${next.trim()}`);
});

test("a locally blocked submission keeps its complete folded input", async (context) => {
	const submitted: string[] = [];
	const target = runtime(context, { initialState: state("session-a", true), onSubmit: (text) => { submitted.push(text); } });
	const content = "/plan " + "task ".repeat(300);
	paste(target, content);
	const display = target.editor.getText();
	target.editor.handleInput("\r");
	await setImmediate();
	assert.deepEqual(submitted, []);
	assert.equal(target.editor.getText(), display);
	assert.equal(target.editor.getExpandedText(), content);
});

test("reopening the same session in a new runtime starts with an empty composer", async (context) => {
	const target = runtime(context);
	paste(target, "unsent text ".repeat(200));
	const session = target.getState();
	await target.shutdown();
	const reopened = runtime(context, { initialState: session });
	assert.equal(reopened.editor.getText(), "");
	assert.equal(reopened.editor.getExpandedText(), "");
});

test("accepted submission preserves text typed while the request was pending", async (context) => {
	const gate = Promise.withResolvers<void>();
	const target = runtime(context, { onSubmit: () => gate.promise });
	try {
		paste(target, "submitted text ".repeat(200));
		target.editor.handleInput("\r");
		const next = "next draft ".repeat(200);
		paste(target, next);
		gate.resolve();
		await setImmediate();
		assert.equal(target.editor.getExpandedText(), next);
	} finally { gate.resolve(); }
});
