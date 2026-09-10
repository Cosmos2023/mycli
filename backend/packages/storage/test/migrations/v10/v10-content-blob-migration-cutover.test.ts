import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	manifestLogicalInputSha256,
	modelInputSha256,
	type InstructionSnapshot,
	type ModelInputReference,
	type ProviderRequest,
	type ProviderRequestManifest,
	type ToolDefinition,
	type ToolSetSnapshot,
} from "@mycli/core";
import Database from "better-sqlite3";
import {
	applyV10ContentBlobMigrationCutover,
	SQLiteTranscriptEventRepository,
	stageV10ContentBlobMigrationBatch,
	TRANSCRIPT_EVENT_SCHEMA_VERSION,
	type CommitProviderStepInput,
} from "../../../src/index.ts";
import {
	appendV10ContentBlobMigrationTail,
	seedV10ContentBlobMigrationFixture,
	V10_CONTENT_MIGRATION_NOW,
} from "../../support/v10-content-blob-migration-fixtures.ts";

test("reconciles the tail and atomically installs parity-validated schema v11", async (t) => {
	const fixture = await databaseFixture(t, "success");
	seedV10ContentBlobMigrationFixture(fixture.dbPath);
	drainStaging(fixture.dbPath, 2);
	appendV10ContentBlobMigrationTail(fixture.dbPath);
	const before = repositorySnapshot(fixture.dbPath);
	const identitiesBefore = storageIdentitySnapshot(fixture.dbPath);

	const result = applyV10ContentBlobMigrationCutover({
		dbPath: fixture.dbPath,
		clock: () => V10_CONTENT_MIGRATION_NOW,
	});
	assert.equal(result.schemaVersion, 11);
	assert.equal(result.tailSourceRowCount, 2);
	assert.equal(result.migratedTranscriptEventCount, 5);
	assert.equal(result.migratedModelInputBlobCount, 3);
	assert.ok(result.installedContentBlobCount < result.installedReferenceCount);
	assert.ok(result.storedBytes < result.uniqueRawBytes);
	assert.equal(result.parityValidated, true);
	assert.equal(result.stagingDiscarded, true);

	assert.deepEqual(repositorySnapshot(fixture.dbPath), before);
	assert.deepEqual(storageIdentitySnapshot(fixture.dbPath), identitiesBefore);
	const database = new Database(fixture.dbPath, { readonly: true });
	try {
		assert.equal(database.prepare("SELECT version FROM schema_version").pluck().get(), 11);
		assert.equal(scalar(database, `
			SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'content_blob_migration_%'
		`), 0);
		assert.equal(scalar(database, `
			SELECT COUNT(*) FROM model_input_blobs AS owner
			JOIN model_input_blob_refs AS reference ON reference.blob_id = owner.blob_id
		`), 3);
		assert.equal(scalar(database, `
			SELECT COUNT(*) FROM model_input_blobs
			WHERE payload_json = '{"schemaVersion":1,"storage":"session_content_blob"}'
		`), 3);
		const ftsSql = String(database.prepare(`
			SELECT sql FROM sqlite_master WHERE name = 'transcript_events_fts'
		`).pluck().get());
		assert.equal(ftsSql.includes("content=''"), true);
		assert.equal(ftsSql.includes("contentless_delete=1"), true);
		assert.equal(scalar(database, "SELECT COUNT(*) FROM pragma_foreign_key_check"), 0);
	} finally {
		database.close();
	}
	const writable = new SQLiteTranscriptEventRepository({ dbPath: fixture.dbPath });
	try {
		const appended = writable.appendEvent({
			schemaVersion: TRANSCRIPT_EVENT_SCHEMA_VERSION,
			sessionId: "migration-session",
			eventId: "post-cutover-event",
			turnId: "post-cutover-turn",
			eventType: "assistant_output",
			modelVisible: true,
			createdAt: V10_CONTENT_MIGRATION_NOW,
			payload: { text: "postcutover searchable content\n".repeat(250) },
		} as never);
		assert.deepEqual(writable.loadEvent("migration-session", "post-cutover-event"), appended);
		assert.equal(writable.searchMessages("postcutover").length, 1);
	} finally {
		writable.close();
	}
});

test("preserves an immutable provider-ledger manifest and exact reconstruction", async (t) => {
	const fixture = await databaseFixture(t, "provider-ledger");
	seedV10ContentBlobMigrationFixture(fixture.dbPath);
	const input = providerStep();
	const v10 = new SQLiteTranscriptEventRepository({ dbPath: fixture.dbPath });
	const committed = v10.modelInputLedger.commitProviderStep(input);
	assert.deepEqual(v10.modelInputLedger.reconstructProviderStep(input.manifest.requestId), committed);
	v10.close();
	drainStaging(fixture.dbPath, 2);

	const result = applyV10ContentBlobMigrationCutover({
		dbPath: fixture.dbPath,
		clock: () => V10_CONTENT_MIGRATION_NOW,
	});
	assert.equal(result.schemaVersion, 11);
	const v11 = new SQLiteTranscriptEventRepository({ dbPath: fixture.dbPath });
	try {
		assert.deepEqual(
			v11.modelInputLedger.reconstructProviderStep(input.manifest.requestId),
			committed,
		);
	} finally {
		v11.close();
	}
});

