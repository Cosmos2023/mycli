import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SQLiteSessionStore, StorageFailure } from "../src/index.ts";

const NOW = "2026-08-06T00:00:00.000Z";

test("forks a bounded conversation prefix and records session lineage atomically", async (t) => {
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: () => NOW });
	t.after(() => store.close());
	seedCompletedTurn(store, fixture.root);

	const forked = store.forkSession({
		sourceSessionId: "source",
		targetSessionId: "branch",
		forkPoint: 1,
	});

	assert.deepEqual(forked, {
		sourceSessionId: "source",
		targetSessionId: "branch",
		forkPoint: 1,
		messageCount: 1,
	});
	assert.deepEqual(store.loadConversation("branch"), [
		{ role: "user", content: "inspect the repository" },
	]);
	assert.deepEqual(store.loadSessionLineage("branch"), [
		{ sessionId: "source" },
		{ sessionId: "branch", parentId: "source", forkPoint: 1 },
	]);
	assert.equal(store.loadHistoryItems("branch").length, 1);
	assert.equal(store.loadSession("branch")?.workspaceRoot, fixture.root);

	assert.throws(
		() => store.forkSession({ sourceSessionId: "source", targetSessionId: "branch" }),
		(error: unknown) => error instanceof StorageFailure
			&& error.message === "persistence_error: target session already exists",
	);
	assert.throws(
		() => store.forkSession({ sourceSessionId: "source", targetSessionId: "bad", forkPoint: 99 }),
		(error: unknown) => error instanceof StorageFailure
			&& error.message === "persistence_error: fork point is outside the conversation",
	);
	assert.equal(store.loadSession("bad"), undefined);
});

test("searches session messages with workspace filtering and bounded snippets", async (t) => {
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: () => NOW });
	t.after(() => store.close());
	seedCompletedTurn(store, fixture.root);

	const results = store.searchMessages("repository", {
		workspaceRoot: fixture.root,
		limit: 20,
	});

	assert.ok(results.length >= 1);
	assert.ok(results.every((result) => result.sessionId === "source"));
	assert.ok(results.some((result) => result.role === "user"));
	assert.ok(results.some((result) => /repository/iu.test(result.snippet)));
	assert.ok(results.every((result) => result.snippet.length <= 160));
	assert.deepEqual(store.searchMessages("repository", {
		workspaceRoot: join(fixture.root, "elsewhere"),
		limit: 20,
	}), []);
	assert.deepEqual(store.searchMessages("   "), []);
});

test("reports and applies bounded session maintenance operations", async (t) => {
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: () => NOW });
	t.after(() => store.close());
	seedCompletedTurn(store, fixture.root);
	const database = await openDatabase(fixture.dbPath);
	t.after(() => database.close());
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at,
			updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run("empty", fixture.root, "empty", NOW, NOW, NOW, "active");

	const report = store.sessionMaintenanceReport({ workspaceRoot: fixture.root });
	assert.equal(report.dryRun, true);
	assert.equal(report.workspaceSessionCount, 2);
	assert.equal(report.emptySessionCount, 1);
	assert.deepEqual(report.emptySessionCandidates.map((candidate) => candidate.sessionId), ["empty"]);

	const applied = store.cleanupEmptySessions({ workspaceRoot: fixture.root });
	assert.equal(applied.dryRun, false);
	assert.deepEqual(applied.deletedSessionIds, ["empty"]);
	assert.equal(store.loadSession("empty"), undefined);
	assert.ok(store.loadSession("source"));

	const orphaned = store.cleanupOrphanedSessionRows();
	assert.equal(orphaned.dryRun, false);
	assert.equal(orphaned.totalDeletedRows, 0);
	const vacuumed = store.vacuumSessionStorage();
	assert.equal(vacuumed.dryRun, false);
	assert.ok(vacuumed.afterPageCount >= 0);
	assert.ok(vacuumed.pageSize > 0);
});

function seedCompletedTurn(store: SQLiteSessionStore, workspaceRoot: string): void {
	store.reserveTurn({
		sessionId: "source",
		clientTurnId: "client-1",
		clientUserMessageId: "user-1",
		turnId: "turn-1",
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot,
		threadId: "source",
		userText: "inspect the repository",
		startedAt: NOW,
	});
	store.completeTurn({
		sessionId: "source",
		clientTurnId: "client-1",
		assistantText: "Repository inspected.",
		usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
		completedAt: NOW,
	});
}

async function databaseFixture(t: test.TestContext): Promise<{
	readonly root: string;
	readonly dbPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-session-operations-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return { root, dbPath: join(root, ".mycli", "sessions.db") };
}

async function openDatabase(path: string) {
	const module = await import("better-sqlite3");
	return new module.default(path);
}
