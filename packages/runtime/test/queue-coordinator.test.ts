import assert from "node:assert/strict";
import test from "node:test";
import {
	QueueCapacityError,
	QueueConflictError,
	type QueueSnapshot,
	type QueuedInput,
} from "@mycli/core";
import { StorageFailure } from "@mycli/storage";
import {
	QueueCoordinator,
	type QueueCoordinatorStore,
} from "../src/index.ts";

const NOW = "2026-08-04T00:00:00.000Z";

test("does not publish or mutate a queue revision before persistence", () => {
	const fixture = coordinatorFixture({ failSave: true });

	assert.throws(
		() => fixture.coordinator.enqueueFollowUp({
			clientTurnId: "client-follow",
			text: "continue later",
		}),
		StorageFailure,
	);

	assert.equal(fixture.coordinator.snapshot().revision, 0);
	assert.deepEqual(fixture.events, []);
});

test("commits accepted steers to canonical history exactly once", () => {
	const fixture = coordinatorFixture();
	fixture.coordinator.enqueueSteer({
		clientTurnId: "client-steer",
		expectedTurnId: "turn-1",
		activeTurnId: "turn-1",
		steerable: true,
		text: "inspect result",
	});

	const first = fixture.coordinator.commitPending("turn-1");
	const second = fixture.coordinator.commitPending("turn-1");

	assert.equal(first.length, 1);
	assert.deepEqual(second, []);
	assert.deepEqual(fixture.history, ["queue-1"]);
	assert.equal(fixture.coordinator.snapshot().pendingSteers.length, 0);
});

test("restore removes committed records and rejects stale pending steers without publishing", () => {
	const initial: QueueSnapshot = Object.freeze({
		sessionId: "session-1",
		revision: 3,
		pendingSteers: Object.freeze([
			record("queue-committed", "pending_steer", "turn-old"),
			record("queue-stale", "pending_steer", "turn-old"),
		]),
		rejectedSteers: Object.freeze([]),
		followUps: Object.freeze([]),
	});
	const fixture = coordinatorFixture({
		initial,
		committedQueueIds: new Set(["queue-committed"]),
		activeTurnId: null,
	});

	assert.equal(fixture.coordinator.snapshot().revision, 4);
	assert.deepEqual(
		fixture.coordinator.snapshot().rejectedSteers.map((item) => item.queueId),
		["queue-stale"],
	);
	assert.deepEqual(fixture.savedRevisions, [4]);
	assert.deepEqual(fixture.events, []);
});

test("terminal rejection persists while interruption can retain pending steers", () => {
	const fixture = coordinatorFixture();
	fixture.coordinator.enqueueSteer({
		clientTurnId: "client-steer",
		expectedTurnId: "turn-1",
		activeTurnId: "turn-1",
		steerable: true,
		text: "inspect result",
	});
	const beforeInterrupt = fixture.coordinator.snapshot();

	assert.strictEqual(fixture.coordinator.snapshot(), beforeInterrupt);
	const rejected = fixture.coordinator.rejectPending("turn-1");

	assert.equal(rejected.pendingSteers.length, 0);
	assert.equal(rejected.rejectedSteers[0]?.kind, "rejected_steer");
	assert.equal(rejected.revision, beforeInterrupt.revision + 1);
});

test("drains rejected steers before follow-ups and removes only after start", () => {
	const fixture = coordinatorFixture({
		initial: Object.freeze({
			sessionId: "session-1",
			revision: 2,
			pendingSteers: Object.freeze([]),
			rejectedSteers: Object.freeze([record("queue-rejected", "rejected_steer", "turn-old")]),
			followUps: Object.freeze([record("queue-follow", "follow_up", null)]),
		}),
		activeTurnId: "turn-old",
	});

	assert.equal(fixture.coordinator.next()?.queueId, "queue-rejected");
	assert.equal(fixture.coordinator.snapshot().rejectedSteers.length, 1);
	fixture.coordinator.markStarted("queue-rejected");
	assert.equal(fixture.coordinator.next()?.queueId, "queue-follow");
});

test("duplicate lost-response retry returns the existing record without another save", () => {
	const fixture = coordinatorFixture();
	const input = { clientTurnId: "client-follow", text: "continue later" };
	const first = fixture.coordinator.enqueueFollowUp(input);
	const savedAfterFirst = fixture.savedRevisions.length;

	const duplicate = fixture.coordinator.enqueueFollowUp(input);

	assert.equal(duplicate.disposition, "duplicate");
	assert.strictEqual(duplicate.record, first.record);
	assert.equal(fixture.savedRevisions.length, savedAfterFirst);
	assert.throws(
		() => fixture.coordinator.enqueueFollowUp({ ...input, text: "different" }),
		QueueConflictError,
	);
});

