import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	analyzeV9TranscriptStorage,
	SQLiteSessionStore,
	StorageFailure,
} from "../../../src/index.ts";

const NOW = "2026-08-14T00:00:00.000Z";

test("analyzes v9 transcript bytes, duplication, shapes, amplification, and headroom read-only", async (t) => {
	const fixture = await databaseFixture(t);
	const repeatedOutput = `shared:${"x".repeat(256)}`;
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: () => NOW });
	store.reserveTurn({
		sessionId: "private-session",
		clientTurnId: "private-client-turn",
		clientUserMessageId: "private-user-message",
		turnId: "private-turn",
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot: fixture.root,
		threadId: "private-thread",
		userText: repeatedOutput,
		startedAt: NOW,
	});
	store.appendAssistantToolCalls({
		sessionId: "private-session",
		clientTurnId: "private-client-turn",
		assistantText: "Reading.",
		calls: [{ callId: "private-call", name: "Read", argumentsJson: "{}" }],
	});
	store.appendToolResult({
		sessionId: "private-session",
		clientTurnId: "private-client-turn",
		result: {
			callId: "private-call",
			toolName: "Read",
			output: repeatedOutput,
			success: true,
		},
		summary: "Read completed",
	});
	store.completeTurn({
		sessionId: "private-session",
		clientTurnId: "private-client-turn",
		assistantText: "Done.",
		usage: { input_tokens: 1, output_tokens: 1 },
		completedAt: NOW,
	});
	store.close();

	const before = await stat(fixture.dbPath);
	const analysis = analyzeV9TranscriptStorage({ dbPath: fixture.dbPath });
	const after = await stat(fixture.dbPath);

	assert.equal(analysis.schemaVersion, 9);
	assert.equal(analysis.tables.length, 4);
	assert.equal(
		analysis.totalPayloadBytes,
		analysis.tables.reduce((total, table) => total + table.payloadBytes, 0),
	);
	assert.ok(analysis.largeContent.duplicateBytes >= repeatedOutput.length);
	assert.ok(analysis.largeContent.crossTableDuplicateBytes >= repeatedOutput.length);
	assert.equal(analysis.perTurn.turnCount, 1);
	assert.ok(analysis.perTurn.persistedPayloadBytes > analysis.perTurn.estimatedCanonicalPayloadBytes);
	assert.ok(analysis.perTurn.writeAmplificationRatio > 1);
	assert.equal(analysis.invalidProjections.providerSessionCount, 0);
	assert.equal(analysis.invalidProjections.readableSessionCount, 0);
	assert.ok(analysis.migrationHeadroom.requiredFreeBytes > 0);
	assert.ok((analysis.migrationHeadroom.availableFreeBytes ?? 0) > 0);
	assert.equal(after.size, before.size);
	assert.equal(after.mtimeMs, before.mtimeMs);
	const rendered = JSON.stringify(analysis);
	for (const privateValue of [
		"private-session",
		"private-client-turn",
		"private-user-message",
		"private-turn",
		"private-call",
		repeatedOutput,
	]) {
		assert.equal(rendered.includes(privateValue), false);
	}
});

test("counts malformed legacy rows without exposing their payload or identity", async (t) => {
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: () => NOW });
	store.close();
	const database = new Database(fixture.dbPath);
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at, updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run("secret-broken-session", fixture.root, "thread", NOW, NOW, NOW, "inactive");
	database.prepare(`
		INSERT INTO conversation_messages (session_id, message_index, payload_json)
		VALUES (?, 0, ?)
	`).run("secret-broken-session", "{secret-provider-payload");
	database.prepare(`
		INSERT INTO history_items (session_id, item_id, payload_json)
		VALUES (?, ?, ?)
	`).run("secret-broken-session", "secret-item", "{secret-history-payload");
	database.prepare(`
		INSERT INTO turn_rollouts (session_id, turn_id, payload_json)
		VALUES (?, ?, ?)
	`).run("secret-broken-session", "secret-turn", "{secret-rollout-payload");
	database.close();

	const analysis = analyzeV9TranscriptStorage({ dbPath: fixture.dbPath });

	assert.equal(analysis.invalidProjections.providerSessionCount, 1);
	assert.equal(analysis.invalidProjections.readableSessionCount, 1);
	assert.equal(analysis.invalidProjections.invalidConversationRowCount, 1);
	assert.equal(analysis.invalidProjections.invalidHistoryRowCount, 1);
	assert.equal(analysis.invalidProjections.invalidRolloutRowCount, 1);
	assert.deepEqual(
		analysis.legacyShapes.filter((shape) => shape.shape === "invalid_json")
			.map((shape) => [shape.table, shape.rowCount]),
		[
			["conversation_messages", 1],
			["history_items", 1],
			["turn_rollouts", 1],
		],
	);
	assert.equal(JSON.stringify(analysis).includes("secret"), false);
});

test("rejects non-v9 databases with bounded diagnostics", async (t) => {
	const fixture = await databaseFixture(t);
	const database = new Database(fixture.dbPath);
	database.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
	database.prepare("INSERT INTO schema_version (version) VALUES (8)").run();
	database.close();

	assert.throws(
		() => analyzeV9TranscriptStorage({ dbPath: fixture.dbPath }),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.expected_version === 9
			&& error.diagnostics.actual_version === 8
			&& !error.message.includes(fixture.dbPath),
	);
});

async function databaseFixture(t: test.TestContext): Promise<{
	readonly root: string;
	readonly dbPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-v9-analyzer-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return { root, dbPath: join(root, "sessions.db") };
}
