import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { removeFixtureDirectoryAfterTests } from "../../../storage/test/fixtures/directory-cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	agentThreadId,
	parseAgentPath,
	rootAgentPath,
	type AgentCommunicationEvent,
	type AgentSpawnConfigSnapshot,
	type QueueSnapshot,
	type QueuedInput,
} from "@mycli/core";
import { SQLiteSessionStore } from "@mycli/storage";
import {
	AgentMailbox,
	AgentMailboxTargetError,
	QueueCoordinator,
	type AgentMailboxEndpoint,
	type QueueCoordinatorStore,
} from "../../src/index.ts";

const NOW = "2026-08-08T00:00:00.000Z";

test("delivers ordered sibling messages to a loaded receiver queue", async (t) => {
	const events: AgentCommunicationEvent[] = [];
	const fixture = await mailboxFixture(t, { onEvent: (event) => { events.push(event); } });
	const first = await fixture.mailbox.send({
		sender: fixture.endpoint("sender"),
		root: fixture.rootEndpoint,
		target: "/root/receiver",
		triggerMode: "queue_only",
		logicalId: "call-1",
		sourceCallId: "call-1",
		payload: { kind: "message", text: "first\nmessage" },
	});
	const second = await fixture.mailbox.send({
		sender: fixture.rootEndpoint,
		root: fixture.rootEndpoint,
		target: "receiver",
		triggerMode: "queue_only",
		logicalId: "call-2",
		sourceCallId: "call-2",
		payload: { kind: "message", text: "second" },
	});

	assert.equal(first.projected, true);
	assert.equal(second.item.receiverSequence, 2);
	assert.deepEqual(
		fixture.queue("receiver").snapshot().pendingSteers.map((item) => [item.queueId, item.source]),
		[[first.item.queueId, "agent_mailbox"], [second.item.queueId, "agent_mailbox"]],
	);
	assert.match(fixture.queue("receiver").snapshot().pendingSteers[0]?.text ?? "", /first\\nmessage/u);
	assert.deepEqual(events.map((event) => event.kind), [
		"message_queued",
		"message_delivered",
		"message_queued",
		"message_delivered",
	]);
	assert.equal(events[0]?.receiverSequence, 1);
	assert.equal(events[2]?.receiverSequence, 2);
	assert.equal(JSON.stringify(events).includes("first\\nmessage"), false);
});

test("keeps mail durable for an unloaded receiver and repairs it idempotently", async (t) => {
	const fixture = await mailboxFixture(t, { loaded: [] });
	const sent = await fixture.mailbox.send({
		sender: fixture.rootEndpoint,
		root: fixture.rootEndpoint,
		target: "receiver",
		triggerMode: "queue_only",
		logicalId: "call-unloaded",
		payload: { kind: "message", text: "wait durably" },
	});
	assert.equal(sent.projected, false);
	assert.equal(fixture.store.agentMailbox.get(sent.item.messageId)?.state, "pending");

	fixture.loadQueue("receiver");
	const repaired = fixture.mailbox.repair(fixture.endpoint("receiver"));
	const repeated = fixture.mailbox.repair(fixture.endpoint("receiver"));
	assert.equal(repaired.repairedCount, 1);
	assert.equal(repeated.repairedCount, 1);
	assert.equal(fixture.queue("receiver").snapshot().pendingSteers.length, 1);
	assert.equal(fixture.store.agentMailbox.get(sent.item.messageId)?.state, "queued");

	const committed = fixture.queue("receiver").commitPending("turn-1");
	assert.equal(fixture.mailbox.markQueueRecordsCommitted(committed), 1);
	assert.equal(fixture.store.agentMailbox.get(sent.item.messageId)?.state, "committed");
	assert.equal(fixture.mailbox.repair(fixture.endpoint("receiver")).repairedCount, 0);
});

