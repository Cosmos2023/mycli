import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createV9ProjectionManifest, SQLiteSessionStore } from "../../../src/index.ts";
import {
	createRichV9NormalizationFixture,
	createVersionedLegacyNormalizationFixture,
	LEGACY_SCHEMA_VERSIONS,
	MALFORMED_CONVERSATION_PAYLOAD,
	MALFORMED_HISTORY_PAYLOAD,
	MALFORMED_ROLLOUT_PAYLOAD,
	OPAQUE_VALID_CONVERSATION_PAYLOAD,
	OPAQUE_VALID_HISTORY_PAYLOAD,
	RICH_V9_SESSION_IDS,
} from "../../support/v9-normalization-fixtures.ts";

test("builds reusable v2-v9 fixtures that preserve transcript rows through the v9 adapter", async (t) => {
	for (const sourceSchemaVersion of LEGACY_SCHEMA_VERSIONS) {
		await t.test(`schema v${sourceSchemaVersion}`, async (t) => {
			const fixture = await databaseFixture(t, `mycli-normalization-v${sourceSchemaVersion}-`);
			createVersionedLegacyNormalizationFixture({
				dbPath: fixture.dbPath,
				workspaceRoot: fixture.root,
				sourceSchemaVersion,
			});

			let database = new Database(fixture.dbPath, { readonly: true });
			assert.equal(schemaVersion(database), sourceSchemaVersion);
			const ftsColumns = database.prepare("PRAGMA table_info(conversation_messages_fts)").all()
				.map((row) => String((row as { name: unknown }).name));
			assert.deepEqual(
				ftsColumns,
				sourceSchemaVersion === 9 ? ["payload_json"] : ["session_id", "message_index", "content"],
			);
			database.close();

			const store = new SQLiteSessionStore({ dbPath: fixture.dbPath });
			try {
				assert.deepEqual(store.loadConversation(`fixture-schema-v${sourceSchemaVersion}`), [
					{ role: "user", content: "legacy version payload" },
					{ role: "assistant", content: "legacy version payload answer" },
				]);
			} finally {
				store.close();
			}
			database = new Database(fixture.dbPath, { readonly: true });
			assert.equal(schemaVersion(database), 9);
			database.close();
		});
	}
});

