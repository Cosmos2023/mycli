import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { projectProviderRequest } from "@mycli/core";
import type {
	CanonicalConversationItem,
	ProviderRequestConfig,
	ToolDefinition,
} from "@mycli/core";
import {
	decodeSessionContentBlobUtf8,
	hydrateTranscriptPayload,
	MODEL_INPUT_CONTENT_BLOB_MARKER_JSON,
	parseTranscriptEventEnvelope,
	SCHEMA_V10_VERSION,
	SCHEMA_V11_VERSION,
	SCHEMA_V12_VERSION,
	SCHEMA_VERSION,
	V10_CONTENT_BLOB_MIGRATION_STAGING_COLUMNS,
	V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES,
	V10_CONTENT_BLOB_MIGRATION_STAGING_VERSION,
	v10ModelInputSourceHash,
	v10TranscriptSourceHash,
} from "@mycli/storage";
import type {
	StoredSessionContentBlob,
	TranscriptJsonValue,
	TranscriptPayloadBlobReference,
	V10ModelInputSourceHashRow,
	V10TranscriptSourceHashRow,
} from "@mycli/storage";
import { scanDoctorFiles } from "./redaction.ts";
import type { DoctorCheck } from "./types.ts";

export interface StorageDoctorOptions {
	readonly workspaceRoot: string;
	readonly homeDir: string;
}

const COMMON_REQUIRED_SCHEMA_OBJECTS = Object.freeze(new Map<string, string>([
	["schema_version", "table"],
	["sessions", "table"],
	["conversation_trees", "table"],
	["session_state", "table"],
	["runtime_turns", "table"],
	["subagent_tasks", "table"],
	["model_input_blobs", "table"],
	["instruction_snapshots", "table"],
	["tool_set_snapshots", "table"],
	["model_context_events", "table"],
	["provider_input_timeline_events", "table"],
	["provider_request_manifests", "table"],
	["provider_step_events", "table"],
	["model_input_blobs_no_update", "trigger"],
	["model_input_blobs_no_delete", "trigger"],
	["instruction_snapshots_no_update", "trigger"],
	["instruction_snapshots_no_delete", "trigger"],
	["tool_set_snapshots_no_update", "trigger"],
	["tool_set_snapshots_no_delete", "trigger"],
	["model_context_events_no_update", "trigger"],
	["model_context_events_no_delete", "trigger"],
	["provider_input_timeline_events_no_update", "trigger"],
	["provider_input_timeline_events_no_delete", "trigger"],
	["provider_request_manifests_no_update", "trigger"],
	["provider_request_manifests_no_delete", "trigger"],
	["provider_step_events_no_update", "trigger"],
	["provider_step_events_no_delete", "trigger"],
	["shell_output_chunks", "table"],
	["shell_output_chunks_no_update", "trigger"],
]));
const V9_REQUIRED_SCHEMA_OBJECTS = Object.freeze(new Map<string, string>([
	["conversation_messages", "table"],
	["conversation_messages_fts", "table"],
	["conversation_messages_fts_insert", "trigger"],
	["conversation_messages_fts_delete", "trigger"],
	["conversation_messages_fts_update", "trigger"],
	["history_items", "table"],
	["turn_rollouts", "table"],
	["session_summaries", "table"],
]));
const V10_REQUIRED_SCHEMA_OBJECTS = Object.freeze(new Map<string, string>([
	["transcript_events", "table"],
	["transcript_events_fts", "table"],
	["transcript_events_fts_insert", "trigger"],
	["transcript_events_fts_delete", "trigger"],
	["transcript_events_fts_update", "trigger"],
	["transcript_events_no_update", "trigger"],
	["transcript_events_no_delete", "trigger"],
	["idx_transcript_events_session_sequence", "index"],
	["idx_transcript_events_session_turn_sequence", "index"],
	["idx_transcript_events_session_provider", "index"],
	["idx_transcript_events_session_type_sequence", "index"],
	["idx_conversation_trees_parent_event", "index"],
]));
const V11_REQUIRED_SCHEMA_OBJECTS = Object.freeze(new Map<string, string>([
	["transcript_events", "table"],
	["transcript_events_fts", "table"],
	["transcript_events_no_update", "trigger"],
	["transcript_events_no_delete", "trigger"],
	["idx_transcript_events_session_sequence", "index"],
	["idx_transcript_events_session_turn_sequence", "index"],
	["idx_transcript_events_session_provider", "index"],
	["idx_transcript_events_session_type_sequence", "index"],
	["idx_conversation_trees_parent_event", "index"],
	["session_content_blobs", "table"],
	["session_content_blobs_no_update", "trigger"],
	["idx_session_content_blobs_codec", "index"],
	["transcript_event_blob_refs", "table"],
	["idx_transcript_event_blob_refs_blob", "index"],
	["model_input_blob_refs", "table"],
	["idx_model_input_blob_refs_content", "index"],
]));
const V12_REQUIRED_SCHEMA_OBJECTS = V11_REQUIRED_SCHEMA_OBJECTS;
const V10_REMOVED_LEGACY_OBJECTS = Object.freeze([
	"conversation_messages",
	"conversation_messages_fts",
	"conversation_messages_fts_insert",
	"conversation_messages_fts_delete",
	"conversation_messages_fts_update",
	"history_items",
	"history_items_fts",
	"history_items_fts_insert",
	"history_items_fts_delete",
	"history_items_fts_update",
	"turn_rollouts",
	"session_summaries",
] as const);
const NORMALIZATION_STAGING_TABLES = Object.freeze([
	"transcript_normalization_events",
	"transcript_normalization_batches",
	"transcript_normalization_source_map",
	"transcript_normalization_merge_keys",
	"transcript_normalization_source_conflicts",
] as const);
const NORMALIZATION_STAGING_COLUMNS = Object.freeze(new Map<string, readonly string[]>([
	["transcript_normalization_events", [
		"session_id", "event_id", "turn_id", "event_type", "provider_index",
		"model_visible", "payload_json", "created_at", "order_key",
		"order_source_priority", "canonical_source_kind", "canonical_source_rowid",
		"canonical_source_priority", "event_hash", "staging_schema_version",
	]],
	["transcript_normalization_batches", [
		"batch_id", "started_at", "completed_at", "source_row_count", "event_count",
		"merged_source_row_count", "opaque_source_row_count", "first_source_kind",
		"first_source_rowid", "last_source_kind", "last_source_rowid",
		"schema_version_before", "schema_version_after", "staging_schema_version",
	]],
	["transcript_normalization_source_map", [
		"source_kind", "source_rowid", "session_id", "source_order", "source_identity",
		"source_hash", "event_id", "disposition", "batch_id", "mapped_at",
		"staging_schema_version",
	]],
	["transcript_normalization_merge_keys", [
		"session_id", "merge_key", "event_id", "staging_schema_version",
	]],
	["transcript_normalization_source_conflicts", [
		"source_kind", "source_rowid", "detected_operation", "staging_schema_version",
	]],
]));
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MODEL_INPUT_TABLES = Object.freeze([
	"model_input_blobs",
	"instruction_snapshots",
	"tool_set_snapshots",
	"model_context_events",
	"provider_input_timeline_events",
	"provider_request_manifests",
	"provider_step_events",
] as const);
const CRITICAL_STATE_KEYS = Object.freeze([
	"pending_decision",
	"suspended_turn",
	"turn_record",
	"responses_continuation_state",
]);
const MAX_TRACE_FILES = 64;
const MAX_TRACE_FILE_BYTES = 1_048_576;

export async function collectStorageChecks(
	options: StorageDoctorOptions,
): Promise<readonly DoctorCheck[]> {
	const homeRoot = join(options.homeDir, ".mycli");
	const logsRoot = join(homeRoot, "logs");
	const tracesRoot = join(homeRoot, "traces");
	const databasePath = join(homeRoot, "sessions.db");
	return Object.freeze([
		await checkStorageLayout(homeRoot),
		await checkSessionsDatabase(databasePath),
		await checkModelInputLedger(databasePath),
		await checkDirectory("logs", logsRoot, "warning"),
		await checkTraces(tracesRoot),
		await checkRedaction(homeRoot, logsRoot, tracesRoot),
	]);
}

async function checkModelInputLedger(path: string): Promise<DoctorCheck> {
	const metadata = await optionalStat(path);
	if (!metadata) return check("model_input_ledger", "warning", "sessions database not created yet");
	if (!metadata.isFile()) return check("model_input_ledger", "failed", "sessions database is not a file");

	let database: DatabaseSyncType | undefined;
	try {
		const { DatabaseSync } = await import("node:sqlite");
		database = new DatabaseSync(path, { readOnly: true });
		database.exec("PRAGMA query_only = ON");
		const objects = new Set((database.prepare(
			"SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')",
		).all() as readonly Readonly<Record<string, unknown>>[]).flatMap((row) => (
			typeof row.name === "string" ? [row.name] : []
		)));
		const missing = MODEL_INPUT_TABLES.filter((name) => !objects.has(name));
		if (missing.length > 0) {
			return check(
				"model_input_ledger",
				"failed",
				`missing_schema_objects=${missing.length}`,
				missing.join(","),
			);
		}
		const result = inspectModelInputLedger(database);
		return check(
			"model_input_ledger",
			result.issueCount > 0 ? "failed" : "ok",
			`blobs=${result.blobCount} manifests=${result.manifestCount} issues=${result.issueCount}`,
			result.issueCount > 0 ? result.detail : undefined,
		);
	} catch {
		return check("model_input_ledger", "failed", "model-input ledger is not readable");
	} finally {
		database?.close();
	}
}

interface LedgerInspection {
	readonly blobCount: number;
	readonly manifestCount: number;
	readonly issueCount: number;
	readonly detail: string;
}

