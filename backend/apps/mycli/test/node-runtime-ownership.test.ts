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
