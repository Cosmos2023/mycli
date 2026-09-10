import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { CanonicalConversationItem } from "@mycli/core";
import {
	canonicalConversationItem,
	canonicalHistoryItem,
	conversationSearchRole,
	repairTerminalToolProtocol,
} from "../../projections/legacy-provider-projection.ts";
import { StorageFailure } from "../../sessions/session-store.ts";
import { stableJson } from "../../stable-json.ts";
import { projectTranscript } from "../../projections/transcript-projector.ts";

export const V9_PROJECTION_MANIFEST_VERSION = 1 as const;

export type V9ProjectionErrorCode = "persistence_error" | "session_state_invalid";

export type V9ProjectionDigest =
	| Readonly<{
		readonly status: "ok";
		readonly recordCount: number;
		readonly sha256: string;
	}>
	| Readonly<{
		readonly status: "error";
		readonly errorCode: V9ProjectionErrorCode;
	}>;

export interface V9SessionProjectionManifest {
	readonly sessionKey: string;
	readonly providerWindow: V9ProjectionDigest;
	readonly readableTranscript: V9ProjectionDigest;
	readonly searchDocuments: V9ProjectionDigest;
	readonly lineage: V9ProjectionDigest;
	readonly recoveryState: V9ProjectionDigest;
}

export interface V9ProviderLedgerTableManifest {
	readonly table: string;
	readonly rowCount: number;
	readonly sha256: string;
}

export interface V9ProviderLedgerManifest {
	readonly rowCount: number;
	readonly sha256: string;
	readonly tables: readonly V9ProviderLedgerTableManifest[];
}

export interface V9ProjectionManifest {
	readonly manifestVersion: typeof V9_PROJECTION_MANIFEST_VERSION;
	readonly sourceSchemaVersion: 9;
	readonly sessionCount: number;
	readonly sessions: readonly V9SessionProjectionManifest[];
	readonly providerLedger: V9ProviderLedgerManifest;
	readonly manifestSha256: string;
}

export interface CreateV9ProjectionManifestOptions {
	readonly dbPath: string;
}

interface SessionRow {
	readonly session_id: unknown;
	readonly workspace_root: unknown;
}

interface PayloadRow {
	readonly payload_json: unknown;
}

const PROVIDER_LEDGER_TABLES: readonly Readonly<{
	table: string;
	orderBy: string;
}>[] = Object.freeze([
	{ table: "model_input_blobs", orderBy: "blob_id" },
	{ table: "instruction_snapshots", orderBy: "snapshot_id" },
	{ table: "tool_set_snapshots", orderBy: "snapshot_id" },
	{ table: "model_context_events", orderBy: "event_id" },
	{ table: "provider_request_manifests", orderBy: "request_id" },
	{ table: "provider_step_events", orderBy: "sequence_no" },
	{ table: "provider_input_timeline_events", orderBy: "sequence_no" },
]);

export function createV9ProjectionManifest(
	options: CreateV9ProjectionManifestOptions,
): V9ProjectionManifest {
	let database: Database.Database;
	try {
		database = new Database(options.dbPath, { readonly: true, fileMustExist: true });
		database.pragma("query_only = ON");
	} catch {
		throw new StorageFailure("unable to open session storage for projection manifest");
	}
	try {
		assertV9(database);
		const sessionRows = database.prepare(`
			SELECT session_id, workspace_root FROM sessions ORDER BY session_id
		`).all() as readonly SessionRow[];
		const sessionIds = new Set(sessionRows.flatMap((row) => (
			typeof row.session_id === "string" ? [row.session_id] : []
		)));
		const sessions = Object.freeze(sessionRows.map((row) => {
			if (typeof row.session_id !== "string" || !row.session_id
				|| typeof row.workspace_root !== "string") {
				throw new StorageFailure("invalid session row in projection manifest");
			}
			const sessionId = row.session_id;
			return Object.freeze({
				sessionKey: sessionKey(sessionId),
				providerWindow: projectionDigest(() => projectV9ProviderWindow(database, sessionId)),
				readableTranscript: projectionDigest(() => projectV9ReadableTranscript(database, sessionId)),
				searchDocuments: projectionDigest(() => projectV9SearchDocuments(
					database,
					sessionId,
					row.workspace_root as string,
				)),
				lineage: projectionDigest(() => projectV9Lineage(database, sessionIds, sessionId)),
				recoveryState: projectionDigest(() => projectV9RecoveryState(database, sessionId)),
			});
		}).sort((left, right) => left.sessionKey.localeCompare(right.sessionKey)));
		const providerLedger = createV9ProviderLedgerManifest(database);
		const unsigned = Object.freeze({
			manifestVersion: V9_PROJECTION_MANIFEST_VERSION,
			sourceSchemaVersion: 9 as const,
			sessionCount: sessions.length,
			sessions,
			providerLedger,
		});
		return Object.freeze({
			...unsigned,
			manifestSha256: digest(unsigned),
		});
	} catch (error) {
		if (error instanceof StorageFailure) throw error;
		throw new StorageFailure("v9 projection manifest failed");
	} finally {
		database.close();
	}
}