function inspectModelInputLedger(database: DatabaseSyncType): LedgerInspection {
	const issues = new Map<string, number>();
	const addIssue = (code: string, count = 1): void => {
		if (count > 0) issues.set(code, (issues.get(code) ?? 0) + count);
	};
	const version = Number(database.prepare("SELECT version FROM schema_version").get()?.version);
	const blobBacked = version === SCHEMA_V11_VERSION || version === SCHEMA_V12_VERSION;
	const hashOnlyRequests = version === SCHEMA_V12_VERSION;
	const blobRows = rows(database, blobBacked ? `
		SELECT owner.blob_id, owner.payload_json, reference.content_blob_id,
		       content.codec, content.raw_bytes, content.stored_bytes, content.payload_blob
		FROM model_input_blobs AS owner
		LEFT JOIN model_input_blob_refs AS reference ON reference.blob_id = owner.blob_id
		LEFT JOIN session_content_blobs AS content
		  ON content.blob_id = reference.content_blob_id
		ORDER BY owner.rowid
	` : `
		SELECT blob_id, payload_json FROM model_input_blobs ORDER BY rowid
	`);
	const blobs = new Map<string, unknown>();
	for (const row of blobRows) {
		if (typeof row.blob_id !== "string" || typeof row.payload_json !== "string") {
			addIssue("invalid_blob_row");
			continue;
		}
		try {
			const payloadJson = blobBacked ? hydratedModelInputBlobJson(row) : row.payload_json;
			const payload: unknown = JSON.parse(payloadJson);
			const canonical = stableJson(payload);
			const digestInput = typeof payload === "string" ? payload : canonical;
			if (canonical !== payloadJson || sha256(digestInput) !== row.blob_id) {
				addIssue("invalid_blob_hash");
				continue;
			}
			blobs.set(row.blob_id, payload);
		} catch {
			addIssue("invalid_blob_json");
		}
	}

	const instructions = new Map<string, { readonly sessionId: string; readonly payload: Readonly<Record<string, unknown>> }>();
	for (const row of rows(database, `
		SELECT snapshot_id, session_id, blob_id, content_sha256, created_at
		FROM instruction_snapshots ORDER BY rowid
	`)) {
		const payload = blobRecord(blobs, row.blob_id);
		if (!payload) {
			addIssue("missing_instruction_blob");
			continue;
		}
		if (payload.snapshotId !== row.snapshot_id || payload.contentSha256 !== row.content_sha256
			|| payload.createdAt !== row.created_at || typeof payload.content !== "string"
			|| sha256(payload.content) !== row.content_sha256 || typeof row.session_id !== "string"
			|| typeof row.snapshot_id !== "string") {
			addIssue("invalid_instruction_snapshot");
			continue;
		}
		instructions.set(row.snapshot_id, { sessionId: row.session_id, payload });
	}

	const toolSets = new Map<string, { readonly sessionId: string; readonly payload: Readonly<Record<string, unknown>> }>();
	for (const row of rows(database, `
		SELECT snapshot_id, session_id, blob_id, content_sha256, created_at
		FROM tool_set_snapshots ORDER BY rowid
	`)) {
		const payload = blobRecord(blobs, row.blob_id);
		if (!payload) {
			addIssue("missing_tool_set_blob");
			continue;
		}
		if (payload.snapshotId !== row.snapshot_id || payload.contentSha256 !== row.content_sha256
			|| payload.createdAt !== row.created_at || !Array.isArray(payload.tools)
			|| sha256(stableJson(payload.tools)) !== row.content_sha256
			|| typeof row.session_id !== "string" || typeof row.snapshot_id !== "string") {
			addIssue("invalid_tool_set_snapshot");
			continue;
		}
		toolSets.set(row.snapshot_id, { sessionId: row.session_id, payload });
	}

	const contextRows = rows(database, `
		SELECT rowid, event_id, session_id, turn_id, provider_step, section_key, blob_id,
		       supersedes_event_id, tombstone, created_at
		FROM model_context_events ORDER BY rowid
	`);
	const contextById = new Map<string, Readonly<Record<string, unknown>>>();
	for (const row of contextRows) {
		const payload = blobRecord(blobs, row.blob_id);
		if (!payload) {
			addIssue("missing_context_blob");
			continue;
		}
		const tombstone = row.tombstone === 1;
		if (payload.eventId !== row.event_id || payload.sessionId !== row.session_id
			|| payload.turnId !== row.turn_id || payload.providerStep !== row.provider_step
			|| payload.sectionKey !== row.section_key || payload.tombstone !== tombstone
			|| payload.createdAt !== row.created_at
			|| (payload.supersedesEventId ?? null) !== (row.supersedes_event_id ?? null)
			|| (tombstone ? payload.fragment !== undefined : !isRecord(payload.fragment))) {
			addIssue("invalid_context_event");
			continue;
		}
		if (typeof row.event_id === "string") contextById.set(row.event_id, row);
	}
	for (const row of contextRows) {
		if (typeof row.supersedes_event_id !== "string") continue;
		const previous = contextById.get(row.supersedes_event_id);
		if (!previous || previous.session_id !== row.session_id
			|| previous.section_key !== row.section_key
			|| Number(previous.rowid) >= Number(row.rowid)) {
			addIssue("invalid_context_supersession");
		}
	}

	const timelineRows = rows(database, `
		SELECT sequence_no, event_id, session_id, window_id, turn_id, provider_step, kind,
		       blob_id, model_context_event_id, created_at
		FROM provider_input_timeline_events ORDER BY sequence_no
	`);
	const timelineById = new Map<string, Readonly<Record<string, unknown>>>();
	const timelineByWindow = new Map<string, Readonly<Record<string, unknown>>[]>();
	const activeWindowBySession = new Map<string, string>();
	for (const row of timelineRows) {
		const payload = blobRecord(blobs, row.blob_id);
		if (!payload || !timelineEventMatchesRow(payload, row)) {
			addIssue("invalid_timeline_event");
			continue;
		}
		const sessionId = String(row.session_id);
		const windowId = String(row.window_id);
		if (row.kind === "window_boundary") {
			if (activeWindowBySession.get(sessionId) === windowId) {
				addIssue("invalid_timeline_window");
				continue;
			}
			activeWindowBySession.set(sessionId, windowId);
		} else if (activeWindowBySession.get(sessionId) !== windowId) {
			addIssue("invalid_timeline_window");
			continue;
		}
		if (typeof row.model_context_event_id === "string"
			&& !contextById.has(row.model_context_event_id)) {
			addIssue("invalid_timeline_context_reference");
			continue;
		}
		if (typeof row.event_id !== "string") {
			addIssue("invalid_timeline_event");
			continue;
		}
		timelineById.set(row.event_id, payload);
		const key = timelineWindowKey(sessionId, windowId);
		const window = timelineByWindow.get(key) ?? [];
		window.push(payload);
		timelineByWindow.set(key, window);
	}

	const manifestRows = rows(database, hashOnlyRequests ? `
		SELECT rowid, request_id, session_id, turn_id, provider_step, manifest_blob_id,
		       request_signature, logical_input_sha256, logical_request_sha256,
		       previous_request_id, boundary, created_at
		FROM provider_request_manifests ORDER BY rowid
	` : `
		SELECT rowid, request_id, session_id, turn_id, provider_step, manifest_blob_id,
		       logical_request_blob_id, request_signature, logical_input_sha256,
		       logical_request_sha256, previous_request_id, boundary, created_at
		FROM provider_request_manifests ORDER BY rowid
	`);
	const latestBySession = new Map<string, string>();
	for (const row of manifestRows) {
		const manifest = blobRecord(blobs, row.manifest_blob_id);
		const request = hashOnlyRequests ? undefined : blobRecord(blobs, row.logical_request_blob_id);
		if (!manifest || (!hashOnlyRequests && !request)) {
			addIssue("missing_manifest_blob");
			continue;
		}
		if (!manifestMatchesRow(manifest, row, hashOnlyRequests)
			|| (!hashOnlyRequests && row.logical_request_sha256 !== row.logical_request_blob_id)) {
			addIssue("invalid_manifest_row");
			continue;
		}
		const instruction = instructions.get(String(manifest.instructionSnapshotId));
		const toolSet = toolSets.get(String(manifest.toolSetSnapshotId));
		if (!instruction || !toolSet || instruction.sessionId !== row.session_id
			|| toolSet.sessionId !== row.session_id) {
			addIssue("invalid_manifest_snapshot_reference");
		} else if (hashOnlyRequests || manifest.schemaVersion === 3) {
			if (!validCompactTimelineManifest({
				manifest,
				instruction: instruction.payload,
				toolSet: toolSet.payload,
				timelineByWindow,
				committedRequestSha256: row.logical_request_sha256,
			})) {
				addIssue("invalid_manifest_timeline_reference");
			}
		} else if (!request || request.instructions !== instruction.payload.content
			|| stableJson(request.tools) !== stableJson(toolSet.payload.tools)) {
			addIssue("invalid_manifest_snapshot_reference");
		} else {
			if (!Array.isArray(manifest.orderedItems)
				|| sha256(stableJson({
					instruction_snapshot: instruction.payload.contentSha256,
					tool_set_snapshot: toolSet.payload.contentSha256,
					ordered_items: manifest.orderedItems,
				})) !== manifest.logicalInputSha256) {
				addIssue("invalid_manifest_logical_digest");
			}
			if (manifest.schemaVersion === 2 && !validTimelineManifest({
				manifest,
				request,
				instruction: instruction.payload,
				toolSet: toolSet.payload,
				timelineById,
				timelineByWindow,
			})) {
				addIssue("invalid_manifest_timeline_reference");
			}
		}
		const sessionId = String(row.session_id);
		const previous = latestBySession.get(sessionId);
		if (previous === undefined) {
			if (row.previous_request_id !== null || row.boundary !== "bootstrap") {
				addIssue("invalid_manifest_chain");
			}
		} else if (row.previous_request_id !== previous || row.boundary === "bootstrap") {
			addIssue("invalid_manifest_chain");
		}
		if (typeof row.request_id === "string") latestBySession.set(sessionId, row.request_id);
	}

	const lifecycleByRequest = new Map<string, string[]>();
	for (const row of rows(database, `
		SELECT event_id, request_id, session_id, state, payload_json
		FROM provider_step_events ORDER BY sequence_no
	`)) {
		if (typeof row.request_id !== "string" || typeof row.state !== "string"
			|| typeof row.payload_json !== "string") {
			addIssue("invalid_lifecycle_event");
			continue;
		}
		try {
			const payload: unknown = JSON.parse(row.payload_json);
			if (!isRecord(payload) || stableJson(payload) !== row.payload_json) {
				addIssue("invalid_lifecycle_event");
			}
		} catch {
			addIssue("invalid_lifecycle_event");
		}
		const states = lifecycleByRequest.get(row.request_id) ?? [];
		states.push(row.state);
		lifecycleByRequest.set(row.request_id, states);
	}
	for (const row of manifestRows) {
		const states = lifecycleByRequest.get(String(row.request_id)) ?? [];
		if (states[0] !== "prepared") addIssue("missing_prepared_event");
		for (let index = 1; index < states.length; index += 1) {
			if (!validLifecycleTransition(states[index - 1]!, states[index]!)) {
				addIssue("invalid_lifecycle_transition");
			}
		}
	}

	const issueCount = [...issues.values()].reduce((total, value) => total + value, 0);
	return Object.freeze({
		blobCount: blobRows.length,
		manifestCount: manifestRows.length,
		issueCount,
		detail: [...issues].slice(0, 12).map(([code, count]) => `${code}=${count}`).join(","),
	});
}

function hydratedModelInputBlobJson(row: Readonly<Record<string, unknown>>): string {
	if (row.payload_json !== MODEL_INPUT_CONTENT_BLOB_MARKER_JSON
		|| typeof row.content_blob_id !== "string"
		|| typeof row.codec !== "string"
		|| typeof row.raw_bytes !== "number"
		|| typeof row.stored_bytes !== "number"
		|| !(row.payload_blob instanceof Uint8Array)) {
		throw new Error("invalid model-input content reference");
	}
	return decodeSessionContentBlobUtf8({
		blobId: row.content_blob_id,
		codec: row.codec,
		rawBytes: row.raw_bytes,
		storedBytes: row.stored_bytes,
		payload: row.payload_blob,
	});
}

