import assert from "node:assert/strict";
import test from "node:test";
import {
	AgentCapacityError,
	AgentDepthError,
	parseAgentPath,
	rootAgentPath,
} from "@mycli/core";
import { AgentScheduler } from "../src/index.ts";

test("scheduler counts root and reserves the final resident slot atomically", () => {
	const scheduler = new AgentScheduler({ maxResidents: 2 });
	assert.equal(scheduler.residentCount(), 1);
	assert.deepEqual(scheduler.reserve("child-1"), { threadId: "child-1" });
	assert.throws(() => scheduler.reserve("child-2"), AgentCapacityError);
	assert.equal(scheduler.residentCount(), 2);
	assert.equal(scheduler.release("child-1"), true);
	assert.deepEqual(scheduler.reserve("child-2"), { threadId: "child-2" });
});

test("scheduler evicts only the least-recent idle unprotected resident", () => {
	const scheduler = new AgentScheduler({ maxResidents: 3 });
	scheduler.reserve("idle-old");
	scheduler.reserve("idle-new");
	assert.deepEqual(scheduler.reserve("next", [
		{ threadId: "running", status: "running", lastActiveAt: "2026-01-01T00:00:00Z" },
		{ threadId: "idle-new", status: "idle", lastActiveAt: "2026-01-03T00:00:00Z" },
		{ threadId: "idle-old", status: "idle", lastActiveAt: "2026-01-02T00:00:00Z" },
	]), { threadId: "next", evictThreadId: "idle-old" });
	assert.equal(scheduler.has("idle-old"), false);
	assert.equal(scheduler.has("idle-new"), true);

	const protectedOnly = new AgentScheduler({ maxResidents: 2 });
	protectedOnly.reserve("protected");
	assert.throws(() => protectedOnly.reserve("blocked", [
		{
			threadId: "protected",
			status: "idle",
			lastActiveAt: "2026-01-01T00:00:00Z",
			protected: true,
		},
	]), AgentCapacityError);
	assert.throws(() => protectedOnly.reserve("waiting", [
		{ threadId: "protected", status: "waiting", lastActiveAt: "2026-01-01T00:00:00Z" },
	]), AgentCapacityError);
});

test("scheduler rejects descendants beyond the configured depth", () => {
	const scheduler = new AgentScheduler({ maxDepth: 1 });
	assert.doesNotThrow(() => scheduler.assertChildDepth(rootAgentPath()));
	assert.throws(
		() => scheduler.assertChildDepth(parseAgentPath("/root/child")),
		AgentDepthError,
	);
});
