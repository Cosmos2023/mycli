import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import test from "node:test";
import { startSupervisedNodeBackend } from "../src/node-runtime/node-backend-supervisor.ts";

type JsonObject = Record<string, unknown>;

test("supervisor retains the backend failure diagnostic after Worker exit and cleanup", async (t) => {
	const backend = await startSupervisedNodeBackend({
		cwd: process.cwd(), env: {}, args: [],
		workerUrl: new URL("./fixtures/node-backend-flow-control-worker.mjs", import.meta.url),
	});
	t.after(() => backend.close());
	backend.transport.input.resume();
	writeRequest(backend, "fail", "fail", {});
	assert.equal(await backend.completion, 1);
	await backend.close();
	assert.equal(backend.diagnostic(), "gateway_overloaded");
	assert.equal(backend.transport.diagnostic?.(), "gateway_overloaded");
});

test("supervisor delivery credit requires consumption acknowledgements even after replies", async (t) => {
	const backend = await startSupervisedNodeBackend({
		cwd: process.cwd(), env: {}, args: ["no-ack"], limits: { maxPendingRequests: 1, controlReserveRequests: 1 },
		workerUrl: new URL("./fixtures/node-backend-flow-control-worker.mjs", import.meta.url),
	});
	t.after(async () => backend.close());
	const messages: JsonObject[] = [];
	createInterface({ input: backend.transport.input }).on("line", (line) => messages.push(JSON.parse(line) as JsonObject));
	writeRequest(backend, "one", "echo", { text: "\u4e2d\u6587" });
	assert.equal(objectValue((await waitFor(() => response(messages, "one"))).result)?.text, "\u4e2d\u6587");
	writeRequest(backend, "two", "echo", {});
	const rejected = await waitFor(() => messages.find((message) => message.id === "two"));
	assert.equal(objectValue(rejected.error)?.code, "gateway_overloaded");
	assert.deepEqual(objectValue(rejected.error)?.data, { dispatched: false });
	writeRequest(backend, "stop", "turn.interrupt", { turn_id: "turn" });
	await waitFor(() => response(messages, "stop"));
});