export function projectV9ProviderWindow(
	database: Database.Database,
	sessionId: string,
): readonly CanonicalConversationItem[] {
	const compaction = latestCompaction(database, sessionId);
	const rows = database.prepare(`
		SELECT payload_json
		FROM conversation_messages
		WHERE session_id = ? AND message_index >= ?
		ORDER BY message_index
	`).all(sessionId, compaction?.sourceMessageCount ?? 0) as readonly PayloadRow[];
	if (rows.length > 0 || compaction) {
		return repairTerminalToolProtocol([
			...(compaction?.replacement ?? []),
			...rows.map((row) => canonicalConversationItem(
				row.payload_json,
				"conversation_messages",
			)),
		], activeToolCallIds(database, sessionId));
	}
	const historyRows = database.prepare(`
		SELECT payload_json
		FROM history_items
		WHERE session_id = ?
		  AND json_extract(payload_json, '$.type') IN (
		    'user_message', 'assistant_message', 'tool_call', 'tool_result'
		  )
		ORDER BY sequence_no
	`).all(sessionId) as readonly PayloadRow[];
	return repairTerminalToolProtocol(
		historyRows.map((row) => canonicalHistoryItem(row.payload_json)),
		activeToolCallIds(database, sessionId),
	);
}

function latestCompaction(
	database: Database.Database,
	sessionId: string,
): Readonly<{
	readonly sourceMessageCount: number;
	readonly replacement: readonly CanonicalConversationItem[];
}> | undefined {
	const row = database.prepare(`
		SELECT payload_json
		FROM history_items
		WHERE session_id = ?
		  AND json_extract(payload_json, '$.type') = 'compaction_boundary'
		ORDER BY sequence_no DESC
		LIMIT 1
	`).get(sessionId) as PayloadRow | undefined;
	if (!row) return undefined;
	const payload = parseObjectJson(row.payload_json, "compaction_boundary");
	if (!Number.isSafeInteger(payload.source_message_count)
		|| Number(payload.source_message_count) < 0
		|| !Array.isArray(payload.replacement_messages)
		|| payload.replacement_messages.length > 4_096) {
		throw new StorageFailure("invalid compaction boundary");
	}
	const sourceMessageCount = Number(payload.source_message_count);
	const count = database.prepare(`
		SELECT COUNT(*) AS count FROM conversation_messages WHERE session_id = ?
	`).get(sessionId) as { readonly count: unknown };
	if (sourceMessageCount > Number(count.count)) {
		throw new StorageFailure("invalid compaction boundary");
	}
	return Object.freeze({
		sourceMessageCount,
		replacement: Object.freeze(payload.replacement_messages.map((message) => (
			canonicalConversationItem(stableJson(message), "compaction_boundary")
		))),
	});
}

