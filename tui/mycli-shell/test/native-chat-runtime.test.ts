import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { NativeChatRuntime } from "../src/native-chat-runtime.ts";
import type { MycliShellState } from "../src/model.ts";

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
	return /\x1b\[\?1049[hl]|\x1b\[\?(1000|1002|1003|1006)h|\x1b\[2J|\x1b\[3J|\x1b\[\d*A/;
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
