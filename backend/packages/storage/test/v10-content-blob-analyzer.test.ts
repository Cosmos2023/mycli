import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	analyzeV10ContentBlobs,
	createV10SessionDatabase,
	StorageFailure,
} from "../src/index.ts";

const NOW = "2026-08-14T00:00:00.000Z";

test("estimates schema-v10 compression, deduplication, and headroom read-only", async (t) => {
	const fixture = await databaseFixture(t);
	createV10SessionDatabase({ dbPath: fixture.dbPath, clock: () => NOW });
	const repeated = `private-content:${"x".repeat(4_096)}`;
	const database = new Database(fixture.dbPath);
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at, updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, 'active')
	`).run("private-session", fixture.root, "private-session", NOW, NOW, NOW);
	const insertEvent = database.prepare(`
		INSERT INTO transcript_events (
			session_id, event_id, turn_id, event_type, provider_index,
			model_visible, payload_json, created_at
		) VALUES (?, ?, ?, 'assistant_output', ?, 1, ?, ?)
	`);
	for (let index = 0; index < 2; index += 1) {
		insertEvent.run(
			"private-session",
			`private-event-${index}`,
			"private-turn",
			index,
			JSON.stringify({ schemaVersion: 1, payload: { text: repeated } }),
			NOW,
		);
	}
	const modelPayload = JSON.stringify({
		request: "private-provider-request",
		content: "model-input".repeat(1_000),
	});
	database.prepare(`
		INSERT INTO model_input_blobs (blob_id, payload_json, created_at) VALUES (?, ?, ?)
	`).run("private-model-input-blob", modelPayload, NOW);
	database.close();

	const before = await stat(fixture.dbPath);
	const analysis = analyzeV10ContentBlobs({ dbPath: fixture.dbPath });
	const after = await stat(fixture.dbPath);

	assert.equal(analysis.schemaVersion, 10);
	assert.deepEqual(analysis.sources.map((source) => [source.source, source.rowCount]), [
		["transcript_events", 2],
		["model_input_blobs", 1],
	]);
	const transcript = analysis.sources[0]!;
	assert.equal(transcript.eligibleValueCount, 2);
	assert.equal(transcript.uniqueBlobCount, 1);
	assert.ok(transcript.duplicateReferenceBytes >= Buffer.byteLength(repeated));
	assert.equal(analysis.eligibleValueCount, 3);
	assert.equal(analysis.uniqueBlobCount, 2);
	assert.ok(analysis.compressionSavingsBytes > 0);
	assert.ok(analysis.estimatedStoredBytes < analysis.uniqueRawBytes);
	assert.ok(analysis.migrationHeadroom.requiredFreeBytes > 0);
	assert.equal(after.size, before.size);
	assert.equal(after.mtimeMs, before.mtimeMs);
	const rendered = JSON.stringify(analysis);
	for (const privateValue of [
		"private-session",
		"private-event",
		"private-provider-request",
		"private-content",
		fixture.root,
	]) assert.equal(rendered.includes(privateValue), false);
});

test("rejects non-v10 databases with bounded diagnostics", async (t) => {
	const fixture = await databaseFixture(t);
	const database = new Database(fixture.dbPath);
	database.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
	database.prepare("INSERT INTO schema_version (version) VALUES (9)").run();
	database.close();

	assert.throws(
		() => analyzeV10ContentBlobs({ dbPath: fixture.dbPath }),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.expected_version === 10
			&& error.diagnostics.actual_version === 9
			&& !error.message.includes(fixture.dbPath),
	);
});

async function databaseFixture(t: test.TestContext): Promise<{
	readonly root: string;
	readonly dbPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-v10-content-analyzer-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return { root, dbPath: join(root, "sessions.db") };
}