test("supervisor frames split UTF-8 requests before forwarding to the Worker", async (t) => {
	const backend = await startSupervisedNodeBackend({
		cwd: process.cwd(), env: {}, args: [],
		workerUrl: new URL("./fixtures/node-backend-flow-control-worker.mjs", import.meta.url),
	});
	t.after(async () => backend.close());
	const messages: JsonObject[] = [];
	createInterface({ input: backend.transport.input }).on("line", (line) => messages.push(JSON.parse(line) as JsonObject));
	const frame = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: "split", method: "echo", params: { text: "\u4e2d\u6587" } })}\n`);
	for (const byte of frame) backend.transport.output.write(Buffer.from([byte]));
	const reply = await waitFor(() => response(messages, "split"));
	assert.equal(objectValue(reply.result)?.text, "\u4e2d\u6587");
});

test("supervisor fails boundedly on oversized input and undrained Worker output", async () => {
	for (const flood of [false, true]) {
		const backend = await startSupervisedNodeBackend({
			cwd: process.cwd(), env: {}, args: [],
			limits: flood ? { maxQueuedMessages: 1 } : { maxFrameBytes: 128 },
			workerUrl: new URL("./fixtures/node-backend-flow-control-worker.mjs", import.meta.url),
		});
		try {
			if (flood) writeRequest(backend, "flood", "flood", {});
			else { backend.transport.output.write(" ".repeat(128)); backend.transport.output.write("x"); }
			assert.equal(await backend.completion, 1);
			assert.equal(backend.diagnostic?.(), flood ? "gateway_overloaded" : "gateway_message_too_large");
		} finally { await backend.close(); }
	}
});

test("supervisor aborts stalled startup and closes the owned Worker", { timeout: 3000 }, async () => {
	const controller = new AbortController();
	const started = startSupervisedNodeBackend({
		cwd: process.cwd(), env: {}, args: [], signal: controller.signal,
		workerUrl: new URL("./fixtures/node-backend-stalled-start-worker.mjs", import.meta.url),
	});
	const reason = new Error("startup canceled");
	controller.abort(reason);
	await assert.rejects(started, (error: unknown) => error === reason);
});

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
		args: ["--session", "supervisor-session", "--profile", "work"],
		hardInterruptTimeoutMs: 30,
		workerUrl: new URL("./fixtures/node-backend-blocking-worker.mjs", import.meta.url),
	});
	t.after(async () => backend.close());
	const messages: JsonObject[] = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(JSON.parse(line) as JsonObject);
	});
	const firstReady = await waitFor(() => messages.find((message) => message.method === "runtime.ready"));
	assert.equal(objectValue(firstReady.params)?.config_profile, "work");

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
	for (const ready of messages.filter((message) => message.method === "runtime.ready")) {
		assert.equal(objectValue(ready.params)?.config_profile, "work");
	}
});

test("saturated coordinator accepts interruption, rejects recovery mutations, and resets generation credit", async (t) => {
	const backend = await startSupervisedNodeBackend({
		cwd: process.cwd(), env: {}, args: ["--session", "supervisor-session", "--delay-recovery"],
		hardInterruptTimeoutMs: 30, limits: { maxPendingRequests: 1, controlReserveRequests: 1 },
		workerUrl: new URL("./fixtures/node-backend-blocking-worker.mjs", import.meta.url),
	});
	t.after(async () => backend.close());
	const messages: JsonObject[] = [];
	createInterface({ input: backend.transport.input }).on("line", (line) => messages.push(JSON.parse(line) as JsonObject));
	await waitFor(() => messages.find((message) => message.method === "runtime.ready"));
	writeRequest(backend, "submit", "turn.submit", { message: "block", client_turn_id: "client-blocking" });
	await waitFor(() => response(messages, "submit"));
	await waitFor(() => messages.find((message) => message.method === "turn.started"));
	writeRequest(backend, "stale", "hold", {});
	writeRequest(backend, "overload", "mutate", {});
	assert.equal(objectValue((await waitFor(() => messages.find((message) => message.id === "overload"))).error)?.code, "gateway_overloaded");
	writeRequest(backend, "interrupt", "turn.interrupt", { turn_id: "turn-blocking" });
	await waitFor(() => messages.filter((message) => message.method === "runtime.ready")[1]);
	writeRequest(backend, "recovery-mutation", "probe", {});
	const rejected = await waitFor(() => messages.find((message) => message.id === "recovery-mutation"));
	assert.equal(objectValue(rejected.error)?.code, "gateway_overloaded");
	assert.deepEqual(objectValue(rejected.error)?.data, { dispatched: false });
	const interrupted = await waitFor(() => messages.find((message) => message.method === "turn.interrupted"));
	const completed = await waitFor(() => response(messages, "interrupt"));
	assert.ok(messages.indexOf(interrupted) < messages.indexOf(completed));
	const stale = await waitFor(() => messages.find((message) => message.id === "stale"));
	assert.equal(objectValue(stale.error)?.code, "internal_error");
	writeRequest(backend, "new", "probe", {});
	assert.deepEqual((await waitFor(() => response(messages, "new"))).result, { generation: 2 });
	assert.equal(messages.filter((message) => message.id === "recovery-mutation").length, 1);
});

test("supervisor fails recovery that never publishes durable interruption instead of waiting forever", { timeout: 3000 }, async (t) => {
	const backend = await startSupervisedNodeBackend({
		cwd: process.cwd(), env: {}, args: ["--session", "supervisor-session", "--omit-recovery"],
		hardInterruptTimeoutMs: 10, limits: { writeStallTimeoutMs: 100 },
		workerUrl: new URL("./fixtures/node-backend-blocking-worker.mjs", import.meta.url),
	});
	t.after(async () => backend.close());
	const messages: JsonObject[] = [];
	createInterface({ input: backend.transport.input }).on("line", (line) => messages.push(JSON.parse(line) as JsonObject));
	writeRequest(backend, "submit", "turn.submit", { message: "block", client_turn_id: "client-blocking" });
	await waitFor(() => response(messages, "submit"));
	writeRequest(backend, "interrupt", "turn.interrupt", { turn_id: "turn-blocking" });
	assert.equal(await backend.completion, 1);
	assert.equal(backend.diagnostic?.(), "node_backend_worker_restart_failed");
	assert.equal(response(messages, "interrupt"), undefined);
});

test("shutdown during recovery closes the replacement Worker and does not resume buffered work", { timeout: 3000 }, async (t) => {
	const backend = await startSupervisedNodeBackend({
		cwd: process.cwd(), env: {}, args: ["--session", "supervisor-session", "--delay-recovery"],
		hardInterruptTimeoutMs: 10,
		workerUrl: new URL("./fixtures/node-backend-blocking-worker.mjs", import.meta.url),
	});
	t.after(async () => backend.close());
	const messages: JsonObject[] = [];
	createInterface({ input: backend.transport.input }).on("line", (line) => messages.push(JSON.parse(line) as JsonObject));
	await waitFor(() => messages.find((message) => message.method === "runtime.ready"));
	writeRequest(backend, "submit", "turn.submit", { message: "block", client_turn_id: "client-blocking" });
	await waitFor(() => response(messages, "submit"));
	writeRequest(backend, "interrupt", "turn.interrupt", { turn_id: "turn-blocking" });
	await waitFor(() => messages.filter((message) => message.method === "runtime.ready")[1]);
	writeRequest(backend, "shutdown", "shutdown", {});
	assert.deepEqual((await waitFor(() => response(messages, "shutdown"))).result, { ok: true });
	assert.equal(await backend.completion, 0);
	const firstClose = backend.close();
	assert.equal(backend.close(), firstClose);
	await firstClose;
	assert.equal(response(messages, "interrupt"), undefined);
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

test("supervisor preserves the headless goal capability gate across the Worker boundary", async (t) => {
	const backend = await startSupervisedNodeBackend({ cwd: process.cwd(), env: {}, args: [], enableGoals: false,
		workerUrl: new URL("./fixtures/node-backend-flow-control-worker.mjs", import.meta.url) });
	t.after(() => backend.close());
	const messages: JsonObject[] = [];
	createInterface({ input: backend.transport.input }).on("line", (line) => messages.push(JSON.parse(line) as JsonObject));
	writeRequest(backend, "options", "inspect-options", {});
	assert.equal(objectValue((await waitFor(() => response(messages, "options"))).result)?.enableGoals, false);
});