async function checkStorageLayout(homeRoot: string): Promise<DoctorCheck> {
	const problems: string[] = [];
	for (const name of ["traces", "artifacts"] as const) {
		const metadata = await optionalStat(join(homeRoot, name));
		if (!metadata) continue;
		if (!metadata.isDirectory()) problems.push(`${name}_not_directory`);
		else if ((metadata.mode & 0o222) === 0) problems.push(`${name}_not_writable`);
	}
	return problems.length > 0
		? check("storage_layout", "failed", `issues=${problems.length}`, problems.join(","))
		: check("storage_layout", "ok", "reserved storage layout valid");
}

async function checkSessionsDatabase(path: string): Promise<DoctorCheck> {
	const metadata = await optionalStat(path);
	if (!metadata) return check("sessions_db", "warning", "sessions database not created yet");
	if (!metadata.isFile()) return check("sessions_db", "failed", "sessions database is not a file");

	let database: DatabaseSyncType | undefined;
	try {
		const { DatabaseSync } = await import("node:sqlite");
		database = new DatabaseSync(path, { readOnly: true });
		database.exec("PRAGMA query_only = ON");
		const integrity = database.prepare("PRAGMA quick_check").get();
		const integrityFailure = !integrity || !Object.values(integrity).includes("ok")
			? check("sessions_db", "failed", "SQLite integrity check failed")
			: undefined;
		const objects = database.prepare(
			"SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
		).all() as readonly Readonly<Record<string, unknown>>[];
		const present = new Map(objects.flatMap((row) => (
			typeof row.name === "string" && typeof row.type === "string"
				? [[row.name, row.type] as const]
				: []
		)));
		const missingCommon = missingSchemaObjects(present, COMMON_REQUIRED_SCHEMA_OBJECTS);
		if (missingCommon.length > 0) {
			return missingSchemaCheck(missingCommon);
		}
		const versions = database.prepare("SELECT version FROM schema_version").all();
		const version = versions.length === 1 && typeof versions[0]?.version === "number"
			? versions[0].version
			: undefined;
		if (version !== SCHEMA_VERSION && version !== SCHEMA_V10_VERSION
			&& version !== SCHEMA_V11_VERSION && version !== SCHEMA_V12_VERSION) {
			return check(
				"sessions_db",
				"failed",
				`schema_version expected=${SCHEMA_VERSION}|${SCHEMA_V10_VERSION}|${
					SCHEMA_V11_VERSION}|${SCHEMA_V12_VERSION
				} actual=${
					version ?? "invalid"
				}`,
			);
		}
		const versionObjects = version === SCHEMA_VERSION
			? V9_REQUIRED_SCHEMA_OBJECTS
			: version === SCHEMA_V10_VERSION
				? V10_REQUIRED_SCHEMA_OBJECTS
				: version === SCHEMA_V11_VERSION
					? V11_REQUIRED_SCHEMA_OBJECTS
					: V12_REQUIRED_SCHEMA_OBJECTS;
		const missing = missingSchemaObjects(present, versionObjects);
		if (missing.length > 0) {
			return missingSchemaCheck(missing);
		}
		const invalidStates = invalidCriticalStates(database);
		if (invalidStates > 0) {
			return check("sessions_db", "failed", `invalid_recovery_states=${invalidStates}`);
		}
		if (version === SCHEMA_VERSION) {
			if (!validExternalContentFts(database, "conversation_messages_fts", "conversation_messages", "rowid")) {
				return check("sessions_db", "failed", "invalid_conversation_search_projection");
			}
			const invalidLineage = invalidV9LineageCount(database);
			if (invalidLineage > 0) {
				return check("sessions_db", "failed", `invalid_session_lineage=${invalidLineage}`);
			}
			const staging = inspectV9NormalizationStaging(database, present);
			if (staging.issueCount > 0) {
				return check(
					"sessions_db",
					"failed",
					`invalid_transcript_normalization_staging=${staging.issueCount}`,
					staging.detail,
				);
			}
			return integrityFailure ?? check(
				"sessions_db",
				"ok",
				`schema_version=${SCHEMA_VERSION} integrity=ok ${staging.summary}`,
			);
		}
		const result = version === SCHEMA_V10_VERSION
			? inspectV10SessionsDatabase(database, present)
			: inspectBlobBackedSessionsDatabase(database, present, version);
		return result.status === "failed" ? result : integrityFailure ?? result;
	} catch {
		return check("sessions_db", "failed", "sessions database is not readable");
	} finally {
		database?.close();
	}
}

function missingSchemaObjects(
	present: ReadonlyMap<string, string>,
	required: ReadonlyMap<string, string>,
): readonly string[] {
	return [...required].flatMap(([name, type]) => present.get(name) === type ? [] : [name]);
}

function missingSchemaCheck(missing: readonly string[]): DoctorCheck {
	return check(
		"sessions_db",
		"failed",
		`missing_schema_objects=${missing.length}`,
		missing.slice(0, 12).join(","),
	);
}

function validExternalContentFts(
	database: DatabaseSyncType,
	name: string,
	contentTable: string,
	contentRowid: string,
): boolean {
	const row = database.prepare(`
		SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
	`).get(name) as Readonly<Record<string, unknown>> | undefined;
	const sql = typeof row?.sql === "string" ? row.sql.toLowerCase().replace(/\s+/gu, "") : "";
	return sql.includes(`content='${contentTable}'`)
		&& sql.includes(`content_rowid='${contentRowid}'`);
}

function validContentlessFts(database: DatabaseSyncType, name: string): boolean {
	const row = database.prepare(`
		SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
	`).get(name) as Readonly<Record<string, unknown>> | undefined;
	const sql = typeof row?.sql === "string" ? row.sql.toLowerCase().replace(/\s+/gu, "") : "";
	return sql.includes("content=''") && sql.includes("contentless_delete=1");
}

function invalidCriticalStates(database: DatabaseSyncType): number {
	const placeholders = CRITICAL_STATE_KEYS.map(() => "?").join(",");
	const rows = database.prepare(
		`SELECT state_key, payload_json FROM session_state WHERE state_key IN (${placeholders})`,
	).all(...CRITICAL_STATE_KEYS) as readonly Readonly<Record<string, unknown>>[];
	let invalid = 0;
	for (const row of rows) {
		if (typeof row.payload_json !== "string") {
			invalid += 1;
			continue;
		}
		try {
			const payload: unknown = JSON.parse(row.payload_json);
			if (!isRecord(payload) || !validNestedRecoveryState(row.state_key, payload)) invalid += 1;
		} catch {
			invalid += 1;
		}
	}
	return invalid;
}

function validNestedRecoveryState(
	key: unknown,
	payload: Readonly<Record<string, unknown>>,
): boolean {
	if (key !== "suspended_turn") return true;
	for (const nested of ["pending_decision", "pending_clarification"] as const) {
		if (payload[nested] !== undefined && payload[nested] !== null
			&& !isRecord(payload[nested])) return false;
	}
	return payload.user_message === undefined || typeof payload.user_message === "string";
}

function invalidV9LineageCount(database: DatabaseSyncType): number {
	const row = database.prepare(`
		WITH message_counts AS (
			SELECT session_id, COUNT(*) AS message_count
			FROM conversation_messages
			GROUP BY session_id
		)
		SELECT COUNT(*) AS invalid_count
		FROM conversation_trees AS tree
		LEFT JOIN message_counts AS child ON child.session_id = tree.session_id
		LEFT JOIN message_counts AS parent ON parent.session_id = tree.parent_id
		WHERE tree.fork_point IS NOT NULL
		  AND (
			tree.fork_point < 0
			OR tree.fork_point > COALESCE(child.message_count, 0)
			OR (tree.parent_id IS NOT NULL AND tree.fork_point > COALESCE(parent.message_count, 0))
		  )
	`).get();
	return typeof row?.invalid_count === "number" ? row.invalid_count : Number(row?.invalid_count ?? 0);
}

interface StagingInspection {
	readonly issueCount: number;
	readonly detail?: string;
	readonly summary: string;
}

function inspectV9NormalizationStaging(
	database: DatabaseSyncType,
	present: ReadonlyMap<string, string>,
): StagingInspection {
	const staging = NORMALIZATION_STAGING_TABLES.filter((name) => present.get(name) === "table");
	if (staging.length === 0) return { issueCount: 0, summary: "staging=none" };
	if (staging.length !== NORMALIZATION_STAGING_TABLES.length) {
		return {
			issueCount: NORMALIZATION_STAGING_TABLES.length - staging.length,
			detail: "incomplete_staging_schema",
			summary: "staging=invalid",
		};
	}
	const issues = new Map<string, number>();
	for (const [table, expected] of NORMALIZATION_STAGING_COLUMNS) {
		const actual = rows(database, `PRAGMA table_info(${table})`).map((row) => String(row.name));
		if (stableJson(actual) !== stableJson(expected)) issues.set("invalid_staging_columns", 1);
	}
	const invalidEvents = countRows(database, `
		SELECT COUNT(*) AS count FROM transcript_normalization_events
		WHERE staging_schema_version != 1
		   OR length(event_hash) != 64
		   OR event_hash GLOB '*[^0-9a-f]*'
		   OR json_valid(payload_json) = 0
		   OR json_extract(payload_json, '$.schemaVersion') != 1
		   OR json_type(payload_json, '$.payload') != 'object'
		   OR (model_visible = 1) != (provider_index IS NOT NULL)
	`);
	if (invalidEvents > 0) issues.set("invalid_staged_events", invalidEvents);
	const invalidBatches = countRows(database, `
		SELECT COUNT(*) AS count FROM transcript_normalization_batches
		WHERE staging_schema_version != 1 OR schema_version_before != 9
		   OR schema_version_after != 9 OR completed_at IS NULL
	`);
	if (invalidBatches > 0) issues.set("invalid_staging_batches", invalidBatches);
	const invalidMappings = countRows(database, `
		SELECT COUNT(*) AS count
		FROM transcript_normalization_source_map AS mapped
		LEFT JOIN transcript_normalization_events AS events
		  ON events.session_id = mapped.session_id AND events.event_id = mapped.event_id
		WHERE mapped.staging_schema_version != 1
		   OR length(mapped.source_hash) != 64
		   OR mapped.source_hash GLOB '*[^0-9a-f]*'
		   OR events.event_id IS NULL
	`);
	if (invalidMappings > 0) issues.set("invalid_staging_mappings", invalidMappings);
	const invalidVersions = countRows(database, `
		SELECT
			(SELECT COUNT(*) FROM transcript_normalization_merge_keys
			 WHERE staging_schema_version != 1)
			+ (SELECT COUNT(*) FROM transcript_normalization_source_conflicts
			   WHERE staging_schema_version != 1) AS count
	`);
	if (invalidVersions > 0) issues.set("invalid_staging_versions", invalidVersions);
	const conflicts = countRows(
		database,
		"SELECT COUNT(*) AS count FROM transcript_normalization_source_conflicts",
	);
	if (conflicts > 0) issues.set("source_conflicts", conflicts);
	const eventCount = countRows(
		database,
		"SELECT COUNT(*) AS count FROM transcript_normalization_events",
	);
	const mappedCount = countRows(
		database,
		"SELECT COUNT(*) AS count FROM transcript_normalization_source_map",
	);
	const opaqueCount = countRows(database, `
		SELECT COUNT(*) AS count FROM transcript_normalization_source_map
		WHERE disposition = 'opaque'
	`);
	return {
		issueCount: sumIssueCounts(issues),
		...(issues.size > 0 ? { detail: issueDetail(issues) } : {}),
		summary: `staging=present events=${eventCount} mapped=${mappedCount} opaque=${opaqueCount}`,
	};
}

