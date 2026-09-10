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
} from "../../src/index.ts";

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

test("persists restoration claims before exposing them and retires only after ack", () => {
	const fixture = coordinatorFixture();
	fixture.coordinator.enqueueFollowUp({
		clientTurnId: "client-restore",
		text: "restore me",
	});

	const claim = fixture.coordinator.claimForRestoration("restore_rpc_1");
	assert.equal(claim.records[0]?.text, "restore me");
	assert.equal(claim.snapshot.followUps[0]?.state, "claimed");
	assert.equal(fixture.coordinator.next(), undefined);
	assert.deepEqual(fixture.savedRevisions, [1, 2]);

	const retry = fixture.coordinator.claimForRestoration("restore_rpc_1");
	assert.strictEqual(retry.snapshot, claim.snapshot);
	assert.deepEqual(fixture.savedRevisions, [1, 2]);

	const acknowledged = fixture.coordinator.acknowledgeRestoration("restore_rpc_1");
	assert.equal(acknowledged.followUps.length, 0);
	assert.deepEqual(fixture.savedRevisions, [1, 2, 3]);
});

test("releases an unacknowledged restoration claim for recovery", () => {
	const fixture = coordinatorFixture();
	fixture.coordinator.enqueueFollowUp({
		clientTurnId: "client-restore",
		text: "restore me",
	});
	fixture.coordinator.claimForRestoration("restore_rpc_1");

	const released = fixture.coordinator.releaseRestorationClaims();
	assert.equal(released.followUps[0]?.state, "queued");
	assert.equal(released.followUps[0]?.claimTurnId, undefined);
	assert.equal(fixture.coordinator.next()?.text, "restore me");
	assert.deepEqual(fixture.savedRevisions, [1, 2, 3]);
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

test("loads queued image paths before committing canonical history", () => {
	const loadedPaths: string[][] = [];
	const fixture = coordinatorFixture({
		loadLocalImages: (paths) => {
			loadedPaths.push([...paths]);
			return [{ mediaType: "image/png", data: "aW1hZ2U=" }];
		},
	});
	fixture.coordinator.enqueueSteer({
		clientTurnId: "client-image",
		expectedTurnId: "turn-1",
		activeTurnId: "turn-1",
		steerable: true,
		text: "describe this",
		imagePaths: ["/tmp/sample.png"],
	});

	fixture.coordinator.commitPending("turn-1");

	assert.deepEqual(loadedPaths, [["/tmp/sample.png"]]);
	assert.deepEqual(fixture.committedImages.get("queue-1"), [
		{ mediaType: "image/png", data: "aW1hZ2U=" },
	]);
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

test("terminal rejection and interrupted steer resubmission persist before publication", () => {
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
	const prepared = fixture.coordinator.prepareInterruptedSteers("turn-1");

	assert.deepEqual(prepared.records.map((record) => record.clientTurnId), ["client-steer"]);
	assert.equal(prepared.snapshot.pendingSteers.length, 0);
	assert.equal(prepared.snapshot.rejectedSteers[0]?.kind, "rejected_steer");
	assert.equal(prepared.snapshot.revision, beforeInterrupt.revision + 1);
	assert.equal(fixture.durable().revision, prepared.snapshot.revision);

	fixture.coordinator.enqueueSteer({
		clientTurnId: "client-next",
		expectedTurnId: "turn-2",
		activeTurnId: "turn-2",
		steerable: true,
		text: "inspect next",
	});
	const rejected = fixture.coordinator.rejectPending("turn-2");
	assert.equal(rejected.pendingSteers.length, 0);
	assert.equal(rejected.rejectedSteers.at(-1)?.kind, "rejected_steer");
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

test("persists queued claims and reconciles them against canonical user input", () => {
	const fixture = coordinatorFixture({
		initial: Object.freeze({
			sessionId: "session-1",
			revision: 1,
			pendingSteers: Object.freeze([]),
			rejectedSteers: Object.freeze([]),
			followUps: Object.freeze([record("queue-follow", "follow_up", null)]),
		}),
	});

	const claimed = fixture.coordinator.claim("queue-follow", "turn-queued");
	assert.equal(claimed.followUps[0]?.state, "claimed");
	assert.equal(claimed.followUps[0]?.claimTurnId, "turn-queued");
	assert.equal(fixture.durable().followUps[0]?.state, "claimed");
	assert.equal(fixture.coordinator.next(), undefined);

	const released = fixture.coordinator.reconcileClaim("queue-follow", "turn-queued");
	assert.equal(released.committed, false);
	assert.equal(released.snapshot.followUps[0]?.state, "queued");

	fixture.coordinator.claim("queue-follow", "turn-retry");
	fixture.committedQueueIds.add("queue-follow");
	const retired = fixture.coordinator.reconcileClaim("queue-follow", "turn-retry");
	assert.equal(retired.committed, true);
	assert.equal(retired.snapshot.followUps.length, 0);
	assert.equal(fixture.durable().followUps.length, 0);
});

test("claim persistence failure leaves the queued record dispatchable", () => {
	const fixture = coordinatorFixture({
		failSave: true,
		initial: Object.freeze({
			sessionId: "session-1",
			revision: 1,
			pendingSteers: Object.freeze([]),
			rejectedSteers: Object.freeze([]),
			followUps: Object.freeze([record("queue-follow", "follow_up", null)]),
		}),
	});

	assert.throws(
		() => fixture.coordinator.claim("queue-follow", "turn-queued"),
		StorageFailure,
	);
	assert.equal(fixture.coordinator.snapshot().followUps[0]?.state, "queued");
	assert.equal(fixture.coordinator.next()?.queueId, "queue-follow");
});

test("restart releases orphaned claims and retires committed claims", () => {
	const claimedRecord = Object.freeze({
		...record("queue-follow", "follow_up", null),
		state: "claimed" as const,
		claimTurnId: "turn-queued",
	});
	const initial = Object.freeze({
		sessionId: "session-1",
		revision: 2,
		pendingSteers: Object.freeze([]),
		rejectedSteers: Object.freeze([]),
		followUps: Object.freeze([claimedRecord]),
	});

	const orphaned = coordinatorFixture({ initial });
	assert.equal(orphaned.coordinator.snapshot().followUps[0]?.state, "queued");
	assert.equal(orphaned.coordinator.snapshot().followUps[0]?.claimTurnId, undefined);

	const committed = coordinatorFixture({
		initial,
		committedQueueIds: new Set(["queue-follow"]),
	});
	assert.equal(committed.coordinator.snapshot().followUps.length, 0);
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

test("queues deterministic task notifications once before and after commit", () => {
	const fixture = coordinatorFixture();
	const first = fixture.coordinator.enqueueTaskNotification({
		taskId: "task-1",
		text: "<task-notification>done</task-notification>",
	});
	const savedAfterFirst = fixture.savedRevisions.length;
	const queued = fixture.coordinator.snapshot().pendingSteers[0];

	assert.equal(first.disposition, "queued");
	assert.equal(first.queueId.startsWith("task-notification:"), true);
	assert.equal(queued?.queueId, first.queueId);
	assert.equal(queued?.clientTurnId, first.queueId);
	assert.equal(queued?.targetTurnId, "turn_pending");
	assert.equal(queued?.source, "task_notification");
	assert.equal(
		fixture.coordinator.enqueueTaskNotification({
			taskId: "task-1",
			text: "a later serializer does not replace durable notification text",
		}).disposition,
		"duplicate",
	);
	assert.equal(fixture.savedRevisions.length, savedAfterFirst);

	fixture.coordinator.commitPending("turn-1");
	assert.equal(
		fixture.coordinator.enqueueTaskNotification({ taskId: "task-1", text: "done" }).disposition,
		"duplicate",
	);
	assert.equal(fixture.coordinator.snapshot().pendingSteers.length, 0);
	assert.deepEqual(fixture.history, [first.queueId]);
});

test("queues agent mailbox input internally and reports its durable commit", () => {
	const committed: QueuedInput[][] = [];
	const fixture = coordinatorFixture({
		onCommitted: (records) => {
			committed.push([...records]);
		},
	});
	const first = fixture.coordinator.enqueueInternalNotification({
		queueId: "mailbox-1",
		text: "<agent-mailbox>message</agent-mailbox>",
		source: "agent_mailbox",
	});
	assert.equal(first.disposition, "queued");
	assert.equal(fixture.coordinator.next(), undefined);
	assert.equal(fixture.coordinator.clear().snapshot.pendingSteers.length, 1);
	assert.equal(fixture.coordinator.legacyMigration(), undefined);
	assert.equal(fixture.coordinator.enqueueInternalNotification({
		queueId: "mailbox-1",
		text: "duplicate",
		source: "agent_mailbox",
	}).disposition, "duplicate");

	fixture.coordinator.commitPending("turn-1");
	assert.equal(committed.length, 1);
	assert.equal(committed[0]?.[0]?.queueId, "mailbox-1");
});

test("waits for matching task notifications and reports existing steering immediately", async () => {
	const fixture = coordinatorFixture();
	const controller = new AbortController();
	const waiting = fixture.coordinator.waitForActivity({
		turnId: "turn-1",
		timeoutMs: 1_000,
		signal: controller.signal,
	});

	fixture.coordinator.enqueueTaskNotification({ taskId: "task-1", text: "done" });
	assert.deepEqual(await waiting, {
		kind: "activity",
		activity: "task_notification",
		pendingCount: 1,
	});

	fixture.coordinator.enqueueSteer({
		clientTurnId: "client-steer",
		expectedTurnId: "turn-1",
		activeTurnId: "turn-1",
		steerable: true,
		text: "user steering",
	});
	assert.deepEqual(await fixture.coordinator.waitForActivity({
		turnId: "turn-1",
		timeoutMs: 1_000,
		signal: controller.signal,
	}), {
		kind: "activity",
		activity: "mixed",
		pendingCount: 2,
	});
});

test("activity wait times out, aborts, and releases its queue subscription", async () => {
	const fixture = coordinatorFixture();
	const timedOut = fixture.coordinator.waitForActivity({
		turnId: "turn-1",
		timeoutMs: 5,
		signal: new AbortController().signal,
	});
	assert.deepEqual(await timedOut, { kind: "timeout" });

	const controller = new AbortController();
	const interrupted = fixture.coordinator.waitForActivity({
		turnId: "turn-1",
		timeoutMs: 1_000,
		signal: controller.signal,
	});
	controller.abort();
	await assert.rejects(interrupted, { name: "AbortError", message: "interrupted" });

	fixture.coordinator.enqueueSteer({
		clientTurnId: "client-after-cleanup",
		expectedTurnId: "another-turn",
		activeTurnId: "another-turn",
		steerable: true,
		text: "unrelated",
	});
	assert.equal(fixture.coordinator.snapshot().pendingSteers.length, 1);
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
	readonly onCommitted?: (records: readonly QueuedInput[]) => void;
	readonly loadLocalImages?: NonNullable<ConstructorParameters<typeof QueueCoordinator>[0]["loadLocalImages"]>;
} = {}) {
	const events: QueueSnapshot[] = [];
	const savedRevisions: number[] = [];
	const history: string[] = [];
	const committedImages = new Map<string, readonly { readonly mediaType: string; readonly data: string }[]>();
	const committedQueueIds = new Set(options.committedQueueIds ?? []);
	let durable = options.initial ?? emptyQueue();
	const store: QueueCoordinatorStore = {
		loadCommittedQueueIds: () => new Set(committedQueueIds),
		saveSnapshot: (snapshot) => {
			if (options.failSave) throw new StorageFailure("queue save failed");
			durable = snapshot;
			savedRevisions.push(snapshot.revision);
		},
		commitPending: (_turnId, records, imagesByQueueId) => {
			for (const [queueId, images] of imagesByQueueId ?? []) {
				committedImages.set(queueId, images);
			}
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
		...(options.onCommitted ? { onCommitted: options.onCommitted } : {}),
		...(options.loadLocalImages ? { loadLocalImages: options.loadLocalImages } : {}),
	});
	return {
		coordinator,
		events,
		savedRevisions,
		history,
		committedImages,
		committedQueueIds,
		durable: () => durable,
	};
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
