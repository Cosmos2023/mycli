import assert from "node:assert/strict";
import test from "node:test";
import {
	NodeBackendResourceOwner,
	SerializedSessionArtifactQueue,
} from "../src/node-runtime/node-runtime-resources.ts";
import { NodeRuntimeRegistry } from "../src/node-runtime/node-runtime-registry.ts";

test("runtime registry refreshes a stable snapshot and removes only the expected owner", () => {
	const refreshed: string[] = [];
	const first = { refreshExtensions: () => { refreshed.push("first"); } };
	const second = { refreshExtensions: () => { refreshed.push("second"); } };
	const registry = new NodeRuntimeRegistry<typeof first>();

	registry.set("session", first);
	registry.set("session", second);
	assert.equal(registry.delete("session", first), false);
	assert.equal(registry.get("session"), second);
	registry.refreshExtensions();
	assert.deepEqual(refreshed, ["second"]);
	assert.equal(registry.delete("session", second), true);
	assert.equal(registry.get("session"), undefined);
});

test("runtime preparation coalesces per session while other sessions prepare independently", async () => {
	const registry = new NodeRuntimeRegistry<{ closeExtensions(): Promise<void> }>();
	const pending = Promise.withResolvers<{ closeExtensions(): Promise<void> }>();
	const closed: string[] = [];
	const a = { closeExtensions: async () => { closed.push("a"); } };
	const b = { closeExtensions: async () => { closed.push("b"); } };
	const first = registry.getOrCreate("a", () => pending.promise);
	const second = registry.getOrCreate("a", async () => assert.fail("duplicate startup"));
	assert.equal(first, second);
	assert.equal(await registry.getOrCreate("b", async () => b), b);
	pending.resolve(a);
	assert.equal(await first, a);
	assert.equal(await registry.getOrCreate("a", async () => assert.fail("duplicate resume")), a);
	await registry.dispose("a", a);
	const replacement = { closeExtensions: async () => undefined };
	await registry.getOrCreate("a", async () => replacement);
	await registry.dispose("a", a);
	assert.equal(registry.get("a"), replacement, "stale close must leave the replacement registered");
	assert.equal(registry.get("b"), b);
	await registry.close();
	assert.ok(closed.includes("b"));
});

test("failed preparation retries and shutdown fences a late successful startup", async () => {
	const registry = new NodeRuntimeRegistry<{ closeExtensions(): Promise<void> }>();
	await assert.rejects(registry.getOrCreate("session", async () => { throw new Error("startup failed"); }));
	const started = Promise.withResolvers<AbortSignal>();
	const release = Promise.withResolvers<void>();
	let closed = 0;
	const pending = registry.getOrCreate("session", async (signal) => {
		started.resolve(signal);
		await release.promise;
		return { closeExtensions: async () => { closed += 1; } };
	});
	const rejected = assert.rejects(pending, { name: "AbortError" });
	const signal = await started.promise;
	const closing = registry.close();
	assert.equal(registry.close(), closing);
	assert.equal(signal.aborted, true);
	await assert.rejects(registry.getOrCreate("later", async () => assert.fail("late startup")));
	release.resolve();
	await Promise.all([closing, rejected]);
	assert.equal(closed, 1);
	assert.equal(registry.get("session"), undefined);
});

test("runtime shutdown closes every session even if one close fails", async () => {
	const registry = new NodeRuntimeRegistry<{ closeExtensions(): Promise<void> }>();
	let secondClosed = false;
	registry.set("a", { closeExtensions: async () => { throw new Error("close failed"); } });
	registry.set("b", { closeExtensions: async () => { secondClosed = true; } });
	await assert.rejects(registry.close(), /close failed/u);
	assert.equal(secondClosed, true);
	assert.equal(registry.get("a"), undefined);
	assert.equal(registry.get("b"), undefined);
});

test("backend resource owner closes every resource once in dependency order", async () => {
	const closed: string[] = [];
	let releaseUpdate!: () => void;
	const updateReleased = new Promise<void>((resolve) => { releaseUpdate = resolve; });
	const owner = new NodeBackendResourceOwner({
		closeUpdateCache: async () => {
			closed.push("update:start");
			await updateReleased;
			closed.push("update:end");
		},
		closeAgentWorkers: async () => { closed.push("workers"); },
		closeShellManager: async () => { closed.push("shell"); },
		drainShellLifecycle: async () => { closed.push("shell-lifecycle"); },
		drainArtifacts: async () => { closed.push("artifacts"); },
		closeStore: () => { closed.push("store"); },
	});
	owner.bindIntegration(async () => { closed.push("integrations"); });

	const first = owner.close();
	const second = owner.close();
	assert.equal(first, second);
	await Promise.resolve();
	assert.deepEqual(closed, ["update:start"]);
	releaseUpdate();
	await first;
	assert.deepEqual(closed, [
		"update:start",
		"update:end",
		"integrations",
		"workers",
		"shell",
		"shell-lifecycle",
		"artifacts",
		"store",
	]);
	await owner.close();
	assert.equal(closed.filter((entry) => entry === "store").length, 1);
});

test("backend resource owner continues cleanup after an earlier failure", async () => {
	const closed: string[] = [];
	const owner = new NodeBackendResourceOwner({
		closeUpdateCache: async () => {
			closed.push("update");
			throw new Error("update failed");
		},
		closeShellManager: async () => { closed.push("shell"); },
		drainShellLifecycle: async () => { closed.push("shell-lifecycle"); },
		drainArtifacts: async () => { closed.push("artifacts"); },
		closeStore: () => { closed.push("store"); },
	});

	await assert.rejects(owner.close(), /update failed/u);
	assert.deepEqual(closed, ["update", "shell", "shell-lifecycle", "artifacts", "store"]);
});

test("artifact queue serializes writes and drains the accepted prefix", async () => {
	const queue = new SerializedSessionArtifactQueue();
	const trace: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const first = queue.run(async () => {
		trace.push("first:start");
		await gate;
		trace.push("first:end");
	});
	const second = queue.run(async () => { trace.push("second"); });
	const draining = queue.close();
	await Promise.resolve();
	assert.deepEqual(trace, ["first:start"]);
	assert.throws(() => queue.run(async () => undefined), /artifact queue is closing/u);
	release();
	await Promise.all([first, second, draining]);
	assert.deepEqual(trace, ["first:start", "first:end", "second"]);
	assert.equal(queue.close(), draining);
});
