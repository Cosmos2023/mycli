import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ApprovalTransition, QueueSnapshot, QueuedInput } from "@mycli/core";
import * as storage from "../src/index.ts";

interface M5Store {
	reserveTurn(input: ReturnType<typeof submission>): unknown;
	completeTurn(input: {
		readonly sessionId: string;
		readonly clientTurnId: string;
		readonly assistantText: string;
		readonly usage: Readonly<Record<string, number>>;
		readonly completedAt: string;
	}): unknown;
	loadConversation(sessionId: string): readonly { readonly role: string; readonly content: string }[];
	listSessions(query?: { readonly workspaceRoot?: string; readonly limit?: number }): readonly {
		readonly sessionId: string;
		readonly messageCount: number;
		readonly summaryCount: number;
	}[];
	loadSession(sessionId: string): { readonly sessionId: string } | undefined;
	saveState(input: {
		readonly sessionId: string;
		readonly workspaceRoot: string;
		readonly threadId: string;
		readonly key: string;
		readonly payload: unknown;
	}): void;
	loadState(sessionId: string, key: string): unknown | undefined;
	saveQueueSnapshot(input: {
		readonly sessionId: string;
		readonly workspaceRoot: string;
		readonly threadId: string;
		readonly snapshot: QueueSnapshot;
	}): QueueSnapshot;
	deleteState(sessionId: string, key: string): void;
	appendSessionSummary(input: {
		readonly sessionId: string;
		readonly workspaceRoot: string;
		readonly threadId: string;
		readonly summary: string;
	}): void;
	loadSessionSummaries(sessionId: string): readonly string[];
	loadSessionLineage(sessionId: string): readonly { readonly sessionId: string }[];
	importLegacyConversation(input: {
		readonly sessionId: string;
		readonly workspaceRoot: string;
		readonly threadId: string;
		readonly messages: readonly Readonly<Record<string, unknown>>[];
	}): boolean;
	commitQueuedInputs(input: {
		readonly sessionId: string;
		readonly turnId: string;
		readonly records: readonly QueuedInput[];
	}): QueueSnapshot;
	compareAndSetApproval(input: {
		readonly sessionId: string;
		readonly expectedStatus: string;
		readonly transition: ApprovalTransition;
	}): { readonly status: string; readonly decisionId: string };
	commitCompaction(input: {
		readonly sessionId: string;
		readonly replacementMessages: readonly Readonly<Record<string, unknown>>[];
		readonly summary: string;
		readonly checkpoint: Readonly<Record<string, unknown>>;
	}): void;
	close(): void;
}

type StoreConstructor = new (options: {
	readonly dbPath: string;
	readonly clock?: () => string;
	readonly stateFailpoint?: (name: string) => void;
}) => M5Store;

const NOW = "2026-08-04T00:00:00.000Z";

test("lists sessions by last activity with compatible counts", async (t) => {
	const fixture = await databaseFixture(t);
	const store = createStore(fixture.dbPath);
	t.after(() => store.close());
	store.reserveTurn(submission(fixture.root, "older", "2026-08-03T00:00:00.000Z"));
	store.completeTurn({
		sessionId: "older",
		clientTurnId: "client-older",
		assistantText: "old answer",
		usage: {},
		completedAt: "2026-08-03T00:00:01.000Z",
	});
	store.reserveTurn(submission(fixture.root, "newer", "2026-08-04T00:00:00.000Z"));
	store.appendSessionSummary({
		sessionId: "newer",
		workspaceRoot: fixture.root,
		threadId: "newer",
		summary: "new summary",
	});

	const sessions = store.listSessions({ workspaceRoot: fixture.root, limit: 20 });
	assert.deepEqual(sessions.map((item) => item.sessionId), ["newer", "older"]);
	assert.deepEqual(
		sessions.map((item) => [item.messageCount, item.summaryCount]),
		[[1, 1], [2, 0]],
	);
	assert.equal(store.loadSession("older")?.sessionId, "older");
	assert.equal(store.loadSession("missing"), undefined);
});

