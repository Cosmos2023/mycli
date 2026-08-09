import assert from "node:assert/strict";
import test from "node:test";
import {
	QueueCapacityError,
	QueueConflictError,
	claimPendingSteers,
	clearQueue,
	enqueueFollowUp,
	enqueueSteer,
	markQueuedInputStarted,
	nextQueuedInput,
	popLastFollowUp,
	rejectPendingSteers,
	restoreQueue,
	type QueueSnapshot,
} from "../src/queue-state.ts";

const now = "2026-08-04T00:00:00.000Z";

function emptyQueue(sessionId = "s1"): QueueSnapshot {
	return {
		sessionId,
		revision: 0,
		pendingSteers: [],
		rejectedSteers: [],
		followUps: [],
	};
}

function steerInput(overrides: Partial<Parameters<typeof enqueueSteer>[1]> = {}) {
	return {
		queueId: "q1",
		clientTurnId: "c1",
		expectedTurnId: "t1",
		activeTurnId: "t1",
		steerable: true,
		text: "inspect output",
		source: "user",
		now,
		...overrides,
	};
}

function followUpInput(overrides: Partial<Parameters<typeof enqueueFollowUp>[1]> = {}) {
	return {
		queueId: "q-follow",
		clientTurnId: "c-follow",
		text: "continue later",
		source: "user",
		now,
		...overrides,
	};
}

test("accepts a steer only for the expected active turn", () => {
	const result = enqueueSteer(emptyQueue(), steerInput());
	assert.equal(result.disposition, "accepted_for_turn");
	assert.equal(result.snapshot.pendingSteers[0]?.queueId, "q1");
	assert.equal(result.snapshot.pendingSteers[0]?.state, "accepted");
	assert.equal(result.snapshot.revision, 1);
	assert.ok(Object.isFrozen(result.snapshot));
	assert.ok(Object.isFrozen(result.snapshot.pendingSteers));
});

test("defers stale and unsteerable input ahead of ordinary follow-ups", () => {
	const followed = enqueueFollowUp(emptyQueue(), followUpInput());
	const deferred = enqueueSteer(
		followed.snapshot,
		steerInput({ queueId: "q-stale", clientTurnId: "c-stale", expectedTurnId: "old" }),
	);
	assert.equal(deferred.disposition, "deferred_to_end_of_turn");
	assert.equal(deferred.snapshot.rejectedSteers[0]?.kind, "rejected_steer");
	assert.equal(nextQueuedInput(deferred.snapshot)?.queueId, "q-stale");
});

test("deduplicates the same client payload and rejects conflicting reuse", () => {
	const first = enqueueFollowUp(emptyQueue(), followUpInput());
	const duplicate = enqueueFollowUp(
		first.snapshot,
		followUpInput({ queueId: "ignored-retry-id" }),
	);
	assert.equal(duplicate.disposition, "duplicate");
	assert.equal(duplicate.record.queueId, first.record.queueId);
	assert.equal(duplicate.snapshot.revision, first.snapshot.revision);
	assert.throws(
		() => enqueueFollowUp(first.snapshot, followUpInput({ text: "different" })),
		QueueConflictError,
	);
});

test("enforces record, UTF-8 text, aggregate, and attachment capacity", () => {
	assert.throws(
		() => enqueueFollowUp(emptyQueue(), followUpInput(), { maxRecords: 0 }),
		QueueCapacityError,
	);
	assert.throws(
		() => enqueueFollowUp(emptyQueue(), followUpInput({ text: "中" }), { maxTextBytes: 2 }),
		QueueCapacityError,
	);
	assert.throws(
		() => enqueueFollowUp(emptyQueue(), followUpInput(), { maxTotalTextBytes: 3 }),
		QueueCapacityError,
	);
	assert.throws(
		() => enqueueFollowUp(
			emptyQueue(),
			followUpInput({ imagePaths: ["a.png", "b.png"] }),
			{ maxAttachments: 1 },
		),
		QueueCapacityError,
	);
});

test("reconciles committed queue ids without delivering them again", () => {
	const pending = enqueueSteer(emptyQueue(), steerInput()).snapshot;
	const restored = restoreQueue(pending, {
		committedQueueIds: new Set(["q1"]),
		activeTurnId: null,
		now,
	});
	assert.equal(restored.pendingSteers.length, 0);
	assert.equal(restored.revision, 2);
});

