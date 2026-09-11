import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import test from "node:test";
import { parseGatewayEvent, type GatewayEventNotification } from "@mycli/contracts";
import { NodeGatewayEventProjector } from "../src/node-runtime/node-gateway-event-projector.ts";
import { NodeGatewayRpcTransport } from "../src/node-runtime/node-gateway-rpc-transport.ts";

test("bursty model output preserves every event and mirror before terminal state and RPC replies", async (t) => {
	let closures = 0;
	const rpc = new NodeGatewayRpcTransport({
		dispatch: () => ({ ok: true }),
		mapFailure: () => ({ code: "internal_error", message: "failed" }),
		close: () => { closures++; },
	});
	const received: unknown[] = [];
	const expected: GatewayEventNotification[] = [];
	let writes = 0;
	const consumer = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, callback): void {
		writes++;
		for (const line of chunk.toString().trimEnd().split("\n")) received.push(JSON.parse(line) as unknown);
		setImmediate(callback);
	} });
	t.after(() => { rpc.dispose(); consumer.destroy(); });
	rpc.transport.input.pipe(consumer);
	const projector = new NodeGatewayEventProjector({
		clock: () => 0,
		currentOwnership: () => ({ sessionId: "session", generation: 1, turnId: "turn" }),
		write: (event) => { expected.push(event); rpc.writeNotification(event); },
	});
	for (let index = 0; index < 790; index++) {
		const text = `${index}:\u4e2d\u6587\uD83D\uDE00\n`;
		projector.emitRuntime("reasoning.delta", { client_turn_id: "client", text });
		projector.emitRuntime("thinking.delta", { client_turn_id: "client", text });
		projector.emitRuntime("turn.event", {
			client_turn_id: "client", phase: "reasoning", kind: "reasoning", text, tool_name: null, metadata: {},
		});
		projector.emitRuntime("message.delta", { client_turn_id: "client", text });
		if (index === 390) projector.emitRuntime("message.reset", { client_turn_id: "client" });
	}
	projector.emitRuntime("message.complete", { client_turn_id: "client" });
	projector.emitRuntime("turn.completed", {
		client_turn_id: "client", turn_id: "turn", assistant_message: "done", activity_events: [],
		progress_updates: [], plan_steps: [], pending_decision: false, turn_state: "completed",
		usage: { input_tokens: 0, output_tokens: 0 },
	});
	rpc.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} })}\n`);
	assert.equal(await rpc.close(), true);
	await finished(consumer);
	assert.equal(closures, 0);
	assert.deepEqual(received.slice(0, -1).map(parseGatewayEvent), expected);
	assert.deepEqual(received.at(-1), { jsonrpc: "2.0", id: 1, result: { ok: true } });
	assert.ok(writes < 256);
});