test("stores raw Python-compatible state and preserves unknown optional fields", async (t) => {
	const fixture = await databaseFixture(t);
	const store = createStore(fixture.dbPath);
	t.after(() => store.close());
	const payload = queuePayload();
	store.saveState({
		sessionId: "s1",
		workspaceRoot: fixture.root,
		threadId: "s1",
		key: "input_queue",
		payload,
	});

	const loaded = store.loadState("s1", "input_queue") as typeof payload;
	assert.deepEqual(loaded, payload);
	assert.ok(Object.isFrozen(loaded));
	assert.ok(Object.isFrozen(loaded.pending_steers));

	const database = await openDatabase(fixture.dbPath);
	t.after(() => database.close());
	const raw = JSON.parse(String((database.prepare(`
		SELECT payload_json FROM session_state
		WHERE session_id = ? AND state_key = ?
	`).get("s1", "input_queue") as { payload_json: unknown }).payload_json)) as Record<string, unknown>;
	assert.equal(raw.session_id, "s1");
	assert.equal(raw.python_optional_field, "keep-me");
	assert.equal("kind" in raw, false);
	assert.equal("payload" in raw, false);

	store.deleteState("s1", "input_queue");
	assert.equal(store.loadState("s1", "input_queue"), undefined);
});

test("saves queue snapshots without dropping Python optional fields", async (t) => {
	const fixture = await databaseFixture(t);
	const store = createStore(fixture.dbPath);
	t.after(() => store.close());
	store.saveState({
		sessionId: "s1",
		workspaceRoot: fixture.root,
		threadId: "s1",
		key: "input_queue",
		payload: queuePayload(),
	});
	const followUp: QueuedInput = {
		queueId: "q-follow",
		sessionId: "s1",
		clientTurnId: "client-follow",
		targetTurnId: null,
		kind: "follow_up",
		state: "queued",
		text: "continue later",
		imagePaths: [],
		source: "user",
		createdAt: NOW,
		updatedAt: NOW,
	};

	const saved = store.saveQueueSnapshot({
		sessionId: "s1",
		workspaceRoot: fixture.root,
		threadId: "s1",
		snapshot: {
			sessionId: "s1",
			revision: 2,
			pendingSteers: [queuedRecord()],
			rejectedSteers: [],
			followUps: [followUp],
		},
	});

	assert.equal(saved.revision, 2);
	const raw = store.loadState("s1", "input_queue") as ReturnType<typeof queuePayload>;
	assert.equal(raw.python_optional_field, "keep-me");
	assert.equal(raw.follow_ups[0]?.python_record_optional, "keep-record-field");
});

test("queue snapshot writes enforce monotonic revision CAS and idempotency", async (t) => {
	const fixture = await databaseFixture(t);
	const store = createStore(fixture.dbPath);
	t.after(() => store.close());
	const initial: QueueSnapshot = {
		sessionId: "s1",
		revision: 1,
		pendingSteers: [],
		rejectedSteers: [],
		followUps: [],
	};

	assert.equal(store.saveQueueSnapshot({
		sessionId: "s1",
		workspaceRoot: fixture.root,
		threadId: "s1",
		snapshot: initial,
	}).revision, 1);
	assert.equal(store.saveQueueSnapshot({
		sessionId: "s1",
		workspaceRoot: fixture.root,
		threadId: "s1",
		snapshot: initial,
	}).revision, 1);
	assert.throws(() => store.saveQueueSnapshot({
		sessionId: "s1",
		workspaceRoot: fixture.root,
		threadId: "s1",
		snapshot: { ...initial, revision: 3 },
	}), (error: unknown) => hasCode(error, "queue_conflict"));
	assert.throws(() => store.saveQueueSnapshot({
		sessionId: "new-session",
		workspaceRoot: fixture.root,
		threadId: "new-session",
		snapshot: {
			sessionId: "new-session",
			revision: 2,
			pendingSteers: [],
			rejectedSteers: [],
			followUps: [],
		},
	}), (error: unknown) => hasCode(error, "queue_conflict"));
});

test("fails closed for malformed and unsupported persisted state", async (t) => {
	const fixture = await databaseFixture(t);
	const store = createStore(fixture.dbPath);
	t.after(() => store.close());
	store.saveState({
		sessionId: "s1",
		workspaceRoot: fixture.root,
		threadId: "s1",
		key: "input_queue",
		payload: queuePayload(),
	});
	const database = await openDatabase(fixture.dbPath);
	database.prepare(`
		UPDATE session_state SET payload_json = '[]'
		WHERE session_id = 's1' AND state_key = 'input_queue'
	`).run();
	database.close();

	assert.throws(
		() => store.loadState("s1", "input_queue"),
		(error: unknown) => hasCode(error, "session_state_invalid"),
	);
	assert.throws(
		() => store.saveState({
			sessionId: "s1",
			workspaceRoot: fixture.root,
			threadId: "s1",
			key: "compact_checkpoint",
			payload: { ...compactCheckpoint(), version: 2 },
		}),
		(error: unknown) => hasCode(error, "session_state_version_unsupported"),
	);
});

