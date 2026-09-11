import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { modelInputSha256 } from "@mycli/core";
import { commitRuntimeProviderStep } from "@mycli/runtime";
import {
	encodeSessionContentBlob,
	openRuntimeSessionStore,
	SCHEMA_V2_SQL,
	SCHEMA_V5_SQL,
	SCHEMA_V6_SQL,
	SCHEMA_V7_SQL,
	SCHEMA_V8_SQL,
	SCHEMA_V9_SQL,
	SCHEMA_VERSION,
	SQLiteSessionStore,
	stageV10ContentBlobMigrationBatch,
	V10_CONTENT_BLOB_MIGRATION_STAGING_SQL,
} from "@mycli/storage";
import { READ_TOOL_DEFINITION } from "@mycli/tools";
import {
	createV10SessionDatabase,
	createV11SessionDatabase,
	SQLiteTranscriptEventRepository,
} from "../../../packages/storage/src/transcript/transcript-event-repository.ts";
import { applyV9TranscriptNormalizationCutover } from "../../../packages/storage/src/migrations/v9/v9-normalization-cutover.ts";
import { V9_TRANSCRIPT_NORMALIZATION_STAGING_SQL } from "../../../packages/storage/src/migrations/v9/v9-normalization-staging.ts";
import { renderManagementResponse } from "../src/management/render.ts";
import { collectConfigChecks } from "../src/management/doctor/check-config.ts";
import { collectProcessChecks } from "../src/management/doctor/check-process.ts";
import { collectRuntimeChecks } from "../src/management/doctor/check-runtime.ts";
import { collectStorageChecks } from "../src/management/doctor/check-storage.ts";
import {
	doctorResponseFromReport,
	runDoctorCollectors,
} from "../src/management/doctor/runner.ts";

const NOW = "2026-08-14T00:00:00.000Z";

test("doctor collectors preserve order, isolate failures, and count severities", async () => {
	const calls: string[] = [];
	const report = await runDoctorCollectors([
		{
			name: "first",
			collect: () => {
				calls.push("first");
				return { name: "first", status: "ok", message: "ready" };
			},
		},
		{
			name: "broken",
			collect: () => {
				calls.push("broken");
				throw new Error("Authorization: Bearer test-secret private-command");
			},
		},
		{
			name: "last",
			collect: async () => {
				calls.push("last");
				return { name: "last", status: "warning", message: "optional state missing" };
			},
		},
	]);

	assert.deepEqual(calls, ["first", "broken", "last"]);
	assert.deepEqual(report.checks.map((check) => check.name), ["first", "broken", "last"]);
	assert.deepEqual(
		[report.okCount, report.warningCount, report.failedCount],
		[1, 1, 1],
	);
	assert.doesNotMatch(JSON.stringify(report), /test-secret|Bearer|private-command/u);
});

test("doctor bounds a collector, aborts its cleanup, and continues", { timeout: 500 }, async () => {
	let cleanupCount = 0;
	let lastCount = 0;
	const report = await runDoctorCollectors([
		{
			name: "slow",
			collect: (signal) => new Promise((_, reject) => {
				signal.addEventListener("abort", () => {
					cleanupCount += 1;
					const error = new Error("timed out with private-output");
					error.name = "AbortError";
					reject(error);
				}, { once: true });
			}),
		},
		{
			name: "last",
			collect: () => {
				lastCount += 1;
				return { name: "last", status: "ok", message: "ready" };
			},
		},
	], new AbortController().signal, { collectorTimeoutMs: 5, cleanupTimeoutMs: 50 });

	assert.equal(cleanupCount, 1);
	assert.equal(lastCount, 1);
	assert.deepEqual(report.checks.map((check) => [check.name, check.status]), [
		["slow", "failed"],
		["last", "ok"],
	]);
	assert.match(report.checks[0]?.message ?? "", /timed out/u);
	assert.doesNotMatch(JSON.stringify(report), /private-output/u);
});

test("doctor contains malformed collector rows at the sanitization boundary", async () => {
	const report = await runDoctorCollectors([{
		name: "malformed",
		collect: () => ({
			name: 7,
			status: "unknown",
			message: null,
			details: ["safe detail", 9, "Authorization: Bearer collector-secret"],
			remediation: { private: true },
			recoveryActions: [null, { id: "run_doctor", label: "untrusted label" }],
		}) as never,
	}]);

	assert.deepEqual(report.checks.map((check) => ({
		name: check.name,
		status: check.status,
		message: check.message,
		details: check.details,
		recoveryActionIds: check.recoveryActions.map((action) => action.id),
	})), [{
		name: "malformed",
		status: "failed",
		message: "check completed",
		details: ["safe detail", "[REDACTED]"],
		recoveryActionIds: ["run_doctor"],
	}]);
	assert.doesNotMatch(JSON.stringify(report), /collector-secret|untrusted label/u);
});

