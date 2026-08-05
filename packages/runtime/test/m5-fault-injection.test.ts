import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type {
	ApprovalResolution,
	CanonicalConversationItem,
	QueueSnapshot,
} from "@mycli/core";
import {
	SQLiteSessionStore,
	TranscriptSnapshotStore,
	type CommitCompactionInput,
	type SaveStateInput,
} from "@mycli/storage";
import type { ToolExecutionResult, ToolRouterContract } from "@mycli/tools";
import {
	ApprovalContinuationCoordinator,
	CompactionCoordinator,
	MemoryStore,
	QueueCoordinator,
	SessionCoordinator,
	type CompactionCoordinatorOptions,
	type PreparedSession,
} from "../src/index.ts";

const NOW = "2026-08-05T00:00:00.000Z";

class InjectedCrash extends Error {
	constructor(readonly failpoint: string) {
		super(`injected crash at ${failpoint}`);
	}
}

test("queue crashes publish only durable snapshots and restart with one pending input", () => {
	for (const target of ["queue_before_save", "queue_after_save"]) {
		const initial = emptyQueue("session-queue");
		let durable = initial;
		let saves = 0;
		let publications = 0;
		const options = {
			initial,
			store: {
				loadCommittedQueueIds: () => new Set<string>(),
				saveSnapshot: (snapshot: QueueSnapshot) => {
					saves += 1;
					durable = snapshot;
				},
				commitPending: () => durable,
			},
			activeTurnId: "turn-queue",
			createQueueId: () => "queue-1",
			clock: () => NOW,
			publish: () => { publications += 1; },
			failpoint: crashAt(target),
		};
		const coordinator = new QueueCoordinator(options);

		assert.throws(() => coordinator.enqueueFollowUp({
			clientTurnId: "client-queue",
			text: "continue once",
		}), (error: unknown) => isCrash(error, target));
		assert.equal(publications, 0);
		assert.equal(coordinator.snapshot().revision, 0);
		if (target === "queue_before_save") {
			assert.equal(saves, 0);
			assert.equal(durable.revision, 0);
		} else {
			assert.equal(saves, 1);
			assert.equal(durable.revision, 1);
			assert.equal(durable.followUps.length, 1);
			const reopened = new QueueCoordinator({ ...options, initial: durable, failpoint: () => {} });
			assert.equal(reopened.snapshot().followUps.length, 1);
		}
	}
});

test("approval crashes never execute a claimed effect twice", async (t) => {
	for (const target of ["approval_after_resolution", "effect_after_claim"]) {
		await t.test(target, async (subtest) => {
			const fixture = await approvalFixture(subtest, target);
			fixture.coordinator.suspend(approvalSuspension());

			await assert.rejects(() => fixture.coordinator.resolve({
				decisionId: "call-approval",
				choice: "approve_once",
				signal: new AbortController().signal,
			}), (error: unknown) => isCrash(error, target));
			assert.equal(fixture.executeCount(), 0);
			const effect = fixture.store.loadState("session-approval", "node_effect_checkpoint") as {
				readonly status: ApprovalResolution["status"];
			};
			assert.equal(effect.status, target === "approval_after_resolution" ? "approved" : "executing");

			const reopened = fixture.reopen();
			if (target === "approval_after_resolution") {
				const completed = await reopened.resolve({
					decisionId: "call-approval",
					choice: "approve_once",
					signal: new AbortController().signal,
				});
				assert.equal(completed.status, "completed");
				assert.equal(fixture.executeCount(), 1);
			} else {
				assert.equal(reopened.recover()?.status, "interrupted");
				assert.equal(fixture.executeCount(), 0);
				assert.equal(toolResultCount(fixture.store, "session-approval", "call-approval"), 1);
				assert.equal(reopened.recover(), undefined);
			}
		});
	}
});