test("loads summaries and lineage in stable order", async (t) => {
	const fixture = await databaseFixture(t);
	const store = createStore(fixture.dbPath);
	store.reserveTurn(submission(fixture.root, "root", NOW));
	store.reserveTurn(submission(fixture.root, "child", NOW));
	store.appendSessionSummary({
		sessionId: "child",
		workspaceRoot: fixture.root,
		threadId: "child",
		summary: "  first  ",
	});
	store.appendSessionSummary({
		sessionId: "child",
		workspaceRoot: fixture.root,
		threadId: "child",
		summary: "second",
	});
	store.close();
	const database = await openDatabase(fixture.dbPath);
	database.prepare(`
		INSERT INTO conversation_trees (session_id, parent_id, fork_point, updated_at)
		VALUES (?, ?, ?, ?), (?, ?, ?, ?)
	`).run("root", null, null, NOW, "child", "root", 1, NOW);
	database.close();
	const reopened = createStore(fixture.dbPath);
	t.after(() => reopened.close());

	assert.deepEqual(reopened.loadSessionSummaries("child"), ["  first  ", "second"]);
	assert.deepEqual(
		reopened.loadSessionLineage("child").map((item) => item.sessionId),
		["root", "child"],
	);
});

test("imports legacy conversation only while canonical SQLite data is absent", async (t) => {
	const fixture = await databaseFixture(t);
	const store = createStore(fixture.dbPath);
	t.after(() => store.close());

	const imported = store.importLegacyConversation({
		sessionId: "legacy",
		workspaceRoot: fixture.root,
		threadId: "legacy",
		messages: [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi" },
		],
	});
	const duplicate = store.importLegacyConversation({
		sessionId: "legacy",
		workspaceRoot: fixture.root,
		threadId: "legacy",
		messages: [{ role: "user", content: "stale replacement" }],
	});

	assert.equal(imported, true);
	assert.equal(duplicate, false);
	assert.deepEqual(store.loadConversation("legacy"), [
		{ role: "user", content: "hello" },
		{ role: "assistant", content: "hi" },
	]);
});

test("rolls back an invalid legacy conversation import", async (t) => {
	const fixture = await databaseFixture(t);
	const store = createStore(fixture.dbPath);
	t.after(() => store.close());

	assert.throws(() => store.importLegacyConversation({
		sessionId: "legacy",
		workspaceRoot: fixture.root,
		threadId: "legacy",
		messages: [
			{ role: "user", content: "valid prefix" },
			{ role: "assistant", content: 42 },
		],
	}), /invalid legacy conversation message/u);
	assert.deepEqual(store.loadConversation("legacy"), []);
});

test("commits queued history and pending removal exactly once", async (t) => {
	const fixture = await databaseFixture(t);
	const store = createStore(fixture.dbPath);
	t.after(() => store.close());
	store.reserveTurn(submission(fixture.root, "s1", NOW));
	store.saveState({
		sessionId: "s1",
		workspaceRoot: fixture.root,
		threadId: "s1",
		key: "input_queue",
		payload: queuePayload(),
	});
	const record = queuedRecord();

	const committed = store.commitQueuedInputs({
		sessionId: "s1",
		turnId: "turn-s1",
		records: [record],
	});
	const duplicate = store.commitQueuedInputs({
		sessionId: "s1",
		turnId: "turn-s1",
		records: [record],
	});

	assert.equal(committed.pendingSteers.length, 0);
	assert.equal(committed.revision, 2);
	assert.deepEqual(duplicate, committed);
	const rawQueue = store.loadState("s1", "input_queue") as ReturnType<typeof queuePayload>;
	assert.equal(rawQueue.follow_ups[0]?.python_record_optional, "keep-record-field");
	assert.deepEqual(store.loadConversation("s1").map((item) => item.content), [
		"message-s1",
		"inspect output",
	]);
	const database = await openDatabase(fixture.dbPath);
	t.after(() => database.close());
	const count = database.prepare(`
		SELECT COUNT(*) AS count FROM history_items
		WHERE session_id = ? AND json_extract(payload_json, '$.metadata.queue_id') = ?
	`).get("s1", "q1") as { count: number };
	assert.equal(count.count, 1);
});

