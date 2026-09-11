import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { MycliShellRuntime } from "../../src/application/shell-runtime.ts";
import type { MycliShellCommandSpec, MycliShellSession, MycliShellState } from "../../src/model.ts";
import { HeadlessTerminal } from "../support/headless-terminal.ts";

function idleState(): MycliShellState {
	return { title: "mycli", sessionId: "source", messages: [], tools: [], bash: [], footer: { cwd: "/tmp", liveState: "Idle", trust: "trusted" } };
}

function command(name = "/new"): MycliShellCommandSpec {
	return { id: name, name, description: `Run ${name}`, argumentPolicy: "none", availableDuringTurn: false };
}

test("command palette failures stay recoverable and preserve the composer draft", async () => {
	const terminal = new HeadlessTerminal();
	let attempts = 0;
	const runtime = new MycliShellRuntime({
		initialState: idleState(), terminal, commands: [command()],
		onCommandSubmit: async () => { if (++attempts === 1) throw new Error("Command rejected"); },
	});
	try {
		runtime.start();
		runtime.editor.setText("keep this draft");
		runtime.showCommandPalette();
		terminal.sendInput("\r");
		await setImmediate();
		assert.equal(runtime.isStarted(), true);
		assert.equal(runtime.editor.getText(), "keep this draft");
		assert.match(runtime.getState().messages.at(-1)?.text ?? "", /Command failed.*Command rejected/);
		runtime.showCommandPalette();
		terminal.sendInput("\r");
		await setImmediate();
		assert.equal(attempts, 2);
	} finally { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); }
});

test("an open command palette follows both running-to-idle and idle-to-running changes", async () => {
	for (const initiallyRunning of [false, true]) {
		const terminal = new HeadlessTerminal();
		const submitted: string[] = [];
		const state = idleState();
		const runtime = new MycliShellRuntime({
			initialState: { ...state, footer: { ...state.footer, turnRunning: initiallyRunning } }, terminal,
			commands: [command()], onCommandSubmit: (text) => { submitted.push(text); },
		});
		try {
			runtime.start();
			runtime.showCommandPalette();
			runtime.setState({ ...state, footer: { ...state.footer, turnRunning: !initiallyRunning } });
			const rendered = runtime.ui.render(100).join("\n");
			assert.equal(rendered.includes("unavailable while running"), !initiallyRunning);
			terminal.sendInput("\r");
			await setImmediate();
			assert.deepEqual(submitted, initiallyRunning ? ["/new"] : []);
		} finally { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); }
	}
});

test("command catalog refresh updates an open palette, aliases, and submission routing", async () => {
	const terminal = new HeadlessTerminal();
	const submitted: string[] = [];
	const messages: string[] = [];
	const runtime = new MycliShellRuntime({
		initialState: idleState(), terminal, commands: [command("/old")],
		onCommandSubmit: (text) => { submitted.push(text); }, onSubmit: (text) => { messages.push(text); },
	});
	try {
		runtime.start();
		runtime.showCommandPalette();
		runtime.setCommands([{ ...command("/plugin:test:run"), aliases: ["/plugin-test"] }]);
		const rendered = runtime.ui.render(100).join("\n");
		assert.match(rendered, /\/plugin:test:run/);
		assert.doesNotMatch(rendered, /\/old/);
		terminal.sendInput("\r");
		await setImmediate();
		runtime.editor.onSubmit?.("/plugin-test\targ");
		await setImmediate();
		assert.deepEqual(submitted, ["/plugin:test:run", "/plugin-test\targ"]);
		assert.deepEqual(messages, []);
	} finally { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); }
});

test("session picker refreshes rows and discards results after closing", async () => {
	const terminal = new HeadlessTerminal();
	let pending = Promise.withResolvers<MycliShellSession[]>();
	const runtime = new MycliShellRuntime({ initialState: idleState(), terminal, onSessionLoad: () => pending.promise });
	try {
		runtime.start();
		runtime.editor.setText("draft");
		runtime.showSessionSelector();
		assert.match(runtime.ui.render(100).join("\n"), /Loading sessions/);
		terminal.sendInput("\x1b");
		pending.resolve([{ id: "late", title: "Late session", cwd: "/tmp" }]);
		await setImmediate();
		assert.equal(runtime.editorContainer.children[0], runtime.editor);
		assert.equal(runtime.editor.getText(), "draft");
		pending = Promise.withResolvers<MycliShellSession[]>();
		runtime.showSessionSelector();
		pending.resolve([{ id: "fresh", title: "Fresh session", cwd: "/tmp" }]);
		await setImmediate();
		assert.match(runtime.ui.render(100).join("\n"), /Fresh session/);
	} finally { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); }
});

test("skill resources open the canonical skills command with or without an explicit route", async () => {
	for (const explicit of [false, true]) {
		const terminal = new HeadlessTerminal();
		const submitted: string[] = [];
		const runtime = new MycliShellRuntime({
			initialState: idleState(), terminal,
			onResourceLoad: async () => [{
				id: "skill:review", type: "skill", name: "review", source: "repo", enabled: true,
				status: "enabled", detail: "Review code", ...(explicit ? { command: "/skills" } : {}),
			}],
			onCommandSubmit: (text) => { submitted.push(text); },
		});
		try {
			runtime.start();
			await runtime.handleClientAction("open_resources", "");
			terminal.sendInput("\r");
			await setImmediate();
			assert.deepEqual(submitted, ["/skills"]);
		} finally { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); }
	}
});
