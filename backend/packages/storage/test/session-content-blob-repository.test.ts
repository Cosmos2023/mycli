import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	createV11SessionDatabase,
	encodeSessionContentBlob,
	SQLiteSessionContentBlobRepository,
	SQLiteTranscriptEventRepository,
	StorageFailure,
	type SessionContentBlobRepository,
} from "../src/index.ts";

const NOW = "2026-08-14T00:00:00.000Z";

test("inserts, reuses, and rejects conflicting content rows", async (t) => {
	const fixture = await repositoryFixture(t, "put");
	const value = "compressible shared content\n".repeat(1_000);
	const first = fixture.repository.put(value);
	const second = fixture.repository.put(value);
	assert.deepEqual(second, first);
	assert.equal(scalar(fixture.database, "SELECT COUNT(*) FROM session_content_blobs"), 1);
	assert.equal(fixture.repository.loadUtf8(first.blobId), value);

	const collision = encodeSessionContentBlob("different collision content\n".repeat(1_000));
	fixture.database.prepare(`
		INSERT INTO session_content_blobs (
			blob_id, codec, raw_bytes, stored_bytes, payload_blob, created_at
		) VALUES (?, 'identity-v1', ?, ?, ?, ?)
	`).run(
		collision.blobId,
		collision.rawBytes,
		collision.rawBytes,
		Buffer.alloc(collision.rawBytes, 0x78),
		NOW,
	);
	assert.throws(
		() => fixture.repository.putEncoded(collision),
		(error: unknown) => error instanceof StorageFailure
			&& error.message.includes("collides")
			&& !error.message.includes(collision.blobId)
			&& !JSON.stringify(error.diagnostics).includes(collision.blobId),
	);
});

test("loads a batch in request order and keeps verification cache operation-scoped", async (t) => {
	const fixture = await repositoryFixture(t, "load-many");
	const left = fixture.repository.put(randomBytes(1_024));
	const right = fixture.repository.put("right payload\n".repeat(500));
	const missing = `sha256:${"0".repeat(64)}`;
	const loaded = fixture.repository.loadMany([
		right.blobId,
		left.blobId,
		right.blobId,
		missing,
	]);
	assert.deepEqual(loaded.map((blob) => blob?.blobId), [
		right.blobId,
		left.blobId,
		right.blobId,
		undefined,
	]);
	assert.equal(loaded[0], loaded[2]);

	fixture.database.exec("DROP TRIGGER session_content_blobs_no_update");
	fixture.database.prepare(`
		UPDATE session_content_blobs SET payload_blob = ? WHERE blob_id = ?
	`).run(Buffer.alloc(left.storedBytes, 0x61), left.blobId);
	assert.throws(
		() => fixture.repository.loadMany([left.blobId]),
		(error: unknown) => error instanceof StorageFailure
			&& !error.message.includes(left.blobId),
	);
});

test("links transcript and model-input owners atomically", async (t) => {
	const fixture = await repositoryFixture(t, "references");
	const first = fixture.repository.put("first referenced value\n".repeat(500));
	const second = fixture.repository.put("second referenced value\n".repeat(500));
	const sequenceNo = seedOwners(fixture.database);

	fixture.repository.linkTranscriptEvent(sequenceNo, [
		{ jsonPointer: "/payload/text", blobId: first.blobId },
	]);
	fixture.repository.linkTranscriptEvent(sequenceNo, [
		{ jsonPointer: "/payload/text", blobId: first.blobId },
	]);
	fixture.repository.linkModelInputBlob("model-owner", second.blobId);
	fixture.repository.linkModelInputBlob("model-owner", second.blobId);
	assert.equal(scalar(fixture.database, "SELECT COUNT(*) FROM transcript_event_blob_refs"), 1);
	assert.equal(scalar(fixture.database, "SELECT COUNT(*) FROM model_input_blob_refs"), 1);

	assert.throws(
		() => fixture.repository.linkTranscriptEvent(sequenceNo, [
			{ jsonPointer: "/payload/text", blobId: second.blobId },
		]),
		(error: unknown) => error instanceof StorageFailure
			&& error.message.includes("conflicts")
			&& !error.message.includes(second.blobId),
	);
	assert.throws(
		() => fixture.repository.linkModelInputBlob("model-owner", first.blobId),
		(error: unknown) => error instanceof StorageFailure
			&& error.message.includes("conflicts")
			&& !error.message.includes(first.blobId),
	);

	const missing = `sha256:${"f".repeat(64)}`;
	assert.throws(
		() => fixture.repository.linkTranscriptEvent(sequenceNo, [
			{ jsonPointer: "/payload/other", blobId: first.blobId },
			{ jsonPointer: "/payload/missing", blobId: missing },
		]),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.sqlite_code === "SQLITE_CONSTRAINT_FOREIGNKEY"
			&& !error.message.includes(missing),
	);
	assert.equal(scalar(fixture.database, `
		SELECT COUNT(*) FROM transcript_event_blob_refs WHERE json_pointer != '/payload/text'
	`), 0);
});

