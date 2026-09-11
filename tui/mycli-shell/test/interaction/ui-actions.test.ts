import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import {
	createMycliUiActionDispatcher,
	isMycliUiQueuedInput,
	MycliShellRuntime,
	type MycliShellState,
	type MycliUiAction,
} from "../../src/index.ts";
import { HeadlessTerminal } from "../support/headless-terminal.ts";

function idleState(): MycliShellState {
	return {
		title: "mycli",
		messages: [],
		tools: [],
		bash: [],
		footer: {
			cwd: "~/Desktop/mycli",
			liveState: "Idle",
		},
	};
}

test("queued UI input validation rejects malformed attachment payloads", () => {
	assert.equal(isMycliUiQueuedInput(null), true);
	assert.equal(isMycliUiQueuedInput("plain queued input"), true);
	assert.equal(isMycliUiQueuedInput({
		text: "queued image",
		localImages: [{ path: "/tmp/image.png", placeholder: "[image #1]" }],
	}), true);
	assert.equal(isMycliUiQueuedInput({ text: "bad", localImages: "not-an-array" }), false);
	assert.equal(isMycliUiQueuedInput({
		text: "bad",
		localImages: [{ path: "/tmp/image.png" }],
	}), false);
});

test("full TUI routes composer lifecycle through the shared UI action dispatcher", async () => {
	const actions: MycliUiAction[] = [];
	const terminal = new HeadlessTerminal({ columns: 100, rows: 40 });
	const runtime = new MycliShellRuntime({
		initialState: idleState(),
		terminal,
		commandNames: ["/help"],
		actions: createMycliUiActionDispatcher((action) => {
			actions.push(action);
			if (action.type === "dequeue_queued_input") {
				return { text: "restored queued input" };
			}
			return undefined;
		}),
	});

	runtime.start();
	await runtime.editor.onSubmit?.("hello");
	await runtime.editor.onSubmit?.("/help");
	runtime.setState({
		...idleState(),
		footer: { ...idleState().footer, liveState: "Running", turnRunning: true },
	});
	runtime.editor.setText("follow this up");
	runtime.editor.actionHandlers.get("app.message.followUp")?.();
	await setTimeout(10);
	runtime.editor.actionHandlers.get("app.message.dequeue")?.();
	await setTimeout(10);
	assert.equal(runtime.editor.getText(), "restored queued input");
	runtime.editor.setText("");
	runtime.editor.actionHandlers.get("app.interrupt")?.();
	await setTimeout(10);

	assert.deepEqual(actions.slice(0, 5), [
		{ type: "submit", text: "hello", localImages: [] },
		{ type: "command", command: "/help" },
		{ type: "follow_up", text: "follow this up", localImages: [] },
		{ type: "dequeue_queued_input" },
		{ type: "interrupt", rollbackUserInput: true },
	]);

	await runtime.shutdown();
	assert.deepEqual(actions.at(-1), { type: "exit", reason: "normal" });
	terminal.dispose();
});

test("full TUI preserves interactive ownership in shared UI actions", async () => {
	const actions: MycliUiAction[] = [];
	const terminal = new HeadlessTerminal({ columns: 100, rows: 40 });
	const approval = {
		decisionId: "decision-1",
		sessionId: "child-session",
		generation: 4,
		preview: "Run tests",
		options: [
			{ choice: "approve_once", label: "Approve once" },
			{ choice: "reject", label: "Reject" },
		],
	};
	const runtime = new MycliShellRuntime({
		initialState: {
			...idleState(),
			pendingApproval: approval,
			footer: { ...idleState().footer, liveState: "Waiting approval", turnRunning: true },
		},
		terminal,
		actions: createMycliUiActionDispatcher((action) => {
			actions.push(action);
		}),
	});

	runtime.start();
	terminal.sendInput("1");
	await setTimeout(10);
	assert.deepEqual(actions, [
		{ type: "approval.respond", approval, choice: "approve_once" },
	]);

	const clarification = {
		requestId: "question-1",
		turnId: "child-turn",
		sessionId: "child-session",
		generation: 4,
		childSessionId: "child-session",
		agentPath: "/root/reviewer",
		workerName: "reviewer",
		question: "Which implementation?",
		options: [{ label: "Runtime" }, { label: "TUI" }],
		multiSelect: false,
	};
	runtime.setState({
		...idleState(),
		pendingClarification: clarification,
		footer: { ...idleState().footer, liveState: "Waiting clarification", turnRunning: true },
	});
	terminal.sendInput("1");
	await setTimeout(10);

	assert.deepEqual(actions.at(-1), {
		type: "clarification.respond",
		clarification,
		response: "Runtime",
	});

	runtime.ui.stop();
	terminal.dispose();
});