function inspectV10SessionsDatabase(
	database: DatabaseSyncType,
	present: ReadonlyMap<string, string>,
): DoctorCheck {
	const legacy = V10_REMOVED_LEGACY_OBJECTS.filter((name) => present.has(name));
	if (legacy.length > 0) {
		return check(
			"sessions_db",
			"failed",
			`legacy_schema_objects_after_cutover=${legacy.length}`,
			legacy.slice(0, 12).join(","),
		);
	}
	const staging = NORMALIZATION_STAGING_TABLES.filter((name) => present.has(name));
	if (staging.length > 0) {
		return check(
			"sessions_db",
			"failed",
			`staging_schema_objects_after_cutover=${staging.length}`,
			staging.join(","),
		);
	}
	if (!validExternalContentFts(
		database,
		"transcript_events_fts",
		"transcript_events",
		"sequence_no",
	)) return check("sessions_db", "failed", "invalid_transcript_search_projection");
	const contentBlobStaging = inspectV10ContentBlobStaging(database, present);
	if (contentBlobStaging.issueCount > 0) {
		return check(
			"sessions_db",
			"failed",
			`invalid_content_blob_staging=${contentBlobStaging.issueCount}`,
			contentBlobStaging.detail,
		);
	}

	const issues = new Map<string, number>();
	const invalidEvents = invalidTranscriptEventCount(database);
	if (invalidEvents > 0) issues.set("invalid_events", invalidEvents);
	const invalidFts = invalidTranscriptFtsCount(database);
	if (invalidFts > 0) issues.set("invalid_event_fts", invalidFts);
	const invalidLineage = invalidV10LineageCount(database);
	if (invalidLineage > 0) issues.set("invalid_event_lineage", invalidLineage);
	const invalidRecovery = invalidV10RecoveryReferenceCount(database);
	if (invalidRecovery > 0) issues.set("invalid_recovery_references", invalidRecovery);
	const foreignKeys = rows(database, "PRAGMA foreign_key_check").length;
	if (foreignKeys > 0) issues.set("foreign_key_violations", foreignKeys);
	const manifest = inspectNormalizationManifest(database, present);
	if (manifest.issueCount > 0) issues.set("invalid_migration_manifest", manifest.issueCount);
	if (issues.size > 0) {
		return check(
			"sessions_db",
			"failed",
			`invalid_normalized_transcript=${sumIssueCounts(issues)}`,
			issueDetail(issues),
		);
	}
	const eventCount = countRows(database, "SELECT COUNT(*) AS count FROM transcript_events");
	const opaqueCount = countRows(database, `
		SELECT COUNT(*) AS count FROM transcript_events WHERE event_type = 'opaque_legacy'
	`);
	const activeTurns = countRows(database, `
		SELECT COUNT(*) AS count FROM runtime_turns WHERE status = 'in_progress'
	`);
	return check(
		"sessions_db",
		"ok",
		`schema_version=${SCHEMA_V10_VERSION} integrity=ok events=${eventCount} `
			+ `opaque_events=${opaqueCount} active_turns=${activeTurns} ${manifest.summary}`
			+ contentBlobStaging.summary,
	);
}

function inspectBlobBackedSessionsDatabase(
	database: DatabaseSyncType,
	present: ReadonlyMap<string, string>,
	version: typeof SCHEMA_V11_VERSION | typeof SCHEMA_V12_VERSION,
): DoctorCheck {
	if (version === SCHEMA_V12_VERSION) {
		const columns = new Set(rows(database, "PRAGMA table_info(provider_request_manifests)")
			.flatMap((row) => typeof row.name === "string" ? [row.name] : []));
		if (columns.has("logical_request_blob_id") || !columns.has("logical_request_sha256")) {
			return check("sessions_db", "failed", "invalid_provider_request_manifest_shape");
		}
	}
	const legacy = V10_REMOVED_LEGACY_OBJECTS.filter((name) => present.has(name));
	if (legacy.length > 0) {
		return check(
			"sessions_db",
			"failed",
			`legacy_schema_objects_after_cutover=${legacy.length}`,
			legacy.slice(0, 12).join(","),
		);
	}
	const staging = NORMALIZATION_STAGING_TABLES.filter((name) => present.has(name));
	if (staging.length > 0) {
		return check(
			"sessions_db",
			"failed",
			`staging_schema_objects_after_cutover=${staging.length}`,
			staging.join(","),
		);
	}
	if (!validContentlessFts(database, "transcript_events_fts")) {
		return check("sessions_db", "failed", "invalid_transcript_search_projection");
	}

	const issues = new Map<string, number>();
	const invalidEvents = invalidTranscriptEventCount(database);
	if (invalidEvents > 0) issues.set("invalid_events", invalidEvents);
	const invalidBlobs = invalidContentBlobCount(database, "session_content_blobs");
	if (invalidBlobs > 0) issues.set("invalid_content_blobs", invalidBlobs);
	const hydratedEvents = inspectHydratedTranscriptEvents(database);
	if (hydratedEvents.invalidReferenceCount > 0) {
		issues.set("invalid_event_references", hydratedEvents.invalidReferenceCount);
	}
	if (hydratedEvents.invalidTypedEventCount > 0) {
		issues.set("invalid_typed_events", hydratedEvents.invalidTypedEventCount);
	}
	const invalidModelInputReferences = invalidV11ModelInputReferenceCount(database);
	if (invalidModelInputReferences > 0) {
		issues.set("invalid_model_input_references", invalidModelInputReferences);
	}
	const invalidFts = invalidTranscriptFtsCount(database);
	if (invalidFts > 0) issues.set("invalid_event_fts", invalidFts);
	const invalidLineage = invalidV10LineageCount(database);
	if (invalidLineage > 0) issues.set("invalid_event_lineage", invalidLineage);
	const invalidRecovery = invalidV10RecoveryReferenceCount(database);
	if (invalidRecovery > 0) issues.set("invalid_recovery_references", invalidRecovery);
	const foreignKeys = rows(database, "PRAGMA foreign_key_check").length;
	if (foreignKeys > 0) issues.set("foreign_key_violations", foreignKeys);
	if (issues.size > 0) {
		return check(
			"sessions_db",
			"failed",
			`invalid_blob_backed_transcript=${sumIssueCounts(issues)}`,
			issueDetail(issues),
		);
	}
	const eventCount = countRows(database, "SELECT COUNT(*) AS count FROM transcript_events");
	const metrics = contentBlobMetrics(database);
	return check(
		"sessions_db",
		"ok",
		`schema_version=${version} integrity=ok events=${eventCount} `
			+ `blobs=${metrics.blobCount} references=${metrics.referenceCount} `
			+ `raw_bytes=${metrics.reachableRawBytes} stored_bytes=${metrics.reachableStoredBytes} `
			+ `logical_bytes=${metrics.logicalReferenceBytes} `
			+ `deduplicated_bytes=${metrics.deduplicatedReferenceBytes} `
			+ `orphan_blobs=${metrics.orphanBlobCount} `
			+ `orphan_raw_bytes=${metrics.orphanRawBytes} `
			+ `orphan_stored_bytes=${metrics.orphanStoredBytes}`,
	);
}

interface ContentBlobStagingInspection {
	readonly issueCount: number;
	readonly detail?: string;
	readonly summary: string;
}

