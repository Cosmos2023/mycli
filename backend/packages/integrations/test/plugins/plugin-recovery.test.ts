import assert from "node:assert/strict";
import test from "node:test";
import { PluginHostError } from "../../src/plugins/process-host.ts";
import { RecoverablePluginHost } from "../../src/plugins/recoverable-host.ts";
import type { PluginHostContract, PluginHostStatus, PluginInvocationResult, PluginProtocolRegistration } from "../../src/plugins/types.ts";

const REGISTRATIONS: readonly PluginProtocolRegistration[] = [{
	kind: "command", name: "act", token: "command:act", description: "Run a command",
	input_schema: { type: "object", properties: {} },
}];
const SIGNAL = new AbortController().signal;

test("plugin recovery serves only new calls and concurrent callers share one replacement", async (t) => {
	const gate = Promise.withResolvers<void>();
	const replacement = new FakeHost(async () => gate.promise);
	const { host, first, created } = await failedHost(t, replacement);
	assert.deepEqual(first.calls, ["original"]);
	assert.equal(created.length, 1);
	const one = host.invoke("command:act", { id: "one" }, SIGNAL);
	const two = host.invoke("command:act", { id: "two" }, SIGNAL);
	await replacement.started.promise;
	assert.equal(created.length, 2);
	assert.equal(host.status, "starting");
	assert.deepEqual(replacement.calls, []);
	gate.resolve();
	await Promise.all([one, two]);
	assert.deepEqual(replacement.calls, ["one", "two"]);
	assert.deepEqual(first.calls, ["original"]);
	assert.equal(host.status, "ready");
	assert.equal(host.failure, undefined);
	let changes = 0;
	host.subscribe(() => { changes += 1; });
	await host.invoke("command:act", { id: "healthy" }, SIGNAL);
	assert.equal(changes, 0);
});

test("cancelling one recovery waiter preserves the other invocation", async (t) => {
	const gate = Promise.withResolvers<void>();
	const replacement = new FakeHost(async () => gate.promise);
	const { host } = await failedHost(t, replacement);
	const controller = new AbortController();
	const cancelled = host.invoke("command:act", { id: "cancelled" }, controller.signal);
	const rejected = assert.rejects(cancelled, { name: "AbortError" });
	const live = host.invoke("command:act", { id: "live" }, SIGNAL);
	await replacement.started.promise;
	controller.abort();
	await rejected;
	assert.equal(replacement.startSignal?.aborted, false);
	gate.resolve();
	await live;
	assert.deepEqual(replacement.calls, ["live"]);
});

test("last-waiter cancellation stops startup and a new caller waits for cleanup before recovering", async (t) => {
	const gate = Promise.withResolvers<void>();
	const abandoned = new FakeHost(async () => gate.promise);
	const replacement = new FakeHost();
	const { host, created } = await failedHost(t, abandoned, replacement);
	const controller = new AbortController();
	const cancelled = host.invoke("command:act", { id: "cancelled" }, controller.signal);
	const rejected = assert.rejects(cancelled, { name: "AbortError" });
	await abandoned.started.promise;
	controller.abort();
	await rejected;
	assert.equal(abandoned.startSignal?.aborted, true);
	const next = host.invoke("command:act", { id: "next" }, SIGNAL);
	gate.resolve();
	await next;
	assert.equal(created.length, 3);
	assert.ok(abandoned.closes > 0);
	assert.deepEqual(abandoned.calls, []);
	assert.deepEqual(replacement.calls, ["next"]);
});

test("close fences a pending recovery and never publishes a late ready status", async (t) => {
	const gate = Promise.withResolvers<void>();
	const replacement = new FakeHost(async () => gate.promise);
	const { host } = await failedHost(t, replacement);
	const states: PluginHostStatus[] = [];
	host.subscribe(() => states.push(host.status));
	const pending = host.invoke("command:act", { id: "cancelled" }, SIGNAL);
	const rejected = assert.rejects(pending, { name: "AbortError" });
	await replacement.started.promise;
	const closing = host.close();
	assert.equal(host.close(), closing);
	gate.resolve();
	await closing;
	await rejected;
	assert.deepEqual(replacement.calls, []);
	assert.equal(host.status, "closed");
	assert.equal(states.at(-1), "closed");
	assert.equal(states.includes("ready"), false);
	await assert.rejects(host.invoke("command:act", {}, SIGNAL), { kind: "host_closed" });
});

