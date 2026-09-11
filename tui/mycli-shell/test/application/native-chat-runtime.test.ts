import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { NativeChatRuntime } from "../../src/application/native-chat-runtime.ts";
import type { MycliShellState } from "../../src/model.ts";
import type { MycliUiAction, MycliUiActionDispatcher } from "../../src/interaction/ui-actions.ts";

function stateWithMessages(count: number): MycliShellState {
	return {
		title: "mycli",
		messages: Array.from({ length: count }, (_, index) => ({
			id: `message-${index}`,
			role: index % 2 === 0 ? "user" as const : "assistant" as const,
			text: `message ${index}`,
		})),
		tools: [],
		bash: [],
		footer: {
			cwd: "~/Desktop/mycli",
			model: "deepseek-v4-flash",
			liveState: "Idle",
		},
	};
}

function unsafeSequences(): RegExp {
	return /\x1b\[\?1049[hl]|\x1b\[\?(1000|1002|1003|1006)h|\x1b\[2J|\x1b\[3J/;
}

test("native chat runtime appends transcript without fullscreen control sequences", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	let captured = "";
	output.on("data", (chunk) => {
		captured += String(chunk);
	});
	const runtime = new NativeChatRuntime({
		initialState: stateWithMessages(4),
		streams: { input, output },
		columns: () => 100,
	});

	runtime.start();
	await setTimeout(10);
	assert.match(captured, /message 0/);
	assert.match(captured, /message 3/);
	assert.doesNotMatch(captured, unsafeSequences());

	captured = "";
	runtime.setState({
		...stateWithMessages(5),
		footer: {
			...stateWithMessages(5).footer,
			liveState: "Running",
		},
	});
	await setTimeout(10);

	assert.match(captured, /message 4/);
	assert.doesNotMatch(captured, /message 0/);
	assert.doesNotMatch(captured, /deepseek-v4-flash/);
	assert.doesNotMatch(captured, unsafeSequences());
	await runtime.stop({ notifyExit: false });
});

test("native chat runtime submits readline input", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const submitted: string[] = [];
	const runtime = new NativeChatRuntime({
		initialState: stateWithMessages(0),
		streams: { input, output },
		columns: () => 100,
		onSubmit: (text) => {
			submitted.push(text);
		},
	});

	runtime.start();
	input.write("hello native chat\n");
	await setTimeout(10);

	assert.deepEqual(submitted, ["hello native chat"]);
	await runtime.stop({ notifyExit: false });
});

test("native chat runtime routes pending clarification input", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const submitted: string[] = [];
	const responses: Array<[string, string]> = [];
	const runtime = new NativeChatRuntime({
		initialState: {
			...stateWithMessages(0),
			pendingClarification: {
				requestId: "question-1",
				question: "Which implementation?",
				options: [{ label: "Runtime" }, { label: "TUI" }],
				multiSelect: false,
			},
		},
		streams: { input, output },
		columns: () => 100,
		onSubmit: (text) => {
			submitted.push(text);
		},
		onClarificationRespond: (requestId, response) => {
			responses.push([requestId, response]);
		},
	});

	runtime.start();
	input.write("Runtime\n");
	await setTimeout(25);

	assert.deepEqual(submitted, []);
	assert.deepEqual(responses, [["question-1", "Runtime"]]);
	await runtime.stop({ notifyExit: false });
});

test("native chat runtime delegates every slash command including quit", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const commands: string[] = [];
	const runtime = new NativeChatRuntime({
		initialState: stateWithMessages(0),
		streams: { input, output },
		columns: () => 100,
		commandNames: ["/help", "/status usage", "/quit"],
		onCommandSubmit: (command) => {
			commands.push(command);
		},
	});

	runtime.start();
	input.write("/help\n");
	input.write("/status usage\n");
	input.write("/quit\n");
	await setTimeout(10);

	assert.deepEqual(commands, ["/help", "/status usage", "/quit"]);
	assert.equal(runtime.isStarted(), true);
	await runtime.stop({ notifyExit: false });
});

test("native chat runtime submits an absolute path as ordinary user text", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const submitted: string[] = [];
	const commands: string[] = [];
	const runtime = new NativeChatRuntime({
		initialState: stateWithMessages(0),
		streams: { input, output },
		columns: () => 100,
		commandNames: ["/help", "/status", "/quit"],
		onSubmit: (text) => {
			submitted.push(text);
		},
		onCommandSubmit: (command) => {
			commands.push(command);
		},
	});

	runtime.start();
	input.write("/Users/cosmos/Desktop/demo create game folder\n");
	await setTimeout(10);

	assert.deepEqual(submitted, ["/Users/cosmos/Desktop/demo create game folder"]);
	assert.deepEqual(commands, []);
	await runtime.stop({ notifyExit: false });
});

test("native chat runtime treats Ctrl+C as local interrupt exit", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	let ordinaryExitCount = 0;
	let interruptExitCount = 0;
	const runtime = new NativeChatRuntime({
		initialState: stateWithMessages(0),
		streams: { input, output },
		columns: () => 100,
		onExit: () => {
			ordinaryExitCount += 1;
		},
		onInterruptExit: () => {
			interruptExitCount += 1;
		},
	});

	runtime.start();
	input.emit("keypress", "", { name: "c", ctrl: true });
	input.emit("data", "\x03");
	await setTimeout(10);

	assert.equal(runtime.isStarted(), false);
	assert.equal(ordinaryExitCount, 0);
	assert.equal(interruptExitCount, 1);
});

