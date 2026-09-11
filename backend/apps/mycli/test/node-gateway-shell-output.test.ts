import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import test from "node:test";
import { parseGatewayEvent, type GatewayEventNotification } from "@mycli/contracts";
import { NodeGatewayEventProjector } from "../src/node-runtime/node-gateway-event-projector.ts";
import { NodeGatewayRpcTransport } from "../src/node-runtime/node-gateway-rpc-transport.ts";
import { GATEWAY_SHELL_OUTPUT_MAX_CHARS, shellOutputCoalescing } from "../src/node-runtime/node-gateway-shell-output.ts";

type ShellOutput = Extract<GatewayEventNotification, { method: "shell.output" }>;

test("Shell coalescing preserves contiguous text, overlaps, gaps, and bounded suffixes", () => {
	const first = outputEvent("abc", 3, 1);
	assert.deepEqual(merge(first, outputEvent("def", 6, 2)).params, {
		...outputEvent("abcdef", 6, 2).params, omitted_output_chars: 0,
	});
	assert.equal(merge(first, outputEvent("bcdef", 6, 2)).params.output_delta, "abcdef");
	assert.deepEqual(merge(first, outputEvent("tail", 12, 2)).params, {
		...outputEvent("tail", 12, 2).params, omitted_output_chars: 8,
	});
	const large = merge(outputEvent("x".repeat(8_000), 8_000, 1), outputEvent("y".repeat(8_000), 16_000, 2));
	assert.equal(large.params.output_delta?.length, GATEWAY_SHELL_OUTPUT_MAX_CHARS);
	assert.equal(large.params.omitted_output_chars, 6_000);
	assert.equal(large.params.output_delta, "x".repeat(2_000) + "y".repeat(8_000));
	const unicode = merge(outputEvent("a\uD83D\uDE00", 3, 1), outputEvent("z".repeat(9_999), 10_002, 2));
	assert.equal(unicode.params.output_delta, "z".repeat(9_999));
	assert.equal(unicode.params.omitted_output_chars, 3);
});

test("Shell output coalescing fences each ownership dimension and delivery surface", () => {
	const output = outputEvent("a", 1, 1);
	const key = shellOutputCoalescing(output)!.key;
	for (const field of ["session_id", "generation", "turn_id", "shell_id", "call_id"] as const) {
		const params = { ...output.params, [field]: field === "generation" ? 2 : "other" };
		assert.notEqual(shellOutputCoalescing({ ...output, params })!.key, key, field);
	}
	assert.equal(shellOutputCoalescing({ ...output, method: "shell.completed" }), undefined);
	assert.equal(shellOutputCoalescing({ jsonrpc: "2.0", method: "message.delta", params: { client_turn_id: "turn", text: "a" } }), undefined);
});

test("a 670429-character Shell burst drains through the gateway and delivers completion and RPC replies", async (t) => {
	let closures = 0;
	const rpc = new NodeGatewayRpcTransport({
		dispatch: () => ({ ok: true }),
		mapFailure: () => ({ code: "internal_error", message: "failed" }),
		close: () => { closures++; },
	});
	const rows: Array<Record<string, unknown>> = [];
	const consumer = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, callback): void {
		for (const line of chunk.toString().trimEnd().split("\n")) rows.push(JSON.parse(line) as Record<string, unknown>);
		setImmediate(callback);
	} });
	t.after(() => { rpc.dispose(); consumer.destroy(); });
	rpc.transport.input.pipe(consumer);
	const projector = new NodeGatewayEventProjector({
		clock: () => 0,
		currentOwnership: () => ({ sessionId: "session", generation: 1, turnId: "turn" }),
		write: (event) => rpc.writeNotification(event),
	});
	projector.emitRuntime("shell.started", { ...outputEvent("", 0, 0).params });
	const output = "head\n" + "x".repeat(670_419) + "\ntail";
	let sequence = 0;
	for (let cursor = 0; cursor < output.length; cursor += 4_096) {
		const delta = output.slice(cursor, cursor + 4_096);
		projector.emitRuntime("shell.output", { ...outputEvent(delta, cursor + delta.length, ++sequence).params });
		if (sequence === 80) projector.emitRuntime("message.delta", { client_turn_id: "turn", text: "still running" });
	}
	assert.equal(sequence, 164);
	projector.emitRuntime("shell.completed", {
		...outputEvent("", output.length, ++sequence).params,
		process_state: "completed", terminal_state: "completed", exit_code: 0,
	});
	projector.emitRuntime("turn.completed", {
		client_turn_id: "turn", turn_id: "turn", assistant_message: "done", activity_events: [],
		progress_updates: [], plan_steps: [], pending_decision: false, turn_state: "completed",
		usage: { input_tokens: 0, output_tokens: 0 },
	});
	rpc.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} })}\n`);
	assert.equal(await rpc.close(), true);
	await finished(consumer);
	assert.equal(closures, 0);
	assert.deepEqual(rows.find((row) => row.id === 1)?.result, { ok: true });
	const events = rows.filter((row) => typeof row.method === "string").map(parseGatewayEvent);
	const outputs = events.filter((event): event is ShellOutput => event.method === "shell.output");
	assert.ok(outputs.length > 0 && outputs.length < 164);
	assert.match(outputs.at(-1)!.params.output_delta ?? "", /\ntail$/u);
	assert.ok(outputs.at(-1)!.params.omitted_output_chars! > 0);
	const sequences = events.flatMap((event) => event.method === "runtime.event" ? [event.params.sequence] : []);
	assert.ok(sequences.every((value, index) => index === 0 || value > sequences[index - 1]!));
	const methods = events.map((event) => event.method);
	assert.ok(methods.lastIndexOf("shell.output") < methods.indexOf("shell.completed"));
	assert.ok(methods.indexOf("shell.completed") < methods.indexOf("turn.completed"));
	assert.ok(events.some((event) => event.method === "message.delta" && event.params.text === "still running"));
});

function outputEvent(output: string, cursor: number, sequence: number): ShellOutput {
	return { jsonrpc: "2.0", method: "shell.output", params: {
		session_id: "session", generation: 1, turn_id: "turn", shell_id: "shell", call_id: "call",
		sequence, command_preview: "synthetic output", background: false,
		process_state: "running_foreground", transport: "pipe", tty: false, yielded: false,
		output_delta: output, next_cursor: cursor, output_chars: cursor,
	} };
}

function merge(previous: ShellOutput, next: ShellOutput): ShellOutput {
	const frame = shellOutputCoalescing(next)!.merge(JSON.stringify(previous), JSON.stringify(next));
	const result = parseGatewayEvent(JSON.parse(frame) as unknown);
	assert.equal(result.method, "shell.output");
	return result as ShellOutput;
}