test("pop and clear return removed records only after their snapshots persist", () => {
	const fixture = coordinatorFixture();
	fixture.coordinator.enqueueFollowUp({ clientTurnId: "client-1", text: "first" });
	fixture.coordinator.enqueueFollowUp({ clientTurnId: "client-2", text: "second" });

	const popped = fixture.coordinator.popLastFollowUp();
	const cleared = fixture.coordinator.clear();

	assert.equal(popped.record?.text, "second");
	assert.deepEqual(cleared.records.map((item) => item.text), ["first"]);
	assert.equal(fixture.coordinator.snapshot().followUps.length, 0);
});

test("legacy migration ack removes user records but preserves task notifications", () => {
	const fixture = coordinatorFixture();
	fixture.coordinator.enqueueFollowUp({ clientTurnId: "client-user", text: "user input" });
	fixture.coordinator.enqueueFollowUp({
		clientTurnId: "client-task",
		text: "task update",
		source: "task_notification",
	});
	const migration = fixture.coordinator.legacyMigration();
	assert.ok(migration);

	fixture.coordinator.acknowledgeLegacyMigration(migration.token);

	assert.deepEqual(
		fixture.coordinator.snapshot().followUps.map((item) => item.text),
		["task update"],
	);
	assert.throws(
		() => fixture.coordinator.acknowledgeLegacyMigration(migration.token),
		QueueConflictError,
	);
});

test("queue capacity and session isolation errors do not persist a candidate", () => {
	const fixture = coordinatorFixture();
	assert.throws(
		() => fixture.coordinator.enqueueFollowUp({
			clientTurnId: "client-large",
			text: "x".repeat(64 * 1024 + 1),
		}),
		QueueCapacityError,
	);
	assert.throws(
		() => fixture.coordinator.enqueueFollowUp({
			sessionId: "another-session",
			clientTurnId: "client-wrong",
			text: "wrong session",
		}),
		QueueConflictError,
	);
	assert.deepEqual(fixture.savedRevisions, []);
});

test("notifies subscribers only after persistence and supports unsubscribe", () => {
	const fixture = coordinatorFixture();
	const observed: number[] = [];
	const unsubscribe = fixture.coordinator.subscribe((snapshot) => {
		assert.deepEqual(fixture.savedRevisions, [snapshot.revision]);
		observed.push(snapshot.revision);
	});

	fixture.coordinator.enqueueFollowUp({ clientTurnId: "client-1", text: "first" });
	unsubscribe();
	fixture.coordinator.enqueueFollowUp({ clientTurnId: "client-2", text: "second" });

	assert.deepEqual(observed, [1]);
});

function coordinatorFixture(options: {
	readonly failSave?: boolean;
	readonly initial?: QueueSnapshot;
	readonly committedQueueIds?: ReadonlySet<string>;
	readonly activeTurnId?: string | null;
} = {}) {
	const events: QueueSnapshot[] = [];
	const savedRevisions: number[] = [];
	const history: string[] = [];
	let durable = options.initial ?? emptyQueue();
	const store: QueueCoordinatorStore = {
		loadCommittedQueueIds: () => options.committedQueueIds ?? new Set(),
		saveSnapshot: (snapshot) => {
			if (options.failSave) throw new StorageFailure("queue save failed");
			durable = snapshot;
			savedRevisions.push(snapshot.revision);
		},
		commitPending: (_turnId, records) => {
			for (const item of records) {
				if (!history.includes(item.queueId)) history.push(item.queueId);
			}
			const ids = new Set(records.map((item) => item.queueId));
			durable = Object.freeze({
				...durable,
				revision: durable.revision + (records.length > 0 ? 1 : 0),
				pendingSteers: Object.freeze(
					durable.pendingSteers.filter((item) => !ids.has(item.queueId)),
				),
				rejectedSteers: Object.freeze(
					durable.rejectedSteers.filter((item) => !ids.has(item.queueId)),
				),
				followUps: Object.freeze(durable.followUps.filter((item) => !ids.has(item.queueId))),
			});
			return durable;
		},
	};
	let nextQueueId = 0;
	const coordinator = new QueueCoordinator({
		initial: durable,
		store,
		activeTurnId: options.activeTurnId ?? null,
		createQueueId: () => `queue-${++nextQueueId}`,
		clock: () => NOW,
		publish: (snapshot) => { events.push(snapshot); },
	});
	return { coordinator, events, savedRevisions, history };
}

function emptyQueue(): QueueSnapshot {
	return Object.freeze({
		sessionId: "session-1",
		revision: 0,
		pendingSteers: Object.freeze([]),
		rejectedSteers: Object.freeze([]),
		followUps: Object.freeze([]),
	});
}

function record(
	queueId: string,
	kind: "pending_steer" | "rejected_steer" | "follow_up",
	targetTurnId: string | null,
): QueuedInput {
	return Object.freeze({
		queueId,
		sessionId: "session-1",
		clientTurnId: `client-${queueId}`,
		targetTurnId,
		kind,
		state: kind === "pending_steer" ? "accepted" : "queued",
		text: queueId,
		imagePaths: Object.freeze([]),
		source: "user",
		createdAt: NOW,
		updatedAt: NOW,
	});
}