test("a filesystem commit followed by a thrown result becomes one unknown effect", async (t) => {
	const fixture = await approvalFixture(t, "filesystem_after_commit", { routerThrows: true });
	fixture.coordinator.suspend(approvalSuspension());

	const result = await fixture.coordinator.resolve({
		decisionId: "call-approval",
		choice: "approve_once",
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "interrupted");
	assert.equal(fixture.executeCount(), 1);
	assert.equal(toolResultCount(fixture.store, "session-approval", "call-approval"), 1);
	assert.equal(fixture.reopen().recover(), undefined);
});

test("a crash while committing a tool result rolls back and recovers one unknown result", async (t) => {
	const fixture = await approvalFixture(t, "approval_result_after_tool", {
		storageFailpoint: true,
	});
	fixture.coordinator.suspend(approvalSuspension());

	await assert.rejects(() => fixture.coordinator.resolve({
		decisionId: "call-approval",
		choice: "approve_once",
		signal: new AbortController().signal,
	}), (error: unknown) => hasCode(error, "persistence_error"));
	assert.equal(toolResultCount(fixture.store, "session-approval", "call-approval"), 0);
	assert.equal(fixture.reopen().recover()?.status, "interrupted");
	assert.equal(toolResultCount(fixture.store, "session-approval", "call-approval"), 1);
});

test("a crash after summary response leaves an in-progress checkpoint and never resends", async () => {
	const conversation = compactionConversation();
	const store = new FaultCompactionStore(conversation);
	let summaryCalls = 0;
	const options = compactionOptions(store, async () => {
		summaryCalls += 1;
		return "fixture summary";
	}, crashAt("compaction_after_summary_request"));
	const coordinator = new CompactionCoordinator(options);

	await assert.rejects(() => coordinator.compact(compactInput(conversation)), (error: unknown) => (
		isCrash(error, "compaction_after_summary_request")
	));
	assert.equal(summaryCalls, 1);
	assert.equal(store.state?.status, "in_progress");
	assert.equal(store.commitCount, 0);

	const reopened = new CompactionCoordinator({ ...options, failpoint: () => {} });
	const recovered = await reopened.compact(compactInput(conversation));
	assert.equal(recovered.status, "interrupted");
	assert.equal(summaryCalls, 1);
	assert.equal(store.commitCount, 0);
});

test("snapshot rename crash preserves the prior complete snapshot", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-m5-snapshot-fault-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const initialStore = new TranscriptSnapshotStore({ homeDir: root });
	await initialStore.write(snapshot("before"));
	const crashing = new TranscriptSnapshotStore({
		homeDir: root,
		failpoint: (name) => {
			if (name === "snapshot_before_rename") throw new InjectedCrash(name);
		},
	});

	await assert.rejects(() => crashing.write(snapshot("after")), (error: unknown) => (
		isCrash(error, "snapshot_before_rename")
	));
	const payload = JSON.parse(await readFile(initialStore.snapshotPath("session-snapshot"), "utf8")) as {
		readonly transcript: readonly { readonly text: string }[];
	};
	assert.equal(payload.transcript[0]?.text, "before");
});

test("memory topic/index crashes leave one discoverable topic and no false index entry", async (t) => {
	for (const target of ["memory_after_topic_write", "memory_before_index_write"]) {
		await t.test(target, async (subtest) => {
			const root = await mkdtemp(join(tmpdir(), "mycli-m5-memory-fault-"));
			subtest.after(() => rm(root, { recursive: true, force: true }));
			const workspace = join(root, "workspace");
			const { mkdir } = await import("node:fs/promises");
			await mkdir(workspace);
			const options = {
				homeDir: join(root, "home"),
				workspaceRoot: workspace,
				failpoint: crashAt(target),
			};
			const store = new MemoryStore(options);

			await assert.rejects(() => store.remember({
				kind: "project",
				name: "Fixture Topic",
				description: "fixture topic",
				content: "fixture memory body",
			}), (error: unknown) => isCrash(error, target));
			const reopened = new MemoryStore({ ...options, failpoint: () => {} });
			const memories = await reopened.scan();
			assert.equal(memories.length, 1);
			assert.equal(memories[0]?.name, "Fixture Topic");
			assert.doesNotMatch((await reopened.loadEntrypoint()).content, /fixture_topic\.md/u);
		});
	}
});