function activeToolCallIds(database: Database.Database, sessionId: string): ReadonlySet<string> {
	const rows = database.prepare(`
		SELECT c.payload_json
		FROM conversation_messages c
		JOIN runtime_turns t
		  ON t.session_id = c.session_id
		 AND t.turn_id = json_extract(c.payload_json, '$.metadata.turn_id')
		WHERE c.session_id = ? AND t.status = 'in_progress'
		ORDER BY c.message_index
	`).all(sessionId) as readonly PayloadRow[];
	const ids = new Set<string>();
	for (const row of rows) {
		const item = canonicalConversationItem(row.payload_json, "conversation_messages");
		if (item.type !== "assistant_tool_calls") continue;
		for (const call of item.calls) ids.add(call.callId);
	}
	return ids;
}

export function projectV9ReadableTranscript(
	database: Database.Database,
	sessionId: string,
): readonly unknown[] {
	const history = (database.prepare(`
		SELECT payload_json FROM history_items WHERE session_id = ? ORDER BY sequence_no
	`).all(sessionId) as readonly PayloadRow[]).map((row) => (
		parseObjectJson(row.payload_json, "history_items")
	));
	const rollouts = (database.prepare(`
		SELECT payload_json FROM turn_rollouts WHERE session_id = ? ORDER BY sequence_no
	`).all(sessionId) as readonly PayloadRow[]).map((row) => (
		parseObjectJson(row.payload_json, "turn_rollouts")
	));
	return projectTranscript(history, rollouts, { limit: Number.MAX_SAFE_INTEGER });
}

export function projectV9SearchDocuments(
	database: Database.Database,
	sessionId: string,
	workspaceRoot: string,
): readonly unknown[] {
	const rows = database.prepare(`
		SELECT message_index, payload_json
		FROM conversation_messages
		WHERE session_id = ?
		ORDER BY message_index
	`).all(sessionId) as readonly {
		readonly message_index: unknown;
		readonly payload_json: unknown;
	}[];
	return Object.freeze(rows.map((row) => {
		const payload = parseObjectJson(row.payload_json, "conversation_messages");
		const item = canonicalConversationItem(row.payload_json, "conversation_messages");
		return Object.freeze({
			workspaceRoot,
			messageIndex: Number(row.message_index),
			role: conversationSearchRole(item),
			payload,
		});
	}));
}

export function projectV9Lineage(
	database: Database.Database,
	sessionIds: ReadonlySet<string>,
	sessionId: string,
): readonly unknown[] {
	let current = sessionId;
	const nodes: Array<Readonly<Record<string, unknown>>> = [];
	const seen = new Set<string>();
	for (let depth = 0; depth < 100; depth += 1) {
		if (seen.has(current)) throw sessionStateInvalid();
		seen.add(current);
		const row = database.prepare(`
			SELECT session_id, parent_id, fork_point
			FROM conversation_trees WHERE session_id = ?
		`).get(current) as {
			readonly session_id: unknown;
			readonly parent_id: unknown;
			readonly fork_point: unknown;
		} | undefined;
		const parentId = typeof row?.parent_id === "string" && row.parent_id
			? row.parent_id
			: undefined;
		const forkPoint = typeof row?.fork_point === "number"
			&& Number.isSafeInteger(row.fork_point)
			&& row.fork_point >= 0
			? row.fork_point
			: undefined;
		nodes.push(Object.freeze({
			sessionId: current,
			...(parentId ? { parentId } : {}),
			...(forkPoint === undefined ? {} : { forkPoint }),
		}));
		if (!parentId) return Object.freeze(nodes.reverse());
		if (!sessionIds.has(parentId)) throw sessionStateInvalid();
		current = parentId;
	}
	throw sessionStateInvalid();
}

