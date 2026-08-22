import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	openRuntimeSessionStore,
	createV10SessionDatabase,
	createV11SessionDatabase,
	createV12SessionDatabase,
	SQLiteSessionStore,
	SQLiteTranscriptEventRepository,
	StorageFailure,
} from "../src/index.ts";

const NOW = "2026-08-14T00:00:00.000Z";

test("opens new and empty session databases as hash-only schema v12", async (t) => {
	for (const existingEmptyFile of [false, true]) {
		const fixture = await databaseFixture(t);
		if (existingEmptyFile) await writeFile(fixture.dbPath, "");
		const store = openRuntimeSessionStore({ dbPath: fixture.dbPath, clock: () => NOW });
		assert.ok(store instanceof SQLiteTranscriptEventRepository);
		store.close();

		const database = new Database(fixture.dbPath, { readonly: true });
		assert.equal(database.prepare("SELECT version FROM schema_version").pluck().get(), 12);
		assert.equal(database.prepare(`
			SELECT COUNT(*) FROM sqlite_master
			WHERE type = 'table' AND name IN (
				'session_content_blobs', 'transcript_event_blob_refs', 'model_input_blob_refs'
			)
		`).pluck().get(), 3);
		assert.deepEqual(database.prepare(`
			PRAGMA table_info(provider_request_manifests)
		`).all().map((row) => (row as { readonly name: string }).name), [
			"request_id",
			"session_id",
			"turn_id",
			"provider_step",
			"manifest_blob_id",
			"request_signature",
			"logical_input_sha256",
			"logical_request_sha256",
			"previous_request_id",
			"boundary",
			"created_at",
		]);
		assert.equal(database.prepare(`
			SELECT COUNT(*) FROM sqlite_master
			WHERE type = 'table' AND name IN (
				'conversation_messages', 'history_items', 'turn_rollouts', 'session_summaries'
			)
		`).pluck().get(), 0);
		database.close();
	}
});

test("reopens v12 and rejects v9/v10/v11 without modifying them", async (t) => {
	const legacy = await databaseFixture(t);
	new SQLiteSessionStore({ dbPath: legacy.dbPath }).close();
	const normalized = await databaseFixture(t);
	createV10SessionDatabase({ dbPath: normalized.dbPath });
	const blobBacked = await databaseFixture(t);
	createV11SessionDatabase({ dbPath: blobBacked.dbPath });
	for (const [dbPath, version] of [
		[legacy.dbPath, 9],
		[normalized.dbPath, 10],
		[blobBacked.dbPath, 11],
	] as const) {
		const before = schemaObjects(dbPath);
		assert.throws(
			() => openRuntimeSessionStore({ dbPath }),
			(error: unknown) => error instanceof StorageFailure
				&& error.diagnostics.expected_version === 12
				&& error.diagnostics.actual_version === version,
		);
		assert.equal(schemaVersion(dbPath), version);
		assert.deepEqual(schemaObjects(dbPath), before);
	}

	const current = await databaseFixture(t);
	createV12SessionDatabase({ dbPath: current.dbPath });
	const currentStore = openRuntimeSessionStore({ dbPath: current.dbPath });
	assert.ok(currentStore instanceof SQLiteTranscriptEventRepository);
	currentStore.close();
	assert.equal(schemaVersion(current.dbPath), 12);
});

test("rejects an unsupported marker without installing either runtime schema", async (t) => {
	const fixture = await databaseFixture(t);
	const database = new Database(fixture.dbPath);
	database.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
	database.prepare("INSERT INTO schema_version (version) VALUES (13)").run();
	database.close();

	assert.throws(
		() => openRuntimeSessionStore({ dbPath: fixture.dbPath }),
		(error: unknown) => error instanceof StorageFailure
			&& error.message === "persistence_error: unsupported session schema version"
			&& error.diagnostics.expected_version === 12
			&& error.diagnostics.actual_version === 13,
	);
	const check = new Database(fixture.dbPath, { readonly: true });
	assert.deepEqual(check.prepare(`
		SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
	`).pluck().all(), ["schema_version"]);
	check.close();
});

test("provides the production compatibility surface from normalized events", async (t) => {
	const fixture = await databaseFixture(t);
	const store = openRuntimeSessionStore({ dbPath: fixture.dbPath, clock: () => NOW });
	if (!(store instanceof SQLiteTranscriptEventRepository)) assert.fail("expected normalized store");
	t.after(() => store.close());

	assert.equal(store.importLegacyConversation({
		sessionId: "legacy",
		workspaceRoot: fixture.root,
		threadId: "legacy",
		messages: [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi" },
		],
	}), true);
	assert.equal(store.importLegacyConversation({
		sessionId: "legacy",
		workspaceRoot: fixture.root,
		threadId: "legacy",
		messages: [{ role: "user", content: "stale" }],
	}), false);
	assert.deepEqual(store.loadConversation("legacy"), [
		{ role: "user", content: "hello" },
		{ role: "assistant", content: "hi" },
	]);

	store.reserveTurn({
		sessionId: "runtime",
		clientTurnId: "client-1",
		clientUserMessageId: "message-1",
		turnId: "turn-1",
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot: fixture.root,
		threadId: "runtime",
		userText: "question",
		startedAt: NOW,
	});
	store.completeTurn({
		sessionId: "runtime",
		clientTurnId: "client-1",
		assistantText: "answer",
		usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
		lastTokenUsage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
		responseId: "resp-1",
		completedAt: NOW,
	});
	assert.deepEqual(store.loadTurnRollouts("runtime").map((rollout) => ({
		status: rollout.status,
		stopReason: rollout.stop_reason,
		usage: (rollout.continuation_state as Readonly<Record<string, unknown>>).usage,
	})), [{
		status: "completed",
		stopReason: "assistant_completed",
		usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
	}]);
	assert.deepEqual(store.loadRecentSessionSummaries("runtime", 8), []);
	assert.deepEqual(store.cleanupLegacySessionPayloads(), {
		compactedRolloutCount: 0,
		deletedStateCount: 0,
		removedPayloadBytes: 0,
		remainingCompactableRolloutCount: 0,
		remainingRemovableStateCount: 0,
		...storageMetrics(store.sessionMaintenanceReport()),
		dryRun: false,
	});
});

function schemaVersion(dbPath: string): number {
	const database = new Database(dbPath, { readonly: true });
	try {
		return Number(database.prepare("SELECT version FROM schema_version").pluck().get());
	} finally {
		database.close();
	}
}

function schemaObjects(dbPath: string): readonly Readonly<Record<string, unknown>>[] {
	const database = new Database(dbPath, { readonly: true });
	try {
		return database.prepare(`
			SELECT type, name, tbl_name, sql
			FROM sqlite_master
			WHERE name NOT LIKE 'sqlite_%'
			ORDER BY type, name
		`).all() as readonly Readonly<Record<string, unknown>>[];
	} finally {
		database.close();
	}
}

function storageMetrics(report: Readonly<{
	readonly dbSizeBytes: number;
	readonly pageCount: number;
	readonly freelistCount: number;
	readonly pageSize: number;
}>): Readonly<Record<string, unknown>> {
	return {
		dbSizeBytes: report.dbSizeBytes,
		pageCount: report.pageCount,
		freelistCount: report.freelistCount,
		pageSize: report.pageSize,
	};
}

async function databaseFixture(t: test.TestContext): Promise<{
	readonly root: string;
	readonly dbPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-runtime-session-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, ".mycli"));
	return { root, dbPath: join(root, ".mycli", "sessions.db") };
}