test("reports reachability and explicitly collects only proven orphans", async (t) => {
	const fixture = await repositoryFixture(t, "orphans");
	const transcript = fixture.repository.put("transcript value\n".repeat(500));
	const shared = fixture.repository.put("shared value\n".repeat(500));
	const orphan = fixture.repository.put("orphan value\n".repeat(500));
	const sequenceNo = seedOwners(fixture.database);
	fixture.repository.linkTranscriptEvent(sequenceNo, [
		{ jsonPointer: "/payload/text", blobId: transcript.blobId },
		{ jsonPointer: "/payload/shared", blobId: shared.blobId },
	]);
	fixture.repository.linkModelInputBlob("model-owner", shared.blobId);

	assert.deepEqual(fixture.repository.metrics(), {
		blobCount: 3,
		referenceCount: 3,
		transcriptReferenceCount: 2,
		modelInputReferenceCount: 1,
		reachableBlobCount: 2,
		reachableRawBytes: transcript.rawBytes + shared.rawBytes,
		reachableStoredBytes: transcript.storedBytes + shared.storedBytes,
		logicalReferenceBytes: transcript.rawBytes + (2 * shared.rawBytes),
		deduplicatedReferenceBytes: shared.rawBytes,
		orphanBlobCount: 1,
		orphanRawBytes: orphan.rawBytes,
		orphanStoredBytes: orphan.storedBytes,
	});
	assert.deepEqual(fixture.repository.collectOrphans(), {
		deletedBlobCount: 1,
		deletedRawBytes: orphan.rawBytes,
		deletedStoredBytes: orphan.storedBytes,
	});
	assert.deepEqual(fixture.repository.collectOrphans(), {
		deletedBlobCount: 0,
		deletedRawBytes: 0,
		deletedStoredBytes: 0,
	});
	assert.equal(fixture.repository.loadUtf8(orphan.blobId), undefined);
	assert.ok(fixture.repository.loadBytes(transcript.blobId));
	assert.ok(fixture.repository.loadBytes(shared.blobId));
});

test("uses the owning write transaction and rolls back content insertion", async (t) => {
	const fixture = await repositoryFixture(t, "rollback");
	assert.throws(
		() => fixture.write(() => {
			fixture.repository.put("rolled back content\n".repeat(500));
			throw new Error("abort owning operation");
		}),
		/abort owning operation/u,
	);
	assert.equal(scalar(fixture.database, "SELECT COUNT(*) FROM session_content_blobs"), 0);
});

test("deduplicates the same content inserted by independent processes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-content-blob-process-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const dbPath = join(root, "sessions.db");
	createV11SessionDatabase({ dbPath });
	const [left, right] = await Promise.all([
		runPutProcess(dbPath),
		runPutProcess(dbPath),
	]);
	assert.equal(left.blobId, right.blobId);
	const database = new Database(dbPath, { readonly: true });
	try {
		assert.equal(scalar(database, "SELECT COUNT(*) FROM session_content_blobs"), 1);
	} finally {
		database.close();
	}
});