test("rolls back queue history and removal together", async (t) => {
	const fixture = await databaseFixture(t);
	const store = createStore(fixture.dbPath, (name) => {
		if (name === "queue_commit_after_history") throw new Error("failpoint");
	});
	t.after(() => store.close());
	store.reserveTurn(submission(fixture.root, "s1", NOW));
	store.saveState({
		sessionId: "s1",
		workspaceRoot: fixture.root,
		threadId: "s1",
		key: "input_queue",
		payload: queuePayload(),
	});

	assert.throws(() => store.commitQueuedInputs({
		sessionId: "s1",
		turnId: "turn-s1",
		records: [queuedRecord()],
	}));
	const restored = store.loadState("s1", "input_queue") as ReturnType<typeof queuePayload>;
	assert.equal(restored.pending_steers.length, 1);
	const database = await openDatabase(fixture.dbPath);
	t.after(() => database.close());
	const count = database.prepare(`
		SELECT COUNT(*) AS count FROM history_items
		WHERE session_id = ? AND json_extract(payload_json, '$.metadata.queue_id') = ?
	`).get("s1", "q1") as { count: number };
	assert.equal(count.count, 0);
});

test("compare-and-set approval transitions are monotonic and idempotent", async (t) => {
	const fixture = await databaseFixture(t);
	const store = createStore(fixture.dbPath);
	t.after(() => store.close());
	store.saveState({
		sessionId: "s1",
		workspaceRoot: fixture.root,
		threadId: "s1",
		key: "node_effect_checkpoint",
		payload: effectCheckpoint("waiting"),
	});

	const approved = store.compareAndSetApproval({
		sessionId: "s1",
		expectedStatus: "waiting",
		transition: { type: "approve_once" },
	});
	assert.equal(approved.status, "approved");
	assert.equal(store.compareAndSetApproval({
		sessionId: "s1",
		expectedStatus: "waiting",
		transition: { type: "approve_once" },
	}).status, "approved");
	const executing = store.compareAndSetApproval({
		sessionId: "s1",
		expectedStatus: "approved",
		transition: { type: "claim_effect", fingerprint: "sha256:a" },
	});
	assert.equal(executing.status, "executing");
	assert.throws(
		() => store.compareAndSetApproval({
			sessionId: "s1",
			expectedStatus: "executing",
			transition: { type: "approve_once" },
		}),
		(error: unknown) => hasCode(error, "approval_conflict"),
	);
	const completed = store.compareAndSetApproval({
		sessionId: "s1",
		expectedStatus: "executing",
		transition: { type: "complete_effect", resultCallId: "result-1" },
	});
	assert.equal(completed.status, "completed");
	assert.deepEqual(store.loadState("s1", "node_effect_checkpoint"), {
		...effectCheckpoint("completed"),
		fingerprint: "sha256:a",
		result_call_id: "result-1",
	});
});

test("commits compact replacement, summary, checkpoint, and continuation together", async (t) => {
	const fixture = await databaseFixture(t);
	const store = createStore(fixture.dbPath);
	t.after(() => store.close());
	store.reserveTurn(submission(fixture.root, "s1", NOW));
	store.commitCompaction({
		sessionId: "s1",
		replacementMessages: [pythonMessage("user", "[compact-summary]\nsummary")],
		summary: "summary",
		checkpoint: {
			...compactCheckpoint(),
			replacement_messages: [pythonMessage("user", "stale replacement")],
		},
	});

	assert.deepEqual(store.loadConversation("s1"), [
		{ role: "user", content: "[compact-summary]\nsummary" },
	]);
	assert.deepEqual(store.loadSessionSummaries("s1"), ["summary"]);
	assert.deepEqual(store.loadState("s1", "compact_checkpoint"), compactCheckpoint());
	assert.deepEqual(store.loadState("s1", "responses_continuation_state"), {
		response_id: null,
		request_signature: "",
		request_input: [],
		response_output: [],
		eligible: false,
		failure_reason: "compacted_history",
	});
	const database = await openDatabase(fixture.dbPath);
	t.after(() => database.close());
	assert.equal((database.prepare(
		"SELECT COUNT(*) AS count FROM history_items WHERE session_id = ?",
	).get("s1") as { count: number }).count, 1);
});

