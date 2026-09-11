import assert from "node:assert/strict";
import test from "node:test";
import type { QueueSnapshot } from "@mycli/core";
import type { SessionOverview, TranscriptItem } from "@mycli/storage";
import {
	SessionCoordinator,
	SessionTransitionError,
	type PreparedSession,
} from "../../src/sessions/session-coordinator.ts";

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
	const claim = coordinator.claimExecution(coordinator.context());
	assert.ok(claim);
	assert.equal(coordinator.releaseExecution(claim), true);
});

test("lease conflict rejects resume before target preparation", async () => {
	const acquired: string[] = [];
	const released: string[] = [];
	const prepared: string[] = [];
	const coordinator = fixture({
		targetLeaseFailure: "session_in_use",
		acquired,
		released,
		prepared,
	});

	await assert.rejects(
		() => coordinator.resume("target"),
		(error: unknown) => hasCode(error, "session_in_use"),
	);
	assert.deepEqual(acquired, ["target"]);
	assert.deepEqual(prepared, []);
	assert.deepEqual(released, []);
	assert.equal(coordinator.snapshot().sessionId, "source");
});

test("failed target preparation releases its lease and retains the source lease", async () => {
	const acquired: string[] = [];
	const released: string[] = [];
	const coordinator = fixture({
		targetFailure: "session_state_invalid",
		acquired,
		released,
	});

	await assert.rejects(() => coordinator.resume("target"));
	assert.deepEqual(acquired, ["target"]);
	assert.deepEqual(released, ["target"]);
	assert.equal(coordinator.snapshot().sessionId, "source");
});

test("successful resume replaces every session-scoped value in one generation", async () => {
	const acquired: string[] = [];
	const released: string[] = [];
	const coordinator = fixture({ acquired, released });

	const result = await coordinator.resume("target");

	assert.equal(result.sessionId, "target");
	assert.equal(result.generation, 2);
	assert.equal(result.queue.sessionId, "target");
	assert.equal(result.pendingApproval?.sessionId, "target");
	assert.equal(result.transcript[0]?.id, "target:user:1");
	assert.equal(result.binding.name, "runtime-target");
	assert.strictEqual(coordinator.snapshot(), result);
	assert.ok(Object.isFrozen(result));
	assert.deepEqual(acquired, ["target"]);
	assert.deepEqual(released, ["source"]);
	const claim = coordinator.claimExecution(coordinator.context());
	assert.ok(claim);
	assert.equal(coordinator.releaseExecution(claim), true);
});

test("retained source ownership survives a successful session switch", async () => {
	const released: string[] = [];
	const coordinator = fixture({ retainSourceSession: true, released });

	await coordinator.resume("target");

	assert.equal(coordinator.snapshot().sessionId, "target");
	assert.deepEqual(released, []);
});

test("failed preparation does not release a target already owned by this window", async () => {
	const released: string[] = [];
	const coordinator = fixture({
		targetFailure: "session_state_invalid",
		targetLeaseRetained: true,
		released,
	});

	await assert.rejects(() => coordinator.resume("target"));

	assert.deepEqual(released, []);
	assert.equal(coordinator.snapshot().sessionId, "source");
});

test("same-session resume is idempotent and does not prepare twice", async () => {
	const prepared: string[] = [];
	const coordinator = fixture({ prepared });
	const before = coordinator.snapshot();

	const result = await coordinator.resume("source");

	assert.strictEqual(result, before);
	assert.deepEqual(prepared, []);
});

test("inspection is distinguished from activation and cannot run resume recovery", async () => {
	const intents: string[] = [];
	const coordinator = new SessionCoordinator({
		initial: preparedSession("source"),
		prepare: (sessionId, intent) => { intents.push(intent); return preparedSession(sessionId); },
		listSessions: () => [], loadSessionLineage: () => [],
	});
	await coordinator.inspect("target");
	assert.deepEqual(intents, ["inspect"]);
	assert.equal(coordinator.snapshot().sessionId, "source");
	await coordinator.resume("target");
	assert.deepEqual(intents, ["inspect", "resume"]);
});

test("updates queue state only for the active session generation", () => {
	const coordinator = fixture();
	const context = coordinator.context();
	const updated = queue("source", 1);

	assert.equal(coordinator.updateQueue(context, updated), true);
	assert.strictEqual(coordinator.snapshot().queue, updated);
	assert.equal(coordinator.snapshot().generation, 1);
	assert.equal(coordinator.updateQueue({ ...context, generation: 2 }, queue("source", 2)), false);
	assert.equal(coordinator.updateQueue(context, queue("target", 2)), false);
	assert.strictEqual(coordinator.snapshot().queue, updated);
});

test("rejects cross-session resume while the current generation is executing", async () => {
	const coordinator = fixture();
	const context = coordinator.context();
	const claim = coordinator.claimExecution(context);
	assert.ok(claim);

	await assert.rejects(
		() => coordinator.resume("target"),
		(error: unknown) => error instanceof SessionTransitionError
			&& error.code === "turn_in_progress",
	);
	assert.equal(coordinator.snapshot().sessionId, "source");
	assert.equal(coordinator.releaseExecution(claim), true);
	assert.equal((await coordinator.resume("target")).sessionId, "target");
});