test("builds a rich v9 normalization corpus without copied private content", async (t) => {
	const fixture = await databaseFixture(t, "mycli-normalization-rich-v9-");
	createRichV9NormalizationFixture({ dbPath: fixture.dbPath, workspaceRoot: fixture.root });
	const database = new Database(fixture.dbPath, { readonly: true });
	t.after(() => database.close());

	assert.equal(schemaVersion(database), 9);
	assert.equal(tableExists(database, "transcript_events"), false);
	assert.equal(sessionCount(database), 16);

	const nodeMessages = payloadRows(database, "conversation_messages", RICH_V9_SESSION_IDS.node);
	const nodeUser = nodeMessages[0] as { blocks?: readonly unknown[] };
	const nodeToolBatch = nodeMessages[1] as { tool_calls?: readonly unknown[] };
	assert.equal(nodeUser.blocks?.length, 1);
	assert.equal(nodeToolBatch.tool_calls?.length, 2);

	const pythonMessages = payloadRows(database, "conversation_messages", RICH_V9_SESSION_IDS.python);
	const pythonUser = pythonMessages[0] as {
		readonly content?: unknown;
		readonly metadata?: Readonly<Record<string, unknown>>;
	};
	assert.equal(pythonUser.content, "Python unicode payload: \u4f60\u597d");
	assert.equal(pythonUser.metadata?.source, "python_runtime");
	assert.equal(payloadRows(database, "history_items", RICH_V9_SESSION_IDS.python).length, 4);
	assert.equal(payloadRows(database, "turn_rollouts", RICH_V9_SESSION_IDS.python).length, 1);

	assert.deepEqual(transcriptCounts(database, RICH_V9_SESSION_IDS.conversationOnly), [1, 0, 0]);
	assert.deepEqual(transcriptCounts(database, RICH_V9_SESSION_IDS.historyOnly), [0, 1, 0]);
	const compactionCount = database.prepare(`
		SELECT COUNT(*) AS count FROM history_items
		WHERE session_id = ? AND json_extract(payload_json, '$.type') = 'compaction_boundary'
	`).get(RICH_V9_SESSION_IDS.repeatedCompaction) as { count: number };
	assert.equal(compactionCount.count, 2);
	assert.deepEqual(database.prepare(`
		SELECT parent_id, fork_point FROM conversation_trees WHERE session_id = ?
	`).get(RICH_V9_SESSION_IDS.forkChild), {
		parent_id: RICH_V9_SESSION_IDS.forkParent,
		fork_point: 2,
	});

	const activeTurn = database.prepare(`
		SELECT status FROM runtime_turns WHERE session_id = ?
	`).get(RICH_V9_SESSION_IDS.activeRecovery) as { status: string };
	assert.equal(activeTurn.status, "in_progress");
	assert.deepEqual(database.prepare(`
		SELECT state_key FROM session_state WHERE session_id = ? ORDER BY state_key
	`).all(RICH_V9_SESSION_IDS.activeRecovery).map((row) => (
		String((row as { state_key: unknown }).state_key)
	)), ["node_effect_checkpoint", "pending_decision", "suspended_turn", "turn_record"]);

	assert.equal(rawPayload(database, "conversation_messages", RICH_V9_SESSION_IDS.malformedConversation), MALFORMED_CONVERSATION_PAYLOAD);
	assert.equal(rawPayload(database, "history_items", RICH_V9_SESSION_IDS.malformedHistory), MALFORMED_HISTORY_PAYLOAD);
	assert.equal(rawPayload(database, "turn_rollouts", RICH_V9_SESSION_IDS.malformedRollout), MALFORMED_ROLLOUT_PAYLOAD);
	assert.equal(rawPayload(database, "conversation_messages", RICH_V9_SESSION_IDS.opaqueConversation), OPAQUE_VALID_CONVERSATION_PAYLOAD);
	assert.equal(rawPayload(database, "history_items", RICH_V9_SESSION_IDS.opaqueHistory), OPAQUE_VALID_HISTORY_PAYLOAD);
	assert.doesNotThrow(() => JSON.parse(OPAQUE_VALID_CONVERSATION_PAYLOAD));
	assert.doesNotThrow(() => JSON.parse(OPAQUE_VALID_HISTORY_PAYLOAD));

	const manifest = createV9ProjectionManifest({ dbPath: fixture.dbPath });
	const manifestsByKey = new Map(manifest.sessions.map((session) => [session.sessionKey, session]));
	for (const sessionId of RICH_V9_SESSION_IDS.copiedRealProjectionFailures) {
		const session = manifestsByKey.get(projectionSessionKey(sessionId));
		assert.deepEqual(session?.providerWindow, {
			status: "error",
			errorCode: "persistence_error",
		});
		assert.deepEqual(session?.searchDocuments, {
			status: "error",
			errorCode: "persistence_error",
		});
		assert.equal(session?.readableTranscript.status, "ok");
	}
	const rendered = JSON.stringify(manifest);
	assert.equal(rendered.includes("legacy system item"), false);
	assert.equal(rendered.includes(fixture.root), false);
});

function schemaVersion(database: Database.Database): number {
	return Number((database.prepare("SELECT version FROM schema_version").get() as {
		readonly version: unknown;
	}).version);
}

function sessionCount(database: Database.Database): number {
	return Number((database.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
		readonly count: unknown;
	}).count);
}

function tableExists(database: Database.Database, table: string): boolean {
	return database.prepare(`
		SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
	`).get(table) !== undefined;
}

function transcriptCounts(database: Database.Database, sessionId: string): readonly number[] {
	return ["conversation_messages", "history_items", "turn_rollouts"].map((table) => Number((
		database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`).get(sessionId) as {
			readonly count: unknown;
		}
	).count));
}

function payloadRows(
	database: Database.Database,
	table: "conversation_messages" | "history_items" | "turn_rollouts",
	sessionId: string,
): readonly Readonly<Record<string, unknown>>[] {
	const orderBy = table === "conversation_messages" ? "message_index" : "sequence_no";
	return (database.prepare(`
		SELECT payload_json FROM ${table} WHERE session_id = ? ORDER BY ${orderBy}
	`).all(sessionId) as readonly { payload_json: unknown }[]).map((row) => (
		JSON.parse(String(row.payload_json)) as Readonly<Record<string, unknown>>
	));
}

function rawPayload(
	database: Database.Database,
	table: "conversation_messages" | "history_items" | "turn_rollouts",
	sessionId: string,
): string {
	const row = database.prepare(`
		SELECT payload_json FROM ${table} WHERE session_id = ? LIMIT 1
	`).get(sessionId) as { readonly payload_json: unknown } | undefined;
	assert.ok(row);
	return String(row.payload_json);
}

function projectionSessionKey(sessionId: string): string {
	return createHash("sha256").update(`v9-projection-manifest\0${sessionId}`).digest("hex");
}

async function databaseFixture(
	t: test.TestContext,
	prefix: string,
): Promise<{ readonly root: string; readonly dbPath: string }> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return { root, dbPath: join(root, "sessions.db") };
}