function providerStep(): CommitProviderStepInput {
	const instructionContent = "You are the migration parity agent.\n".repeat(100);
	const instructions: InstructionSnapshot = Object.freeze({
		snapshotId: "migration-instructions",
		version: "v1",
		source: "builtin",
		content: instructionContent,
		contentSha256: modelInputSha256(instructionContent),
		createdAt: V10_CONTENT_MIGRATION_NOW,
	});
	const tools: readonly ToolDefinition[] = Object.freeze([Object.freeze({
		id: "Read",
		name: "Read",
		description: "Read migration data safely.\n".repeat(100),
		inputSchema: Object.freeze({
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
			additionalProperties: false,
		}),
	})]);
	const toolSet: ToolSetSnapshot = Object.freeze({
		snapshotId: "migration-tools",
		tools,
		contentSha256: modelInputSha256(tools),
		createdAt: V10_CONTENT_MIGRATION_NOW,
	});
	const userText = "Inspect the migration ledger.\n".repeat(100);
	const orderedItems: readonly ModelInputReference[] = Object.freeze([
		Object.freeze({
			kind: "instruction_snapshot" as const,
			id: instructions.snapshotId,
			role: "system" as const,
			contentSha256: instructions.contentSha256,
		}),
		Object.freeze({
			kind: "tool_set_snapshot" as const,
			id: toolSet.snapshotId,
			contentSha256: toolSet.contentSha256,
		}),
		Object.freeze({
			kind: "conversation_item" as const,
			id: "migration-turn:user",
			role: "user" as const,
			contentSha256: modelInputSha256(userText),
		}),
	]);
	const request: ProviderRequest = Object.freeze({
		provider: "openai",
		protocol: "responses",
		model: "gpt-5.5",
		instructions: instructionContent,
		messages: Object.freeze([{ role: "user" as const, content: userText }]),
		items: Object.freeze([{ type: "user" as const, text: userText }]),
		tools,
	});
	const manifest: ProviderRequestManifest = Object.freeze({
		schemaVersion: 1,
		requestId: "migration-request",
		sessionId: "migration-session",
		turnId: "migration-turn",
		providerStep: 0,
		providerConfig: Object.freeze({
			provider: request.provider,
			protocol: request.protocol,
			model: request.model,
		}),
		instructionSnapshotId: instructions.snapshotId,
		toolSetSnapshotId: toolSet.snapshotId,
		orderedItems,
		requestSignature: "sha256:migration-request-signature",
		logicalInputSha256: manifestLogicalInputSha256(instructions, toolSet, orderedItems),
		contextPrefixSha256: modelInputSha256([]),
		boundary: "bootstrap",
		createdAt: V10_CONTENT_MIGRATION_NOW,
	});
	return Object.freeze({
		instructionSnapshot: instructions,
		toolSetSnapshot: toolSet,
		contextEvents: Object.freeze([]),
		manifest,
		request,
		preparedEvent: Object.freeze({
			eventId: "migration-request:prepared",
			requestId: manifest.requestId,
			sessionId: manifest.sessionId,
			state: "prepared" as const,
			payload: Object.freeze({}),
			createdAt: V10_CONTENT_MIGRATION_NOW,
		}),
	});
}

function repositorySnapshot(dbPath: string): readonly unknown[] {
	const repository = new SQLiteTranscriptEventRepository({ dbPath });
	try {
		return Object.freeze([
			repository.loadEventWindow("migration-session", { limit: 100 }).events,
			repository.loadConversationItems("migration-session"),
			repository.loadReadableTranscript("migration-session"),
			repository.searchMessages("migration"),
			repository.searchMessages("durable"),
		]);
	} finally {
		repository.close();
	}
}

function storageIdentitySnapshot(dbPath: string): readonly unknown[] {
	const database = new Database(dbPath, { readonly: true });
	try {
		return Object.freeze([
			database.prepare(`
				SELECT sequence_no, session_id, event_id, turn_id, event_type,
				       provider_index, model_visible, created_at
				FROM transcript_events ORDER BY sequence_no
			`).all(),
			database.prepare(`
				SELECT blob_id, created_at FROM model_input_blobs ORDER BY blob_id
			`).all(),
		]);
	} finally {
		database.close();
	}
}

function drainStaging(dbPath: string, batchSize: number): void {
	for (let index = 0; index < 100; index += 1) {
		const result = stageV10ContentBlobMigrationBatch({
			dbPath,
			batchSize,
			clock: () => V10_CONTENT_MIGRATION_NOW,
		});
		if (result.complete) return;
	}
	throw new Error("content-blob staging fixture did not converge");
}

function scalar(database: Database.Database, sql: string): number {
	return Number(database.prepare(sql).pluck().get());
}

async function databaseFixture(t: test.TestContext, name: string): Promise<{
	readonly root: string;
	readonly dbPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), `mycli-v10-content-cutover-${name}-`));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return { root, dbPath: join(root, "sessions.db") };
}