test("session prepare/commit crashes preserve generation isolation", async () => {
	for (const target of ["session_after_prepare", "session_after_commit"]) {
		const options = {
			initial: preparedSession("source"),
			prepare: async (sessionId: string) => preparedSession(sessionId),
			listSessions: () => [],
			loadSessionLineage: () => [],
			failpoint: crashAt(target),
		};
		const coordinator = new SessionCoordinator(options);

		await assert.rejects(() => coordinator.resume("target"), (error: unknown) => (
			isCrash(error, target)
		));
		if (target === "session_after_prepare") {
			assert.equal(coordinator.snapshot().sessionId, "source");
			assert.equal(coordinator.snapshot().generation, 1);
		} else {
			assert.equal(coordinator.snapshot().sessionId, "target");
			assert.equal(coordinator.snapshot().generation, 2);
			const resumed = await coordinator.resume("target");
			assert.equal(resumed.generation, 2);
		}
	}
});

function crashAt(target: string): (name: string) => void {
	return (name) => {
		if (name === target) throw new InjectedCrash(name);
	};
}

function isCrash(error: unknown, target: string): boolean {
	return error instanceof InjectedCrash && error.failpoint === target;
}

function emptyQueue(sessionId: string): QueueSnapshot {
	return Object.freeze({
		sessionId,
		revision: 0,
		pendingSteers: Object.freeze([]),
		rejectedSteers: Object.freeze([]),
		followUps: Object.freeze([]),
	});
}

