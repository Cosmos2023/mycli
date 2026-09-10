import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import {
	initialRuntimeState,
} from "../src/state/runtime-state-model.ts";
import {
	projectRuntimeState,
} from "../src/state/runtime-projection.ts";
import {
	reduceRuntimeEvent,
} from "../src/state/runtime-event-reducer.ts";
import {
	MycliShellRuntime,
} from "../src/application/shell-runtime.ts";
import {
	type MycliShellRuntimeOptions,
	type MycliShellSubmitAttachments,
} from "../src/application/runtime-options.ts";
import type { MycliShellModel, MycliShellProviderRoute, MycliShellState } from "../src/model.ts";
import { HeadlessTerminal } from "./support/headless-terminal.ts";

function initialState(): MycliShellState {
	return { sessionId: "review-a", messages: [{ id: "u1", role: "user", text: "TRUSTED USER MESSAGE" }],
		tools: [], bash: [], footer: { cwd: "/workspace", provider: "test", model: "test", trust: "trusted" } };
}

function setup(t: TestContext, options: Partial<MycliShellRuntimeOptions> = {}, rows = 24, nativeScrollback = true): {
	runtime: MycliShellRuntime; terminal: HeadlessTerminal;
} {
	const terminal = new HeadlessTerminal({ columns: 80, rows, nativeScrollback });
	const runtime = new MycliShellRuntime({ initialState: initialState(), ...options, terminal });
	t.after(async () => { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); });
	runtime.start();
	return { runtime, terminal };
}

async function frame(terminal: HeadlessTerminal): Promise<string> {
	await delay(40);
	await terminal.flush();
	return terminal.visibleLines().join("\n");
}