export function projectV9RecoveryState(
	database: Database.Database,
	sessionId: string,
): readonly unknown[] {
	const runtimeTurns = rowsForDigest(database, `
		SELECT * FROM runtime_turns WHERE session_id = ? ORDER BY client_turn_id
	`, [sessionId]);
	const sessionState = rowsForDigest(database, `
		SELECT * FROM session_state WHERE session_id = ? ORDER BY state_key
	`, [sessionId]);
	const effectAttempts = rowsForDigest(database, `
		SELECT * FROM agent_effect_attempts WHERE session_id = ? ORDER BY attempt_id
	`, [sessionId]);
	const effectOutcomes = rowsForDigest(database, `
		SELECT outcomes.*
		FROM agent_effect_attempt_outcomes outcomes
		JOIN agent_effect_attempts attempts ON attempts.attempt_id = outcomes.attempt_id
		WHERE attempts.session_id = ?
		ORDER BY outcomes.attempt_id
	`, [sessionId]);
	return Object.freeze([
		...taggedRows("runtime_turns", runtimeTurns),
		...taggedRows("session_state", sessionState),
		...taggedRows("agent_effect_attempts", effectAttempts),
		...taggedRows("agent_effect_attempt_outcomes", effectOutcomes),
	]);
}

export function createV9ProviderLedgerManifest(
	database: Database.Database,
): V9ProviderLedgerManifest {
	const tables = Object.freeze(PROVIDER_LEDGER_TABLES.map((definition) => {
		const result = digestQuery(database, `
			SELECT * FROM ${definition.table} ORDER BY ${definition.orderBy}
		`);
		return Object.freeze({
			table: definition.table,
			rowCount: result.rowCount,
			sha256: result.sha256,
		});
	}));
	return Object.freeze({
		rowCount: tables.reduce((count, table) => count + table.rowCount, 0),
		sha256: digest(tables),
		tables,
	});
}

function projectionDigest(operation: () => readonly unknown[]): V9ProjectionDigest {
	try {
		const records = operation();
		return Object.freeze({
			status: "ok" as const,
			recordCount: records.length,
			sha256: digest(records),
		});
	} catch (error) {
		return Object.freeze({
			status: "error" as const,
			errorCode: projectionErrorCode(error),
		});
	}
}

function projectionErrorCode(error: unknown): V9ProjectionErrorCode {
	return error instanceof StorageFailure && error.diagnostics.state_key === "session_lineage"
		? "session_state_invalid"
		: "persistence_error";
}

function sessionStateInvalid(): StorageFailure {
	return new StorageFailure("persisted session lineage state is not usable", {
		state_key: "session_lineage",
	});
}

function digestQuery(
	database: Database.Database,
	sql: string,
): Readonly<{ rowCount: number; sha256: string }> {
	const hash = createHash("sha256");
	let rowCount = 0;
	for (const row of database.prepare(sql).iterate() as IterableIterator<Record<string, unknown>>) {
		const json = stableJson(row);
		hash.update(`${Buffer.byteLength(json)}:`);
		hash.update(json);
		rowCount += 1;
	}
	return Object.freeze({ rowCount, sha256: hash.digest("hex") });
}

function rowsForDigest(
	database: Database.Database,
	sql: string,
	parameters: readonly unknown[],
): readonly Readonly<Record<string, unknown>>[] {
	return Object.freeze((database.prepare(sql).all(...parameters) as readonly Record<string, unknown>[])
		.map((row) => Object.freeze(row)));
}

function taggedRows(
	table: string,
	rows: readonly Readonly<Record<string, unknown>>[],
): readonly Readonly<Record<string, unknown>>[] {
	return Object.freeze(rows.map((row) => Object.freeze({ table, row })));
}

function digest(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function sessionKey(sessionId: string): string {
	return createHash("sha256").update(`v9-projection-manifest\0${sessionId}`).digest("hex");
}

function parseObjectJson(value: unknown, source: string): Readonly<Record<string, unknown>> {
	try {
		const parsed = JSON.parse(String(value)) as unknown;
		if (!isRecord(parsed)) throw new Error("not an object");
		return Object.freeze(parsed);
	} catch {
		throw new StorageFailure(`invalid JSON in ${source}`);
	}
}

function assertV9(database: Database.Database): void {
	const row = database.prepare("SELECT version FROM schema_version LIMIT 1").get() as {
		readonly version: unknown;
	} | undefined;
	if (row?.version !== 9) {
		throw new StorageFailure("v9 projection manifest requires schema version 9", {
			expected_version: 9,
			actual_version: typeof row?.version === "number" ? row.version : null,
		});
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
