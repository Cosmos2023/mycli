import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import {
	GatewayClient,
	GatewayRequestError,
	type GatewayEvent,
} from "../../src/transport/gateway-client.ts";
import {
	initialRuntimeState,
	type RuntimeShellState,
} from "../../src/state/runtime-state-model.ts";
import {
	reduceRuntimeEvent,
} from "../../src/state/runtime-event-reducer.ts";
import {
	runtimeStateWithSessionCommandNotice,
} from "../../src/state/session-state.ts";
import { runtimeStateWithCommandResult } from "../../src/state/command-state.ts";
import { SessionTransitionController } from "../../src/application/session-transition.ts";

test("gateway client closes on an invalid JSON-RPC envelope", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const client = new GatewayClient({ input, output });
	client.start();

	const pending = client.send("status.inspect", {});
	input.write('{"jsonrpc":"1.0","id":"1","result":{}}\n');

	await assert.rejects(pending, /Invalid JSON-RPC message/);
	assert.equal(input.destroyed, true);
	client.stop();
});

test("gateway client rejects an invalid known event payload", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const client = new GatewayClient({ input, output });
	client.start();

	const event = client.waitForEvent("turn.started");
	input.write('{"jsonrpc":"2.0","method":"turn.started","params":{}}\n');

	await assert.rejects(event, /Invalid gateway event/);
	client.stop();
});

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

test("gateway client reports an unexpected pipe close once", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const closed: string[] = [];
	const client = new GatewayClient({
		input,
		output,
		onClose: (error) => closed.push(error.message),
	});
	client.start();

	output.emit("error", new Error("sidecar pipe failed"));
	assert.equal(input.listenerCount("error"), 0);
	assert.equal(output.listenerCount("error"), 0);
	input.on("error", () => {});
	input.emit("error", new Error("duplicate close"));
	await setTimeout(10);

	assert.deepEqual(closed, ["sidecar pipe failed"]);
	client.stop();
});

test("gateway client stop does not report an unexpected close", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const closed: string[] = [];
	const client = new GatewayClient({
		input,
		output,
		onClose: (error) => closed.push(error.message),
	});
	client.start();

	client.stop();
	await setTimeout(10);

	assert.deepEqual(closed, []);
});

test("gateway client does not report an expected remote close", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const closed: string[] = [];
	const client = new GatewayClient({
		input,
		output,
		onClose: (error) => closed.push(error.message),
	});
	client.start();
	client.expectClose();

	input.end();
	await setTimeout(10);

	assert.deepEqual(closed, []);
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

test("gateway client consumes a replayed event only once", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const client = new GatewayClient({ input, output });
	client.start();

	input.write(`${JSON.stringify({
		jsonrpc: "2.0",
		method: "message.delta",
		params: { client_turn_id: "turn-1", text: "done" },
	})}\n`);
	await setTimeout(10);

	const replayed = await client.waitForEvent("message.delta");
	assert.equal(clientTurnId(replayed), "turn-1");
	await assert.rejects(client.waitForEvent("message.delta", () => true, 5), /Timed out/);
	client.stop();
});

test("gateway client does not replay an event that resolved a pending waiter", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const client = new GatewayClient({ input, output });
	client.start();

	const pending = client.waitForEvent("message.delta");
	input.write(`${JSON.stringify({
		jsonrpc: "2.0",
		method: "message.delta",
		params: { client_turn_id: "turn-1", text: "done" },
	})}\n`);

	await pending;
	await assert.rejects(client.waitForEvent("message.delta", () => true, 5), /Timed out/);
	client.stop();
});

test("gateway client bounds unmatched event replay", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const client = new GatewayClient({ input, output, eventReplayLimit: 2 });
	client.start();

	for (const clientTurnId of ["turn-1", "turn-2", "turn-3"]) {
		input.write(`${JSON.stringify({
			jsonrpc: "2.0",
			method: "message.delta",
			params: { client_turn_id: clientTurnId, text: clientTurnId },
		})}\n`);
	}
	await setTimeout(10);

	await assert.rejects(
		client.waitForEvent(
			"message.delta",
			(event) => clientTurnId(event) === "turn-1",
			5,
		),
		/Timed out/,
	);
	const second = await client.waitForEvent(
		"message.delta",
		(event) => clientTurnId(event) === "turn-2",
	);
	const third = await client.waitForEvent(
		"message.delta",
		(event) => clientTurnId(event) === "turn-3",
	);
	assert.equal(clientTurnId(second), "turn-2");
	assert.equal(clientTurnId(third), "turn-3");
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

	let state: RuntimeShellState = source;
	const transition = new SessionTransitionController({
		current: () => state,
		update: (next) => { state = next; },
		loadTranscript: async (sessionId) => {
			calls.push(`transcript.load:${sessionId}`);
			return {
				session_id: sessionId,
				items: [
					{ id: "destination-message", type: "assistant_final", text: "destination", folded: false },
				],
			};
		},
	});
	const result = { mutated_session: true, session_id: "demo-2", lines: ["Resumed session demo-2"] };
	await transition.resume(result);
	state = runtimeStateWithSessionCommandNotice(state, "/resume demo-2", result);

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

	let state = eventAdvanced;
	const transition = new SessionTransitionController({
		current: () => state,
		update: (next) => { state = next; },
		loadTranscript: async () => {
			loads += 1;
			return {
				session_id: "demo-2",
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
	});
	await transition.resume({ session_id: "demo-2" }, undefined, { sessionId: "demo-1", generation: null });

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
	const state = runtimeStateWithCommandResult(
		source,
		"/resume demo",
		{
			mutated_session: true,
			session_id: "demo",
			lines: ["Already using demo"],
		},
	);

	assert.equal(state.transcript[0]?.id, "existing");
	assert.equal(state.transcript[1]?.text, "Already using demo");
});

function clientTurnId(event: GatewayEvent): string | undefined {
	return "client_turn_id" in event.params && typeof event.params.client_turn_id === "string"
		? event.params.client_turn_id
		: undefined;
}
