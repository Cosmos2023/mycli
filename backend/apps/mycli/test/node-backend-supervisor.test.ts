import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import test from "node:test";
import { startSupervisedNodeBackend } from "../src/node-runtime/node-backend-supervisor.ts";

type JsonObject = Record<string, unknown>;

test("hard interruption terminates a blocked Worker and publishes terminal state first", async (t) => {
	const backend = await startSupervisedNodeBackend({
		cwd: process.cwd(),
		env: {},
		args: ["--session", "supervisor-session"],
		hardInterruptTimeoutMs: 30,
		workerUrl: new URL("./fixtures/node-backend-blocking-worker.mjs", import.meta.url),
	});
	t.after(async () => backend.close());
	const messages: JsonObject[] = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(JSON.parse(line) as JsonObject);
	});
	await waitFor(() => messages.find((message) => message.method === "runtime.ready"));

	writeRequest(backend, "submit", "turn.submit", {
		message: "block",
		client_turn_id: "client-blocking",
		client_user_message_id: "message-blocking",
	});
	await waitFor(() => response(messages, "submit"));
	await waitFor(() => messages.find((message) => message.method === "turn.started"));
	writeRequest(backend, "interrupt", "turn.interrupt", {
		turn_id: "turn-blocking",
		rollback_user_input: true,
	});

	const interrupted = await waitFor(() => messages.find((message) =>
		message.method === "turn.interrupted"));
	const interruptResponse = await waitFor(() => response(messages, "interrupt"));
	assert.ok(messages.indexOf(interrupted) < messages.indexOf(interruptResponse));
	assert.deepEqual(interruptResponse.result, {
		accepted: true,
		requested: true,
		client_turn_id: "client-blocking",
		turn_id: "turn-blocking",
		input_rolled_back: false,
	});
	assert.equal(messages.filter((message) => message.method === "runtime.ready").length, 2);
});

function writeRequest(
	backend: Awaited<ReturnType<typeof startSupervisedNodeBackend>>,
	id: string,
	method: string,
	params: JsonObject,
): void {
	backend.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function response(messages: readonly JsonObject[], id: string): JsonObject | undefined {
	return messages.find((message) => message.id === id && "result" in message);
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) throw new Error("timed_out_waiting_for_supervisor_event");
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}