function inspectV10ContentBlobStaging(
	database: DatabaseSyncType,
	present: ReadonlyMap<string, string>,
): ContentBlobStagingInspection {
	const existing = V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES.filter(
		(name) => present.get(name) === "table",
	);
	if (existing.length === 0) return { issueCount: 0, summary: "" };
	if (existing.length !== V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES.length) {
		const missing = V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES.length - existing.length;
		return {
			issueCount: missing,
			detail: `incomplete_staging_schema=${missing}`,
			summary: " content_blob_staging=invalid",
		};
	}

	const issues = new Map<string, number>();
	let invalidColumns = 0;
	for (const [table, expected] of Object.entries(
		V10_CONTENT_BLOB_MIGRATION_STAGING_COLUMNS,
	)) {
		const actual = rows(database, `PRAGMA table_info(${table})`).map((row) => String(row.name));
		if (stableJson(actual) !== stableJson(expected)) invalidColumns += 1;
	}
	if (invalidColumns > 0) {
		return {
			issueCount: invalidColumns,
			detail: `invalid_staging_columns=${invalidColumns}`,
			summary: " content_blob_staging=invalid",
		};
	}

	const invalidBatches = countRows(database, `
		SELECT COUNT(*) AS count FROM content_blob_migration_batches AS batch
		WHERE batch.staging_schema_version != ${V10_CONTENT_BLOB_MIGRATION_STAGING_VERSION}
		   OR batch.completed_at IS NULL
		   OR batch.schema_version_before != ${SCHEMA_V10_VERSION}
		   OR batch.schema_version_after != ${SCHEMA_V10_VERSION}
		   OR batch.source_row_count != batch.transcript_event_count + batch.model_input_blob_count
		   OR batch.transcript_event_count != (
		       SELECT COUNT(*) FROM content_blob_migration_event_source_map AS event_map
		       WHERE event_map.batch_id = batch.batch_id
		   )
		   OR batch.model_input_blob_count != (
		       SELECT COUNT(*) FROM content_blob_migration_model_input_source_map AS model_map
		       WHERE model_map.batch_id = batch.batch_id
		   )
		   OR batch.reference_count != (
		       SELECT COUNT(*) FROM content_blob_migration_event_refs AS event_ref
		       JOIN content_blob_migration_event_source_map AS event_map
		         ON event_map.sequence_no = event_ref.sequence_no
		       WHERE event_map.batch_id = batch.batch_id
		   ) + batch.model_input_blob_count
		   OR batch.source_payload_bytes != COALESCE((
		       SELECT SUM(source_payload_bytes)
		       FROM content_blob_migration_event_source_map AS event_map
		       WHERE event_map.batch_id = batch.batch_id
		   ), 0) + COALESCE((
		       SELECT SUM(source_payload_bytes)
		       FROM content_blob_migration_model_input_source_map AS model_map
		       WHERE model_map.batch_id = batch.batch_id
		   ), 0)
		   OR batch.reference_raw_bytes != COALESCE((
		       SELECT SUM(reference_raw_bytes)
		       FROM content_blob_migration_event_source_map AS event_map
		       WHERE event_map.batch_id = batch.batch_id
		   ), 0) + COALESCE((
		       SELECT SUM(source_payload_bytes)
		       FROM content_blob_migration_model_input_source_map AS model_map
		       WHERE model_map.batch_id = batch.batch_id
		   ), 0)
		   OR batch.new_content_blob_count < 0 OR batch.new_raw_bytes < 0
		   OR batch.new_stored_bytes < 0 OR batch.new_stored_bytes > batch.new_raw_bytes
	`);
	if (invalidBatches > 0) issues.set("invalid_staging_batches", invalidBatches);
	const invalidBlobs = invalidContentBlobCount(
		database,
		"content_blob_migration_content",
		true,
	);
	if (invalidBlobs > 0) issues.set("invalid_staged_content_blobs", invalidBlobs);
	const invalidEventMaps = invalidStagedEventMapCount(database);
	if (invalidEventMaps > 0) issues.set("invalid_staged_events", invalidEventMaps);
	const invalidModelMaps = invalidStagedModelInputMapCount(database);
	if (invalidModelMaps > 0) issues.set("invalid_staged_model_inputs", invalidModelMaps);
	const conflicts = countRows(
		database,
		"SELECT COUNT(*) AS count FROM content_blob_migration_source_conflicts",
	);
	if (conflicts > 0) issues.set("source_conflicts", conflicts);
	const orphanBlobs = countRows(database, `
		SELECT COUNT(*) AS count FROM content_blob_migration_content AS content
		WHERE NOT EXISTS (
			SELECT 1 FROM content_blob_migration_event_refs AS event_ref
			WHERE event_ref.blob_id = content.blob_id
		) AND NOT EXISTS (
			SELECT 1 FROM content_blob_migration_model_input_source_map AS model_ref
			WHERE model_ref.content_blob_id = content.blob_id
		)
	`);
	if (orphanBlobs > 0) issues.set("orphan_staged_content_blobs", orphanBlobs);
	const invalidVersions = V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES.reduce(
		(total, table) => total + countRows(database, `
			SELECT COUNT(*) AS count FROM ${table}
			WHERE staging_schema_version != ${V10_CONTENT_BLOB_MIGRATION_STAGING_VERSION}
		`),
		0,
	);
	if (invalidVersions > 0) issues.set("invalid_staging_versions", invalidVersions);
	const metrics = contentBlobTableMetrics(database, "content_blob_migration_content");
	const batches = countRows(database, "SELECT COUNT(*) AS count FROM content_blob_migration_batches");
	const events = countRows(
		database,
		"SELECT COUNT(*) AS count FROM content_blob_migration_event_source_map",
	);
	const modelInputs = countRows(
		database,
		"SELECT COUNT(*) AS count FROM content_blob_migration_model_input_source_map",
	);
	const references = countRows(
		database,
		"SELECT COUNT(*) AS count FROM content_blob_migration_event_refs",
	) + modelInputs;
	const remaining = countRows(database, `
		SELECT (
			SELECT COUNT(*) FROM transcript_events AS event
			LEFT JOIN content_blob_migration_event_source_map AS mapped
			  ON mapped.sequence_no = event.sequence_no
			WHERE mapped.sequence_no IS NULL
		) + (
			SELECT COUNT(*) FROM model_input_blobs AS owner
			LEFT JOIN content_blob_migration_model_input_source_map AS mapped
			  ON mapped.blob_id = owner.blob_id
			WHERE mapped.blob_id IS NULL
		) AS count
	`);
	return {
		issueCount: sumIssueCounts(issues),
		...(issues.size > 0 ? { detail: issueDetail(issues) } : {}),
		summary: ` content_blob_staging=present batches=${batches} events=${events} `
			+ `model_inputs=${modelInputs} blobs=${metrics.blobCount} references=${references} `
			+ `raw_bytes=${metrics.rawBytes} stored_bytes=${metrics.storedBytes} `
			+ `remaining=${remaining}`,
	};
}

function invalidStagedEventMapCount(database: DatabaseSyncType): number {
	let invalid = 0;
	for (const mapped of iterateRows(database, `
		SELECT * FROM content_blob_migration_event_source_map ORDER BY sequence_no
	`)) {
		try {
			const source = database.prepare(`
				SELECT sequence_no, session_id, event_id, turn_id, event_type, provider_index,
				       model_visible, payload_json, created_at
				FROM transcript_events WHERE sequence_no = ?
			`).get(mapped.sequence_no as SQLInputValue) as
				| Readonly<Record<string, unknown>>
				| undefined;
			if (!source || typeof source.payload_json !== "string"
				|| mapped.source_hash !== v10TranscriptSourceHash(
					source as unknown as V10TranscriptSourceHashRow,
				)
				|| mapped.staging_schema_version !== V10_CONTENT_BLOB_MIGRATION_STAGING_VERSION
				|| mapped.source_payload_bytes !== Buffer.byteLength(source.payload_json, "utf8")
				|| typeof mapped.staged_payload_json !== "string"
				|| mapped.staged_payload_bytes !== Buffer.byteLength(mapped.staged_payload_json, "utf8")) {
				throw new Error("invalid staged transcript source");
			}
			const references = transcriptReferences(
				database,
				"content_blob_migration_event_refs",
				mapped.sequence_no,
			);
			if (mapped.reference_count !== references.length
				|| mapped.reference_raw_bytes !== referenceRawBytes(
					database,
					"content_blob_migration_content",
					references,
				)) {
				throw new Error("invalid staged transcript reference count");
			}
			const inline = parseTranscriptRowEvent(source, parseStoredTranscriptPayload(source.payload_json));
			const hydrated = hydrateTranscriptPayload(
				parseStoredTranscriptPayload(mapped.staged_payload_json),
				references,
				(blobId) => loadStoredContentBlob(
					database,
					"content_blob_migration_content",
					blobId,
				),
			);
			const staged = parseTranscriptRowEvent(source, hydrated);
			if (stableJson(inline) !== stableJson(staged)) {
				throw new Error("staged transcript parity failed");
			}
		} catch {
			invalid += 1;
		}
	}
	return invalid;
}

function invalidStagedModelInputMapCount(database: DatabaseSyncType): number {
	let invalid = 0;
	for (const mapped of iterateRows(database, `
		SELECT * FROM content_blob_migration_model_input_source_map ORDER BY blob_id
	`)) {
		try {
			const source = database.prepare(`
				SELECT blob_id, payload_json, created_at FROM model_input_blobs WHERE blob_id = ?
				`).get(mapped.blob_id as SQLInputValue) as
					| Readonly<Record<string, unknown>>
					| undefined;
			if (!source || typeof source.payload_json !== "string"
				|| mapped.source_hash !== v10ModelInputSourceHash(
					source as unknown as V10ModelInputSourceHashRow,
				)
				|| mapped.staging_schema_version !== V10_CONTENT_BLOB_MIGRATION_STAGING_VERSION
				|| mapped.source_payload_bytes !== Buffer.byteLength(source.payload_json, "utf8")
				|| typeof mapped.content_blob_id !== "string") {
				throw new Error("invalid staged model-input source");
			}
			const content = loadStoredContentBlob(
				database,
				"content_blob_migration_content",
				mapped.content_blob_id,
			);
			if (!content || mapped.content_stored_bytes !== content.storedBytes
				|| decodeSessionContentBlobUtf8(content) !== source.payload_json) {
				throw new Error("staged model-input parity failed");
			}
		} catch {
			invalid += 1;
		}
	}
	return invalid;
}

interface HydratedTranscriptInspection {
	readonly invalidReferenceCount: number;
	readonly invalidTypedEventCount: number;
}

function inspectHydratedTranscriptEvents(
	database: DatabaseSyncType,
): HydratedTranscriptInspection {
	let invalidReferenceCount = 0;
	let invalidTypedEventCount = 0;
	for (const event of iterateRows(database, `
		SELECT sequence_no, session_id, event_id, turn_id, event_type, provider_index,
		       model_visible, payload_json, created_at
		FROM transcript_events ORDER BY sequence_no
	`)) {
		let hydrated: TranscriptJsonValue;
		try {
			const references = transcriptReferences(
				database,
				"transcript_event_blob_refs",
				event.sequence_no,
			);
			hydrated = hydrateTranscriptPayload(
				parseStoredTranscriptPayload(event.payload_json),
				references,
				(blobId) => loadStoredContentBlob(database, "session_content_blobs", blobId),
			);
		} catch {
			invalidReferenceCount += 1;
			continue;
		}
		try {
			parseTranscriptRowEvent(event, hydrated);
		} catch {
			invalidTypedEventCount += 1;
		}
	}
	const orphanReferences = countRows(database, `
		SELECT COUNT(*) AS count FROM transcript_event_blob_refs AS reference
		LEFT JOIN transcript_events AS event ON event.sequence_no = reference.sequence_no
		LEFT JOIN session_content_blobs AS content ON content.blob_id = reference.blob_id
		WHERE event.sequence_no IS NULL OR content.blob_id IS NULL
	`);
	return {
		invalidReferenceCount: invalidReferenceCount + orphanReferences,
		invalidTypedEventCount,
	};
}

function invalidV11ModelInputReferenceCount(database: DatabaseSyncType): number {
	let invalid = 0;
	for (const owner of iterateRows(database, `
		SELECT owner.blob_id, owner.payload_json, reference.content_blob_id
		FROM model_input_blobs AS owner
		LEFT JOIN model_input_blob_refs AS reference ON reference.blob_id = owner.blob_id
		ORDER BY owner.blob_id
	`)) {
		try {
			if (typeof owner.blob_id !== "string"
				|| owner.payload_json !== MODEL_INPUT_CONTENT_BLOB_MARKER_JSON
				|| typeof owner.content_blob_id !== "string") {
				throw new Error("invalid model-input ownership");
			}
			const content = loadStoredContentBlob(
				database,
				"session_content_blobs",
				owner.content_blob_id,
			);
			if (!content) throw new Error("missing model-input content");
			const payloadJson = decodeSessionContentBlobUtf8(content);
			const payload: unknown = JSON.parse(payloadJson);
			const canonical = stableJson(payload);
			const digestInput = typeof payload === "string" ? payload : canonical;
			if (canonical !== payloadJson || sha256(digestInput) !== owner.blob_id) {
				throw new Error("invalid model-input identity");
			}
		} catch {
			invalid += 1;
		}
	}
	return invalid + countRows(database, `
		SELECT COUNT(*) AS count FROM model_input_blob_refs AS reference
		LEFT JOIN model_input_blobs AS owner ON owner.blob_id = reference.blob_id
		LEFT JOIN session_content_blobs AS content
		  ON content.blob_id = reference.content_blob_id
		WHERE owner.blob_id IS NULL OR content.blob_id IS NULL
	`);
}