async function approvalFixture(
	t: TestContext,
	target: string,
	options: { readonly routerThrows?: boolean; readonly storageFailpoint?: boolean } = {},
) {
	const root = await mkdtemp(join(tmpdir(), "mycli-m5-approval-fault-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let executeCount = 0;
	const store = new SQLiteSessionStore({
		dbPath: join(root, "sessions.db"),
		clock: () => NOW,
		ownerId: "fixture-owner",
		processId: process.pid,
		isProcessAlive: () => true,
		...(options.storageFailpoint ? {
			stateFailpoint: (name) => {
				if (name === target) throw new InjectedCrash(name);
			},
		} : {}),
	});
	t.after(() => store.close());
	store.reserveTurn({
		sessionId: "session-approval",
		clientTurnId: "client-approval",
		turnId: "turn-approval",
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot: root,
		threadId: "session-approval",
		userText: "write fixture",
		startedAt: NOW,
	});
	store.appendAssistantToolCalls({
		sessionId: "session-approval",
		clientTurnId: "client-approval",
		assistantText: "",
		calls: [{
			callId: "call-approval",
			name: "Write",
			argumentsJson: JSON.stringify({ file_path: "fixture.txt", content: "fixture" }),
		}],
		responseId: "response-approval",
	});
	const router: ToolRouterContract = {
		execute: async (call): Promise<ToolExecutionResult> => {
			executeCount += 1;
			if (options.routerThrows) throw new InjectedCrash("filesystem_after_commit");
			return {
				callId: call.callId,
				toolName: call.name,
				success: true,
				modelOutput: "fixture write complete",
				summary: "fixture write complete",
				metadata: { path: "fixture.txt", status: "created" },
			};
		},
	};
	const create = (failpoint?: (name: string) => void) => new ApprovalContinuationCoordinator({
		sessionId: "session-approval",
		workspaceRoot: root,
		threadId: "session-approval",
		store,
		toolRouter: router,
		clock: () => NOW,
		...(failpoint ? { failpoint } : {}),
	});
	return {
		store,
		coordinator: create(options.storageFailpoint || options.routerThrows ? undefined : crashAt(target)),
		reopen: () => create(),
		executeCount: () => executeCount,
	};
}

function approvalSuspension() {
	return {
		clientTurnId: "client-approval",
		turnId: "turn-approval",
		userMessage: "write fixture",
		providerProtocol: "responses" as const,
		call: {
			callId: "call-approval",
			name: "Write",
			argumentsJson: JSON.stringify({ file_path: "fixture.txt", content: "fixture" }),
		},
		remainingCalls: [],
		conversation: [{ role: "user" as const, content: "write fixture" }],
		assistantText: "",
		responseId: "response-approval",
		usage: {},
		preview: "Write fixture.txt",
		reason: "approval required",
	};
}

function toolResultCount(store: SQLiteSessionStore, sessionId: string, callId: string): number {
	return store.loadConversationItems(sessionId).filter(
		(item) => item.type === "tool_result" && item.callId === callId,
	).length;
}

class FaultCompactionStore {
	state: Readonly<Record<string, unknown>> | undefined;
	commitCount = 0;

	constructor(readonly conversation: readonly CanonicalConversationItem[]) {}

	loadState(): unknown | undefined {
		return this.state;
	}

	saveState(input: SaveStateInput): void {
		this.state = input.payload as Readonly<Record<string, unknown>>;
	}

	deleteState(): void {
		this.state = undefined;
	}

	loadHistoryItems(): readonly Readonly<Record<string, unknown>>[] {
		return this.conversation.map((item, index) => ({
			id: `history-${index}`,
			type: item.type === "user" ? "user_message" : "assistant_message",
			text: "text" in item ? item.text : "",
			metadata: {},
		}));
	}

	commitCompaction(input: CommitCompactionInput): void {
		this.commitCount += 1;
		this.state = input.checkpoint;
	}
}

function compactionOptions(
	store: FaultCompactionStore,
	summarize: CompactionCoordinatorOptions["summarize"],
	failpoint: (name: string) => void,
): CompactionCoordinatorOptions & { readonly failpoint: (name: string) => void } {
	return {
		sessionId: "session-compact",
		workspaceRoot: "/workspace",
		threadId: "session-compact",
		store,
		tokenLimit: 64,
		reservedOutputTokens: 0,
		triggerRatio: 0.1,
		tailTurns: 1,
		tailMaxTokens: 64,
		minSavingsRatio: 0,
		summaryMaxTokens: 64,
		rehydrationMaxFiles: 0,
		rehydrationMaxItemTokens: 0,
		rehydrationMaxTotalTokens: 0,
		summarize,
		createCheckpointId: () => "checkpoint-compact",
		clock: () => NOW,
		failpoint,
	};
}

function compactionConversation(): readonly CanonicalConversationItem[] {
	return Object.freeze([
		{ type: "user", text: `old request ${"context ".repeat(40)}` },
		{ type: "assistant", text: `old answer ${"result ".repeat(40)}` },
		{ type: "user", text: `tail request ${"context ".repeat(20)}` },
		{ type: "assistant", text: `tail answer ${"result ".repeat(20)}` },
		{ type: "user", text: "current request" },
	]);
}

function compactInput(conversation: readonly CanonicalConversationItem[]) {
	return {
		clientTurnId: "client-compact",
		turnId: "turn-compact",
		source: "pre_turn" as const,
		conversation,
		freshItemIds: new Set(["history-4"]),
		emit: () => {},
		signal: new AbortController().signal,
	};
}

function snapshot(text: string) {
	return {
		schema_version: 2 as const,
		session_id: "session-snapshot",
		cwd: "/workspace",
		state: "idle" as const,
		message_count: 1,
		created_at: NOW,
		updated_at: NOW,
		transcript: [{ id: "item-1", type: "user_message" as const, text }],
	};
}

function preparedSession(sessionId: string): PreparedSession<{ readonly name: string }> {
	return {
		sessionId,
		workspaceRoot: "/workspace",
		threadId: sessionId,
		transcript: [],
		queue: emptyQueue(sessionId),
		suspendedTurn: false,
		readOnly: false,
		binding: { name: `runtime-${sessionId}` },
	};
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error
		&& "code" in error
		&& (error as Error & { readonly code: unknown }).code === code;
}