test("restores stale pending steers as rejected and rejects cross-session records", () => {
	const pending = enqueueSteer(emptyQueue(), steerInput()).snapshot;
	const restored = restoreQueue(pending, {
		committedQueueIds: new Set(),
		activeTurnId: "different-turn",
		now: "2026-08-04T00:00:01.000Z",
	});
	assert.equal(restored.pendingSteers.length, 0);
	assert.equal(restored.rejectedSteers[0]?.kind, "rejected_steer");
	assert.equal(restored.rejectedSteers[0]?.updatedAt, "2026-08-04T00:00:01.000Z");

	const crossSession = {
		...pending,
		pendingSteers: [{ ...pending.pendingSteers[0]!, sessionId: "s2" }],
	};
	assert.throws(
		() => restoreQueue(crossSession, {
			committedQueueIds: new Set(),
			activeTurnId: "t1",
			now,
		}),
		QueueConflictError,
	);
});

test("keeps internal task notifications pending across idle restore and repairs legacy rejection", () => {
	const pending = enqueueSteer(emptyQueue(), steerInput({
		queueId: "task-notification:q1",
		clientTurnId: "task-notification:q1",
		expectedTurnId: "turn_pending",
		activeTurnId: "turn_pending",
		text: "<task-notification>done</task-notification>",
		source: "task_notification",
	})).snapshot;
	const restored = restoreQueue(pending, {
		committedQueueIds: new Set(),
		activeTurnId: null,
		now: "2026-08-04T00:00:01.000Z",
	});

	assert.equal(restored.pendingSteers.length, 1);
	assert.equal(restored.rejectedSteers.length, 0);
	assert.equal(restored.revision, pending.revision);

	const legacyRejected = rejectPendingSteers(
		pending,
		"turn_pending",
		"2026-08-04T00:00:02.000Z",
	);
	const repaired = restoreQueue(legacyRejected, {
		committedQueueIds: new Set(),
		activeTurnId: null,
		now: "2026-08-04T00:00:03.000Z",
	});
	assert.equal(repaired.pendingSteers[0]?.kind, "pending_steer");
	assert.equal(repaired.pendingSteers[0]?.state, "accepted");
	assert.equal(repaired.rejectedSteers.length, 0);
});

test("migrates legacy follow-up task notifications into pending provider input", () => {
	const legacy = enqueueFollowUp(emptyQueue(), followUpInput({
		queueId: "task-notification:legacy",
		clientTurnId: "task-notification:legacy",
		text: "<task-notification>legacy done</task-notification>",
		source: "task_notification",
	})).snapshot;
	const restored = restoreQueue(legacy, {
		committedQueueIds: new Set(),
		activeTurnId: null,
		now: "2026-08-04T00:00:01.000Z",
	});

	assert.equal(restored.followUps.length, 0);
	assert.deepEqual(restored.pendingSteers[0], {
		...legacy.followUps[0],
		targetTurnId: "turn_pending",
		kind: "pending_steer",
		state: "accepted",
		updatedAt: "2026-08-04T00:00:01.000Z",
	});
	assert.equal(restored.revision, legacy.revision + 1);
});

test("claims matching pending steers and moves terminal steers to the rejected queue", () => {
	const pending = enqueueSteer(emptyQueue(), steerInput()).snapshot;
	assert.deepEqual(claimPendingSteers(pending, "t1").map((item) => item.queueId), ["q1"]);
	assert.deepEqual(claimPendingSteers(pending, "other"), []);

	const rejected = rejectPendingSteers(pending, "t1", "2026-08-04T00:00:02.000Z");
	assert.equal(rejected.pendingSteers.length, 0);
	assert.equal(rejected.rejectedSteers[0]?.state, "queued");
	assert.equal(rejected.revision, 2);
	assert.equal(rejectPendingSteers(rejected, "t1", now), rejected);
});