function invalidContentBlobCount(
	database: DatabaseSyncType,
	table: "content_blob_migration_content" | "session_content_blobs",
	staged = false,
): number {
	let invalid = 0;
	for (const row of iterateRows(database, `
		SELECT blob_id, codec, raw_bytes, stored_bytes, payload_blob
		       ${staged ? ", staging_schema_version" : ""}
		FROM ${table} ORDER BY blob_id
	`)) {
		try {
			if (staged
				&& row.staging_schema_version !== V10_CONTENT_BLOB_MIGRATION_STAGING_VERSION) {
				throw new Error("invalid content-blob staging version");
			}
			decodeSessionContentBlobUtf8(storedContentBlob(row));
		} catch {
			invalid += 1;
		}
	}
	return invalid;
}

function transcriptReferences(
	database: DatabaseSyncType,
	table: "content_blob_migration_event_refs" | "transcript_event_blob_refs",
	sequenceNo: unknown,
): readonly TranscriptPayloadBlobReference[] {
	return rows(database, `
		SELECT json_pointer, blob_id FROM ${table}
		WHERE sequence_no = ? ORDER BY json_pointer
	`, sequenceNo as SQLInputValue).map((row) => {
		if (typeof row.json_pointer !== "string" || typeof row.blob_id !== "string") {
			throw new Error("invalid transcript content reference");
		}
		return Object.freeze({ jsonPointer: row.json_pointer, blobId: row.blob_id });
	});
}

function referenceRawBytes(
	database: DatabaseSyncType,
	table: "content_blob_migration_content" | "session_content_blobs",
	references: readonly TranscriptPayloadBlobReference[],
): number {
	let total = 0;
	for (const reference of references) {
		const content = loadStoredContentBlob(database, table, reference.blobId);
		if (!content) throw new Error("missing referenced content");
		total += content.rawBytes;
	}
	return total;
}

function loadStoredContentBlob(
	database: DatabaseSyncType,
	table: "content_blob_migration_content" | "session_content_blobs",
	blobId: string,
): StoredSessionContentBlob | undefined {
	const row = database.prepare(`
		SELECT blob_id, codec, raw_bytes, stored_bytes, payload_blob
		FROM ${table} WHERE blob_id = ?
	`).get(blobId) as Readonly<Record<string, unknown>> | undefined;
	return row ? storedContentBlob(row) : undefined;
}

function storedContentBlob(
	row: Readonly<Record<string, unknown>>,
): StoredSessionContentBlob {
	if (typeof row.blob_id !== "string" || typeof row.codec !== "string"
		|| typeof row.raw_bytes !== "number" || typeof row.stored_bytes !== "number"
		|| !(row.payload_blob instanceof Uint8Array)) {
		throw new Error("invalid content blob row");
	}
	return Object.freeze({
		blobId: row.blob_id,
		codec: row.codec,
		rawBytes: row.raw_bytes,
		storedBytes: row.stored_bytes,
		payload: row.payload_blob,
	});
}

function parseStoredTranscriptPayload(value: unknown): TranscriptJsonValue {
	if (typeof value !== "string") throw new Error("invalid stored transcript payload");
	const parsed: unknown = JSON.parse(value);
	if (!isRecord(parsed) || !("schemaVersion" in parsed) || !("payload" in parsed)
		|| Object.keys(parsed).some((key) => key !== "schemaVersion" && key !== "payload")) {
		throw new Error("invalid stored transcript payload");
	}
	return parsed as TranscriptJsonValue;
}

function parseTranscriptRowEvent(
	row: Readonly<Record<string, unknown>>,
	stored: TranscriptJsonValue,
): unknown {
	if (!isRecord(stored)) throw new Error("invalid stored transcript envelope");
	return parseTranscriptEventEnvelope({
		schemaVersion: stored.schemaVersion,
		sequenceNo: row.sequence_no,
		sessionId: row.session_id,
		eventId: row.event_id,
		...(typeof row.turn_id === "string" ? { turnId: row.turn_id } : {}),
		eventType: row.event_type,
		...(typeof row.provider_index === "number" ? { providerIndex: row.provider_index } : {}),
		modelVisible: row.model_visible === 1,
		createdAt: row.created_at,
		payload: stored.payload,
	});
}

interface ContentBlobTableMetrics {
	readonly blobCount: number;
	readonly rawBytes: number;
	readonly storedBytes: number;
}

function contentBlobTableMetrics(
	database: DatabaseSyncType,
	table: "content_blob_migration_content" | "session_content_blobs",
): ContentBlobTableMetrics {
	const row = database.prepare(`
		SELECT COUNT(*) AS blob_count,
		       COALESCE(SUM(CASE WHEN typeof(raw_bytes) = 'integer' AND raw_bytes >= 0
		                         THEN raw_bytes ELSE 0 END), 0) AS raw_bytes,
		       COALESCE(SUM(CASE WHEN typeof(stored_bytes) = 'integer' AND stored_bytes >= 0
		                         THEN stored_bytes ELSE 0 END), 0) AS stored_bytes
		FROM ${table}
	`).get() as Readonly<Record<string, unknown>>;
	return {
		blobCount: nonNegativeMetric(row.blob_count),
		rawBytes: nonNegativeMetric(row.raw_bytes),
		storedBytes: nonNegativeMetric(row.stored_bytes),
	};
}

interface ContentBlobDoctorMetrics {
	readonly blobCount: number;
	readonly referenceCount: number;
	readonly reachableRawBytes: number;
	readonly reachableStoredBytes: number;
	readonly logicalReferenceBytes: number;
	readonly deduplicatedReferenceBytes: number;
	readonly orphanBlobCount: number;
	readonly orphanRawBytes: number;
	readonly orphanStoredBytes: number;
}

function contentBlobMetrics(database: DatabaseSyncType): ContentBlobDoctorMetrics {
	const row = database.prepare(`
		WITH all_references(blob_id) AS (
			SELECT blob_id FROM transcript_event_blob_refs
			UNION ALL
			SELECT content_blob_id FROM model_input_blob_refs
		), reachable(blob_id) AS (
			SELECT DISTINCT blob_id FROM all_references
		)
		SELECT COUNT(*) AS blob_count,
		       (SELECT COUNT(*) FROM all_references) AS reference_count,
		       COALESCE(SUM(CASE WHEN reachable.blob_id IS NOT NULL
		                         THEN content.raw_bytes ELSE 0 END), 0) AS reachable_raw_bytes,
		       COALESCE(SUM(CASE WHEN reachable.blob_id IS NOT NULL
		                         THEN content.stored_bytes ELSE 0 END), 0) AS reachable_stored_bytes,
		       COALESCE((
		           SELECT SUM(content.raw_bytes) FROM all_references AS reference
		           JOIN session_content_blobs AS content ON content.blob_id = reference.blob_id
		       ), 0) AS logical_reference_bytes,
		       COALESCE(SUM(CASE WHEN reachable.blob_id IS NULL THEN 1 ELSE 0 END), 0)
		         AS orphan_blob_count,
		       COALESCE(SUM(CASE WHEN reachable.blob_id IS NULL
		                         THEN content.raw_bytes ELSE 0 END), 0) AS orphan_raw_bytes,
		       COALESCE(SUM(CASE WHEN reachable.blob_id IS NULL
		                         THEN content.stored_bytes ELSE 0 END), 0) AS orphan_stored_bytes
		FROM session_content_blobs AS content
		LEFT JOIN reachable ON reachable.blob_id = content.blob_id
	`).get() as Readonly<Record<string, unknown>>;
	const reachableRawBytes = nonNegativeMetric(row.reachable_raw_bytes);
	const logicalReferenceBytes = nonNegativeMetric(row.logical_reference_bytes);
	return {
		blobCount: nonNegativeMetric(row.blob_count),
		referenceCount: nonNegativeMetric(row.reference_count),
		reachableRawBytes,
		reachableStoredBytes: nonNegativeMetric(row.reachable_stored_bytes),
		logicalReferenceBytes,
		deduplicatedReferenceBytes: Math.max(0, logicalReferenceBytes - reachableRawBytes),
		orphanBlobCount: nonNegativeMetric(row.orphan_blob_count),
		orphanRawBytes: nonNegativeMetric(row.orphan_raw_bytes),
		orphanStoredBytes: nonNegativeMetric(row.orphan_stored_bytes),
	};
}

function nonNegativeMetric(value: unknown): number {
	const metric = Number(value);
	return Number.isSafeInteger(metric) && metric >= 0 ? metric : 0;
}

function invalidTranscriptEventCount(database: DatabaseSyncType): number {
	return countRows(database, `
		SELECT COUNT(*) AS count
		FROM transcript_events AS events
		LEFT JOIN sessions ON sessions.session_id = events.session_id
		WHERE sessions.session_id IS NULL
		   OR typeof(events.sequence_no) != 'integer' OR events.sequence_no < 1
		   OR typeof(events.session_id) != 'text' OR length(events.session_id) = 0
		   OR typeof(events.event_id) != 'text' OR length(events.event_id) = 0
		   OR json_valid(events.payload_json) = 0
		   OR json_extract(events.payload_json, '$.schemaVersion') != 1
		   OR json_type(events.payload_json, '$.payload') != 'object'
		   OR (events.model_visible = 1) != (events.provider_index IS NOT NULL)
	`);
}

const V10_SEARCH_EVENT_TYPES = "'user_input','assistant_output','assistant_tool_call_batch','tool_result','context'";

function invalidTranscriptFtsCount(database: DatabaseSyncType): number {
	const eligible = `(events.model_visible = 1 AND (
		(events.event_type IN (${V10_SEARCH_EVENT_TYPES}) AND COALESCE(
			json_extract(events.payload_json, '$.payload.readableProjection.searchVisible'), 1
		) != 0) OR (events.event_type = 'opaque_legacy' AND
			json_extract(events.payload_json, '$.payload.sourceKind') = 'conversation_messages')
	))`;
	const missing = countRows(database, `
		SELECT COUNT(*) AS count
		FROM transcript_events AS events
		LEFT JOIN transcript_events_fts_docsize AS documents
		  ON documents.id = events.sequence_no
		WHERE ${eligible} AND documents.id IS NULL
	`);
	const unexpected = countRows(database, `
		SELECT COUNT(*) AS count
		FROM transcript_events_fts_docsize AS documents
		LEFT JOIN transcript_events AS events ON events.sequence_no = documents.id
		WHERE events.sequence_no IS NULL OR NOT ${eligible}
	`);
	return missing + unexpected;
}

