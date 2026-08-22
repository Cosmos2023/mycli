import { modelInputSha256, stableModelInputJson } from "@mycli/core";
import Database from "better-sqlite3";
import {
	SCHEMA_V10_VERSION,
	SQLiteTranscriptEventRepository,
	TRANSCRIPT_EVENT_SCHEMA_VERSION,
	type TranscriptEventAppendInput,
} from "../../src/index.ts";

export const V10_CONTENT_MIGRATION_NOW = "2026-08-14T00:00:00.000Z";
export const V10_CONTENT_MIGRATION_SHARED_TEXT = "shared migration payload\n".repeat(300);
export const V10_CONTENT_MIGRATION_MODEL_VALUE = Object.freeze({
	content: V10_CONTENT_MIGRATION_SHARED_TEXT,
	kind: "migration-fixture",
});
export const V10_CONTENT_MIGRATION_MODEL_JSON = stableModelInputJson(
	V10_CONTENT_MIGRATION_MODEL_VALUE,
);

export function seedV10ContentBlobMigrationFixture(dbPath: string): void {
	const repository = new SQLiteTranscriptEventRepository({
		dbPath,
		initializeSchemaVersion: SCHEMA_V10_VERSION,
		clock: () => V10_CONTENT_MIGRATION_NOW,
	});
	try {
		seedSession(dbPath);
		for (const input of fixtureEvents()) repository.appendEvent(input);
	} finally {
		repository.close();
	}
	insertModelInput(dbPath, V10_CONTENT_MIGRATION_MODEL_VALUE);
	insertModelInput(dbPath, Object.freeze({
		content: "second unique model input\n".repeat(250),
		kind: "migration-fixture-tail",
	}));
}

export function appendV10ContentBlobMigrationTail(dbPath: string): void {
	const repository = new SQLiteTranscriptEventRepository({
		dbPath,
		clock: () => V10_CONTENT_MIGRATION_NOW,
	});
	try {
		repository.appendEvent(event(
			"assistant_output",
			"migration-event-tail",
			{ text: "new durable transcript tail\n".repeat(250) },
			true,
		));
	} finally {
		repository.close();
	}
	insertModelInput(dbPath, Object.freeze({
		content: "new durable model-input tail\n".repeat(250),
		kind: "migration-tail",
	}));
}

function fixtureEvents(): readonly TranscriptEventAppendInput[] {
	return Object.freeze([
		event("assistant_output", "migration-event-assistant", {
			text: V10_CONTENT_MIGRATION_MODEL_JSON,
		}, true),
		event("tool_result", "migration-event-tool", {
			result: {
				callId: "migration-call",
				toolName: "Read",
				output: V10_CONTENT_MIGRATION_MODEL_JSON,
				success: true,
			},
			summary: "read complete",
			metadata: { retained: V10_CONTENT_MIGRATION_SHARED_TEXT },
		}, true),
		event("display_activity", "migration-event-display", {
			activityType: "reasoning",
			text: V10_CONTENT_MIGRATION_SHARED_TEXT,
			metadata: {},
		}, false),
		event("opaque_legacy", "migration-event-opaque", {
			sourceKind: "session_summaries",
			sourceIdentity: "migration-summary",
			rawPayload: "opaque migration payload\n".repeat(250),
			errorCode: "invalid_shape",
		}, false),
	]);
}

function event(
	eventType: string,
	eventId: string,
	payload: Readonly<Record<string, unknown>>,
	modelVisible: boolean,
): TranscriptEventAppendInput {
	return {
		schemaVersion: TRANSCRIPT_EVENT_SCHEMA_VERSION,
		sessionId: "migration-session",
		eventId,
		turnId: "migration-turn",
		eventType,
		modelVisible,
		createdAt: V10_CONTENT_MIGRATION_NOW,
		payload,
	} as never;
}

function seedSession(dbPath: string): void {
	const database = new Database(dbPath);
	try {
		database.prepare(`
			INSERT INTO sessions (
				session_id, workspace_root, thread_id, created_at,
				updated_at, last_active_at, status
			) VALUES (?, ?, ?, ?, ?, ?, 'active')
		`).run(
			"migration-session",
			"/workspace",
			"migration-session",
			V10_CONTENT_MIGRATION_NOW,
			V10_CONTENT_MIGRATION_NOW,
			V10_CONTENT_MIGRATION_NOW,
		);
	} finally {
		database.close();
	}
}

function insertModelInput(dbPath: string, value: unknown): void {
	const payloadJson = stableModelInputJson(value);
	const database = new Database(dbPath);
	try {
		database.prepare(`
			INSERT INTO model_input_blobs (blob_id, payload_json, created_at)
			VALUES (?, ?, ?)
		`).run(modelInputSha256(value), payloadJson, V10_CONTENT_MIGRATION_NOW);
	} finally {
		database.close();
	}
}