test("consumes only the priority record, pops the newest follow-up, and clears atomically", () => {
	let snapshot = enqueueFollowUp(
		emptyQueue(),
		followUpInput({ queueId: "q-first", clientTurnId: "c-first", text: "first" }),
	).snapshot;
	snapshot = enqueueFollowUp(
		snapshot,
		followUpInput({ queueId: "q-last", clientTurnId: "c-last", text: "last" }),
	).snapshot;

	assert.throws(() => markQueuedInputStarted(snapshot, "q-last"), QueueConflictError);
	const started = markQueuedInputStarted(snapshot, "q-first");
	assert.equal(started.followUps[0]?.queueId, "q-last");

	const popped = popLastFollowUp(snapshot);
	assert.equal(popped.record?.queueId, "q-last");
	assert.equal(popped.snapshot.followUps[0]?.queueId, "q-first");

	const cleared = clearQueue(snapshot);
	assert.deepEqual(cleared.records.map((item) => item.queueId), ["q-first", "q-last"]);
	assert.equal(cleared.snapshot.followUps.length, 0);
	assert.equal(cleared.snapshot.revision, snapshot.revision + 1);
});

test("end-of-turn queue operations preserve internal task notifications", () => {
	let snapshot = enqueueSteer(emptyQueue(), steerInput({
		queueId: "task-notification:rejected",
		clientTurnId: "task-notification:rejected",
		expectedTurnId: "turn_pending",
		activeTurnId: "turn_pending",
		text: "<task-notification>rejected legacy</task-notification>",
		source: "task_notification",
	})).snapshot;
	snapshot = rejectPendingSteers(snapshot, "turn_pending", now);
	snapshot = enqueueFollowUp(
		snapshot,
		followUpInput({
			queueId: "task-notification:legacy",
			clientTurnId: "task-notification:legacy",
			text: "<task-notification>done</task-notification>",
			source: "task_notification",
		}),
	).snapshot;
	snapshot = enqueueFollowUp(
		snapshot,
		followUpInput({ queueId: "q-user", clientTurnId: "c-user", text: "user follow-up" }),
	).snapshot;
	snapshot = enqueueFollowUp(
		snapshot,
		followUpInput({
			queueId: "task-notification:newer",
			clientTurnId: "task-notification:newer",
			text: "<task-notification>newer done</task-notification>",
			source: "task_notification",
		}),
	).snapshot;

	assert.equal(nextQueuedInput(snapshot)?.queueId, "q-user");
	const started = markQueuedInputStarted(snapshot, "q-user");
	assert.deepEqual(
		started.rejectedSteers.map((record) => record.queueId),
		["task-notification:rejected"],
	);
	assert.deepEqual(
		started.followUps.map((record) => record.queueId),
		["task-notification:legacy", "task-notification:newer"],
	);

	const popped = popLastFollowUp(snapshot);
	assert.equal(popped.record?.queueId, "q-user");
	assert.deepEqual(
		popped.snapshot.followUps.map((record) => record.queueId),
		["task-notification:legacy", "task-notification:newer"],
	);
	assert.equal(popLastFollowUp(popped.snapshot).record, undefined);
});

test("queue clear removes user input but preserves internal task notifications", () => {
	const notification = enqueueSteer(emptyQueue(), steerInput({
		queueId: "task-notification:q1",
		clientTurnId: "task-notification:q1",
		expectedTurnId: "turn_pending",
		activeTurnId: "turn_pending",
		text: "<task-notification>done</task-notification>",
		source: "task_notification",
	})).snapshot;
	const withUser = enqueueFollowUp(notification, followUpInput()).snapshot;
	const cleared = clearQueue(withUser);

	assert.deepEqual(cleared.records.map((record) => record.queueId), ["q-follow"]);
	assert.deepEqual(
		cleared.snapshot.pendingSteers.map((record) => record.queueId),
		["task-notification:q1"],
	);
	assert.equal(cleared.snapshot.followUps.length, 0);
});

test("agent mailbox inputs remain internal and pending across restore and clear", () => {
	const notification = enqueueSteer(emptyQueue(), steerInput({
		queueId: "mailbox-message",
		clientTurnId: "mailbox-message",
		expectedTurnId: "turn_pending",
		activeTurnId: "turn_pending",
		text: "<agent-mailbox>internal</agent-mailbox>",
		source: "agent_mailbox",
	})).snapshot;
	const restored = restoreQueue(notification, {
		committedQueueIds: new Set(),
		activeTurnId: null,
		now,
	});
	assert.equal(restored.pendingSteers[0]?.source, "agent_mailbox");
	assert.equal(nextQueuedInput(restored), undefined);
	assert.equal(clearQueue(restored).snapshot.pendingSteers.length, 1);
});