test("doctor human and JSON output consume one report and share exit semantics", async () => {
	const warningReport = await runDoctorCollectors([{
		name: "config",
		collect: () => ({
			name: "config",
			status: "warning",
			message: "api key missing",
			details: ["layer=user", "Authorization: Bearer private-doctor-token"],
			remediation: "Run mycli config validate.",
		}),
	}]);
	const warningResponse = doctorResponseFromReport(warningReport);
	const human = renderManagementResponse(
		{ kind: "doctor", operation: "check", json: false, verbose: false },
		warningResponse,
	);
	const verbose = renderManagementResponse(
		{ kind: "doctor", operation: "check", json: false, verbose: true },
		warningResponse,
	);
	const json = JSON.parse(renderManagementResponse(
		{ kind: "doctor", operation: "check", json: true, verbose: false },
		warningResponse,
	)) as Readonly<Record<string, unknown>>;

	assert.equal(warningResponse.ok, true);
	assert.equal(warningResponse.exitCode, 0);
	assert.deepEqual(json.checks, warningReport.checks);
	assert.deepEqual(json.support, warningReport.support);
	assert.equal(json.warningCount, warningReport.warningCount);
	assert.match(human, /^mycli doctor\n/u);
	assert.match(human, /\[WARN\] config: api key missing/u);
	assert.match(human, /Summary: 0 ok, 1 warning, 0 failed/u);
	assert.doesNotMatch(human, /layer=user|private-doctor-token|duration_ms/u);
	assert.match(verbose, /detail: layer=user/u);
	assert.match(verbose, /detail: \[REDACTED\]/u);
	assert.match(verbose, /remedy: Run mycli config validate\./u);
	assert.match(verbose, /duration_ms: \d+/u);
	assert.doesNotMatch(verbose, /private-doctor-token/u);
	assert.deepEqual(warningReport.support.diagnosticCodes, ["config"]);
	assert.deepEqual(warningReport.support.logReferences, [
		"logs/agent.log",
		"logs/errors.log",
		"logs/model-events.jsonl",
		"logs/model-raw/",
		"traces/",
	]);

	const failedReport = await runDoctorCollectors([{
		name: "storage",
		collect: () => ({ name: "storage", status: "failed", message: "database invalid" }),
	}]);
	const failedResponse = doctorResponseFromReport(failedReport);
	assert.equal(failedResponse.ok, false);
	assert.equal(failedResponse.exitCode, 1);
});