test("deduplicates recovery when the receiver queue already committed the message", async (t) => {
	const fixture = await mailboxFixture(t);
	const sent = await fixture.mailbox.send({
		sender: fixture.rootEndpoint,
		root: fixture.rootEndpoint,
		target: "receiver",
		triggerMode: "queue_only",
		logicalId: "call-committed",
		payload: { kind: "message", text: "already consumed" },
	});
	fixture.queue("receiver").commitPending("turn-1");

	const repaired = fixture.mailbox.repair(fixture.endpoint("receiver"));
	assert.equal(repaired.committedCount, 1);
	assert.equal(fixture.store.agentMailbox.get(sent.item.messageId)?.state, "committed");
	assert.equal(fixture.queue("receiver").snapshot().pendingSteers.length, 0);
});

test("resolves only unambiguous same-root targets", async (t) => {
	const fixture = await mailboxFixture(t);
	fixture.reserve("alpha", "alpha", "/root");
	fixture.reserve("beta", "beta", "/root");
	fixture.reserve("alpha-review", "review", "/root/alpha", "alpha");
	fixture.reserve("beta-review", "review", "/root/beta", "beta");
	fixture.reserve("outside", "outside", "/root", "other-root", "other-root");

	await assert.rejects(() => fixture.mailbox.send({
		sender: fixture.rootEndpoint,
		root: fixture.rootEndpoint,
		target: "review",
		triggerMode: "queue_only",
		logicalId: "ambiguous",
		payload: { kind: "message", text: "no" },
	}), (error) => error instanceof AgentMailboxTargetError
		&& error.code === "agent_target_ambiguous");
	await assert.rejects(() => fixture.mailbox.send({
		sender: fixture.rootEndpoint,
		root: fixture.rootEndpoint,
		target: "outside",
		triggerMode: "queue_only",
		logicalId: "forbidden",
		payload: { kind: "message", text: "no" },
	}), (error) => error instanceof AgentMailboxTargetError
		&& error.code === "agent_target_forbidden");
	await assert.rejects(() => fixture.mailbox.send({
		sender: fixture.rootEndpoint,
		root: fixture.rootEndpoint,
		target: "/root/missing",
		triggerMode: "queue_only",
		logicalId: "missing",
		payload: { kind: "message", text: "no" },
	}), (error) => error instanceof AgentMailboxTargetError
		&& error.code === "agent_target_not_found");
	assert.equal(fixture.store.agentMailbox.list({ receiverThreadId: "receiver" }).length, 0);
});

test("requests a receiver trigger only for follow-up delivery", async (t) => {
	const triggered: string[] = [];
	const fixture = await mailboxFixture(t, {
		loaded: [],
		triggerReceiver: (receiver) => { triggered.push(receiver.threadId); },
	});
	await fixture.mailbox.send({
		sender: fixture.rootEndpoint,
		root: fixture.rootEndpoint,
		target: "receiver",
		triggerMode: "queue_only",
		logicalId: "queue-only",
		payload: { kind: "message", text: "queue" },
	});
	const followUp = {
		sender: fixture.rootEndpoint,
		root: fixture.rootEndpoint,
		target: "receiver",
		triggerMode: "follow_up" as const,
		logicalId: "follow-up",
		payload: { kind: "message", text: "run" },
	} as const;
	await fixture.mailbox.send(followUp);
	const duplicate = await fixture.mailbox.send(followUp);
	assert.deepEqual(triggered, ["receiver"]);
	assert.equal(duplicate.disposition, "duplicate");
});