test("execution claims are exclusive until the owning generation releases them", () => {
	const coordinator = fixture();
	const context = coordinator.context();

	const claim = coordinator.claimExecution(context);
	assert.ok(claim);
	assert.equal(coordinator.claimExecution(context), undefined);
	assert.equal(coordinator.executing(), true);
	assert.equal(coordinator.releaseExecution(claim), true);
	assert.equal(coordinator.executing(), false);
});

test("a stale execution claim cannot release newer work in the same generation", () => {
	const coordinator = fixture();
	const context = coordinator.context();
	const first = coordinator.claimExecution(context);
	assert.ok(first);
	assert.equal(coordinator.releaseExecution(first), true);
	const second = coordinator.claimExecution(context);
	assert.ok(second);

	assert.equal(coordinator.releaseExecution(first), false);
	assert.equal(coordinator.executing(), true);
	assert.equal(coordinator.releaseExecution(second), true);
	assert.equal(coordinator.executing(), false);
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

	const executionClaim = coordinator.claimExecution(sourceContext);
	releasePreparation();
	const resumed = await resume;

	assert.equal(executionClaim, undefined);
	assert.equal(resumed.sessionId, "target");
	assert.equal(coordinator.executing(), false);
});

test("stale generation contexts cannot mutate the active session", async () => {
	const coordinator = fixture();
	const stale = coordinator.context();
	await coordinator.resume("target");

	assert.equal(coordinator.isCurrent(stale), false);
	assert.equal(coordinator.claimExecution(stale), undefined);
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

test("starts a fresh prepared session in a new generation", async () => {
	const coordinator = fixture({ createSessionId: "fresh" });
	const previous = coordinator.snapshot();

	const result = await coordinator.startNew();

	assert.equal(result.sessionId, "fresh");
	assert.equal(result.generation, previous.generation + 1);
	assert.equal(result.workspaceRoot, previous.workspaceRoot);
	assert.deepEqual(result.transcript, [transcriptItem("fresh")]);
	assert.strictEqual(coordinator.snapshot(), result);
	const claim = coordinator.claimExecution(coordinator.context());
	assert.ok(claim);
	assert.equal(coordinator.releaseExecution(claim), true);
});

test("retains source ownership when starting a fresh session", async () => {
	const released: string[] = [];
	const coordinator = fixture({
		createSessionId: "fresh",
		retainSourceSession: true,
		released,
	});

	await coordinator.startNew();

	assert.equal(coordinator.snapshot().sessionId, "fresh");
	assert.deepEqual(released, []);
});

test("rejects new session creation while the active generation is executing", async () => {
	const coordinator = fixture({ createSessionId: "fresh" });
	const context = coordinator.context();
	assert.ok(coordinator.claimExecution(context));

	await assert.rejects(
		() => coordinator.startNew(),
		(error: unknown) => error instanceof SessionTransitionError
			&& error.code === "turn_in_progress",
	);
	assert.equal(coordinator.snapshot().sessionId, "source");
});

function fixture(options: {
	readonly targetFailure?: string;
	readonly targetLeaseFailure?: string;
	readonly targetLeaseRetained?: boolean;
	readonly retainSourceSession?: boolean;
	readonly targetReadOnly?: boolean;
	readonly prepared?: string[];
	readonly acquired?: string[];
	readonly released?: string[];
	readonly createSessionId?: string;
} = {}): SessionCoordinator<Binding> {
	const overviews: readonly SessionOverview[] = [
		overview("target", "2026-08-04T00:00:01.000Z"),
		overview("source", "2026-08-04T00:00:00.000Z"),
	];
	return new SessionCoordinator({
		initial: preparedSession("source"),
		acquireSession: (sessionId) => {
			options.acquired?.push(sessionId);
			if (options.targetLeaseFailure) {
				throw Object.assign(new Error("target lease failed"), {
					code: options.targetLeaseFailure,
				});
			}
			return options.targetLeaseRetained ? false : undefined;
		},
		releaseSession: (sessionId) => {
			options.released?.push(sessionId);
		},
		prepare: async (sessionId) => {
			options.prepared?.push(sessionId);
			if (options.targetFailure) {
				throw Object.assign(new Error("target preparation failed"), {
					code: options.targetFailure,
				});
			}
			return preparedSession(sessionId, options.targetReadOnly ?? false);
		},
		...(options.createSessionId ? {
			create: (current) => preparedSession(options.createSessionId!, current.readOnly),
		} : {}),
		listSessions: () => overviews,
		loadSessionLineage: (sessionId) => sessionId === "target"
			? [
				{ sessionId: "source" },
				{ sessionId: "target", parentId: "source", forkPoint: 1 },
			]
			: [{ sessionId }],
		retainSourceSession: options.retainSourceSession,
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

function queue(sessionId: string, revision = 0): QueueSnapshot {
	return Object.freeze({
		sessionId,
		revision,
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