test("rolls back a compact replacement when checkpoint commit fails", async (t) => {
	const fixture = await databaseFixture(t);
	const store = createStore(fixture.dbPath, (name) => {
		if (name === "compact_after_replacement") throw new Error("failpoint");
	});
	t.after(() => store.close());
	store.reserveTurn(submission(fixture.root, "s1", NOW));

	assert.throws(() => store.commitCompaction({
		sessionId: "s1",
		replacementMessages: [pythonMessage("user", "replacement")],
		summary: "summary",
		checkpoint: compactCheckpoint(),
	}));
	assert.deepEqual(store.loadConversation("s1"), [{ role: "user", content: "message-s1" }]);
	assert.deepEqual(store.loadSessionSummaries("s1"), []);
	assert.equal(store.loadState("s1", "compact_checkpoint"), undefined);
});

function constructor(): StoreConstructor {
	const value = Reflect.get(storage, "SQLiteSessionStore") as StoreConstructor | undefined;
	assert.equal(typeof value, "function");
	return value!;
}

function createStore(dbPath: string, stateFailpoint?: (name: string) => void): M5Store {
	const Store = constructor();
	return new Store({ dbPath, clock: () => NOW, ...(stateFailpoint ? { stateFailpoint } : {}) });
}

function submission(workspaceRoot: string, sessionId: string, startedAt: string) {
	return {
		sessionId,
		clientTurnId: `client-${sessionId}`,
		turnId: `turn-${sessionId}`,
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot,
		threadId: sessionId,
		userText: `message-${sessionId}`,
		startedAt,
	};
}

function queuedRecord(): QueuedInput {
	return {
		queueId: "q1",
		sessionId: "s1",
		clientTurnId: "client-q1",
		targetTurnId: "turn-s1",
		kind: "pending_steer",
		state: "accepted",
		text: "inspect output",
		imagePaths: [],
		source: "user",
		createdAt: NOW,
		updatedAt: NOW,
	};
}

function queuePayload() {
	return {
		session_id: "s1",
		revision: 1,
		pending_steers: [{
			queue_id: "q1",
			session_id: "s1",
			client_turn_id: "client-q1",
			target_turn_id: "turn-s1",
			kind: "pending_steer",
			state: "accepted",
			text: "inspect output",
			image_paths: [],
			source: "user",
			created_at: NOW,
			updated_at: NOW,
		}],
		rejected_steers: [],
		follow_ups: [{
			queue_id: "q-follow",
			session_id: "s1",
			client_turn_id: "client-follow",
			target_turn_id: null,
			kind: "follow_up",
			state: "queued",
			text: "continue later",
			image_paths: [],
			source: "user",
			created_at: NOW,
			updated_at: NOW,
			python_record_optional: "keep-record-field",
		}],
		python_optional_field: "keep-me",
	};
}

function effectCheckpoint(status: string) {
	return {
		session_id: "s1",
		client_turn_id: "client-s1",
		turn_id: "turn-s1",
		decision_id: "decision-1",
		call_id: "call-1",
		tool_name: "Write",
		status,
		updated_at: NOW,
	};
}

function compactCheckpoint() {
	return {
		version: 1,
		turn_id: "turn-s1",
		reason: "context_limit",
		phase: "pre_turn",
		window_number: 1,
		window_id: "window-1",
		history_item_count: 1,
		input_history_hash: "sha256:input",
		replacement_history_hash: "sha256:replacement",
		replacement_messages: [pythonMessage("user", "[compact-summary]\nsummary")],
	};
}

function pythonMessage(role: "user" | "assistant", content: string) {
	return {
		role,
		content,
		tool_call_id: null,
		response_id: null,
		metadata: {},
		blocks: [],
		tool_calls: [],
	};
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error
		&& "code" in error
		&& (error as Error & { code: unknown }).code === code;
}

async function databaseFixture(t: test.TestContext): Promise<{ root: string; dbPath: string }> {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-m5-storage-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return { root, dbPath: join(root, ".mycli", "sessions.db") };
}

async function openDatabase(path: string) {
	const module = await import("better-sqlite3");
	return new module.default(path);
}
