import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { GatewayClient, GatewayRequestError } from "../src/adapters/gateway-client.ts";
import {
	initialRuntimeState,
	reduceRuntimeEvent,
	runtimeStateAfterCommandResult,
} from "../src/adapters/runtime-state.ts";

test("gateway client rejects pending requests when output pipe closes", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const client = new GatewayClient({ input, output });

	client.start();
	const pending = client.send("session.bootstrap", {});
	output.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

	await assert.rejects(pending, /write EPIPE/);
	await assert.rejects(
		client.send("status.inspect", {}),
		(error) =>
			error instanceof GatewayRequestError &&
			error.code === "pipe_closed" &&
			error.method === "status.inspect",
	);
	client.stop();
});

test("gateway client ignores input after closure", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const events: string[] = [];
	const client = new GatewayClient({
		input,
		output,
		log: (event) => events.push(event.method),
	});

	client.start();
	output.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
	input.write('{"jsonrpc":"2.0","method":"status.changed","params":{}}\n');
	await setTimeout(10);

	assert.deepEqual(events, []);
	client.stop();
});

test("gateway client exposes structured error data", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const client = new GatewayClient({ input, output });
	client.start();

	const pending = client.send("turn.steer", {});
	input.write(`${JSON.stringify({
		jsonrpc: "2.0",
		id: "1",
		error: {
			code: "turn_id_mismatch",
			message: "stale turn",
			data: { actual_turn_id: "turn-2" },
		},
	})}\n`);

	await assert.rejects(
		pending,
		(error) =>
			error instanceof GatewayRequestError &&
			error.data.actual_turn_id === "turn-2",
	);
	client.stop();
});

test("inline resume loads the destination before adding one transient notice", async () => {
	const calls = ["command.run"];
	const source = {
		...initialRuntimeState(),
		sessionId: "demo-1",
		transcript: [
			{ id: "source-message", type: "user", text: "source", folded: false },
		],
	};

	const state = await runtimeStateAfterCommandResult(
		source,
		"/resume demo-2",
		{
			mutated_session: true,
			session_id: "demo-2",
			lines: ["Resumed session demo-2"],
		},
		async (sessionId) => {
			calls.push(`transcript.load:${sessionId}`);
			return {
				session_id: sessionId,
				items: [
					{ id: "destination-message", type: "assistant_final", text: "destination", folded: false },
				],
			};
		},
	);

	assert.deepEqual(calls, ["command.run", "transcript.load:demo-2"]);
	assert.equal(state.sessionId, "demo-2");
	assert.deepEqual(state.transcript.map((item) => item.id), [
		"destination-message",
		state.transcript[1]?.id,
	]);
	assert.equal(state.transcript[1]?.type, "system_notice");
	assert.equal(state.transcript[1]?.text, "Resumed session demo-2");
	assert.equal(state.transcript.some((item) => item.id === "source-message"), false);
});

test("inline resume uses the source session when session.changed arrives first", async () => {
	const source = {
		...initialRuntimeState(),
		sessionId: "demo-1",
		transcript: [
			{ id: "source-message", type: "user" as const, text: "source", folded: false },
		],
	};
	const eventAdvanced = reduceRuntimeEvent(source, "session.changed", {
		session_id: "demo-2",
	});
	let loads = 0;

	const state = await runtimeStateAfterCommandResult(
		eventAdvanced,
		"/resume demo-2",
		{
			mutated_session: true,
			session_id: "demo-2",
			lines: ["Resumed session demo-2"],
		},
		async () => {
			loads += 1;
			return {
				items: [
					{
						id: "destination-message",
						type: "assistant_final",
						text: "destination",
						folded: false,
					},
				],
			};
		},
		"demo-1",
	);

	assert.equal(loads, 1);
	assert.equal(state.transcript.some((item) => item.id === "source-message"), false);
	assert.equal(state.transcript[0]?.id, "destination-message");
});

test("same-session mutation keeps transcript and uses normal command projection", async () => {
	const source = {
		...initialRuntimeState(),
		sessionId: "demo",
		transcript: [{ id: "existing", type: "user", text: "keep", folded: false }],
	};
	let loads = 0;

	const state = await runtimeStateAfterCommandResult(
		source,
		"/resume demo",
		{
			mutated_session: true,
			session_id: "demo",
			lines: ["Already using demo"],
		},
		async () => {
			loads += 1;
			return { items: [] };
		},
	);

	assert.equal(loads, 0);
	assert.equal(state.transcript[0]?.id, "existing");
	assert.equal(state.transcript[1]?.text, "Already using demo");
});
