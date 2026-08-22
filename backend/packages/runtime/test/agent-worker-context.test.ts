import assert from "node:assert/strict";
import test from "node:test";
import { modelInputSha256 } from "@mycli/core";
import {
	AGENT_WORKER_SNAPSHOT_CACHE_MAX_BYTES,
	AGENT_WORKER_SNAPSHOT_CACHE_MAX_ENTRIES,
	AgentWorkerContextError,
	AgentWorkerContextState,
	ImmutableAgentSnapshotCache,
	type AgentContextBootstrap,
} from "../src/index.ts";

test("installs one bootstrap and applies only contiguous same-window deltas", () => {
	const state = new AgentWorkerContextState();
	const initial = bootstrap();
	state.bootstrap(initial, { providerApiKey: "secret" });
	assert.equal(state.hasSecrets(), true);
	assert.deepEqual(state.snapshot().conversation, initial.conversation);

	assert.throws(() => state.applyDelta({
		kind: "append",
		jobId: "job-1",
		base: { windowId: "window-1", version: 0 },
		next: { windowId: "window-1", version: 2 },
		items: [],
		logicalInputSha256: modelInputSha256("gap"),
	}), AgentWorkerContextError);

	const appended = { type: "assistant" as const, text: "done" };
	state.applyDelta({
		kind: "append",
		jobId: "job-1",
		base: { windowId: "window-1", version: 0 },
		next: { windowId: "window-1", version: 1 },
		items: [appended],
		logicalInputSha256: modelInputSha256("next"),
	});
	assert.deepEqual(state.snapshot().conversation, [...initial.conversation, appended]);
	assert.equal(state.snapshot().position.version, 1);
	assert.throws(() => state.applyDelta({
		kind: "append",
		jobId: "job-1",
		base: { windowId: "window-1", version: 0 },
		next: { windowId: "window-1", version: 1 },
		items: [],
		logicalInputSha256: modelInputSha256("duplicate"),
	}), AgentWorkerContextError);
});

test("replaces a timeline with a distinct window and rejects the previous base", () => {
	const state = new AgentWorkerContextState();
	state.bootstrap(bootstrap());
	const replacement = bootstrap({
		position: { windowId: "window-2", version: 7 },
		conversation: [{ type: "user", text: "compacted" }],
		logicalInputSha256: modelInputSha256("replacement"),
	});
	state.applyDelta({
		kind: "replace",
		jobId: "job-1",
		base: { windowId: "window-1", version: 0 },
		bootstrap: replacement,
	});
	assert.deepEqual(state.snapshot().position, { windowId: "window-2", version: 7 });
	assert.deepEqual(state.snapshot().conversation, replacement.conversation);
	assert.throws(() => state.applyDelta({
		kind: "append",
		jobId: "job-1",
		base: { windowId: "window-1", version: 0 },
		next: { windowId: "window-1", version: 1 },
		items: [],
		logicalInputSha256: modelInputSha256("stale"),
	}), AgentWorkerContextError);
});

test("clears conversation and job secrets on release while retaining immutable snapshots", () => {
	const state = new AgentWorkerContextState();
	state.bootstrap(bootstrap(), { providerAuthToken: "secret" });
	assert.equal(state.cacheStats().entries, 2);
	state.release();
	assert.equal(state.hasSecrets(), false);
	assert.throws(() => state.snapshot(), AgentWorkerContextError);
	assert.equal(state.cacheStats().entries, 2);

	state.bootstrap(bootstrap({ jobId: "job-2" }));
	assert.equal(state.cacheStats().entries, 2);
	assert.equal(state.cacheStats().maxEntries, AGENT_WORKER_SNAPSHOT_CACHE_MAX_ENTRIES);
	assert.equal(state.cacheStats().maxBytes, AGENT_WORKER_SNAPSHOT_CACHE_MAX_BYTES);
});

test("verifies snapshot hashes and enforces deterministic LRU bounds", () => {
	const cache = new ImmutableAgentSnapshotCache({ maxEntries: 2, maxBytes: 1_024 });
	const first = { value: "first" };
	const second = { value: "second" };
	const third = { value: "third" };
	const firstHash = modelInputSha256(first);
	const secondHash = modelInputSha256(second);
	const thirdHash = modelInputSha256(third);

	cache.put(firstHash, first);
	cache.put(secondHash, second);
	assert.deepEqual(cache.get(firstHash), first);
	cache.put(thirdHash, third);
	assert.equal(cache.get(secondHash), undefined);
	assert.deepEqual(cache.get(firstHash), first);
	assert.deepEqual(cache.get(thirdHash), third);
	assert.throws(() => cache.put(firstHash, { value: "changed" }), AgentWorkerContextError);
});

function bootstrap(
	overrides: Partial<AgentContextBootstrap> = {},
): AgentContextBootstrap {
	const instructions = "You are mycli.";
	const tools = Object.freeze([]);
	return Object.freeze({
		jobId: "job-1",
		position: Object.freeze({ windowId: "window-1", version: 0 }),
		instructionSnapshot: Object.freeze({
			snapshotId: "instructions-1",
			version: "v1",
			source: "test",
			content: instructions,
			contentSha256: modelInputSha256(instructions),
			createdAt: "2026-08-12T00:00:00.000Z",
		}),
		toolSetSnapshot: Object.freeze({
			snapshotId: "tools-1",
			tools,
			contentSha256: modelInputSha256(tools),
			createdAt: "2026-08-12T00:00:00.000Z",
		}),
		conversation: Object.freeze([{ type: "user" as const, text: "hello" }]),
		logicalInputSha256: modelInputSha256("initial"),
		...overrides,
	});
}