async function mailboxFixture(t: test.TestContext, options: {
	readonly loaded?: readonly string[];
	readonly triggerReceiver?: (receiver: AgentMailboxEndpoint) => void;
	readonly onEvent?: (event: AgentCommunicationEvent) => void;
} = {}) {
	const root = await mkdtemp(join(tmpdir(), "mycli-agent-mailbox-runtime-"));
	removeFixtureDirectoryAfterTests(t, root);
	const store = new SQLiteSessionStore({ dbPath: join(root, "sessions.db"), clock: () => NOW });
	t.after(() => store.close());
	const rootEndpoint: AgentMailboxEndpoint = Object.freeze({
		threadId: agentThreadId("root-thread"),
		rootThreadId: agentThreadId("root-thread"),
		path: rootAgentPath(),
		sessionId: "root-session",
	});
	const queues = new Map<string, ReturnType<typeof queueFixture>>();
	const reserve = (
		threadId: string,
		taskName: string,
		parentPath: string,
		parentThreadId = "root-thread",
		rootThreadId = "root-thread",
	) => store.agentThreads.reserve({
		threadId,
		rootThreadId,
		parentThreadId,
		parentPath: parseAgentPath(parentPath),
		taskName,
		profileId: "subagent",
		spawnConfig: spawnConfig(),
	});
	reserve("sender", "sender", "/root");
	reserve("receiver", "receiver", "/root");
	const loadQueue = (threadId: string): QueueCoordinator => {
		const existing = queues.get(threadId);
		if (existing) return existing.queue;
		const created = queueFixture(threadId);
		queues.set(threadId, created);
		return created.queue;
	};
	for (const threadId of options.loaded ?? ["receiver"]) loadQueue(threadId);
	const mailbox = new AgentMailbox({
		store: store.agentMailbox,
		threadStore: store.agentThreads,
		queueForSession: (sessionId) => queues.get(sessionId)?.queue,
		committedQueueIds: (sessionId) => queues.get(sessionId)?.committed ?? new Set(),
		...(options.triggerReceiver ? { triggerReceiver: options.triggerReceiver } : {}),
		...(options.onEvent ? { onEvent: options.onEvent } : {}),
		createEventId: (() => {
			let index = 0;
			return () => `mailbox-event-${++index}`;
		})(),
		clock: () => NOW,
	});
	const endpoint = (threadId: string): AgentMailboxEndpoint => {
		if (threadId === "root-thread") return rootEndpoint;
		const record = store.agentThreads.get(threadId);
		if (!record) throw new Error(`missing test agent ${threadId}`);
		return Object.freeze({
			threadId: record.threadId,
			rootThreadId: record.rootThreadId,
			path: record.path,
			sessionId: record.threadId,
		});
	};
	return {
		store,
		mailbox,
		rootEndpoint,
		reserve,
		loadQueue,
		queue: (threadId: string) => {
			const queue = queues.get(threadId)?.queue;
			if (!queue) throw new Error(`queue ${threadId} is not loaded`);
			return queue;
		},
		endpoint,
	};
}

function queueFixture(sessionId: string) {
	let durable = emptyQueue(sessionId);
	const committed = new Set<string>();
	const store: QueueCoordinatorStore = {
		loadCommittedQueueIds: () => new Set(committed),
		saveSnapshot: (snapshot) => { durable = snapshot; },
		commitPending: (_turnId, records) => {
			for (const record of records) committed.add(record.queueId);
			const ids = new Set(records.map((record) => record.queueId));
			durable = Object.freeze({
				...durable,
				revision: durable.revision + 1,
				pendingSteers: Object.freeze(durable.pendingSteers.filter(
					(record) => !ids.has(record.queueId),
				)),
			});
			return durable;
		},
	};
	return {
		committed,
		queue: new QueueCoordinator({
			initial: durable,
			store,
			activeTurnId: null,
			createQueueId: () => "unused",
			clock: () => NOW,
		}),
	};
}

function emptyQueue(sessionId: string): QueueSnapshot {
	return Object.freeze({
		sessionId,
		revision: 0,
		pendingSteers: Object.freeze([]) as readonly QueuedInput[],
		rejectedSteers: Object.freeze([]) as readonly QueuedInput[],
		followUps: Object.freeze([]) as readonly QueuedInput[],
	});
}

function spawnConfig(): AgentSpawnConfigSnapshot {
	return {
		workspaceRoot: "/workspace",
		cwd: "/workspace",
		environment: {},
		executionPolicy: {
			trusted: true,
			permission: "workspace",
			sandboxMode: "workspace-write",
			filesystem: "workspace_write",
			network: "disabled",
			writableRoots: ["/workspace"],
		},
		provider: { provider: "openai", protocol: "responses", model: "test-model" },
		instructions: { project: "test" },
		tools: ["Read"],
		forkTurns: "none",
	};
}