test("reports and explicitly collects v11 content orphans without vacuuming", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-content-blob-maintenance-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const dbPath = join(root, "sessions.db");
	createV11SessionDatabase({ dbPath });
	const reachable = encodeSessionContentBlob("reachable content\n".repeat(1_000));
	const orphan = encodeSessionContentBlob(randomBytes(256 * 1_024));
	const database = new Database(dbPath);
	database.pragma("foreign_keys = ON");
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at,
			updated_at, last_active_at, status
		) VALUES ('maintenance-session', '/workspace', 'maintenance-session', ?, ?, ?, 'active')
	`).run(NOW, NOW, NOW);
	const event = database.prepare(`
		INSERT INTO transcript_events (
			session_id, event_id, turn_id, event_type, provider_index,
			model_visible, payload_json, created_at
		) VALUES ('maintenance-session', 'maintenance-event', 'maintenance-turn',
		          'assistant_output', 0, 1, ?, ?)
	`).run(JSON.stringify({ schemaVersion: 1, payload: { text: null } }), NOW);
	const insertContent = database.prepare(`
		INSERT INTO session_content_blobs (
			blob_id, codec, raw_bytes, stored_bytes, payload_blob, created_at
		) VALUES (?, ?, ?, ?, ?, ?)
	`);
	for (const blob of [reachable, orphan]) {
		insertContent.run(
			blob.blobId,
			blob.codec,
			blob.rawBytes,
			blob.storedBytes,
			blob.payload,
			NOW,
		);
	}
	database.prepare(`
		INSERT INTO transcript_event_blob_refs (sequence_no, json_pointer, blob_id)
		VALUES (?, '/payload/text', ?)
	`).run(event.lastInsertRowid, reachable.blobId);
	database.close();

	const store = new SQLiteTranscriptEventRepository({ dbPath, clock: () => NOW });
	t.after(() => store.close());
	const before = store.sessionMaintenanceReport();
	assert.equal(before.freelistBytes, before.freelistCount * before.pageSize);
	assert.deepEqual(before.contentBlobs, {
		blobCount: 2,
		referenceCount: 1,
		transcriptReferenceCount: 1,
		modelInputReferenceCount: 0,
		reachableBlobCount: 1,
		reachableRawBytes: reachable.rawBytes,
		reachableStoredBytes: reachable.storedBytes,
		logicalReferenceBytes: reachable.rawBytes,
		deduplicatedReferenceBytes: 0,
		orphanBlobCount: 1,
		orphanRawBytes: orphan.rawBytes,
		orphanStoredBytes: orphan.storedBytes,
	});

	const collected = store.collectSessionContentBlobOrphans();
	assert.equal(collected.dryRun, false);
	assert.equal(collected.deletedBlobCount, 1);
	assert.equal(collected.deletedRawBytes, orphan.rawBytes);
	assert.equal(collected.deletedStoredBytes, orphan.storedBytes);
	assert.equal(collected.dbSizeBytes, before.dbSizeBytes);
	assert.equal(collected.freelistBytes, collected.freelistCount * collected.pageSize);
	assert.ok(collected.freelistBytes > 0);
	const after = store.sessionMaintenanceReport();
	assert.equal(after.dbSizeBytes, before.dbSizeBytes);
	assert.equal(after.contentBlobs?.orphanBlobCount, 0);
	assert.equal(after.contentBlobs?.reachableBlobCount, 1);
	const repeated = store.collectSessionContentBlobOrphans();
	assert.equal(repeated.deletedBlobCount, 0);
	assert.equal(repeated.deletedRawBytes, 0);
	assert.equal(repeated.deletedStoredBytes, 0);
	assert.equal(repeated.dbSizeBytes, before.dbSizeBytes);
	assert.equal(repeated.freelistBytes, collected.freelistBytes);
	const verify = new Database(dbPath, { readonly: true });
	try {
		assert.equal(scalar(verify, "SELECT COUNT(*) FROM session_content_blobs"), 1);
	} finally {
		verify.close();
	}
});

async function repositoryFixture(
	t: test.TestContext,
	name: string,
): Promise<Readonly<{
	readonly database: Database.Database;
	readonly repository: SessionContentBlobRepository;
	readonly write: <Result>(operation: () => Result) => Result;
}>> {
	const root = await mkdtemp(join(tmpdir(), `mycli-content-blob-${name}-`));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const dbPath = join(root, "sessions.db");
	createV11SessionDatabase({ dbPath });
	const database = new Database(dbPath);
	database.pragma("foreign_keys = ON");
	database.pragma("busy_timeout = 5000");
	t.after(() => database.close());
	const write = <Result>(operation: () => Result): Result => {
		if (database.inTransaction) return operation();
		database.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			database.exec("COMMIT");
			return result;
		} catch (error) {
			if (database.inTransaction) database.exec("ROLLBACK");
			throw error;
		}
	};
	return Object.freeze({
		database,
		write,
		repository: new SQLiteSessionContentBlobRepository({
			database,
			write,
			clock: () => NOW,
		}),
	});
}

function seedOwners(database: Database.Database): number {
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at, updated_at, last_active_at, status
		) VALUES ('session-1', '/workspace', 'session-1', ?, ?, ?, 'active')
	`).run(NOW, NOW, NOW);
	const result = database.prepare(`
		INSERT INTO transcript_events (
			session_id, event_id, turn_id, event_type, provider_index,
			model_visible, payload_json, created_at
		) VALUES ('session-1', 'event-1', 'turn-1', 'assistant_output', 0, 1, ?, ?)
	`).run(JSON.stringify({ schemaVersion: 1, payload: { text: null, shared: null } }), NOW);
	database.prepare(`
		INSERT INTO model_input_blobs (blob_id, payload_json, created_at)
		VALUES ('model-owner', '{"schemaVersion":1}', ?)
	`).run(NOW);
	return Number(result.lastInsertRowid);
}

async function runPutProcess(dbPath: string): Promise<{ readonly blobId: string }> {
	const fixturePath = join(
		import.meta.dirname,
		"fixtures",
		"session-content-blob-put-process.mjs",
	);
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", fixturePath, dbPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code !== 0) {
				reject(new Error(`content blob process failed with code ${String(code)}: ${stderr.slice(0, 200)}`));
				return;
			}
			resolve(JSON.parse(stdout) as { readonly blobId: string });
		});
	});
}

function scalar(database: Database.Database, sql: string): number {
	return Number(database.prepare(sql).pluck().get());
}
