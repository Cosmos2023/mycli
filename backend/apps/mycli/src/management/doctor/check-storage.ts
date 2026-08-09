import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { SCHEMA_VERSION } from "@mycli/storage";
import { scanDoctorFiles } from "./redaction.ts";
import type { DoctorCheck } from "./types.ts";

export interface StorageDoctorOptions {
	readonly workspaceRoot: string;
	readonly homeDir: string;
}

const REQUIRED_SCHEMA_OBJECTS = Object.freeze(new Map<string, string>([
	["schema_version", "table"],
	["sessions", "table"],
	["conversation_messages", "table"],
	["conversation_messages_fts", "table"],
	["conversation_messages_fts_insert", "trigger"],
	["conversation_messages_fts_delete", "trigger"],
	["conversation_messages_fts_update", "trigger"],
	["conversation_trees", "table"],
	["history_items", "table"],
	["history_items_fts", "table"],
	["history_items_fts_insert", "trigger"],
	["history_items_fts_delete", "trigger"],
	["history_items_fts_update", "trigger"],
	["turn_rollouts", "table"],
	["session_state", "table"],
	["session_summaries", "table"],
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
]));
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
	const blobRows = rows(database, `
		SELECT blob_id, payload_json FROM model_input_blobs ORDER BY rowid
	`);
	const blobs = new Map<string, unknown>();
	for (const row of blobRows) {
		if (typeof row.blob_id !== "string" || typeof row.payload_json !== "string") {
			addIssue("invalid_blob_row");
			continue;
		}
		try {
			const payload: unknown = JSON.parse(row.payload_json);
			const canonical = stableJson(payload);
			const digestInput = typeof payload === "string" ? payload : canonical;
			if (canonical !== row.payload_json || sha256(digestInput) !== row.blob_id) {
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

	const manifestRows = rows(database, `
		SELECT rowid, request_id, session_id, turn_id, provider_step, manifest_blob_id,
		       logical_request_blob_id, request_signature, logical_input_sha256,
		       logical_request_sha256, previous_request_id, boundary, created_at
		FROM provider_request_manifests ORDER BY rowid
	`);
	const latestBySession = new Map<string, string>();
	for (const row of manifestRows) {
		const manifest = blobRecord(blobs, row.manifest_blob_id);
		const request = blobRecord(blobs, row.logical_request_blob_id);
		if (!manifest || !request) {
			addIssue("missing_manifest_blob");
			continue;
		}
		if (!manifestMatchesRow(manifest, row)
			|| row.logical_request_sha256 !== row.logical_request_blob_id) {
			addIssue("invalid_manifest_row");
			continue;
		}
		const instruction = instructions.get(String(manifest.instructionSnapshotId));
		const toolSet = toolSets.get(String(manifest.toolSetSnapshotId));
		if (!instruction || !toolSet || instruction.sessionId !== row.session_id
			|| toolSet.sessionId !== row.session_id
			|| request.instructions !== instruction.payload.content
			|| stableJson(request.tools) !== stableJson(toolSet.payload.tools)) {
			addIssue("invalid_manifest_snapshot_reference");
			} else if (!Array.isArray(manifest.orderedItems)
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
				instruction: instruction?.payload,
				toolSet: toolSet?.payload,
				timelineById,
				timelineByWindow,
			})) {
				addIssue("invalid_manifest_timeline_reference");
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
		const integrity = database.prepare("PRAGMA quick_check").get();
		if (!integrity || !Object.values(integrity).includes("ok")) {
			return check("sessions_db", "failed", "SQLite integrity check failed");
		}
		const objects = database.prepare(
			"SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
		).all() as readonly Readonly<Record<string, unknown>>[];
		const present = new Map(objects.flatMap((row) => (
			typeof row.name === "string" && typeof row.type === "string"
				? [[row.name, row.type] as const]
				: []
		)));
		const missing = [...REQUIRED_SCHEMA_OBJECTS].flatMap(([name, type]) => (
			present.get(name) === type ? [] : [name]
		));
		if (missing.length > 0) {
			return check(
				"sessions_db",
				"failed",
				`missing_schema_objects=${missing.length}`,
				missing.slice(0, 12).join(","),
			);
		}
		const versions = database.prepare("SELECT version FROM schema_version").all();
		if (versions.length !== 1 || versions[0]?.version !== SCHEMA_VERSION) {
			return check("sessions_db", "failed", `schema_version expected=${SCHEMA_VERSION}`);
		}
		const invalidStates = invalidCriticalStates(database);
		if (invalidStates > 0) {
			return check("sessions_db", "failed", `invalid_recovery_states=${invalidStates}`);
		}
		const invalidLineage = invalidLineageCount(database);
		if (invalidLineage > 0) {
			return check("sessions_db", "failed", `invalid_session_lineage=${invalidLineage}`);
		}
		return check("sessions_db", "ok", `schema_version=${SCHEMA_VERSION} integrity=ok`);
	} catch {
		return check("sessions_db", "failed", "sessions database is not readable");
	} finally {
		database?.close();
	}
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
		if (payload[nested] !== undefined && !isRecord(payload[nested])) return false;
	}
	return payload.user_message === undefined || typeof payload.user_message === "string";
}

function invalidLineageCount(database: DatabaseSyncType): number {
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

function rows(
	database: DatabaseSyncType,
	sql: string,
): readonly Readonly<Record<string, unknown>>[] {
	return database.prepare(sql).all() as readonly Readonly<Record<string, unknown>>[];
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
): boolean {
	return (manifest.schemaVersion === 1 || manifest.schemaVersion === 2)
			&& manifest.requestId === row.request_id
		&& manifest.sessionId === row.session_id
		&& manifest.turnId === row.turn_id
		&& manifest.providerStep === row.provider_step
		&& manifest.requestSignature === row.request_signature
		&& manifest.logicalInputSha256 === row.logical_input_sha256
		&& (manifest.previousManifestId ?? null) === (row.previous_request_id ?? null)
			&& manifestBoundaryColumn(manifest.boundary) === (row.boundary ?? null)
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