function invalidV10LineageCount(database: DatabaseSyncType): number {
	return countRows(database, `
		SELECT COUNT(*) AS count
		FROM conversation_trees AS trees
		LEFT JOIN sessions AS child ON child.session_id = trees.session_id
		LEFT JOIN sessions AS parent ON parent.session_id = trees.parent_id
		LEFT JOIN transcript_events AS boundary
		  ON boundary.session_id = trees.fork_event_session_id
		 AND boundary.event_id = trees.fork_event_id
		WHERE child.session_id IS NULL
		   OR (trees.parent_id IS NOT NULL AND parent.session_id IS NULL)
		   OR (trees.fork_point IS NOT NULL AND trees.fork_point < 0)
		   OR ((trees.fork_event_session_id IS NULL) != (trees.fork_event_id IS NULL))
		   OR (trees.parent_id IS NOT NULL AND COALESCE(trees.fork_point, 0) > 0
		       AND trees.fork_event_id IS NULL)
		   OR (trees.fork_event_id IS NOT NULL AND (
		       boundary.event_id IS NULL OR boundary.event_type != 'turn_lifecycle'
		       OR json_extract(boundary.payload_json, '$.payload.phase') != 'completed'
		   ))
	`);
}

function invalidV10RecoveryReferenceCount(database: DatabaseSyncType): number {
	let invalid = 0;
	const stateRows = rows(database, `
		SELECT session_id, state_key, payload_json FROM session_state
		WHERE state_key IN (
			'compact_checkpoint', 'suspended_turn',
			'responses_continuation_state', 'node_effect_checkpoint'
		)
	`);
	for (const row of stateRows) {
		if (typeof row.session_id !== "string" || typeof row.state_key !== "string"
			|| typeof row.payload_json !== "string") {
			invalid += 1;
			continue;
		}
		let payload: unknown;
		try {
			payload = JSON.parse(row.payload_json);
		} catch {
			invalid += 1;
			continue;
		}
		if (!isRecord(payload) || !validV10RecoveryReference(database, row.session_id, row.state_key, payload)) {
			invalid += 1;
		}
	}
	const activeWithoutStart = countRows(database, `
		SELECT COUNT(*) AS count
		FROM runtime_turns AS turns
		WHERE turns.status = 'in_progress' AND NOT EXISTS (
			SELECT 1 FROM transcript_events AS events
			WHERE events.session_id = turns.session_id AND events.turn_id = turns.turn_id
			  AND events.event_type = 'turn_lifecycle'
			  AND json_extract(events.payload_json, '$.payload.phase') = 'started'
		)
	`);
	return invalid + activeWithoutStart;
}

function validV10RecoveryReference(
	database: DatabaseSyncType,
	sessionId: string,
	stateKey: string,
	payload: Readonly<Record<string, unknown>>,
): boolean {
	if (stateKey === "compact_checkpoint") {
		if (typeof payload.transcript_event_id !== "string" || typeof payload.window_id !== "string") {
			return false;
		}
		const event = transcriptEventReference(database, sessionId, payload.transcript_event_id);
		return event?.event_type === "compaction"
			&& eventPayload(event)?.windowId === payload.window_id;
	}
	if (stateKey === "suspended_turn" && typeof payload.transcript_event_id === "string") {
		const event = transcriptEventReference(database, sessionId, payload.transcript_event_id);
		return event?.event_type === "assistant_tool_call_batch"
			&& event.turn_id === payload.turn_id;
	}
	if (stateKey === "responses_continuation_state" && payload.eligible === true) {
		if (typeof payload.response_id !== "string") return false;
		return countRows(database, `
			SELECT COUNT(*) AS count FROM transcript_events
			WHERE session_id = ? AND event_type IN ('assistant_output', 'assistant_tool_call_batch')
			  AND json_extract(payload_json, '$.payload.responseId') = ?
		`, sessionId, payload.response_id) > 0;
	}
	if (stateKey === "node_effect_checkpoint") {
		if (typeof payload.turn_id !== "string"
			|| typeof payload.call_id !== "string"
			|| typeof payload.tool_name !== "string") return false;
		return countRows(database, `
			SELECT COUNT(*) AS count
			FROM transcript_events AS events, json_each(events.payload_json, '$.payload.calls') AS calls
			WHERE events.session_id = ? AND events.turn_id = ?
			  AND events.event_type = 'assistant_tool_call_batch'
			  AND json_extract(calls.value, '$.callId') = ?
			  AND json_extract(calls.value, '$.name') = ?
		`, sessionId, payload.turn_id, payload.call_id, payload.tool_name) > 0;
	}
	return true;
}

function transcriptEventReference(
	database: DatabaseSyncType,
	sessionId: string,
	eventId: string,
): Readonly<Record<string, unknown>> | undefined {
	return database.prepare(`
		SELECT turn_id, event_type, payload_json FROM transcript_events
		WHERE session_id = ? AND event_id = ?
	`).get(sessionId, eventId) as Readonly<Record<string, unknown>> | undefined;
}

function eventPayload(
	row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
	if (typeof row.payload_json !== "string") return undefined;
	try {
		const envelope: unknown = JSON.parse(row.payload_json);
		return isRecord(envelope) && isRecord(envelope.payload) ? envelope.payload : undefined;
	} catch {
		return undefined;
	}
}

interface ManifestInspection {
	readonly issueCount: number;
	readonly summary: string;
}

function inspectNormalizationManifest(
	database: DatabaseSyncType,
	present: ReadonlyMap<string, string>,
): ManifestInspection {
	if (present.get("transcript_normalization_manifest") !== "table") {
		return { issueCount: 0, summary: "manifest=none" };
	}
	const manifestRows = rows(database, "SELECT * FROM transcript_normalization_manifest");
	if (manifestRows.length !== 1) return { issueCount: 1, summary: "manifest=invalid" };
	const manifest = manifestRows[0]!;
	const hashes = [
		manifest.provider_sha256,
		manifest.readable_sha256,
		manifest.search_sha256,
		manifest.lineage_sha256,
		manifest.recovery_sha256,
		manifest.provider_ledger_sha256,
	];
	const eventCount = countRows(database, "SELECT COUNT(*) AS count FROM transcript_events");
	const valid = manifest.manifest_id === 1 && manifest.manifest_version === 1
		&& manifest.source_schema_version === SCHEMA_VERSION
		&& manifest.target_schema_version === SCHEMA_V10_VERSION
		&& Number.isSafeInteger(manifest.source_row_count) && Number(manifest.source_row_count) >= 0
		&& manifest.event_count === eventCount
		&& Number(manifest.source_row_count) >= eventCount
		&& hashes.every((hash) => typeof hash === "string" && HASH_PATTERN.test(hash))
		&& typeof manifest.completed_at === "string" && manifest.completed_at.length > 0;
	return valid
		? { issueCount: 0, summary: "manifest=valid" }
		: { issueCount: 1, summary: "manifest=invalid" };
}

function countRows(database: DatabaseSyncType, sql: string, ...parameters: readonly SQLInputValue[]): number {
	const row = database.prepare(sql).get(...parameters) as Readonly<Record<string, unknown>> | undefined;
	return typeof row?.count === "number" ? row.count : Number(row?.count ?? 0);
}

function sumIssueCounts(issues: ReadonlyMap<string, number>): number {
	return [...issues.values()].reduce((total, count) => total + count, 0);
}

function issueDetail(issues: ReadonlyMap<string, number>): string {
	return [...issues].slice(0, 12).map(([code, count]) => `${code}=${count}`).join(",");
}

function rows(
	database: DatabaseSyncType,
	sql: string,
	...parameters: readonly SQLInputValue[]
): readonly Readonly<Record<string, unknown>>[] {
	return database.prepare(sql).all(...parameters) as readonly Readonly<Record<string, unknown>>[];
}

function iterateRows(
	database: DatabaseSyncType,
	sql: string,
	...parameters: readonly SQLInputValue[]
): Iterable<Readonly<Record<string, unknown>>> {
	return database.prepare(sql).iterate(...parameters) as Iterable<
		Readonly<Record<string, unknown>>
	>;
}

function blobRecord(
	blobs: ReadonlyMap<string, unknown>,
	blobId: unknown,
): Readonly<Record<string, unknown>> | undefined {
	if (typeof blobId !== "string") return undefined;
	const value = blobs.get(blobId);
	return isRecord(value) ? value : undefined;
}

function manifestMatchesRow(
	manifest: Readonly<Record<string, unknown>>,
	row: Readonly<Record<string, unknown>>,
	exactBoundary = false,
): boolean {
	return (manifest.schemaVersion === 1 || manifest.schemaVersion === 2
			|| manifest.schemaVersion === 3)
			&& manifest.requestId === row.request_id
		&& manifest.sessionId === row.session_id
		&& manifest.turnId === row.turn_id
		&& manifest.providerStep === row.provider_step
		&& manifest.requestSignature === row.request_signature
		&& manifest.logicalInputSha256 === row.logical_input_sha256
		&& (manifest.previousManifestId ?? null) === (row.previous_request_id ?? null)
			&& (exactBoundary ? manifest.boundary ?? null : manifestBoundaryColumn(manifest.boundary))
				=== (row.boundary ?? null)
				&& manifest.createdAt === row.created_at;
}

function timelineEventMatchesRow(
	event: Readonly<Record<string, unknown>>,
	row: Readonly<Record<string, unknown>>,
): boolean {
	const expectedContentSha256 = event.item === undefined
		? sha256(stableJson({ window_id: event.windowId, boundary: event.boundary }))
		: sha256(stableJson(event.item));
	return event.eventId === row.event_id
		&& event.sessionId === row.session_id
		&& event.windowId === row.window_id
		&& event.turnId === row.turn_id
		&& event.providerStep === row.provider_step
		&& event.kind === row.kind
		&& (event.modelContextEventId ?? null) === (row.model_context_event_id ?? null)
		&& event.createdAt === row.created_at
		&& event.contentSha256 === expectedContentSha256
		&& (event.kind === "window_boundary"
			? event.item === undefined && typeof event.boundary === "string"
				: isRecord(event.item));
}