test("config doctor validates profiles and reports API key presence without exposing it", async (t) => {
	const root = await doctorFixture(t);
	const checks = await collectConfigChecks({
		workspaceRoot: root.workspaceRoot,
		homeDir: root.homeDir,
		env: {
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_MODEL: "gpt-5",
			MYCLI_API_KEY: "sk-config-test-secret",
		},
	});

	assert.deepEqual(checks.map((check) => [check.name, check.status]), [
		["config", "ok"],
		["api_key", "ok"],
	]);
	assert.match(checks[0]?.message ?? "", /provider=openai protocol=responses model=gpt-5/u);
	assert.match(checks[1]?.message ?? "", /present/u);
	assert.doesNotMatch(JSON.stringify(checks), /sk-config-test-secret/u);

	await mkdir(join(root.workspaceRoot, ".mycli"), { recursive: true });
	await writeFile(join(root.workspaceRoot, ".mycli", "config.toml"), "[model\napi_key='file-test-secret'", "utf8");
	const malformed = await collectConfigChecks({
		workspaceRoot: root.workspaceRoot,
		homeDir: root.homeDir,
		env: {},
	});
	assert.deepEqual(
		malformed.map((check) => [check.name, check.status]),
		[
			["config_invalid_toml_1", "failed"],
			["api_key", "warning"],
		],
	);
	assert.match(malformed[0]?.message ?? "", /project config contains invalid TOML/u);
	assert.match(malformed[0]?.detail ?? "", /layer=project line=1 column=2/u);
	assert.equal(malformed[1]?.status, "warning");
	assert.doesNotMatch(JSON.stringify(malformed), /file-test-secret|\[model/u);

	await writeFile(join(root.workspaceRoot, ".mycli", "config.toml"), [
		"[model]",
		'name = "gpt-5"',
		'nmae = "must-not-leak"',
	].join("\n"), "utf8");
	const unknown = await collectConfigChecks({
		workspaceRoot: root.workspaceRoot,
		homeDir: root.homeDir,
		env: {},
		workspaceTrust: "trusted",
	});
	assert.deepEqual(
		unknown.map((check) => [check.name, check.status]),
		[
			["config", "ok"],
			["config_unknown_key_1", "warning"],
			["api_key", "warning"],
		],
	);
	assert.match(unknown[1]?.detail ?? "", /layer=project key=model\.nmae/u);
	assert.doesNotMatch(JSON.stringify(unknown), /must-not-leak/u);

	await writeFile(join(root.workspaceRoot, ".mycli", "config.toml"), [
		"[model]",
		'api_key = "must-not-leak"',
	].join("\n"), "utf8");
	const forbidden = await collectConfigChecks({
		workspaceRoot: root.workspaceRoot,
		homeDir: root.homeDir,
		env: {},
		workspaceTrust: "trusted",
	});
	assert.deepEqual(
		forbidden.map((check) => [check.name, check.status]),
		[
			["config_forbidden_inline_secret_1", "failed"],
			["api_key", "warning"],
		],
	);
	assert.match(forbidden[0]?.detail ?? "", /layer=project key=model\.api_key/u);
	assert.doesNotMatch(JSON.stringify(forbidden), /must-not-leak/u);

	await writeFile(join(root.workspaceRoot, ".mycli", "config.toml"), [
		"[model]",
		'provider = "must-not-leak!"',
	].join("\n"), "utf8");
	const unsupportedProvider = await collectConfigChecks({
		workspaceRoot: root.workspaceRoot,
		homeDir: root.homeDir,
		env: {},
		workspaceTrust: "trusted",
	});
	assert.deepEqual(
		unsupportedProvider.map((check) => [check.name, check.status]),
		[
			["config_invalid_value_1", "failed"],
			["api_key", "warning"],
		],
	);
	assert.match(unsupportedProvider[0]?.detail ?? "", /key=provider/u);
	assert.doesNotMatch(JSON.stringify(unsupportedProvider), /must-not-leak/u);
});

test("storage doctor validates SQLite through a read-only connection and creates nothing", async (t) => {
	const root = await doctorFixture(t);
	const missing = await collectStorageChecks(root);
	assert.deepEqual(missing.map((check) => [check.name, check.status]), [
		["storage_layout", "ok"],
		["sessions_db", "warning"],
		["model_input_ledger", "warning"],
		["logs", "warning"],
		["traces", "ok"],
		["logs_redaction", "ok"],
	]);
	await assert.rejects(stat(join(root.homeDir, ".mycli")), /ENOENT/u);

	const homeRoot = join(root.homeDir, ".mycli");
	await mkdir(homeRoot, { recursive: true });
	const databasePath = join(homeRoot, "sessions.db");
	const database = new DatabaseSync(databasePath);
	database.exec(SCHEMA_V2_SQL);
	database.exec(SCHEMA_V5_SQL);
	database.exec(SCHEMA_V6_SQL);
	database.exec(SCHEMA_V7_SQL);
	database.exec(SCHEMA_V8_SQL);
	database.exec(SCHEMA_V9_SQL);
	database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
	database.close();
	const before = await stat(databasePath);
	const present = await collectStorageChecks(root);
	const after = await stat(databasePath);

	assert.equal(present.find((check) => check.name === "sessions_db")?.status, "ok");
	assert.deepEqual(
		present.find((check) => check.name === "model_input_ledger"),
		{
			name: "model_input_ledger",
			status: "ok",
			message: "blobs=0 manifests=0 issues=0",
		},
	);
	assert.equal(after.mtimeMs, before.mtimeMs);
});

test("storage doctor rejects a current marker with the legacy content-bearing search index", async (t) => {
	const root = await doctorFixture(t);
	const homeRoot = join(root.homeDir, ".mycli");
	await mkdir(homeRoot, { recursive: true });
	const databasePath = join(homeRoot, "sessions.db");
	new SQLiteSessionStore({ dbPath: databasePath }).close();
	const database = new DatabaseSync(databasePath);
	database.exec(`
		DROP TRIGGER conversation_messages_fts_insert;
		DROP TRIGGER conversation_messages_fts_delete;
		DROP TRIGGER conversation_messages_fts_update;
		DROP TABLE conversation_messages_fts;
		CREATE VIRTUAL TABLE conversation_messages_fts USING fts5(
			session_id UNINDEXED,
			message_index UNINDEXED,
			content
		);
		CREATE TRIGGER conversation_messages_fts_insert
		AFTER INSERT ON conversation_messages BEGIN
			INSERT INTO conversation_messages_fts(rowid, session_id, message_index, content)
			VALUES (new.rowid, new.session_id, new.message_index, new.payload_json);
		END;
		CREATE TRIGGER conversation_messages_fts_delete
		AFTER DELETE ON conversation_messages BEGIN
			DELETE FROM conversation_messages_fts WHERE rowid = old.rowid;
		END;
		CREATE TRIGGER conversation_messages_fts_update
		AFTER UPDATE ON conversation_messages BEGIN
			DELETE FROM conversation_messages_fts WHERE rowid = old.rowid;
			INSERT INTO conversation_messages_fts(rowid, session_id, message_index, content)
			VALUES (new.rowid, new.session_id, new.message_index, new.payload_json);
		END;
	`);
	database.close();

	const checks = await collectStorageChecks(root);
	assert.deepEqual(checks.find((check) => check.name === "sessions_db"), {
		name: "sessions_db",
		status: "failed",
		message: "invalid_conversation_search_projection",
	});
});

test("storage doctor accepts null optional recovery fields and rejects malformed nested state", async (t) => {
	const root = await doctorFixture(t);
	const homeRoot = join(root.homeDir, ".mycli");
	await mkdir(homeRoot, { recursive: true });
	const databasePath = join(homeRoot, "sessions.db");
	new SQLiteSessionStore({ dbPath: databasePath }).close();
	const database = new DatabaseSync(databasePath);
	const sessionId = "doctor-null-recovery-session";
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at, updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(
		sessionId,
		root.workspaceRoot,
		sessionId,
		"2026-08-14T00:00:00.000Z",
		"2026-08-14T00:00:00.000Z",
		"2026-08-14T00:00:00.000Z",
		"active",
	);
	const writeSuspendedTurn = database.prepare(`
		INSERT OR REPLACE INTO session_state (session_id, state_key, payload_json, updated_at)
		VALUES (?, 'suspended_turn', ?, ?)
	`);
	writeSuspendedTurn.run(sessionId, JSON.stringify({
		user_message: "Continue",
		conversation: [],
		pending_decision: null,
		pending_clarification: null,
	}), "2026-08-14T00:00:00.000Z");

	const healthy = await collectStorageChecks(root);
	assert.equal(healthy.find((check) => check.name === "sessions_db")?.status, "ok");

	writeSuspendedTurn.run(sessionId, JSON.stringify({
		user_message: "Continue",
		conversation: [],
		pending_clarification: "invalid",
	}), "2026-08-14T00:00:01.000Z");
	database.close();

	assert.deepEqual(
		(await collectStorageChecks(root)).find((check) => check.name === "sessions_db"),
		{
			name: "sessions_db",
			status: "failed",
			message: "invalid_recovery_states=1",
		},
	);
});

test("storage doctor reports complete v9 transcript-normalization staging without exposing rows", async (t) => {
	const root = await doctorFixture(t);
	const databasePath = await createV9DoctorDatabase(root);
	const database = new DatabaseSync(databasePath);
	database.exec(V9_TRANSCRIPT_NORMALIZATION_STAGING_SQL);
	insertDoctorSession(database, root.workspaceRoot, "doctor-v9-staging");
	const batch = database.prepare(`
		INSERT INTO transcript_normalization_batches (
			started_at, completed_at, source_row_count, event_count,
			merged_source_row_count, opaque_source_row_count,
			schema_version_before, schema_version_after, staging_schema_version
		) VALUES (?, ?, 1, 1, 0, 1, 9, 9, 1)
	`).run(NOW, NOW);
	database.prepare(`
		INSERT INTO transcript_normalization_events (
			session_id, event_id, turn_id, event_type, provider_index, model_visible,
			payload_json, created_at, order_key, order_source_priority,
			canonical_source_kind, canonical_source_rowid, canonical_source_priority,
			event_hash, staging_schema_version
		) VALUES (?, ?, NULL, 'opaque_legacy', 0, 1, ?, ?, ?, 1,
		          'conversation_messages', 1, 1, ?, 1)
	`).run(
		"doctor-v9-staging",
		"doctor-opaque-event",
		JSON.stringify({
			schemaVersion: 1,
			payload: {
				sourceKind: "conversation_messages",
				sourceRowid: 1,
				rawPayload: "private fixture payload",
				errorCode: "legacy_payload_invalid",
			},
		}),
		NOW,
		"doctor-order-key",
		"0".repeat(64),
	);
	database.prepare(`
		INSERT INTO transcript_normalization_source_map (
			source_kind, source_rowid, session_id, source_order, source_identity,
			source_hash, event_id, disposition, batch_id, mapped_at, staging_schema_version
		) VALUES ('conversation_messages', 1, ?, 0, ?, ?, ?, 'opaque', ?, ?, 1)
	`).run(
		"doctor-v9-staging",
		"doctor-source-identity",
		"1".repeat(64),
		"doctor-opaque-event",
		batch.lastInsertRowid,
		NOW,
	);
	database.close();
	const before = await stat(databasePath);

	const sessions = (await collectStorageChecks(root)).find((check) => check.name === "sessions_db");

	assert.deepEqual(sessions, {
		name: "sessions_db",
		status: "ok",
		message: "schema_version=9 integrity=ok staging=present events=1 mapped=1 opaque=1",
	});
	assert.doesNotMatch(JSON.stringify(sessions), /private fixture payload|doctor-source-identity/u);
	assert.equal((await stat(databasePath)).mtimeMs, before.mtimeMs);
});

test("storage doctor rejects a partial v9 transcript-normalization staging schema", async (t) => {
	const root = await doctorFixture(t);
	const databasePath = await createV9DoctorDatabase(root);
	const database = new DatabaseSync(databasePath);
	database.exec("CREATE TABLE transcript_normalization_events (session_id TEXT NOT NULL)");
	database.close();

	assert.deepEqual(
		(await collectStorageChecks(root)).find((check) => check.name === "sessions_db"),
		{
			name: "sessions_db",
			status: "failed",
			message: "invalid_transcript_normalization_staging=4",
			detail: "incomplete_staging_schema",
		},
	);
});

test("storage doctor validates v10 opaque events and detects read-only FTS row-set drift", async (t) => {
	const root = await doctorFixture(t);
	const databasePath = await createV10DoctorDatabase(root);
	let database = new DatabaseSync(databasePath);
	insertDoctorSession(database, root.workspaceRoot, "doctor-v10-opaque");
	database.prepare(`
		INSERT INTO transcript_events (
			session_id, event_id, turn_id, event_type, provider_index,
			model_visible, payload_json, created_at
		) VALUES (?, ?, NULL, 'opaque_legacy', 0, 1, ?, ?)
	`).run(
		"doctor-v10-opaque",
		"doctor-v10-opaque-event",
		JSON.stringify({
			schemaVersion: 1,
			payload: {
				sourceKind: "conversation_messages",
				sourceRowid: 1,
				rawPayload: "private opaque bytes",
				errorCode: "legacy_payload_invalid",
			},
		}),
		NOW,
	);
	database.close();
	const before = await stat(databasePath);

	const healthy = (await collectStorageChecks(root)).find((check) => check.name === "sessions_db");
	assert.deepEqual(healthy, {
		name: "sessions_db",
		status: "ok",
		message: "schema_version=10 integrity=ok events=1 opaque_events=1 active_turns=0 manifest=none",
	});
	assert.doesNotMatch(JSON.stringify(healthy), /private opaque bytes|doctor-v10-opaque-event/u);
	assert.equal((await stat(databasePath)).mtimeMs, before.mtimeMs);

	database = new DatabaseSync(databasePath);
	const insertTrigger = database.prepare(`
		SELECT sql FROM sqlite_master
		WHERE type = 'trigger' AND name = 'transcript_events_fts_insert'
	`).get() as Readonly<{ readonly sql: string }>;
	database.exec("DROP TRIGGER transcript_events_fts_insert");
	database.prepare(`
		INSERT INTO transcript_events (
			session_id, event_id, turn_id, event_type, provider_index,
			model_visible, payload_json, created_at
		) VALUES (?, ?, NULL, 'assistant_output', 1, 1, ?, ?)
	`).run(
		"doctor-v10-opaque",
		"doctor-v10-unindexed-event",
		JSON.stringify({ schemaVersion: 1, payload: { text: "unindexed fixture" } }),
		NOW,
	);
	database.exec(insertTrigger.sql);
	database.close();
	assert.deepEqual(
		(await collectStorageChecks(root)).find((check) => check.name === "sessions_db"),
		{
			name: "sessions_db",
			status: "failed",
			message: "invalid_normalized_transcript=1",
			detail: "invalid_event_fts=1",
		},
	);
});

test("storage doctor validates real v10 content-blob staging read-only", async (t) => {
	const root = await doctorFixture(t);
	const databasePath = await createV10DoctorDatabase(root);
	let database = new DatabaseSync(databasePath);
	insertDoctorSession(database, root.workspaceRoot, "private-v10-content-staging");
	database.close();
	const repository = new SQLiteTranscriptEventRepository({ dbPath: databasePath, clock: () => NOW });
	repository.appendEvent({
		schemaVersion: 1,
		sessionId: "private-v10-content-staging",
		eventId: "private-v10-content-event",
		turnId: "private-v10-content-turn",
		eventType: "assistant_output",
		modelVisible: true,
		createdAt: NOW,
		payload: { text: "private staged transcript content ".repeat(200) },
	});
	repository.close();
	const staged = stageV10ContentBlobMigrationBatch({
		dbPath: databasePath,
		batchSize: 100,
		clock: () => NOW,
	});
	assert.equal(staged.complete, true);
	const before = await stat(databasePath);

	const sessions = (await collectStorageChecks(root)).find((item) => item.name === "sessions_db");

	assert.equal(sessions?.status, "ok");
	assert.match(
		sessions?.message ?? "",
		/content_blob_staging=present batches=1 events=1 model_inputs=0 blobs=1 references=1/u,
	);
	assert.match(sessions?.message ?? "", /remaining=0/u);
	assert.doesNotMatch(
		JSON.stringify(sessions),
		/private staged transcript|private-v10-content/u,
	);
	assert.equal((await stat(databasePath)).mtimeMs, before.mtimeMs);

	database = new DatabaseSync(databasePath);
	database.prepare(`
		UPDATE content_blob_migration_batches SET source_row_count = 2
	`).run();
	database.close();
	assert.deepEqual(
		(await collectStorageChecks(root)).find((item) => item.name === "sessions_db"),
		{
			name: "sessions_db",
			status: "failed",
			message: "invalid_content_blob_staging=1",
			detail: "invalid_staging_batches=1",
		},
	);
	database = new DatabaseSync(databasePath);
	database.prepare(`
		UPDATE content_blob_migration_batches SET source_row_count = 1
	`).run();
	database.prepare(`
		UPDATE content_blob_migration_event_source_map SET source_hash = ?
	`).run("0".repeat(64));
	database.close();
	assert.deepEqual(
		(await collectStorageChecks(root)).find((item) => item.name === "sessions_db"),
		{
			name: "sessions_db",
			status: "failed",
			message: "invalid_content_blob_staging=1",
			detail: "invalid_staged_events=1",
		},
	);
});

test("storage doctor rejects partial and incompatible v10 content-blob staging", async (t) => {
	for (const fixture of [
		{
			name: "partial",
			prepare: (database: DatabaseSync) => {
				database.exec("CREATE TABLE content_blob_migration_batches (batch_id INTEGER)");
			},
			expected: {
				message: "invalid_content_blob_staging=5",
				detail: "incomplete_staging_schema=5",
			},
		},
		{
			name: "incompatible",
			prepare: (database: DatabaseSync) => {
				database.exec(V10_CONTENT_BLOB_MIGRATION_STAGING_SQL);
				database.exec(`
					DROP TABLE content_blob_migration_source_conflicts;
					CREATE TABLE content_blob_migration_source_conflicts (
						source_kind TEXT NOT NULL
					);
				`);
			},
			expected: {
				message: "invalid_content_blob_staging=1",
				detail: "invalid_staging_columns=1",
			},
		},
	] as const) {
		const root = await doctorFixture(t);
		const databasePath = await createV10DoctorDatabase(root);
		const database = new DatabaseSync(databasePath);
		fixture.prepare(database);
		database.close();

		assert.deepEqual(
			(await collectStorageChecks(root)).find((item) => item.name === "sessions_db"),
			{
				name: "sessions_db",
				status: "failed",
				...fixture.expected,
			},
			fixture.name,
		);
	}
});

test("storage doctor validates v11 contentless FTS rowids read-only", async (t) => {
	const root = await doctorFixture(t);
	const databasePath = await doctorDatabasePath(root.homeDir);
	createV11SessionDatabase({ dbPath: databasePath });
	let database = new DatabaseSync(databasePath);
	insertDoctorSession(database, root.workspaceRoot, "private-v11-session");
	database.close();
	const repository = new SQLiteTranscriptEventRepository({ dbPath: databasePath, clock: () => NOW });
	repository.appendEvent({
		schemaVersion: 1,
		sessionId: "private-v11-session",
		eventId: "private-v11-event",
		turnId: "private-v11-turn",
		eventType: "assistant_output",
		modelVisible: true,
		createdAt: NOW,
		payload: { text: "private searchable v11 content ".repeat(100) },
	});
	let sequence = 0;
	commitRuntimeProviderStep({
		sessionId: "private-v11-session",
		turnId: "private-v11-turn",
		providerStep: 1,
		requestConfig: {
			provider: "openai",
			protocol: "responses",
			model: "gpt-test",
		},
		instructionSnapshot: Object.freeze({
			snapshotId: "private-v11-instructions",
			version: "test-v1",
			source: "test",
			content: "v11 system instructions ".repeat(100),
			contentSha256: modelInputSha256("v11 system instructions ".repeat(100)),
			createdAt: NOW,
		}),
		tools: [READ_TOOL_DEFINITION],
		history: repository.loadConversationItems("private-v11-session"),
		currentUserRequest: "Inspect v11 storage",
		sources: Object.freeze({}),
		ledger: repository.modelInputLedger,
		maxPromptTokens: 16_000,
		clock: () => NOW,
		createId: (kind) => `${kind}-v11-${++sequence}`,
	});
	repository.close();
	const before = await stat(databasePath);

	const healthyChecks = await collectStorageChecks(root);
	const healthy = healthyChecks.find((check) => check.name === "sessions_db");
	assert.equal(healthy?.status, "ok");
	assert.match(healthy?.message ?? "", /schema_version=11 integrity=ok events=1 blobs=\d+ references=\d+/u);
	const ledger = healthyChecks.find((check) => check.name === "model_input_ledger");
	assert.equal(ledger?.status, "ok");
	assert.match(ledger?.message ?? "", /manifests=1 issues=0/u);
	assert.doesNotMatch(JSON.stringify(healthy), /private-v11|private searchable/u);
	assert.equal((await stat(databasePath)).mtimeMs, before.mtimeMs);

	database = new DatabaseSync(databasePath);
	database.prepare(`
		DELETE FROM transcript_events_fts
		WHERE rowid = (SELECT sequence_no FROM transcript_events LIMIT 1)
	`).run();
	database.close();
	assert.deepEqual(
		(await collectStorageChecks(root)).find((check) => check.name === "sessions_db"),
		{
			name: "sessions_db",
			status: "failed",
			message: "invalid_blob_backed_transcript=1",
			detail: "invalid_event_fts=1",
		},
	);
});

test("storage doctor reports bounded v11 codec, count, and hash corruption", async (t) => {
	const root = await doctorFixture(t);
	const databasePath = await doctorDatabasePath(root.homeDir);
	createV11SessionDatabase({ dbPath: databasePath });
	const database = new DatabaseSync(databasePath);
	database.exec("PRAGMA ignore_check_constraints = ON");
	const insert = database.prepare(`
		INSERT INTO session_content_blobs (
			blob_id, codec, raw_bytes, stored_bytes, payload_blob, created_at
		) VALUES (?, ?, ?, ?, ?, ?)
	`);
	insert.run(`sha256:${"1".repeat(64)}`, "private-unknown-codec", 1, 1, Buffer.from("x"), NOW);
	insert.run(`sha256:${"2".repeat(64)}`, "identity-v1", 2, 1, Buffer.from("x"), NOW);
	insert.run(`sha256:${"3".repeat(64)}`, "identity-v1", 1, 1, Buffer.from("x"), NOW);
	database.close();

	const sessions = (await collectStorageChecks(root)).find((item) => item.name === "sessions_db");

	assert.deepEqual(sessions, {
		name: "sessions_db",
		status: "failed",
		message: "invalid_blob_backed_transcript=3",
		detail: "invalid_content_blobs=3",
	});
	assert.doesNotMatch(
		JSON.stringify(sessions),
		/private-unknown-codec|sha256:|11111111|22222222|33333333/u,
	);
});

test("storage doctor validates hydrated v11 references and typed ownership", async (t) => {
	const root = await doctorFixture(t);
	const databasePath = await doctorDatabasePath(root.homeDir);
	createV11SessionDatabase({ dbPath: databasePath });
	let database = new DatabaseSync(databasePath);
	insertDoctorSession(database, root.workspaceRoot, "private-v11-integrity-session");
	database.close();
	const repository = new SQLiteTranscriptEventRepository({ dbPath: databasePath, clock: () => NOW });
	for (const eventId of ["private-reference-event", "private-typed-event"] as const) {
		repository.appendEvent({
			schemaVersion: 1,
			sessionId: "private-v11-integrity-session",
			eventId,
			turnId: "private-v11-integrity-turn",
			eventType: "assistant_output",
			modelVisible: true,
			createdAt: NOW,
			payload: { text: `private hydrated ${eventId} `.repeat(100) },
		});
	}
	repository.close();
	database = new DatabaseSync(databasePath);
	const noUpdateTrigger = database.prepare(`
		SELECT sql FROM sqlite_master
		WHERE type = 'trigger' AND name = 'transcript_events_no_update'
	`).get() as Readonly<{ readonly sql: string }>;
	database.exec("DROP TRIGGER transcript_events_no_update");
	database.prepare(`
		UPDATE transcript_events SET payload_json = ? WHERE event_id = ?
	`).run(JSON.stringify({
		schemaVersion: 1,
		payload: { text: "private non-placeholder value" },
	}), "private-reference-event");
	database.prepare(`
		UPDATE transcript_events SET payload_json = ? WHERE event_id = ?
	`).run(JSON.stringify({
		schemaVersion: 1,
		payload: { text: null, privateUnexpectedField: "private typed payload" },
	}), "private-typed-event");
	database.prepare(`
		INSERT INTO model_input_blobs (blob_id, payload_json, created_at)
		VALUES (?, ?, ?)
	`).run("4".repeat(64), JSON.stringify({ contentBlob: 1 }), NOW);
	database.exec(noUpdateTrigger.sql);
	database.close();

	const sessions = (await collectStorageChecks(root)).find((item) => item.name === "sessions_db");

	assert.deepEqual(sessions, {
		name: "sessions_db",
		status: "failed",
		message: "invalid_blob_backed_transcript=3",
		detail: "invalid_event_references=1,invalid_typed_events=1,invalid_model_input_references=1",
	});
	assert.doesNotMatch(
		JSON.stringify(sessions),
		/private non-placeholder|private typed payload|private-v11-integrity|private-reference/u,
	);
});

test("storage doctor reports v11 orphan bytes without collecting or exposing content", async (t) => {
	const root = await doctorFixture(t);
	const databasePath = await doctorDatabasePath(root.homeDir);
	createV11SessionDatabase({ dbPath: databasePath });
	const orphan = encodeSessionContentBlob("private orphan content ".repeat(100));
	const database = new DatabaseSync(databasePath);
	database.prepare(`
		INSERT INTO session_content_blobs (
			blob_id, codec, raw_bytes, stored_bytes, payload_blob, created_at
		) VALUES (?, ?, ?, ?, ?, ?)
	`).run(orphan.blobId, orphan.codec, orphan.rawBytes, orphan.storedBytes, orphan.payload, NOW);
	database.close();
	const before = await stat(databasePath);

	const sessions = (await collectStorageChecks(root)).find((item) => item.name === "sessions_db");

	assert.equal(sessions?.status, "ok");
	assert.match(
		sessions?.message ?? "",
		new RegExp(
			`orphan_blobs=1 orphan_raw_bytes=${orphan.rawBytes} `
				+ `orphan_stored_bytes=${orphan.storedBytes}`,
			"u",
		),
	);
	assert.doesNotMatch(JSON.stringify(sessions), /private orphan content|sha256:/u);
	assert.equal((await stat(databasePath)).mtimeMs, before.mtimeMs);
	const verify = new DatabaseSync(databasePath, { readOnly: true });
	assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM session_content_blobs").get()?.count, 1);
	verify.close();
});

test("storage doctor rejects legacy and staging objects left after v10 cutover", async (t) => {
	for (const fixture of [
		{
			name: "legacy",
			sql: "CREATE TABLE history_items (sequence_no INTEGER)",
			message: "legacy_schema_objects_after_cutover=1",
			detail: "history_items",
		},
		{
			name: "staging",
			sql: "CREATE TABLE transcript_normalization_events (session_id TEXT)",
			message: "staging_schema_objects_after_cutover=1",
			detail: "transcript_normalization_events",
		},
	] as const) {
		const root = await doctorFixture(t);
		const databasePath = await createV10DoctorDatabase(root);
		const database = new DatabaseSync(databasePath);
		database.exec(fixture.sql);
		database.close();
		assert.deepEqual(
			(await collectStorageChecks(root)).find((check) => check.name === "sessions_db"),
			{
				name: "sessions_db",
				status: "failed",
				message: fixture.message,
				detail: fixture.detail,
			},
			fixture.name,
		);
	}
});

test("storage doctor validates a real v9-to-v10 normalization manifest", async (t) => {
	const root = await doctorFixture(t);
	const databasePath = await createV9DoctorDatabase(root);
	const store = new SQLiteSessionStore({ dbPath: databasePath, clock: () => NOW });
	store.reserveTurn({
		sessionId: "doctor-cutover-session",
		clientTurnId: "doctor-cutover-client-turn",
		clientUserMessageId: "doctor-cutover-user-message",
		turnId: "doctor-cutover-turn",
		requestFingerprint: `sha256:${"b".repeat(64)}`,
		workspaceRoot: root.workspaceRoot,
		threadId: "doctor-cutover-session",
		userText: "normalize this completed fixture turn",
		startedAt: NOW,
	});
	store.completeTurn({
		sessionId: "doctor-cutover-session",
		clientTurnId: "doctor-cutover-client-turn",
		assistantText: "fixture turn normalized",
		usage: {},
		completedAt: NOW,
	});
	store.close();
	applyV9TranscriptNormalizationCutover({
		dbPath: databasePath,
		clock: () => NOW,
		freeSpaceProbe: () => 1_000_000_000,
	});
	const before = await stat(databasePath);

	const healthy = (await collectStorageChecks(root)).find((check) => check.name === "sessions_db");
	assert.equal(healthy?.status, "ok");
	assert.match(healthy?.message ?? "", /schema_version=10 .* manifest=valid/u);
	assert.equal((await stat(databasePath)).mtimeMs, before.mtimeMs);

	const database = new DatabaseSync(databasePath);
	database.prepare("UPDATE transcript_normalization_manifest SET event_count = 1").run();
	database.close();
	assert.deepEqual(
		(await collectStorageChecks(root)).find((check) => check.name === "sessions_db"),
		{
			name: "sessions_db",
			status: "failed",
			message: "invalid_normalized_transcript=1",
			detail: "invalid_migration_manifest=1",
		},
	);
});

test("storage doctor rejects broken v10 transcript recovery references", async (t) => {
	const root = await doctorFixture(t);
	const databasePath = await createV10DoctorDatabase(root);
	const database = new DatabaseSync(databasePath);
	const sessionId = "doctor-v10-recovery";
	insertDoctorSession(database, root.workspaceRoot, sessionId);
	const saveState = database.prepare(`
		INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
		VALUES (?, ?, ?, ?)
	`);
	for (const [key, payload] of [
		["compact_checkpoint", { transcript_event_id: "missing-compaction", window_id: "window-1" }],
		["suspended_turn", {
			transcript_event_id: "missing-suspension",
			turn_id: "turn-1",
			user_message: "private recovery message",
		}],
		["responses_continuation_state", { eligible: true, response_id: "missing-response" }],
		["node_effect_checkpoint", {
			turn_id: "turn-1",
			call_id: "missing-call",
			tool_name: "Read",
		}],
	] as const) saveState.run(sessionId, key, JSON.stringify(payload), NOW);
	database.prepare(`
		INSERT INTO runtime_turns (
			session_id, client_turn_id, turn_id, request_fingerprint,
			status, started_at
		) VALUES (?, 'client-turn-1', 'turn-1', ?, 'in_progress', ?)
	`).run(sessionId, `sha256:${"a".repeat(64)}`, NOW);
	database.close();

	const sessions = (await collectStorageChecks(root)).find((check) => check.name === "sessions_db");
	assert.deepEqual(sessions, {
		name: "sessions_db",
		status: "failed",
		message: "invalid_normalized_transcript=5",
		detail: "invalid_recovery_references=5",
	});
	assert.doesNotMatch(
		JSON.stringify(sessions),
		/private recovery message|missing-compaction|missing-suspension|missing-response|missing-call/u,
	);
});

test("storage doctor reports incomplete and corrupt model-input ledgers read-only", async (t) => {
	const root = await doctorFixture(t);
	const homeRoot = join(root.homeDir, ".mycli");
	await mkdir(homeRoot, { recursive: true });
	const databasePath = join(homeRoot, "sessions.db");
	const database = new DatabaseSync(databasePath);
	database.exec(SCHEMA_V2_SQL);
	database.exec(SCHEMA_V5_SQL);
	database.exec(SCHEMA_V6_SQL);
	database.exec(SCHEMA_V7_SQL);
	database.exec(SCHEMA_V8_SQL);
	database.exec(SCHEMA_V9_SQL);
	database.exec("PRAGMA foreign_keys = OFF");
	database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at, updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(
		"doctor-ledger-session",
		root.workspaceRoot,
		"doctor-ledger-session",
		"2026-08-08T00:00:00.000Z",
		"2026-08-08T00:00:00.000Z",
		"2026-08-08T00:00:00.000Z",
		"active",
	);
	database.prepare(`
		INSERT INTO model_input_blobs (blob_id, payload_json, created_at)
		VALUES (?, ?, ?)
	`).run("not-a-content-hash", "{}", "2026-08-08T00:00:00.000Z");
	database.prepare(`
		INSERT INTO instruction_snapshots (
			snapshot_id, session_id, blob_id, content_sha256, created_at
		) VALUES (?, ?, ?, ?, ?)
	`).run(
		"missing-instruction",
		"doctor-ledger-session",
		"missing-blob",
		"0".repeat(64),
		"2026-08-08T00:00:00.000Z",
	);
	database.close();
	const before = await stat(databasePath);

	const checks = await collectStorageChecks(root);
	const ledger = checks.find((check) => check.name === "model_input_ledger");

	assert.equal(ledger?.status, "failed");
	assert.match(ledger?.message ?? "", /blobs=1 manifests=0 issues=2/u);
	assert.match(ledger?.detail ?? "", /invalid_blob_hash=1/u);
	assert.match(ledger?.detail ?? "", /missing_instruction_blob=1/u);
	assert.equal((await stat(databasePath)).mtimeMs, before.mtimeMs);
});

test("storage doctor accepts a reconstructable persisted provider step", async (t) => {
	const root = await doctorFixture(t);
	const homeRoot = join(root.homeDir, ".mycli");
	await mkdir(homeRoot, { recursive: true });
	const databasePath = join(homeRoot, "sessions.db");
	const store = openRuntimeSessionStore({ dbPath: databasePath });
	const now = "2026-08-08T00:00:00.000Z";
	store.reserveTurn({
		sessionId: "healthy-ledger-session",
		clientTurnId: "healthy-client-turn",
		clientUserMessageId: "healthy-user-message",
		turnId: "healthy-turn",
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot: root.workspaceRoot,
		threadId: "healthy-ledger-session",
		userText: "Inspect README.md",
		startedAt: now,
	});
	let sequence = 0;
	commitRuntimeProviderStep({
		sessionId: "healthy-ledger-session",
		turnId: "healthy-turn",
		providerStep: 1,
		requestConfig: {
			provider: "openai",
			protocol: "responses",
			model: "gpt-test",
		},
		instructionSnapshot: Object.freeze({
			snapshotId: "healthy-instructions",
			version: "test-v1",
			source: "test",
			content: "Test system instructions.",
			contentSha256: modelInputSha256("Test system instructions."),
			createdAt: now,
		}),
		tools: [READ_TOOL_DEFINITION],
		history: store.loadConversationItems("healthy-ledger-session"),
		currentUserRequest: "Inspect README.md",
		sources: Object.freeze({}),
		ledger: store.modelInputLedger,
		maxPromptTokens: 16_000,
		clock: () => now,
		createId: (kind) => `${kind}-${++sequence}`,
	});
	store.completeTurn({
		sessionId: "healthy-ledger-session",
		clientTurnId: "healthy-client-turn",
		assistantText: "README inspected.",
		usage: {},
		completedAt: now,
	});
	store.close();
	const before = await stat(databasePath);

	const checks = await collectStorageChecks(root);
	const ledger = checks.find((check) => check.name === "model_input_ledger");
	const sessions = checks.find((check) => check.name === "sessions_db");

	assert.equal(ledger?.status, "ok");
	assert.match(ledger?.message ?? "", /manifests=1 issues=0/u);
	assert.equal(sessions?.status, "ok", sessions?.detail ?? sessions?.message);
	assert.match(sessions?.message ?? "", /schema_version=14 integrity=ok/u);
	assert.equal((await stat(databasePath)).mtimeMs, before.mtimeMs);
});

test("runtime and process doctor validate local contracts without starting work", async (t) => {
	const root = await doctorFixture(t);
	const runtime = await collectRuntimeChecks();
	let executableProbes = 0;
	const processChecks = await collectProcessChecks({
		workspaceRoot: root.workspaceRoot,
		platform: "darwin",
		isExecutable: () => {
			executableProbes += 1;
			return true;
		},
	});

	assert.deepEqual(runtime.map((check) => [check.name, check.status]), [
		["node_runtime", "ok"],
		["package_layout", "ok"],
		["runtime_contract", "ok"],
		["tool_manifest", "ok"],
	]);
	assert.deepEqual(processChecks.map((check) => [check.name, check.status]), [
		["process_support", "ok"],
		["process_sandbox", "ok"],
	]);
	assert.equal(executableProbes, 1);
	assert.doesNotMatch(JSON.stringify(processChecks), new RegExp(root.workspaceRoot, "u"));
});

async function doctorFixture(t: test.TestContext): Promise<{
	readonly workspaceRoot: string;
	readonly homeDir: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-doctor-runner-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const workspaceRoot = join(root, "workspace");
	await mkdir(workspaceRoot, { recursive: true });
	return { workspaceRoot, homeDir: join(root, "home") };
}

async function createV9DoctorDatabase(root: Readonly<{
	readonly workspaceRoot: string;
	readonly homeDir: string;
}>): Promise<string> {
	const databasePath = await doctorDatabasePath(root.homeDir);
	new SQLiteSessionStore({ dbPath: databasePath }).close();
	return databasePath;
}

async function createV10DoctorDatabase(root: Readonly<{
	readonly workspaceRoot: string;
	readonly homeDir: string;
}>): Promise<string> {
	const databasePath = await doctorDatabasePath(root.homeDir);
	createV10SessionDatabase({ dbPath: databasePath });
	return databasePath;
}

async function doctorDatabasePath(homeDir: string): Promise<string> {
	const homeRoot = join(homeDir, ".mycli");
	await mkdir(homeRoot, { recursive: true });
	return join(homeRoot, "sessions.db");
}

function insertDoctorSession(
	database: DatabaseSync,
	workspaceRoot: string,
	sessionId: string,
): void {
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at,
			updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, 'active')
	`).run(sessionId, workspaceRoot, sessionId, NOW, NOW, NOW);
}
