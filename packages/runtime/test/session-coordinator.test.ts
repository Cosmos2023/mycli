import assert from "node:assert/strict";
import test from "node:test";
import type { QueueSnapshot } from "@mycli/core";
import type { SessionOverview, TranscriptItem } from "@mycli/storage";
import {
	SessionCoordinator,
	SessionTransitionError,
	type PreparedSession,
} from "../src/session-coordinator.ts";

type Binding = { readonly name: string };

test("failed target preparation leaves the source session active", async () => {
	const coordinator = fixture({ targetFailure: "session_state_invalid" });

	await assert.rejects(
		() => coordinator.resume("target"),
		(error: unknown) => hasCode(error, "session_state_invalid"),
	);
	assert.equal(coordinator.snapshot().sessionId, "source");
	assert.equal(coordinator.snapshot().generation, 1);
	assert.equal(coordinator.snapshot().binding.name, "runtime-source");
});

test("successful resume replaces every session-scoped value in one generation", async () => {
	const coordinator = fixture();

	const result = await coordinator.resume("target");

	assert.equal(result.sessionId, "target");
	assert.equal(result.generation, 2);
	assert.equal(result.queue.sessionId, "target");
	assert.equal(result.pendingApproval?.sessionId, "target");
	assert.equal(result.transcript[0]?.id, "target:user:1");
	assert.equal(result.binding.name, "runtime-target");
	assert.strictEqual(coordinator.snapshot(), result);
	assert.ok(Object.isFrozen(result));
});

test("same-session resume is idempotent and does not prepare twice", async () => {
	const prepared: string[] = [];
	const coordinator = fixture({ prepared });
	const before = coordinator.snapshot();

	const result = await coordinator.resume("source");

	assert.strictEqual(result, before);
	assert.deepEqual(prepared, []);
});

test("rejects cross-session resume while the current generation is executing", async () => {
	const coordinator = fixture();
	const context = coordinator.context();
	assert.equal(coordinator.markExecuting(context, true), true);

	await assert.rejects(
		() => coordinator.resume("target"),
		(error: unknown) => error instanceof SessionTransitionError
			&& error.code === "turn_in_progress",
	);
	assert.equal(coordinator.snapshot().sessionId, "source");
	assert.equal(coordinator.markExecuting(context, false), true);
	assert.equal((await coordinator.resume("target")).sessionId, "target");
});

test("session preparation excludes a turn execution claim until commit", async () => {
	let preparationStarted!: () => void;
	let releasePreparation!: () => void;
	const started = new Promise<void>((resolve) => { preparationStarted = resolve; });
	const released = new Promise<void>((resolve) => { releasePreparation = resolve; });
	const coordinator = new SessionCoordinator<Binding>({
		initial: preparedSession("source"),
		prepare: async (sessionId) => {
			preparationStarted();
			await released;
			return preparedSession(sessionId);
		},
		listSessions: () => [],
		loadSessionLineage: (sessionId) => [{ sessionId }],
	});
	const sourceContext = coordinator.context();
	const resume = coordinator.resume("target");
	await started;

	const executionClaimed = coordinator.markExecuting(sourceContext, true);
	releasePreparation();
	const resumed = await resume;

	assert.equal(executionClaimed, false);
	assert.equal(resumed.sessionId, "target");
	assert.equal(coordinator.executing(), false);
});

test("stale generation contexts cannot mutate the active session", async () => {
	const coordinator = fixture();
	const stale = coordinator.context();
	await coordinator.resume("target");

	assert.equal(coordinator.isCurrent(stale), false);
	assert.equal(coordinator.markExecuting(stale, true), false);
	assert.equal(coordinator.executing(), false);
	assert.equal(coordinator.isCurrent(coordinator.context()), true);
});

test("allows a validated read-only replay and exposes catalog lineage", async () => {
	const coordinator = fixture({ targetReadOnly: true });
	const resumed = await coordinator.resume("target");

	assert.equal(resumed.readOnly, true);
	assert.deepEqual(coordinator.listSessions().map((item) => item.sessionId), ["target", "source"]);
	assert.deepEqual(
		coordinator.loadSessionLineage("target").map((item) => item.sessionId),
		["source", "target"],
	);
});

function fixture(options: {
	readonly targetFailure?: string;
	readonly targetReadOnly?: boolean;
	readonly prepared?: string[];
} = {}): SessionCoordinator<Binding> {
	const overviews: readonly SessionOverview[] = [
		overview("target", "2026-08-04T00:00:01.000Z"),
		overview("source", "2026-08-04T00:00:00.000Z"),
	];
	return new SessionCoordinator({
		initial: preparedSession("source"),
		prepare: async (sessionId) => {
			options.prepared?.push(sessionId);
			if (options.targetFailure) {
				throw Object.assign(new Error("target preparation failed"), {
					code: options.targetFailure,
				});
			}
			return preparedSession(sessionId, options.targetReadOnly ?? false);
		},
		listSessions: () => overviews,
		loadSessionLineage: (sessionId) => sessionId === "target"
			? [
				{ sessionId: "source" },
				{ sessionId: "target", parentId: "source", forkPoint: 1 },
			]
			: [{ sessionId }],
	});
}

function preparedSession(sessionId: string, readOnly = false): PreparedSession<Binding> {
	return {
		sessionId,
		workspaceRoot: "/repo",
		threadId: sessionId,
		transcript: [transcriptItem(sessionId)],
		queue: queue(sessionId),
		pendingApproval: {
			sessionId,
			clientTurnId: `client-${sessionId}`,
			turnId: `turn-${sessionId}`,
			decisionId: `decision-${sessionId}`,
			callId: `call-${sessionId}`,
			toolName: "Write",
			preview: "Write notes.txt",
			reason: "Approval required",
			options: ["approve_once", "reject"],
		},
		suspendedTurn: true,
		readOnly,
		binding: { name: `runtime-${sessionId}` },
	};
}

function transcriptItem(sessionId: string): TranscriptItem {
	return {
		id: `${sessionId}:user:1`,
		type: "user_message",
		text: sessionId,
	};
}

function queue(sessionId: string): QueueSnapshot {
	return Object.freeze({
		sessionId,
		revision: 0,
		pendingSteers: Object.freeze([]),
		rejectedSteers: Object.freeze([]),
		followUps: Object.freeze([]),
	});
}

function overview(sessionId: string, lastActiveAt: string): SessionOverview {
	return {
		sessionId,
		workspaceRoot: "/repo",
		threadId: sessionId,
		createdAt: lastActiveAt,
		updatedAt: lastActiveAt,
		lastActiveAt,
		status: "active",
		messageCount: 1,
		summaryCount: 0,
	};
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error
		&& "code" in error
		&& (error as Error & { readonly code: unknown }).code === code;
}