function validCompactTimelineManifest(input: {
	readonly manifest: Readonly<Record<string, unknown>>;
	readonly instruction: Readonly<Record<string, unknown>>;
	readonly toolSet: Readonly<Record<string, unknown>>;
	readonly timelineByWindow: ReadonlyMap<string, readonly Readonly<Record<string, unknown>>[]>;
	readonly committedRequestSha256: unknown;
}): boolean {
	const { manifest, instruction, toolSet } = input;
	if (manifest.schemaVersion !== 3 || manifest.orderedItems !== undefined
		|| manifest.timelineEventIds !== undefined || typeof manifest.sessionId !== "string"
		|| typeof manifest.timelineWindowId !== "string"
		|| !Number.isSafeInteger(manifest.timelineEventCount)
		|| Number(manifest.timelineEventCount) <= 0
		|| !isRecord(manifest.providerConfig) || typeof instruction.content !== "string"
		|| !Array.isArray(toolSet.tools) || !toolSet.tools.every(isRecord)
		|| typeof input.committedRequestSha256 !== "string"
		|| !HASH_PATTERN.test(input.committedRequestSha256)) {
		return false;
	}
	const window = input.timelineByWindow.get(timelineWindowKey(
		manifest.sessionId,
		manifest.timelineWindowId,
	)) ?? [];
	const prefix = window.slice(0, Number(manifest.timelineEventCount));
	if (prefix.length !== manifest.timelineEventCount || prefix[0]?.kind !== "window_boundary") {
		return false;
	}
	const prefixCommitment = prefix.map((event) => ({
		event_id: event.eventId,
		window_id: event.windowId,
		kind: event.kind,
		content_sha256: event.contentSha256,
	}));
	if (sha256(stableJson(prefixCommitment)) !== manifest.timelinePrefixSha256) return false;
	const timelineItems = prefix.flatMap((event) => event.item === undefined ? [] : [event.item]);
	if (!timelineItems.every(isRecord)
		|| sha256(stableJson(timelineItems)) !== manifest.timelineSha256
		|| sha256(stableJson({
			instruction_snapshot: instruction.contentSha256,
			tool_set_snapshot: toolSet.contentSha256,
			timeline: manifest.timelineSha256,
		})) !== manifest.logicalInputSha256) {
		return false;
	}
	const configurationSha256 = sha256(stableJson({
		provider_config: manifest.providerConfig,
		instruction_snapshot_sha256: instruction.contentSha256,
		tool_set_snapshot_sha256: toolSet.contentSha256,
	}));
	const bootstrapItems: unknown[] = [];
	for (const event of prefix) {
		if (event.kind === "window_boundary") continue;
		const item = event.item;
		if (event.kind !== "context_update" || !isRecord(item) || item.type !== "context"
			|| !isRecord(item.metadata) || item.metadata.cacheClass !== "static") {
			break;
		}
		bootstrapItems.push(item);
	}
	const bootstrapSha256 = sha256(stableJson({
		instruction_snapshot_sha256: instruction.contentSha256,
		tool_set_snapshot_sha256: toolSet.contentSha256,
		items: bootstrapItems,
	}));
	if (manifest.requestConfigurationSha256 !== configurationSha256
		|| manifest.bootstrapPrefixSha256 !== bootstrapSha256
		|| manifest.contextPrefixSha256 !== bootstrapSha256
		|| !Number.isSafeInteger(manifest.commonPrefixItemCount)
		|| Number(manifest.commonPrefixItemCount) < 0
		|| Number(manifest.commonPrefixItemCount) > timelineItems.length) {
		return false;
	}
	const request = projectProviderRequest({
		config: manifest.providerConfig as unknown as ProviderRequestConfig,
		instructions: instruction.content,
		history: timelineItems as unknown as readonly CanonicalConversationItem[],
		tools: toolSet.tools as unknown as readonly ToolDefinition[],
	});
	return sha256(stableJson(request)) === input.committedRequestSha256;
}

function validTimelineManifest(input: {
	readonly manifest: Readonly<Record<string, unknown>>;
	readonly request: Readonly<Record<string, unknown>>;
	readonly instruction?: Readonly<Record<string, unknown>>;
	readonly toolSet?: Readonly<Record<string, unknown>>;
	readonly timelineById: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
	readonly timelineByWindow: ReadonlyMap<string, readonly Readonly<Record<string, unknown>>[]>;
}): boolean {
	const { manifest, request, instruction, toolSet } = input;
	if (typeof manifest.sessionId !== "string" || typeof manifest.timelineWindowId !== "string"
		|| !Array.isArray(manifest.timelineEventIds) || !manifest.timelineEventIds.every(isString)
		|| !Array.isArray(manifest.orderedItems) || !Array.isArray(request.items)
		|| !instruction || !toolSet) {
		return false;
	}
	const window = input.timelineByWindow.get(timelineWindowKey(
		manifest.sessionId,
		manifest.timelineWindowId,
	)) ?? [];
	const prefix = window.slice(0, manifest.timelineEventIds.length);
	if (prefix.length !== manifest.timelineEventIds.length
		|| stableJson(prefix.map((event) => event.eventId)) !== stableJson(manifest.timelineEventIds)
		|| manifest.timelineEventIds.some((eventId) => !input.timelineById.has(eventId))) {
		return false;
	}
	const timelineItems = prefix.flatMap((event) => event.item === undefined ? [] : [event.item]);
	const referencedIds = manifest.orderedItems.flatMap((value) => (
		isRecord(value) && value.kind === "provider_timeline_event" && typeof value.id === "string"
			? [value.id]
			: []
	));
	const visibleIds = prefix.flatMap((event) => event.item === undefined ? [] : [String(event.eventId)]);
	if (stableJson(referencedIds) !== stableJson(visibleIds)
		|| stableJson(request.items) !== stableJson(timelineItems)
		|| manifest.timelineSha256 !== sha256(stableJson(timelineItems))) {
		return false;
	}
	const configurationSha256 = sha256(stableJson({
		provider_config: manifest.providerConfig,
		instruction_snapshot_sha256: instruction.contentSha256,
		tool_set_snapshot_sha256: toolSet.contentSha256,
	}));
	const bootstrapItems: unknown[] = [];
	for (const event of prefix) {
		if (event.kind === "window_boundary") continue;
		const item = event.item;
		if (event.kind !== "context_update" || !isRecord(item) || item.type !== "context"
			|| !isRecord(item.metadata) || item.metadata.cacheClass !== "static") {
			break;
		}
		bootstrapItems.push(item);
	}
	const bootstrapSha256 = sha256(stableJson({
		instruction_snapshot_sha256: instruction.contentSha256,
		tool_set_snapshot_sha256: toolSet.contentSha256,
		items: bootstrapItems,
	}));
	return manifest.requestConfigurationSha256 === configurationSha256
		&& manifest.bootstrapPrefixSha256 === bootstrapSha256
		&& Number.isSafeInteger(manifest.commonPrefixItemCount)
		&& Number(manifest.commonPrefixItemCount) >= 0
		&& Number(manifest.commonPrefixItemCount) <= timelineItems.length;
}

function manifestBoundaryColumn(value: unknown): unknown {
	return value === "legacy_bootstrap" || value === "source_reset" ? "continuation_reset" : value ?? null;
}

function timelineWindowKey(sessionId: string, windowId: string): string {
	return `${sessionId}\u0000${windowId}`;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function validLifecycleTransition(current: string, next: string): boolean {
	if (current === "prepared") {
		return next === "dispatch_started" || next === "failed" || next === "unknown";
	}
	if (current === "dispatch_started") {
		return next === "acknowledged" || next === "failed" || next === "unknown";
	}
	return current === "unknown" && (next === "acknowledged" || next === "failed");
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
	const serialized = JSON.stringify(sortJson(value));
	if (serialized === undefined) throw new TypeError("value is not JSON serializable");
	return serialized;
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.entries(value)
		.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
		.map(([key, item]) => [key, sortJson(item)]));
}

async function checkDirectory(
	name: string,
	path: string,
	missingStatus: DoctorCheck["status"],
): Promise<DoctorCheck> {
	const metadata = await optionalStat(path);
	if (!metadata) return check(name, missingStatus, `${name} directory not created yet`);
	if (!metadata.isDirectory()) return check(name, "failed", `${name} path is not a directory`);
	return check(name, "ok", `${name} directory readable`);
}

async function checkTraces(path: string): Promise<DoctorCheck> {
	const metadata = await optionalStat(path);
	if (!metadata) return check("traces", "ok", "trace directory not created yet");
	if (!metadata.isDirectory()) return check("traces", "failed", "trace path is not a directory");
	let entries;
	try {
		entries = (await readdir(path, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.sort((left, right) => left.name.localeCompare(right.name))
			.slice(0, MAX_TRACE_FILES);
	} catch {
		return check("traces", "failed", "trace directory is not readable");
	}
	let rows = 0;
	let invalid = 0;
	let unreadable = 0;
	for (const entry of entries) {
		const filePath = join(path, entry.name);
		try {
			const fileStats = await stat(filePath);
			if (fileStats.size > MAX_TRACE_FILE_BYTES) {
				invalid += 1;
				continue;
			}
			for (const line of (await readFile(filePath, "utf8")).split(/\r?\n/u)) {
				if (!line) continue;
				rows += 1;
				try {
					const parsed: unknown = JSON.parse(line);
					if (!isRecord(parsed)) invalid += 1;
				} catch {
					invalid += 1;
				}
			}
		} catch {
			unreadable += 1;
		}
	}
	if (unreadable > 0) return check("traces", "failed", `unreadable_files=${unreadable}`);
	return check(
		"traces",
		invalid > 0 ? "warning" : "ok",
		`files=${entries.length} rows=${rows} invalid_rows=${invalid}`,
	);
}

async function checkRedaction(
	homeRoot: string,
	logsRoot: string,
	tracesRoot: string,
): Promise<DoctorCheck> {
	const paths = await diagnosticFiles(logsRoot, tracesRoot);
	if (paths.length === 0) return check("logs_redaction", "ok", "no diagnostic files found");
	const scan = await scanDoctorFiles({ root: homeRoot, paths });
	if (scan.unreadableCount > 0) {
		return check("logs_redaction", "failed", `unreadable_files=${scan.unreadableCount}`);
	}
	return check(
		"logs_redaction",
		scan.findingCount > 0 ? "failed" : "ok",
		`files=${scan.scannedFileCount} findings=${scan.findingCount}`,
	);
}

async function diagnosticFiles(logsRoot: string, tracesRoot: string): Promise<readonly string[]> {
	const paths: string[] = [];
	for (const name of ["agent.log", "errors.log", "model-events.jsonl"] as const) {
		if (await optionalStat(join(logsRoot, name))) paths.push(join(logsRoot, name));
	}
	for (const [root, suffix] of [[tracesRoot, ".jsonl"], [join(logsRoot, "model-raw"), ".json"]] as const) {
		try {
			const entries = await readdir(root, { recursive: true, withFileTypes: true });
			for (const entry of entries) {
				if (paths.length >= MAX_TRACE_FILES) break;
				if (entry.isFile() && entry.name.endsWith(suffix)) paths.push(join(entry.parentPath, entry.name));
			}
		} catch {
			// Missing diagnostic directories are healthy and created lazily.
		}
	}
	return Object.freeze(paths);
}

async function optionalStat(path: string) {
	try {
		return await stat(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

function check(
	name: string,
	status: DoctorCheck["status"],
	message: string,
	detail?: string,
): DoctorCheck {
	return Object.freeze({ name, status, message, ...(detail ? { detail } : {}) });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
