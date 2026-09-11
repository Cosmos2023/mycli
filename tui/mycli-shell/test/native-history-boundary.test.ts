import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { MycliShellMessage, MycliShellState } from "../src/model.ts";
import {
	MycliShellRuntime,
} from "../src/application/shell-runtime.ts";
import { HeadlessTerminal } from "./support/headless-terminal.ts";

function historyState(messageCount: number = 40): MycliShellState {
	const messages: MycliShellMessage[] = Array.from({ length: messageCount }, (_, index) => ({
		id: `history-${index}`,
		role: index % 2 === 0 ? "user" : "assistant",
		text: `HISTORY-${String(index).padStart(3, "0")}`,
	}));
	return {
		messages,
		tools: [],
		bash: [],
		transcript: messages.map((message) => ({ id: message.id, kind: "message", message })),
		footer: { cwd: "/workspace", liveState: "Running", liveStateKind: "running", turnRunning: true },
	};
}

function withApproval(state: MycliShellState, decisionId: string): MycliShellState {
	return {
		...state,
		pendingApproval: {
			decisionId,
			toolName: "Shell",
			preview: "echo history-boundary-test",
			reason: "Approval needed for the requested command",
			options: [
				{ choice: "approve_once", label: "Approve once" },
				{ choice: "reject", label: "Reject" },
			],
		},
		footer: { ...state.footer, liveState: "Waiting approval", liveStateKind: "approval" },
	};
}

async function settle(terminal: HeadlessTerminal): Promise<void> {
	await delay(35);
	await terminal.flush();
}

function markers(lines: readonly string[]): string[] {
	return lines.flatMap((line) => line.match(/HISTORY-\d{3}/gu) ?? []);
}

function assertHistory(terminal: HeadlessTerminal, state: MycliShellState): void {
	assert.deepEqual(markers(terminal.bufferLines()), state.messages.map((message) => message.text));
}

