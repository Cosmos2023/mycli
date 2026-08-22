import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import test from "node:test";
import { startSupervisedNodeBackend } from "../src/node-runtime/node-backend-supervisor.ts";

type JsonObject = Record<string, unknown>;

test("targeted Agent Worker interruption keeps the coordinator generation", async (t) => {
	const backend = await startSupervisedNodeBackend({
		cwd: process.cwd(),
		env: {},
		args: ["--session", "supervisor-session"],
		workerUrl: new URL(
			"./fixtures/node-backend-responsive-interrupt-worker.mjs",
			import.meta.url,
		),
	});
	t.after(async () => backend.close());
	const messages: JsonObject[] = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(JSON.parse(line) as JsonObject);
	});
	const ready = await waitFor(() => messages.find((message) => message.method === "runtime.ready"));

	writeRequest(backend, "submit", "turn.submit", {
		message: "interrupt within the targeted Worker cleanup bound",
		client_turn_id: "client-responsive",
		client_user_message_id: "message-responsive",
	});
	await waitFor(() => response(messages, "submit"));
	await waitFor(() => messages.find((message) => message.method === "turn.started"));
	const interruptStartedAt = performance.now();
	writeRequest(backend, "interrupt", "turn.interrupt", {
		turn_id: "turn-responsive",
		rollback_user_input: true,
	});

	const interrupted = await waitFor(() => messages.find((message) =>
		message.method === "turn.interrupted"));
	const interruptResponse = await waitFor(() => response(messages, "interrupt"));
	assert.ok(performance.now() - interruptStartedAt >= 300);
	assert.ok(messages.indexOf(interrupted) < messages.indexOf(interruptResponse));
	assert.equal(messages.filter((message) => message.method === "runtime.ready").length, 1);
	assert.equal(objectValue(ready.params)?.coordinator_generation, 1);
	assert.equal(objectValue(interrupted.params)?.coordinator_generation, 1);
	assert.equal(objectValue(interruptResponse.result)?.coordinator_generation, 1);
});

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

function objectValue(value: unknown): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as JsonObject
		: undefined;
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