test("changed registrations block recovery permanently and retain one bounded cause", async (t) => {
	const replacement = new FakeHost();
	replacement.registrations = [{ ...REGISTRATIONS[0]!, input_schema: { type: "object", properties: { newInput: { type: "string" } } } }];
	const { host, created } = await failedHost(t, replacement);
	await assert.rejects(host.invoke("command:act", {}, SIGNAL), (error: unknown) => {
		assert.ok(error instanceof PluginHostError);
		assert.equal(error.kind, "registration_mismatch");
		assert.equal(error.evidence.phase, "reconnect");
		assert.equal(error.evidence.dispatched, false);
		assert.equal(error.evidence.recoveryAttempts, 1);
		assert.equal(error.evidence.previous?.kind, "worker_exited");
		return true;
	});
	await assert.rejects(host.invoke("command:act", {}, SIGNAL), { kind: "host_closed" });
	assert.equal(created.length, 2);
	assert.deepEqual(replacement.calls, []);
	assert.ok(replacement.closes > 0);
	assert.equal(host.status, "failed");
});

test("protocol corruption never triggers an automatic process replacement", async (t) => {
	const first = new FakeHost();
	first.nextFailure = new PluginHostError("protocol_invalid");
	let created = 0;
	const host = new RecoverablePluginHost(() => { created += 1; return first; });
	t.after(() => host.close());
	await assert.rejects(host.invoke("command:act", { id: "original" }, SIGNAL), { kind: "protocol_invalid" });
	await assert.rejects(host.invoke("command:act", { id: "new" }, SIGNAL), { kind: "host_closed" });
	assert.equal(created, 1);
	assert.deepEqual(first.calls, ["original"]);
});

test("failed replacement startup is not dispatched and may recover on a later invocation", async (t) => {
	const failed = new FakeHost(async () => { throw new PluginHostError("startup_timeout", { phase: "connect", timeoutMs: 500 }); });
	const replacement = new FakeHost();
	const { host } = await failedHost(t, failed, replacement);
	await assert.rejects(host.invoke("command:act", { id: "not-sent" }, SIGNAL), (error: unknown) => {
		assert.ok(error instanceof PluginHostError);
		assert.equal(error.kind, "startup_timeout");
		assert.equal(error.evidence.dispatched, false);
		assert.equal(error.evidence.previous?.evidence.exitCode, 91);
		return true;
	});
	await host.invoke("command:act", { id: "new" }, SIGNAL);
	assert.deepEqual(failed.calls, []);
	assert.deepEqual(replacement.calls, ["new"]);
});

async function failedHost(t: test.TestContext, ...replacements: FakeHost[]): Promise<{
	readonly host: RecoverablePluginHost; readonly first: FakeHost; readonly created: FakeHost[];
}> {
	const first = new FakeHost();
	first.nextFailure = new PluginHostError("worker_exited", { phase: "request", dispatched: true, exitCode: 91 });
	const queue = [first, ...replacements];
	const created: FakeHost[] = [];
	const host = new RecoverablePluginHost(() => {
		const child = queue.shift();
		assert.ok(child, "unexpected extra process replacement");
		created.push(child);
		return child;
	});
	t.after(() => host.close());
	await assert.rejects(host.invoke("command:act", { id: "original" }, SIGNAL), { kind: "worker_exited" });
	return { host, first, created };
}

class FakeHost implements PluginHostContract {
	status: PluginHostStatus = "idle";
	registrations = REGISTRATIONS;
	failure?: PluginHostError;
	nextFailure?: PluginHostError;
	readonly calls: unknown[] = [];
	readonly started = Promise.withResolvers<void>();
	startSignal?: AbortSignal;
	closes = 0;
	readonly #listeners = new Set<() => void>();
	readonly #initialize: (signal: AbortSignal) => Promise<void>;

	constructor(initialize: (signal: AbortSignal) => Promise<void> = async () => undefined) { this.#initialize = initialize; }

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => { this.#listeners.delete(listener); };
	}

	async start(signal: AbortSignal): Promise<readonly PluginProtocolRegistration[]> {
		if (this.status === "ready") return this.registrations;
		this.startSignal = signal;
		this.#status("starting");
		this.started.resolve();
		await this.#initialize(signal);
		signal.throwIfAborted();
		this.#status("ready");
		return this.registrations;
	}

	async invoke(_target: string, input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<PluginInvocationResult> {
		signal.throwIfAborted();
		assert.equal(this.status, "ready");
		this.calls.push(input.id);
		if (this.nextFailure) {
			this.failure = this.nextFailure;
			this.#status("failed");
			throw this.failure;
		}
		return { ok: true, resultType: "command_result", value: { ok: true } };
	}

	async close(): Promise<void> { this.closes += 1; this.#status("closed"); }
	#status(status: PluginHostStatus): void {
		this.status = status;
		for (const listener of this.#listeners) listener();
	}
}
