import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	openRuntimeSessionStore,
	SessionMetadataConflictError,
	SessionStateError,
} from "../../src/index.ts";

test("session metadata updates atomically and controls archive visibility", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-session-metadata-"));
	const store = openRuntimeSessionStore({
		dbPath: join(root, "sessions.db"),
		reconcileRuntimeState: false,
	});
	t.after(() => store.close());
	t.after(() => rm(root, { recursive: true, force: true }));
	seedSession(store, "session-one");

	assert.deepEqual(store.loadSessionMetadata("session-one"), {
		revision: 0,
		archived: false,
		deleted: false,
	});
	const named = store.updateSessionMetadata({
		sessionId: "session-one",
		expectedRevision: 0,
		title: "Release investigation",
	});
	assert.deepEqual(named, {
		revision: 1,
		archived: false,
		deleted: false,
		title: "Release investigation",
	});
	assert.throws(
		() => store.updateSessionMetadata({
			sessionId: "session-one",
			expectedRevision: 0,
			archived: true,
		}),
		(error: unknown) => error instanceof SessionMetadataConflictError,
	);

	const archived = store.updateSessionMetadata({
		sessionId: "session-one",
		expectedRevision: named.revision,
		archived: true,
	});
	assert.deepEqual(store.listSessions(), []);
	assert.equal(store.listSessions({ includeArchived: true })[0]?.title, named.title);
	assert.equal(
		store.listSessions({ includeArchived: true, search: "release" })[0]?.sessionId,
		"session-one",
	);

	store.updateSessionMetadata({
		sessionId: "session-one",
		expectedRevision: archived.revision,
		deleted: true,
	});
	assert.deepEqual(store.listSessions({ includeArchived: true }), []);
	assert.equal(store.listSessions({ includeArchived: true, includeDeleted: true }).length, 1);
});

test("session summaries batch state and expose active and stale ownership without process ids", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-session-summary-state-"));
	const dbPath = join(root, "sessions.db");
	const liveProcesses = new Set([101, 202]);
	const isProcessAlive = (processId: number): boolean => liveProcesses.has(processId);
	const first = openRuntimeSessionStore({
		dbPath,
		ownerId: "first-window",
		processId: 101,
		isProcessAlive,
		reconcileRuntimeState: false,
	});
	seedSession(first, "owned-session");
	first.saveState({
		sessionId: "owned-session",
		workspaceRoot: "/workspace",
		threadId: "owned-session",
		key: "session_preferences",
		payload: { state_version: 1, model: "test-model" },
	});
	first.acquireSessionLease("owned-session");
	assert.equal(first.loadSession("owned-session")?.leaseState, "owned");

	const second = openRuntimeSessionStore({
		dbPath,
		ownerId: "second-window",
		processId: 202,
		isProcessAlive,
		reconcileRuntimeState: false,
	});
	t.after(() => {
		first.close();
		second.close();
	});
	t.after(() => rm(root, { recursive: true, force: true }));
	assert.equal(second.loadSession("owned-session")?.leaseState, "active");
	assert.deepEqual(second.loadStates(["owned-session"], ["session_preferences"]), [{
		sessionId: "owned-session",
		key: "session_preferences",
		payload: { state_version: 1, model: "test-model" },
	}]);

	liveProcesses.delete(101);
	assert.equal(second.loadSession("owned-session")?.leaseState, "stale");
	assert.equal(second.acquireSessionLease("owned-session"), true);
	assert.equal(second.loadSession("owned-session")?.leaseState, "owned");
});

test("session summary reports recoverable pending and invalid metadata state", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-session-summary-invalid-"));
	const dbPath = join(root, "sessions.db");
	const seed = openRuntimeSessionStore({ dbPath, reconcileRuntimeState: false });
	seedSession(seed, "pending-session");
	seed.close();
	const database = new Database(dbPath);
	try {
		database.prepare(`
			INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
			VALUES (?, 'pending_decision', ?, ?), (?, 'session_metadata', ?, ?)
		`).run(
			"pending-session",
			JSON.stringify({ state_version: 1 }),
			"2026-08-30T00:00:00.000Z",
			"pending-session",
			JSON.stringify({ state_version: 1, revision: 1 }),
			"2026-08-30T00:00:00.000Z",
		);
	} finally {
		database.close();
	}
	const store = openRuntimeSessionStore({ dbPath, reconcileRuntimeState: false });
	t.after(() => store.close());
	t.after(() => rm(root, { recursive: true, force: true }));
	const overview = store.loadSession("pending-session");
	assert.equal(overview?.pendingState, "approval");
	assert.equal(overview?.metadataIssue, "session_state_invalid");
	assert.throws(
		() => store.loadSessionMetadata("pending-session"),
		(error: unknown) => error instanceof SessionStateError
			&& error.stateKey === "session_metadata",
	);
});

function seedSession(
	store: ReturnType<typeof openRuntimeSessionStore>,
	sessionId: string,
): void {
	store.importLegacyConversation({
		sessionId,
		workspaceRoot: "/workspace",
		threadId: sessionId,
		messages: [{ role: "user", content: `seed ${sessionId}` }],
	});
}