test("native chat runtime routes approval and child clarification through typed UI actions", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const actions: MycliUiAction[] = [];
	const dispatcher = collectingDispatcher(actions);
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
	const runtime = new NativeChatRuntime({
		initialState: { ...stateWithMessages(0), pendingApproval: approval },
		streams: { input, output },
		columns: () => 100,
		actions: dispatcher,
	});

	runtime.start();
	input.write("1\n");
	await setTimeout(15);

	assert.deepEqual(actions, [{ type: "approval.respond", approval, choice: "approve_once" }]);

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
		...stateWithMessages(0),
		pendingClarification: clarification,
	});
	input.write("Runtime\n");
	await setTimeout(15);

	assert.deepEqual(actions.at(-1), {
		type: "clarification.respond",
		clarification,
		response: "Runtime",
	});
	await runtime.stop({ notifyExit: false });
});

test("native chat runtime serializes submitted lines and recovers from action failures", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	let captured = "";
	output.on("data", (chunk) => {
		captured += String(chunk);
	});
	const started: string[] = [];
	let releaseFirst!: () => void;
	const firstPending = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const dispatcher: MycliUiActionDispatcher = {
		async dispatch(action) {
			if (action.type !== "submit") return undefined;
			started.push(action.text);
			if (action.text === "first") await firstPending;
			if (action.text === "second") throw new Error("provider unavailable");
			return undefined;
		},
	};
	const runtime = new NativeChatRuntime({
		initialState: stateWithMessages(0),
		streams: { input, output },
		columns: () => 100,
		actions: dispatcher,
	});

	runtime.start();
	input.write("first\nsecond\nthird\n");
	await setTimeout(15);
	assert.deepEqual(started, ["first"]);

	releaseFirst();
	await setTimeout(30);
	assert.deepEqual(started, ["first", "second", "third"]);
	assert.match(captured, /Message submission failed: provider unavailable/);
	assert.equal(runtime.isStarted(), true);
	await runtime.stop({ notifyExit: false });
});

test("native chat runtime interrupts an active turn before using Ctrl+C as exit", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const actions: MycliUiAction[] = [];
	const runtime = new NativeChatRuntime({
		initialState: {
			...stateWithMessages(0),
			footer: {
				...stateWithMessages(0).footer,
				turnRunning: true,
				liveState: "Running",
			},
		},
		streams: { input, output },
		columns: () => 100,
		actions: collectingDispatcher(actions),
	});

	runtime.start();
	input.emit("keypress", "", { name: "c", ctrl: true });
	input.emit("data", "\x03");
	await setTimeout(15);

	assert.deepEqual(actions, [{ type: "interrupt", rollbackUserInput: false }]);
	assert.equal(runtime.isStarted(), true);
	await runtime.stop({ notifyExit: false });
});

test("native cancel and EOF bypass a pending submission and discard queued input on close", async (t) => {
	for (const control of ["interrupt", "eof"] as const) {
		await t.test(control, async () => {
			const input = new PassThrough();
			const output = new PassThrough();
			output.resume();
			const actions: MycliUiAction[] = [];
			let release!: () => void;
			const pending = new Promise<void>((resolve) => { release = resolve; });
			const runtime = new NativeChatRuntime({
				initialState: { ...stateWithMessages(0), footer: { ...stateWithMessages(0).footer, turnRunning: true } },
				streams: { input, output },
				actions: { async dispatch(action) {
					actions.push(action);
					if (action.type === "submit") await pending;
				} },
			});
			try {
				runtime.start();
				input.write("first\nsecond\n");
				await setTimeout(10);
				if (control === "interrupt") input.write("\x03");
				else input.end();
				await setTimeout(10);
				assert.deepEqual(actions.map((action) => action.type), ["submit", control === "interrupt" ? "interrupt" : "exit"]);
				await runtime.stop({ notifyExit: false });
				release();
				await setTimeout(10);
				assert.equal(actions.filter((action) => action.type === "submit").length, 1);
			} finally {
				release();
				await runtime.stop({ notifyExit: false });
				input.destroy();
				output.destroy();
			}
		});
	}
});

test("native chat runtime renders revised transcript blocks and each pending notice once", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	let captured = "";
	output.on("data", (chunk) => {
		captured += String(chunk);
	});
	const initial = {
		...stateWithMessages(1),
		transcript: [{
			id: "message-0",
			kind: "message" as const,
			message: { id: "message-0", role: "assistant" as const, text: "draft" },
		}],
	};
	const runtime = new NativeChatRuntime({
		initialState: initial,
		streams: { input, output },
		columns: () => 100,
	});

	runtime.start();
	captured = "";
	const revised = {
		...initial,
		pendingNotice: "Approval still pending.",
		transcript: [{
			id: "message-0",
			kind: "message" as const,
			message: { id: "message-0", role: "assistant" as const, text: "final answer" },
		}],
	};
	runtime.setState(revised);
	runtime.setState({ ...revised, footer: { ...revised.footer, contextPercent: 20 } });
	await setTimeout(15);

	assert.match(captured, /final answer/);
	assert.equal(captured.match(/Approval still pending\./g)?.length, 1);
	await runtime.stop({ notifyExit: false });
});

test("native chat runtime treats EOF as a normal shutdown action", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const actions: MycliUiAction[] = [];
	const runtime = new NativeChatRuntime({
		initialState: stateWithMessages(0),
		streams: { input, output },
		columns: () => 100,
		actions: collectingDispatcher(actions),
	});

	runtime.start();
	input.end();
	await setTimeout(15);

	assert.equal(runtime.isStarted(), false);
	assert.deepEqual(actions, [{ type: "exit", reason: "normal" }]);
});

function collectingDispatcher(actions: MycliUiAction[]): MycliUiActionDispatcher {
	return {
		dispatch(action) {
			actions.push(action);
			return Promise.resolve(undefined);
		},
	};
}