for (const size of [{ columns: 80, rows: 24 }, { columns: 120, rows: 30 }, { columns: 100, rows: 40 }]) {
	test(`native history remains ordered and unique after approvals at ${size.columns}x${size.rows}`, async (t) => {
		const terminal = new HeadlessTerminal({ ...size, nativeScrollback: true, scrollback: 2_000 });
		const state = historyState();
		const runtime = new MycliShellRuntime({
			initialState: state,
			terminal,
			onApprovalRespond: (): void => runtime.setState(state),
		});
		t.after(async () => {
			await runtime.shutdown();
			await terminal.flush();
			terminal.dispose();
		});
		runtime.start();
		await settle(terminal);
		assertHistory(terminal, state);
		terminal.writes.length = 0;

		for (let cycle = 0; cycle < 3; cycle += 1) {
			runtime.setState(withApproval(state, `approval-${cycle}`));
			await settle(terminal);
			terminal.sendInput("1");
			await settle(terminal);
			terminal.scrollLines(-12);
			const visible = markers(terminal.visibleLines());
			assert.equal(new Set(visible).size, visible.length);
			assertHistory(terminal, state);
			terminal.scrollLines(2_000);
		}
		assert.equal(runtime.getState().transcript, state.transcript);
		assert.doesNotMatch(terminal.writes.join(""), /\x1b\[[23]J/u);
	});
}

test("native history survives multiline follow-up submission during streaming", async (t) => {
	const terminal = new HeadlessTerminal({ nativeScrollback: true, scrollback: 2_000 });
	let state = historyState();
	const initial = state;
	const followUps: string[] = [];
	const runtime = new MycliShellRuntime({
		initialState: state,
		terminal,
		onFollowUp: (text) => { followUps.push(text); },
	});
	t.after(async () => {
		await runtime.shutdown();
		await terminal.flush();
		terminal.dispose();
	});
	runtime.start();
	await settle(terminal);
	terminal.writes.length = 0;

	const draft = Array.from({ length: 8 }, (_, index) => `draft line ${index}`).join("\n");
	terminal.sendInput(`\x1b[200~${draft}\x1b[201~`);
	await settle(terminal);
	const assistant: MycliShellMessage = { id: "live-answer", role: "assistant", text: "Streaming answer" };
	state = {
		...state,
		messages: [...state.messages, assistant],
		transcript: [...state.transcript!, { id: assistant.id, kind: "message", message: assistant }],
	};
	runtime.setState(state, { transcriptUpdate: "tail", eventType: "message.delta" });
	await settle(terminal);
	terminal.sendInput("\t");
	await settle(terminal);
	terminal.scrollLines(-12);
	assertHistory(terminal, initial);
	assert.deepEqual(followUps, [draft]);
	assert.equal(runtime.editor.getText(), "");
	assert.doesNotMatch(terminal.writes.join(""), /\x1b\[[23]J/u);
});

test("native history handles blocked coalesced approval and composer changes", async (t) => {
	const terminal = new HeadlessTerminal({ nativeScrollback: true, scrollback: 2_000 });
	const state = historyState();
	const runtime = new MycliShellRuntime({ initialState: state, terminal });
	t.after(async () => {
		await runtime.shutdown();
		await terminal.flush();
		terminal.dispose();
	});
	runtime.start();
	await settle(terminal);
	terminal.writes.length = 0;
	terminal.setOutputBackpressured(true);
	for (let cycle = 0; cycle < 3; cycle += 1) {
		runtime.setState(withApproval(state, `blocked-${cycle}`));
		runtime.setState(state);
		runtime.editor.setText("draft\n".repeat(6));
		runtime.setState(state);
		runtime.editor.setText("");
		runtime.setState(state);
	}
	await delay(35);
	assert.equal(terminal.writes.length, 0);
	terminal.setOutputBackpressured(false);
	await settle(terminal);
	assertHistory(terminal, state);
	assert.doesNotMatch(terminal.writes.join(""), /\x1b\[[23]J/u);
});

for (const transcriptReplayMaxRows of [0, 40]) {
	test(`native history preserves growing transcripts across layout changes with replay cap ${transcriptReplayMaxRows}`, async (t) => {
		const terminal = new HeadlessTerminal({ nativeScrollback: true, scrollback: 2_000 });
		let state = historyState(10);
		const runtime = new MycliShellRuntime({ initialState: state, terminal, transcriptReplayMaxRows });
		t.after(async () => {
			await runtime.shutdown();
			await terminal.flush();
			terminal.dispose();
		});
		runtime.start();
		await settle(terminal);
		terminal.writes.length = 0;
		for (let index = 10; index < 26; index += 1) {
			const message: MycliShellMessage = {
				id: `history-${index}`,
				role: index % 2 === 0 ? "user" : "assistant",
				text: `HISTORY-${String(index).padStart(3, "0")}`,
			};
			state = {
				...state,
				messages: [...state.messages, message],
				transcript: [...state.transcript!, { id: message.id, kind: "message", message }],
			};
			runtime.setState(state, { transcriptUpdate: "tail" });
			await settle(terminal);
			if (index % 4 === 0) {
				runtime.editor.setText("draft\n".repeat(6));
				runtime.setState(state);
				await settle(terminal);
				runtime.editor.setText("");
				runtime.setState(state);
				await settle(terminal);
			}
			assertHistory(terminal, state);
		}
		assert.doesNotMatch(terminal.writes.join(""), /\x1b\[[23]J/u);
		terminal.resize(100, 30);
		await delay(120);
		await terminal.flush();
		const expected = transcriptReplayMaxRows === 0
			? state.messages.map((message) => message.text)
			: state.messages.map((message) => message.text).slice(-markers(terminal.bufferLines()).length);
		assert.deepEqual(markers(terminal.bufferLines()), expected);
		assert.equal(new Set(expected).size, expected.length);
		assert.ok(expected.length > 0);
	});
}
