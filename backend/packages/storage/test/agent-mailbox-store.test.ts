import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	agentMailboxDedupeKey,
	agentThreadId,
	parseAgentPath,
} from "@mycli/core";
import { SQLiteSessionStore, StorageFailure } from "../src/index.ts";

const CREATED = "2026-08-08T00:00:00.000Z";
const QUEUED = "2026-08-08T00:00:01.000Z";
const COMMITTED = "2026-08-08T00:00:02.000Z";

test("persists receiver-local ordering and multiline payloads independently", async (t) => {
	const fixture = await storeFixture(t);
	const first = fixture.store.agentMailbox.enqueue(messageInput("call-1", "receiver-a", "first\nline"));
	const other = fixture.store.agentMailbox.enqueue(messageInput("call-2", "receiver-b", "other"));
	const second = fixture.store.agentMailbox.enqueue(messageInput("call-3", "receiver-a", "second"));

	assert.equal(first.item.receiverSequence, 1);
	assert.equal(other.item.receiverSequence, 1);
	assert.equal(second.item.receiverSequence, 2);
	assert.deepEqual(
		fixture.store.agentMailbox.list({ receiverThreadId: "receiver-a" })
			.map((item) => [item.receiverSequence, item.payload.kind === "message" ? item.payload.text : ""]),
		[[1, "first\nline"], [2, "second"]],
	);
	assert.equal(first.item.queueId, first.item.messageId);
});

test("deduplicates a logical delivery and rejects a conflicting retry", async (t) => {
	const fixture = await storeFixture(t);
	const input = messageInput("call-1", "receiver-a", "deliver once");
	const first = fixture.store.agentMailbox.enqueue(input);
	const duplicate = fixture.store.agentMailbox.enqueue({ ...input });

	assert.equal(first.disposition, "enqueued");
	assert.equal(duplicate.disposition, "duplicate");
	assert.deepEqual(duplicate.item, first.item);
	assert.equal(fixture.store.agentMailbox.list({ receiverThreadId: "receiver-a" }).length, 1);
	assert.throws(
		() => fixture.store.agentMailbox.enqueue({
			...input,
			payload: { kind: "message", text: "conflicting payload" },
		}),
		StorageFailure,
	);
	assert.equal(fixture.store.agentMailbox.list({ receiverThreadId: "receiver-a" }).length, 1);
});

test("persists ordered delivery transitions idempotently", async (t) => {
	const fixture = await storeFixture(t);
	const inserted = fixture.store.agentMailbox.enqueue(completionInput());
	assert.equal(inserted.item.state, "pending");
	assert.equal(inserted.item.queuedAt, undefined);

	const queued = fixture.store.agentMailbox.transition({
		messageId: inserted.item.messageId,
		state: "queued",
	});
	assert.equal(queued.state, "queued");
	assert.equal(queued.queuedAt, QUEUED);
	assert.deepEqual(fixture.store.agentMailbox.transition({
		messageId: inserted.item.messageId,
		state: "queued",
	}), queued);

	const committed = fixture.store.agentMailbox.transition({
		messageId: inserted.item.messageId,
		state: "committed",
	});
	assert.equal(committed.state, "committed");
	assert.equal(committed.queuedAt, QUEUED);
	assert.equal(committed.committedAt, COMMITTED);
	assert.throws(() => fixture.store.agentMailbox.transition({
		messageId: inserted.item.messageId,
		state: "queued",
	}), StorageFailure);
	assert.deepEqual(
		fixture.store.agentMailbox.list({
			receiverThreadId: "root-thread",
			states: ["committed"],
		}),
		[committed],
	);
});

test("reloads durable mailbox metadata without renumbering or duplicating", async (t) => {
	const fixture = await storeFixture(t);
	const input = messageInput("call-reload", "receiver-a", "survive restart");
	const inserted = fixture.store.agentMailbox.enqueue(input).item;
	fixture.store.close();

	const reopened = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: () => COMMITTED });
	t.after(() => reopened.close());
	assert.deepEqual(reopened.agentMailbox.get(inserted.messageId), inserted);
	const duplicate = reopened.agentMailbox.enqueue(input);
	assert.equal(duplicate.disposition, "duplicate");
	assert.equal(duplicate.item.receiverSequence, 1);
	const next = reopened.agentMailbox.enqueue(messageInput("call-next", "receiver-a", "next"));
	assert.equal(next.item.receiverSequence, 2);
});

function messageInput(logicalId: string, receiverThreadId: string, text: string) {
	const rootThreadId = agentThreadId("root-thread");
	const senderThreadId = agentThreadId("sender-thread");
	const receiver = agentThreadId(receiverThreadId);
	return {
		rootThreadId,
		senderThreadId,
		senderPath: parseAgentPath("/root/sender"),
		receiverThreadId: receiver,
		receiverPath: parseAgentPath(`/root/${receiverThreadId}`),
		receiverSessionId: `session-${receiverThreadId}`,
		triggerMode: "queue_only" as const,
		sourceCallId: logicalId,
		dedupeKey: agentMailboxDedupeKey({
			namespace: "coordination_call",
			rootThreadId,
			senderThreadId,
			receiverThreadId: receiver,
			logicalId,
		}),
		payload: { kind: "message" as const, text },
	};
}

function completionInput() {
	const rootThreadId = agentThreadId("root-thread");
	const senderThreadId = agentThreadId("child-thread");
	return {
		rootThreadId,
		senderThreadId,
		senderPath: parseAgentPath("/root/child"),
		receiverThreadId: rootThreadId,
		receiverPath: parseAgentPath("/root"),
		receiverSessionId: "root-session",
		triggerMode: "queue_only" as const,
		dedupeKey: agentMailboxDedupeKey({
			namespace: "terminal_completion",
			rootThreadId,
			senderThreadId,
			receiverThreadId: rootThreadId,
			logicalId: "child-thread",
		}),
		payload: {
			kind: "completion" as const,
			status: "completed" as const,
			report: "child finished",
			outputReference: "tasks/child/output.txt",
		},
	};
}

async function storeFixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "mycli-agent-mailbox-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dbPath = join(root, "sessions.db");
	const timestamps = [CREATED, QUEUED, COMMITTED];
	let index = 0;
	const store = new SQLiteSessionStore({
		dbPath,
		clock: () => timestamps[Math.min(index++, timestamps.length - 1)] ?? COMMITTED,
	});
	t.after(() => {
		try {
			store.close();
		} catch {
			// A restart test closes the initial store before reopening it.
		}
	});
	return { root, dbPath, store };
}
