import assert from "node:assert/strict";
import test from "node:test";
import { agentThreadId } from "@mycli/core";
import { AgentActivityBus } from "../../src/index.ts";

const NOW = "2026-08-08T00:00:00.000Z";

test("wakes only the matching root subscription for lifecycle activity", async () => {
	const bus = new AgentActivityBus();
	const controller = new AbortController();
	const waiting = bus.wait({
		rootThreadId: "root-a",
		timeoutMs: 1_000,
		signal: controller.signal,
	});
	bus.publish({
		kind: "mailbox",
		rootThreadId: agentThreadId("root-b"),
		threadId: agentThreadId("child-b"),
		occurredAt: NOW,
	});
	bus.publish({
		kind: "completion",
		rootThreadId: agentThreadId("root-a"),
		threadId: agentThreadId("child-a"),
		occurredAt: NOW,
	});

	assert.deepEqual(await waiting, {
		kind: "activity",
		event: {
			kind: "completion",
			rootThreadId: "root-a",
			threadId: "child-a",
			occurredAt: NOW,
		},
	});
});

test("times out and releases an abortable activity subscription", async () => {
	const bus = new AgentActivityBus();
	assert.deepEqual(await bus.wait({
		rootThreadId: "root-a",
		timeoutMs: 5,
		signal: new AbortController().signal,
	}), { kind: "timeout" });

	const controller = new AbortController();
	const interrupted = bus.wait({
		rootThreadId: "root-a",
		timeoutMs: 1_000,
		signal: controller.signal,
	});
	controller.abort();
	await assert.rejects(interrupted, { name: "AbortError", message: "interrupted" });
	assert.doesNotThrow(() => bus.publish({
		kind: "lifecycle",
		rootThreadId: agentThreadId("root-a"),
		threadId: agentThreadId("child-a"),
		occurredAt: NOW,
	}));
});