function pasteImage(terminal: HeadlessTerminal, name: string): void {
	terminal.sendInput(`\x1b[200~/tmp/${name}.png\x1b[201~`);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

for (const nativeScrollback of [false, true]) {
	for (const expanded of [false, true]) {
		test(`Shell controls stay inside the output content (native=${nativeScrollback}, expanded=${expanded})`, async (t) => {
			const output = "first line\n\x1b[H\x1b[2J\x1b]52;c;private-payload\x07\x1b[31mRED\x1b[0m\n10%\r20%";
			let reduced = reduceRuntimeEvent(initialRuntimeState(), "shell.started", {
				shell_id: "shell-a", call_id: "call-a", sequence: 1, command_preview: "test output",
				process_state: "running_foreground", background: false,
			});
			reduced = reduceRuntimeEvent(reduced, "shell.output", {
				shell_id: "shell-a", call_id: "call-a", sequence: 2, process_state: "running_foreground",
				output_delta: output, next_cursor: output.length,
			});
			const shell = projectRuntimeState(reduced).bash[0]!;
			const { terminal } = setup(t, { initialState: { ...initialState(), bash: [{ ...shell, expanded }] } }, 24, nativeScrollback);
			const visible = await frame(terminal);
			assert.match(visible, /TRUSTED USER MESSAGE/u);
			assert.match(visible, /Running test output/u);
			assert.match(visible, /\n +20%/u);
			assert.doesNotMatch(terminal.writes.join(""), /private-payload|10%\r20%/u);
			const lines = terminal.visibleLines();
			const row = lines.findIndex((line) => line.includes("RED"));
			assert.equal(terminal.visibleCell(row, lines[row]!.indexOf("RED"))?.getFgColor(), 1);
		});
	}
}

for (const restore of ["history", "undo"] as const) {
	test(`image ${restore} restores the submitted payload with its placeholder`, async (t) => {
		const submitted: Array<{ text: string; attachments?: MycliShellSubmitAttachments }> = [];
		const { runtime, terminal } = setup(t, { onSubmit: (text, attachments) => { submitted.push({ text, attachments }); } });
		pasteImage(terminal, restore);
		const text = runtime.editor.getText();
		if (restore === "history") {
			terminal.sendInput("\r");
			await delay(0);
			terminal.sendInput("\x1b[A");
		} else {
			terminal.sendInput("\x15");
			assert.equal(runtime.editor.getText(), "");
			terminal.sendInput("\x1f");
		}
		assert.equal(runtime.editor.getText(), text);
		terminal.sendInput("\r");
		await delay(0);
		assert.deepEqual(submitted.at(-1)?.attachments?.localImages, [{ path: `/tmp/${restore}.png`, placeholder: text }]);
	});
}

for (const deleteEarlier of [false, true]) {
	test(`image reinsertion has unique identity and exact deletion (earlier=${deleteEarlier})`, async (t) => {
		let submitted: MycliShellSubmitAttachments | undefined;
		const { runtime, terminal } = setup(t, { onSubmit: (_text, attachments) => { submitted = attachments; } });
		pasteImage(terminal, "first");
		terminal.sendInput(" ");
		pasteImage(terminal, "second");
		terminal.sendInput("\x01");
		terminal.sendInput("\x1b[3~");
		terminal.sendInput("\x1b[3~");
		terminal.sendInput("\x05");
		terminal.sendInput(" ");
		pasteImage(terminal, "third");
		const markers = runtime.editor.getText().match(/\[image #\d+\]/gu)!;
		assert.equal(new Set(markers).size, 2);
		assert.deepEqual(markers, ["[image #1]", "[image #2]"]);
		if (deleteEarlier) {
			terminal.sendInput("\x01");
			terminal.sendInput("\x1b[3~");
		} else {
			terminal.sendInput("\x05");
			terminal.sendInput("\x7f");
		}
		terminal.sendInput("\r");
		await delay(0);
		assert.deepEqual(submitted?.localImages?.map((image) => image.path), [`/tmp/${deleteEarlier ? "third" : "second"}.png`]);
	});
}

test("literal image labels never bind a newly dropped image", async (t) => {
	let submitted: MycliShellSubmitAttachments | undefined;
	const { runtime, terminal } = setup(t, { onSubmit: (_text, attachments) => { submitted = attachments; } });
	runtime.editor.setText("literal [image #1] ");
	pasteImage(terminal, "real");
	terminal.sendInput("\x7f");
	terminal.sendInput("\r");
	await delay(0);
	assert.deepEqual(submitted?.localImages, []);
});

test("equal image labels with different payloads remain separate history entries", async (t) => {
	const submitted: string[][] = [];
	const { terminal } = setup(t, { onSubmit: (_text, attachments) => {
		submitted.push(attachments?.localImages?.map((image) => image.path) ?? []);
	} });
	for (const name of ["first", "second"]) {
		pasteImage(terminal, name);
		terminal.sendInput("\r");
		await delay(0);
	}
	terminal.sendInput("\x1b[A");
	terminal.sendInput("\x1b[A");
	terminal.sendInput("\r");
	await delay(0);
	assert.deepEqual(submitted, [["/tmp/first.png"], ["/tmp/second.png"], ["/tmp/first.png"]]);
});

test("switching sessions does not expose another session's attachment through undo", async (t) => {
	let submitted: MycliShellSubmitAttachments | undefined;
	const { runtime, terminal } = setup(t, { onSubmit: (_text, attachments) => { submitted = attachments; } });
	pasteImage(terminal, "session-a");
	runtime.setState({ ...initialState(), sessionId: "review-b" });
	terminal.sendInput("\x1f");
	assert.equal(runtime.editor.getText(), "");
	runtime.setState(initialState());
	terminal.sendInput("\r");
	await delay(0);
	assert.deepEqual(submitted?.localImages?.map((image) => image.path), ["/tmp/session-a.png"]);
});

test("failed settings persistence only rolls back the selected setting", async (t) => {
	const saving = deferred<never>();
	let started = false;
	const { runtime, terminal } = setup(t, {
		initialState: { ...initialState(), settings: { hideThinking: true, statusbarMode: "full" } },
		onSettingsChange: () => { started = true; return saving.promise; },
	});
	await runtime.showSettingsSelector();
	for (const key of ["Hide thinking", "\r", "\x1b[B", "\r", "\x1b[B", "\r"]) terminal.sendInput(key);
	assert.equal(started, true);
	const latest = { ...runtime.getState(),
		messages: [...runtime.getState().messages, { id: "new-answer", role: "assistant" as const, text: "new answer" }],
		bash: [{ id: "finished-shell", command: "test", status: "success" as const }],
		settings: { ...runtime.getState().settings, statusbarMode: "compact" as const },
		footer: { ...runtime.getState().footer, liveState: "Completed" },
	};
	runtime.setState(latest);
	saving.reject(new Error("Synthetic write failure"));
	await delay(0);
	assert.deepEqual(runtime.getState().messages, latest.messages);
	assert.deepEqual(runtime.getState().bash, latest.bash);
	assert.equal(runtime.getState().footer.liveState, "Completed");
	assert.equal(runtime.getState().settings?.hideThinking, true);
	assert.equal(runtime.getState().settings?.statusbarMode, "compact");
});

test("failed keymap reset preserves updates received during persistence", async (t) => {
	const saving = deferred<never>();
	let started = false;
	const { runtime, terminal } = setup(t, {
		initialState: { ...initialState(), settingsCatalog: { version: 1, categories: [], items: [{
			id: "reset-keymap", category: "appearance", kind: "action", label: "Reset keymap",
			description: "", value: "", source: "default", scope: "default", allowedValues: [],
			locked: false, restartRequired: false, action: "reset_keymap", searchTerms: [],
		}] } },
		onSettingsKeymapReset: () => { started = true; return saving.promise; },
	});
	await runtime.showSettingsSelector();
	terminal.sendInput("\r");
	assert.equal(started, true);
	const messages = [...runtime.getState().messages, { id: "new-answer", role: "assistant" as const, text: "answer" }];
	runtime.setState({ ...runtime.getState(), messages, footer: { ...runtime.getState().footer, liveState: "Completed" } });
	saving.reject(new Error("Synthetic write failure"));
	await delay(0);
	assert.deepEqual(runtime.getState().messages, messages);
	assert.equal(runtime.getState().footer.liveState, "Completed");
});

test("failed settings persistence cannot overwrite a newer value of the same setting", async (t) => {
	const saving = deferred<never>();
	let started = false;
	const { runtime, terminal } = setup(t, {
		initialState: { ...initialState(), settings: { statusbarMode: "full" } },
		onSettingsChange: () => { started = true; return saving.promise; },
	});
	await runtime.showSettingsSelector();
	for (const key of ["Statusbar", "\r", "\x1b[A", "\r", "\x1b[B", "\r"]) terminal.sendInput(key);
	assert.equal(started, true);
	assert.equal(runtime.getState().settings?.statusbarMode, "compact");
	runtime.setState({ ...runtime.getState(), settings: { statusbarMode: "off" } });
	saving.reject(new Error("Synthetic write failure"));
	await delay(0);
	assert.equal(runtime.getState().settings?.statusbarMode, "off");
});

test("cancelled login completion cannot finish a newer attempt in the same selector", async (t) => {
	const first = deferred<void>();
	const second = deferred<void>();
	let attempts = 0;
	const { runtime, terminal } = setup(t, {
		initialState: { ...initialState(), authProviders: [{ id: "test", name: "Test", configured: false }] },
		onApiKeyLogin: () => (++attempts === 1 ? first.promise : second.promise),
		onProviderLoad: async () => [provider()], onModelLoad: async () => models,
	});
	runtime.showLoginFlow("test");
	for (const key of ["first-key", "\r", "\x1b", "\r", "second-key", "\r"]) terminal.sendInput(key);
	assert.equal(attempts, 2);
	first.reject(new Error("Old request failed"));
	await delay(0);
	const output = stripVTControlCharacters(runtime.ui.render(80).join("\n"));
	assert.match(output, /Saving API key/u);
	assert.doesNotMatch(output, /Old request failed/u);
	second.resolve();
	assert.match(await frame(terminal), /Select model/u);
});

for (const fails of [false, true]) {
	test(`dismissed login cannot reclaim input on late ${fails ? "failure" : "success"}`, async (t) => {
		const saving = deferred<void>();
		let saves = 0;
		const { runtime, terminal } = setup(t, {
			initialState: { ...initialState(), authProviders: [{ id: "test", name: "Test", configured: false }] },
			onApiKeyLogin: async () => { saves += 1; await saving.promise; },
			onProviderLoad: async () => [provider()], onModelLoad: async () => models,
		});
		runtime.showLoginFlow("test");
		terminal.sendInput("synthetic-key");
		terminal.sendInput("\r");
		terminal.sendInput("\r");
		assert.equal(saves, 1);
		terminal.sendInput("\x1b");
		terminal.sendInput("\x1b");
		assert.equal(runtime.editorContainer.children[0], runtime.editor);
		terminal.sendInput("my new draft");
		if (fails) saving.reject(new Error("Synthetic write failure"));
		else saving.resolve();
		await frame(terminal);
		assert.equal(runtime.editorContainer.children[0], runtime.editor);
		assert.equal(runtime.editor.getText(), "my new draft");
	});
}

const models: MycliShellModel[] = Array.from({ length: 30 }, (_, index) => ({
	provider: "test", model: `model-${String(index).padStart(2, "0")}`, current: index === 0,
	supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
}));

function provider(index = 0): MycliShellProviderRoute {
	return { id: index === 0 ? "test" : `test-${index}`, name: `Provider ${index}`, protocols: ["responses"],
		activation: "active", configured: true, ready: true, current: index === 0 };
}

for (const nativeScrollback of [false, true]) {
	test(`model and provider menus retain selection across short resizes (native=${nativeScrollback})`, async (t) => {
		let selected: string | undefined;
		const { runtime, terminal } = setup(t, {
			initialState: { ...initialState(), models, currentModel: models[0] },
			onProviderLoad: async () => Array.from({ length: 30 }, (_, index) => provider(index)),
			onModelLoad: async () => models,
			onModelSelect: (model) => { selected = model.model; },
		}, 40, nativeScrollback);
		runtime.showModelSelector();
		await frame(terminal);
		for (const rows of [12, 16, 24, 40, 12]) {
			terminal.resize(80, rows);
			await delay(90);
			const before = await frame(terminal);
			assert.ok(runtime.ui.render(80).length <= rows);
			assert.match(before, /Select model/u);
			for (let index = 0; index < 7; index += 1) terminal.sendInput("\x1b[B");
			const after = await frame(terminal);
			const logicalSelection = stripVTControlCharacters(runtime.ui.render(80).join("\n")).split("\n")
					.find((line) => /^\s*\u203a model-/u.test(line));
			assert.ok(logicalSelection);
			assert.ok(after.includes(logicalSelection.trimEnd()), after);
			assert.match(after, /TRUSTED USER MESSAGE/u);
		}
		terminal.sendInput("\r");
		await delay(0);
		assert.equal(selected, "model-05");
		runtime.showModelSelector();
		await frame(terminal);
		terminal.sendInput("\x1b");
		for (let index = 0; index < 7; index += 1) terminal.sendInput("\x1b[B");
		const providers = await frame(terminal);
		assert.match(providers, /Select provider/u);
		assert.ok(runtime.ui.render(80).length <= terminal.rows);
		const current = stripVTControlCharacters(runtime.ui.render(80).join("\n")).split("\n")
			.find((line) => /^\s*\u203a Provider/u.test(line));
		assert.ok(current && providers.includes(current.trimEnd()));
	});
}
