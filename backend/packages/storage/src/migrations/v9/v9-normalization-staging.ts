import { createHash } from "node:crypto";
import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { CanonicalConversationItem, ProviderUsage } from "@mycli/core";
import {
	canonicalConversationItem,
	canonicalHistoryItem,
} from "../../projections/legacy-provider-projection.ts";
import { StorageFailure } from "../../sessions/session-store.ts";
import { stableJson } from "../../stable-json.ts";
import {
	deterministicLegacyTranscriptEventId,
	parseTranscriptEventAppendInput,
	type TranscriptDisplayActivityType,
	type TranscriptEventAppendInput,
	type TranscriptEventPayloadByType,
	type TranscriptEventType,
	type TranscriptJsonValue,
	type TranscriptLegacyErrorCode,
	type TranscriptLegacySourceKind,
	type TranscriptReadableProjection,
} from "../../transcript/transcript-events.ts";
import { migrationFailure as stagingError } from "../migration-failure.ts";

export const V9_TRANSCRIPT_NORMALIZATION_STAGING_VERSION = 1 as const;
export const V9_TRANSCRIPT_NORMALIZATION_MINIMUM_FREE_BYTES = 16 * 1024 * 1024;

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 10_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_BUSY_TIMEOUT_MS = 60_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

const SOURCE_PRIORITIES: Readonly<Record<TranscriptLegacySourceKind, number>> = Object.freeze({
	conversation_messages: 0,
	history_items: 1,
	turn_rollouts: 2,
	session_summaries: 3,
});

const ORDER_PRIORITIES: Readonly<Record<TranscriptLegacySourceKind, number>> = Object.freeze({
	history_items: 0,
	conversation_messages: 1,
	turn_rollouts: 2,
	session_summaries: 3,
});

const DISPLAY_ACTIVITY_TYPES: Readonly<Record<string, TranscriptDisplayActivityType>> = Object.freeze({
	reasoning: "reasoning",
	plan_update: "plan",
	approval_request: "approval_request",
	approval_resolution: "approval_resolution",
	clarification_request: "clarification_request",
	clarification_response: "clarification_response",
	shell: "shell",
	shell_session: "shell",
	warning: "warning",
	status: "status",
	file_change: "file_change",
	tool_activation: "tool_activation",
	tool_exposure: "tool_activation",
	context_baseline_update: "context_baseline",
	capability: "capability",
	contributed_tool: "capability",
	command_result: "command_result",
});

export const V9_TRANSCRIPT_NORMALIZATION_STAGING_SQL = `
CREATE TABLE IF NOT EXISTS transcript_normalization_events (
    session_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    turn_id TEXT,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'user_input', 'assistant_output', 'assistant_tool_call_batch', 'tool_result',
        'context', 'display_activity', 'turn_lifecycle', 'rollback', 'compaction',
        'opaque_legacy'
    )),
    provider_index INTEGER,
    model_visible INTEGER NOT NULL CHECK (model_visible IN (0, 1)),
    payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json)
        AND COALESCE(json_extract(payload_json, '$.schemaVersion') = 1, 0)
        AND COALESCE(json_type(payload_json, '$.payload') = 'object', 0)
    ),
    created_at TEXT NOT NULL,
    order_key TEXT NOT NULL,
    order_source_priority INTEGER NOT NULL,
    canonical_source_kind TEXT NOT NULL,
    canonical_source_rowid INTEGER NOT NULL,
    canonical_source_priority INTEGER NOT NULL,
    event_hash TEXT NOT NULL CHECK (length(event_hash) = 64),
    staging_schema_version INTEGER NOT NULL DEFAULT 1
        CHECK (staging_schema_version = 1),
    PRIMARY KEY (session_id, event_id),
    CHECK (
        (model_visible = 1 AND provider_index IS NOT NULL AND provider_index >= 0)
        OR (model_visible = 0 AND provider_index IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_transcript_normalization_events_order
ON transcript_normalization_events(session_id, order_key, event_id);

CREATE INDEX IF NOT EXISTS idx_transcript_normalization_events_provider
ON transcript_normalization_events(session_id, provider_index)
WHERE provider_index IS NOT NULL;

CREATE TABLE IF NOT EXISTS transcript_normalization_batches (
    batch_id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    source_row_count INTEGER NOT NULL DEFAULT 0,
    event_count INTEGER NOT NULL DEFAULT 0,
    merged_source_row_count INTEGER NOT NULL DEFAULT 0,
    opaque_source_row_count INTEGER NOT NULL DEFAULT 0,
    first_source_kind TEXT,
    first_source_rowid INTEGER,
    last_source_kind TEXT,
    last_source_rowid INTEGER,
    schema_version_before INTEGER NOT NULL CHECK (schema_version_before = 9),
    schema_version_after INTEGER CHECK (schema_version_after = 9),
    staging_schema_version INTEGER NOT NULL DEFAULT 1
        CHECK (staging_schema_version = 1)
);

CREATE TABLE IF NOT EXISTS transcript_normalization_source_map (
    source_kind TEXT NOT NULL CHECK (source_kind IN (
        'conversation_messages', 'history_items', 'turn_rollouts', 'session_summaries'
    )),
    source_rowid INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    source_order INTEGER NOT NULL,
    source_identity TEXT NOT NULL,
    source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
    event_id TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('canonical', 'merged', 'opaque')),
    batch_id INTEGER NOT NULL,
    mapped_at TEXT NOT NULL,
    staging_schema_version INTEGER NOT NULL DEFAULT 1
        CHECK (staging_schema_version = 1),
    PRIMARY KEY (source_kind, source_rowid),
    FOREIGN KEY (session_id, event_id)
        REFERENCES transcript_normalization_events(session_id, event_id),
    FOREIGN KEY (batch_id) REFERENCES transcript_normalization_batches(batch_id)
);

CREATE INDEX IF NOT EXISTS idx_transcript_normalization_source_map_event
ON transcript_normalization_source_map(session_id, event_id);

CREATE TABLE IF NOT EXISTS transcript_normalization_merge_keys (
    session_id TEXT NOT NULL,
    merge_key TEXT NOT NULL,
    event_id TEXT NOT NULL,
    staging_schema_version INTEGER NOT NULL DEFAULT 1
        CHECK (staging_schema_version = 1),
    PRIMARY KEY (session_id, merge_key),
    FOREIGN KEY (session_id, event_id)
        REFERENCES transcript_normalization_events(session_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_transcript_normalization_merge_keys_event
ON transcript_normalization_merge_keys(session_id, event_id);

CREATE TABLE IF NOT EXISTS transcript_normalization_source_conflicts (
    source_kind TEXT NOT NULL CHECK (source_kind IN (
        'conversation_messages', 'history_items', 'turn_rollouts', 'session_summaries'
    )),
    source_rowid INTEGER NOT NULL,
    detected_operation TEXT NOT NULL CHECK (detected_operation IN ('update', 'delete')),
    staging_schema_version INTEGER NOT NULL DEFAULT 1
        CHECK (staging_schema_version = 1),
    PRIMARY KEY (source_kind, source_rowid),
    FOREIGN KEY (source_kind, source_rowid)
        REFERENCES transcript_normalization_source_map(source_kind, source_rowid)
        ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS transcript_normalization_conversation_update
AFTER UPDATE OF payload_json ON conversation_messages
WHEN EXISTS (
    SELECT 1 FROM transcript_normalization_source_map
    WHERE source_kind = 'conversation_messages' AND source_rowid = new.rowid
) BEGIN
    INSERT OR IGNORE INTO transcript_normalization_source_conflicts (
        source_kind, source_rowid, detected_operation
    ) VALUES ('conversation_messages', new.rowid, 'update');
END;

CREATE TRIGGER IF NOT EXISTS transcript_normalization_conversation_delete
AFTER DELETE ON conversation_messages
WHEN EXISTS (
    SELECT 1 FROM transcript_normalization_source_map
    WHERE source_kind = 'conversation_messages' AND source_rowid = old.rowid
) BEGIN
    INSERT OR IGNORE INTO transcript_normalization_source_conflicts (
        source_kind, source_rowid, detected_operation
    ) VALUES ('conversation_messages', old.rowid, 'delete');
END;

CREATE TRIGGER IF NOT EXISTS transcript_normalization_history_update
AFTER UPDATE OF payload_json ON history_items
WHEN EXISTS (
    SELECT 1 FROM transcript_normalization_source_map
    WHERE source_kind = 'history_items' AND source_rowid = new.rowid
) BEGIN
    INSERT OR IGNORE INTO transcript_normalization_source_conflicts (
        source_kind, source_rowid, detected_operation
    ) VALUES ('history_items', new.rowid, 'update');
END;

CREATE TRIGGER IF NOT EXISTS transcript_normalization_history_delete
AFTER DELETE ON history_items
WHEN EXISTS (
    SELECT 1 FROM transcript_normalization_source_map
    WHERE source_kind = 'history_items' AND source_rowid = old.rowid
) BEGIN
    INSERT OR IGNORE INTO transcript_normalization_source_conflicts (
        source_kind, source_rowid, detected_operation
    ) VALUES ('history_items', old.rowid, 'delete');
END;

CREATE TRIGGER IF NOT EXISTS transcript_normalization_rollout_update
AFTER UPDATE OF payload_json ON turn_rollouts
WHEN EXISTS (
    SELECT 1 FROM transcript_normalization_source_map
    WHERE source_kind = 'turn_rollouts' AND source_rowid = new.rowid
) BEGIN
    INSERT OR IGNORE INTO transcript_normalization_source_conflicts (
        source_kind, source_rowid, detected_operation
    ) VALUES ('turn_rollouts', new.rowid, 'update');
END;

CREATE TRIGGER IF NOT EXISTS transcript_normalization_rollout_delete
AFTER DELETE ON turn_rollouts
WHEN EXISTS (
    SELECT 1 FROM transcript_normalization_source_map
    WHERE source_kind = 'turn_rollouts' AND source_rowid = old.rowid
) BEGIN
    INSERT OR IGNORE INTO transcript_normalization_source_conflicts (
        source_kind, source_rowid, detected_operation
    ) VALUES ('turn_rollouts', old.rowid, 'delete');
END;

CREATE TRIGGER IF NOT EXISTS transcript_normalization_summary_update
AFTER UPDATE OF summary_text ON session_summaries
WHEN EXISTS (
    SELECT 1 FROM transcript_normalization_source_map
    WHERE source_kind = 'session_summaries' AND source_rowid = new.rowid
) BEGIN
    INSERT OR IGNORE INTO transcript_normalization_source_conflicts (
        source_kind, source_rowid, detected_operation
    ) VALUES ('session_summaries', new.rowid, 'update');
END;

CREATE TRIGGER IF NOT EXISTS transcript_normalization_summary_delete
AFTER DELETE ON session_summaries
WHEN EXISTS (
    SELECT 1 FROM transcript_normalization_source_map
    WHERE source_kind = 'session_summaries' AND source_rowid = old.rowid
) BEGIN
    INSERT OR IGNORE INTO transcript_normalization_source_conflicts (
        source_kind, source_rowid, detected_operation
    ) VALUES ('session_summaries', old.rowid, 'delete');
END;
`;

export interface StageV9TranscriptNormalizationBatchOptions {
	readonly dbPath: string;
	readonly batchSize?: number;
	readonly busyTimeoutMs?: number;
	readonly clock?: () => string;
	readonly freeSpaceProbe?: (dbPath: string) => number;
}

export interface V9TranscriptNormalizationStagingBatchResult {
	readonly schemaVersion: 9;
	readonly stagingSchemaVersion: typeof V9_TRANSCRIPT_NORMALIZATION_STAGING_VERSION;
	readonly batchId: number | null;
	readonly selectedSourceRowCount: number;
	readonly stagedEventCount: number;
	readonly mergedSourceRowCount: number;
	readonly opaqueSourceRowCount: number;
	readonly totalStagedSourceRowCount: number;
	readonly totalStagedEventCount: number;
	readonly remainingSourceRowCount: number;
	readonly excludedActiveSessionCount: number;
	readonly complete: boolean;
}

export interface ReconcileV9TranscriptNormalizationBatchOptions {
	readonly batchSize: number;
	readonly clock: () => string;
}

interface LegacySourceRow {
	readonly source_kind: unknown;
	readonly source_rowid: unknown;
	readonly source_order: unknown;
	readonly source_identity: unknown;
	readonly session_id: unknown;
	readonly payload_text: unknown;
	readonly source_created_at: unknown;
}

interface NormalizationSource {
	readonly sourceKind: TranscriptLegacySourceKind;
	readonly sourceRowid: number;
	readonly sourceOrder: number;
	readonly sourceIdentity: string;
	readonly sessionId: string;
	readonly payloadText: string;
	readonly sourceHash: string;
	readonly sourceCreatedAt: string;
}

interface StagedCandidate {
	readonly event: TranscriptEventAppendInput;
	readonly providerIndex?: number;
	readonly mergeKeys: readonly string[];
	readonly orderKey: string;
	readonly orderSourcePriority: number;
	readonly canonicalSourcePriority: number;
	readonly opaque: boolean;
}

interface StagedEventRow {
	readonly session_id: unknown;
	readonly event_id: unknown;
	readonly turn_id: unknown;
	readonly event_type: unknown;
	readonly provider_index: unknown;
	readonly model_visible: unknown;
	readonly payload_json: unknown;
	readonly created_at: unknown;
	readonly order_key: unknown;
	readonly order_source_priority: unknown;
	readonly canonical_source_kind: unknown;
	readonly canonical_source_rowid: unknown;
	readonly canonical_source_priority: unknown;
}

interface StoredStagedEvent {
	readonly sessionId: string;
	readonly eventId: string;
	readonly turnId?: string;
	readonly eventType: TranscriptEventType;
	readonly providerIndex?: number;
	readonly modelVisible: boolean;
	readonly payload: TranscriptJsonValue;
	readonly createdAt: string;
	readonly orderKey: string;
	readonly orderSourcePriority: number;
	readonly canonicalSourceKind: TranscriptLegacySourceKind;
	readonly canonicalSourceRowid: number;
	readonly canonicalSourcePriority: number;
}

export function stageV9TranscriptNormalizationBatch(
	options: StageV9TranscriptNormalizationBatchOptions,
): V9TranscriptNormalizationStagingBatchResult {
	const batchSize = boundedInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE, "batchSize");
	const busyTimeoutMs = boundedInteger(
		options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
		0,
		MAX_BUSY_TIMEOUT_MS,
		"busyTimeoutMs",
	);
	const clock = options.clock ?? utcTimestamp;
	assertV9TranscriptNormalizationFreeSpace(options.dbPath, options.freeSpaceProbe);
	let database: Database.Database;
	try {
		database = new Database(options.dbPath, { fileMustExist: true });
		database.pragma("foreign_keys = ON");
		database.pragma(`busy_timeout = ${busyTimeoutMs}`);
	} catch (error) {
		throw stagingError(error, "unable to open session storage for transcript normalization");
	}

	try {
		database.exec("BEGIN IMMEDIATE");
		const result = reconcileV9TranscriptNormalizationBatchInTransaction(database, {
			batchSize,
			clock,
		});
		database.exec("COMMIT");
		return result;
	} catch (error) {
		if (database.inTransaction) database.exec("ROLLBACK");
		throw stagingError(error, "v9 transcript normalization staging failed");
	} finally {
		database.close();
	}
}

export function reconcileV9TranscriptNormalizationBatchInTransaction(
	database: Database.Database,
	options: ReconcileV9TranscriptNormalizationBatchOptions,
): V9TranscriptNormalizationStagingBatchResult {
	if (!database.inTransaction) {
		throw new StorageFailure("transcript normalization reconciliation requires a transaction");
	}
	const batchSize = boundedInteger(options.batchSize, 1, MAX_BATCH_SIZE, "batchSize");
	assertV9(database);
	database.exec(V9_TRANSCRIPT_NORMALIZATION_STAGING_SQL);
	assertStagingSchema(database);
	assertMappedSourceHashes(database, batchSize);
	const sources = selectSources(database, batchSize);
	if (sources.length === 0) return stagingResult(database, null, 0, 0, 0, 0);

	const startedAt = timestamp(options.clock());
	const batchInsert = database.prepare(`
		INSERT INTO transcript_normalization_batches (
			started_at, schema_version_before, staging_schema_version
		) VALUES (?, 9, ?)
	`).run(startedAt, V9_TRANSCRIPT_NORMALIZATION_STAGING_VERSION);
	const batchId = safeInteger(batchInsert.lastInsertRowid, "batch id");
	for (const source of sources) {
		const candidate = normalizeSource(database, source);
		reconcileSource(database, source, candidate, batchId, startedAt);
	}
	const metrics = batchMetrics(database, batchId);
	assertV9(database);
	const completedAt = timestamp(options.clock());
	const first = sources[0]!;
	const last = sources.at(-1)!;
	database.prepare(`
		UPDATE transcript_normalization_batches
		SET completed_at = ?, source_row_count = ?, event_count = ?,
		    merged_source_row_count = ?, opaque_source_row_count = ?,
		    first_source_kind = ?, first_source_rowid = ?,
		    last_source_kind = ?, last_source_rowid = ?, schema_version_after = 9
		WHERE batch_id = ?
	`).run(
		completedAt,
		sources.length,
		metrics.eventCount,
		metrics.mergedSourceRowCount,
		metrics.opaqueSourceRowCount,
		first.sourceKind,
		first.sourceRowid,
		last.sourceKind,
		last.sourceRowid,
		batchId,
	);
	return stagingResult(
		database,
		batchId,
		sources.length,
		metrics.eventCount,
		metrics.mergedSourceRowCount,
		metrics.opaqueSourceRowCount,
	);
}

function selectSources(database: Database.Database, limit: number): readonly NormalizationSource[] {
	const rows = database.prepare(`
		WITH active_sessions AS (
			SELECT session_id FROM runtime_turns WHERE status = 'in_progress'
			UNION
			SELECT session_id FROM session_state
			WHERE state_key IN ('pending_decision', 'suspended_turn', 'node_effect_checkpoint')
		), candidates AS (
			SELECT 0 AS source_priority, 'conversation_messages' AS source_kind,
			       messages.rowid AS source_rowid, messages.message_index AS source_order,
			       CAST(messages.message_index AS TEXT) AS source_identity,
			       messages.session_id, messages.payload_json AS payload_text,
			       sessions.created_at AS source_created_at
			FROM conversation_messages AS messages
			JOIN sessions ON sessions.session_id = messages.session_id
			LEFT JOIN transcript_normalization_source_map AS mapped
			  ON mapped.source_kind = 'conversation_messages'
			 AND mapped.source_rowid = messages.rowid
			WHERE mapped.source_rowid IS NULL
			  AND messages.session_id NOT IN (SELECT session_id FROM active_sessions)
			UNION ALL
			SELECT 1, 'history_items', history.rowid, history.sequence_no,
			       history.item_id, history.session_id, history.payload_json,
			       sessions.created_at
			FROM history_items AS history
			JOIN sessions ON sessions.session_id = history.session_id
			LEFT JOIN transcript_normalization_source_map AS mapped
			  ON mapped.source_kind = 'history_items' AND mapped.source_rowid = history.rowid
			WHERE mapped.source_rowid IS NULL
			  AND history.session_id NOT IN (SELECT session_id FROM active_sessions)
			UNION ALL
			SELECT 2, 'turn_rollouts', rollouts.rowid, rollouts.sequence_no,
			       rollouts.turn_id, rollouts.session_id, rollouts.payload_json,
			       sessions.created_at
			FROM turn_rollouts AS rollouts
			JOIN sessions ON sessions.session_id = rollouts.session_id
			LEFT JOIN transcript_normalization_source_map AS mapped
			  ON mapped.source_kind = 'turn_rollouts' AND mapped.source_rowid = rollouts.rowid
			WHERE mapped.source_rowid IS NULL
			  AND rollouts.session_id NOT IN (SELECT session_id FROM active_sessions)
			UNION ALL
			SELECT 3, 'session_summaries', summaries.rowid, summaries.summary_index,
			       CAST(summaries.summary_index AS TEXT), summaries.session_id,
			       summaries.summary_text, summaries.created_at
			FROM session_summaries AS summaries
			LEFT JOIN transcript_normalization_source_map AS mapped
			  ON mapped.source_kind = 'session_summaries'
			 AND mapped.source_rowid = summaries.rowid
			WHERE mapped.source_rowid IS NULL
			  AND summaries.session_id NOT IN (SELECT session_id FROM active_sessions)
		)
		SELECT source_kind, source_rowid, source_order, source_identity,
		       session_id, payload_text, source_created_at
		FROM candidates
		ORDER BY source_priority, source_rowid
		LIMIT ?
	`).all(limit) as readonly LegacySourceRow[];
	return Object.freeze(rows.map(normalizationSource));
}

function normalizationSource(row: LegacySourceRow): NormalizationSource {
	const sourceKind = legacySourceKind(row.source_kind);
	const sourceRowid = safeInteger(row.source_rowid, "source rowid");
	const sourceOrder = safeInteger(row.source_order, "source order");
	const sessionId = nonEmptyString(row.session_id, "source session id");
	const payloadText = string(row.payload_text, "source payload");
	const sourceCreatedAt = timestamp(row.source_created_at);
	return Object.freeze({
		sourceKind,
		sourceRowid,
		sourceOrder,
		sourceIdentity: boundedSourceIdentity(row.source_identity, sourceOrder),
		sessionId,
		payloadText,
		sourceHash: sha256(payloadText),
		sourceCreatedAt,
	});
}

function normalizeSource(
	database: Database.Database,
	source: NormalizationSource,
): StagedCandidate {
	switch (source.sourceKind) {
		case "conversation_messages": return normalizeConversationSource(database, source);
		case "history_items": return normalizeHistorySource(database, source);
		case "turn_rollouts": return normalizeRolloutSource(database, source);
		case "session_summaries": return normalizeSummarySource(database, source);
	}
}

function normalizeConversationSource(
	database: Database.Database,
	source: NormalizationSource,
): StagedCandidate {
	const parsed = parseJson(source.payloadText);
	if (!parsed.valid) return opaqueCandidate(source, "invalid_json", true);
	if (!isRecord(parsed.value)) return opaqueCandidate(source, "invalid_shape", true);
	let canonical: CanonicalConversationItem;
	try {
		canonical = canonicalConversationItem(source.payloadText, "conversation_messages");
	} catch {
		return opaqueCandidate(
			source,
			knownConversationRole(parsed.value.role) ? "projection_failure" : "unsupported_shape",
			true,
		);
	}
	const metadata = recordValue(parsed.value.metadata);
	const turnId = optionalIdentity(metadata.turn_id);
	const responseId = optionalIdentity(parsed.value.response_id);
	const common = {
		source,
		turnId,
		providerIndex: source.sourceOrder,
		createdAt: sourceTimestamp(parsed.value, source.sourceCreatedAt),
	};
	const readableProjection = {
		readableProjection: { hidden: true, createdAt: null } as const,
	};
	switch (canonical.type) {
		case "user": {
			const clientId = optionalIdentity(metadata.client_user_message_id)
				?? fallbackIdentity(source, "user");
			const queueId = optionalIdentity(metadata.queue_id);
			const keys = userMergeKeys(
				turnId,
				clientId,
				queueId,
				canonical.text,
				userOccurrenceKey(database, source, canonical.text),
			);
			return typedCandidate(common, "user_input", primaryEventKey(keys, source), {
				text: canonical.text,
				clientUserMessageId: clientId,
				...(queueId ? { queueId } : {}),
				source: userSource(metadata.source, queueId),
				...(canonical.images && canonical.images.length > 0
					? { images: canonical.images }
					: {}),
				...readableProjection,
			}, keys);
		}
		case "assistant": {
			const keys = assistantMergeKeys(
				turnId,
				responseId,
				canonical.text,
				assistantOccurrenceKey(database, source, canonical.text),
			);
			return typedCandidate(common, "assistant_output", primaryEventKey(keys, source), {
				text: canonical.text,
				...(responseId ? { responseId } : {}),
				...(canonical.providerState ? { providerState: canonical.providerState } : {}),
				...readableProjection,
			}, keys);
		}
		case "assistant_tool_calls": {
			const keys = toolBatchMergeKeys(turnId, responseId, canonical.calls.map((call) => call.callId));
			return typedCandidate(common, "assistant_tool_call_batch", primaryEventKey(keys, source), {
				text: canonical.text,
				calls: canonical.calls,
				...(canonical.responseId ? { responseId: canonical.responseId } : {}),
				...(canonical.providerState ? { providerState: canonical.providerState } : {}),
				...readableProjection,
			}, keys);
		}
		case "tool_result": {
			const keys = Object.freeze([`tool-result:${canonical.callId}`]);
			return typedCandidate(common, "tool_result", keys[0]!, {
				result: {
					callId: canonical.callId,
					toolName: canonical.toolName,
					output: canonical.output,
					success: canonical.success,
				},
				summary: optionalIdentity(metadata.summary) ?? `${canonical.toolName} complete`,
				...(optionalIdentity(metadata.error_kind)
					? { errorKind: optionalIdentity(metadata.error_kind) }
					: {}),
				...jsonMetadata(metadata, [
					"turn_id", "source", "tool_name", "success", "summary", "error_kind",
				]),
				...readableProjection,
			}, keys);
		}
		case "context": {
			const keys = contextMergeKeys(canonical.metadata.sourceId, canonical.text);
			return typedCandidate(common, "context", primaryEventKey(keys, source), {
				itemId: canonical.metadata.sourceId,
				text: canonical.text,
				metadata: canonical.metadata,
				...readableProjection,
			}, keys);
		}
	}
}

function normalizeHistorySource(
	database: Database.Database,
	source: NormalizationSource,
): StagedCandidate {
	const parsed = parseJson(source.payloadText);
	const conversationCount = sessionConversationCount(database, source.sessionId);
	const providerFallback = conversationCount === 0 && !sessionHasCompaction(database, source.sessionId);
	if (!parsed.valid) return opaqueCandidate(source, "invalid_json", providerFallback, historyProviderIndex(
		database,
		source,
	));
	if (!isRecord(parsed.value)) return opaqueCandidate(source, "invalid_shape", providerFallback, historyProviderIndex(
		database,
		source,
	));
	if (parsed.value.type === "compaction_boundary") {
		return compactionCandidate(database, source, parsed.value);
	}
	if (parsed.value.type === "turn_rollback") {
		return rollbackCandidate(source, parsed.value);
	}
	const displayType = typeof parsed.value.type === "string"
		? DISPLAY_ACTIVITY_TYPES[parsed.value.type]
		: undefined;
	if (displayType) return displayCandidate(source, parsed.value, displayType);

	let canonical: CanonicalConversationItem;
	try {
		canonical = canonicalHistoryItem(source.payloadText);
	} catch {
		return opaqueCandidate(
			source,
			typeof parsed.value.type === "string" ? "unsupported_shape" : "invalid_shape",
			false,
		);
	}
	const metadata = recordValue(parsed.value.metadata);
	const readableProjection = legacyReadableProjection(
		parsed.value,
		canonical,
		providerFallback ? false : undefined,
	);
	const turnId = optionalIdentity(parsed.value.turn_id);
	const responseId = optionalIdentity(metadata.response_id);
	const providerIndex = providerFallback ? source.sourceOrder : undefined;
	const common = {
		source,
		turnId,
		...(providerIndex === undefined ? {} : { providerIndex }),
		createdAt: sourceTimestamp(parsed.value, source.sourceCreatedAt),
	};
	switch (canonical.type) {
		case "user": {
			const clientId = optionalIdentity(metadata.client_user_message_id)
				?? historyClientUserId(parsed.value.id)
				?? fallbackIdentity(source, "user");
			const queueId = optionalIdentity(metadata.queue_id);
			const keys = userMergeKeys(
				turnId,
				clientId,
				queueId,
				canonical.text,
				userOccurrenceKey(database, source, canonical.text),
			);
			return typedCandidate(common, "user_input", primaryEventKey(keys, source), {
				text: canonical.text,
				clientUserMessageId: clientId,
				...(queueId ? { queueId } : {}),
				source: userSource(metadata.source, queueId),
				readableProjection,
			}, keys);
		}
		case "assistant": {
			const keys = assistantMergeKeys(
				turnId,
				responseId,
				canonical.text,
				assistantOccurrenceKey(database, source, canonical.text),
			);
			return typedCandidate(common, "assistant_output", primaryEventKey(keys, source), {
				text: canonical.text,
				...(responseId ? { responseId } : {}),
				...(canonical.providerState ? { providerState: canonical.providerState } : {}),
				readableProjection,
			}, keys);
		}
		case "assistant_tool_calls": {
			const keys = toolBatchMergeKeys(turnId, responseId, canonical.calls.map((call) => call.callId));
			return typedCandidate(common, "assistant_tool_call_batch", primaryEventKey(keys, source), {
				text: canonical.text,
				calls: canonical.calls,
				...(canonical.responseId ? { responseId: canonical.responseId } : {}),
				...(canonical.providerState ? { providerState: canonical.providerState } : {}),
				readableProjection,
			}, keys);
		}
		case "tool_result": {
			const keys = Object.freeze([`tool-result:${canonical.callId}`]);
			return typedCandidate(common, "tool_result", keys[0]!, {
				result: {
					callId: canonical.callId,
					toolName: canonical.toolName,
					output: canonical.output,
					success: canonical.success,
				},
				summary: typeof parsed.value.text === "string" ? parsed.value.text : "",
				...(optionalIdentity(metadata.error_kind)
					? { errorKind: optionalIdentity(metadata.error_kind) }
					: {}),
				...jsonMetadata(metadata, [
					"turn_id", "source", "tool_name", "success", "summary", "error_kind",
					"transcript_content", "provider_state", "arguments", "response_id",
				]),
				readableProjection,
			}, keys);
		}
		case "context": {
			const itemId = optionalIdentity(parsed.value.id) ?? canonical.metadata.sourceId;
			const keys = contextMergeKeys(canonical.metadata.sourceId, canonical.text, itemId);
			return typedCandidate(common, "context", primaryEventKey(keys, source), {
				itemId,
				text: canonical.text,
				metadata: canonical.metadata,
				readableProjection,
			}, keys);
		}
	}
}

function normalizeRolloutSource(
	database: Database.Database,
	source: NormalizationSource,
): StagedCandidate {
	const parsed = parseJson(source.payloadText);
	if (!parsed.valid) return opaqueCandidate(source, "invalid_json", false);
	if (!isRecord(parsed.value)) return opaqueCandidate(source, "invalid_shape", false);
	if (!Array.isArray(parsed.value.events) || parsed.value.events.length > 0) {
		return opaqueCandidate(source, "unsupported_shape", false);
	}
	const turnId = optionalIdentity(parsed.value.turn_id) ?? optionalIdentity(source.sourceIdentity);
	const phase = lifecyclePhase(parsed.value.status);
	if (!turnId || !phase) return opaqueCandidate(source, "unsupported_shape", false);
	const usage = providerUsage(recordValue(parsed.value.continuation_state).usage);
	const event = parseTranscriptEventAppendInput({
		schemaVersion: 1,
		sessionId: source.sessionId,
		eventId: semanticEventId(source.sessionId, `lifecycle:${turnId}:${phase}`),
		turnId,
		eventType: "turn_lifecycle",
		modelVisible: false,
		createdAt: optionalTimestamp(parsed.value.completed_at)
			?? optionalTimestamp(parsed.value.started_at)
			?? source.sourceCreatedAt,
		payload: {
			phase,
			...(phase === "failed" || phase === "interrupted"
				? {
					errorCode: phase === "interrupted" ? "interrupted" : "provider_error",
					message: phase === "interrupted" ? "legacy turn interrupted" : "legacy turn failed",
				}
				: {}),
			...(usage ? { usage } : {}),
		},
	});
	return Object.freeze({
		event,
		mergeKeys: Object.freeze([`lifecycle:${turnId}:${phase}`]),
		orderKey: lifecycleOrderKey(database, source, turnId, phase),
		orderSourcePriority: ORDER_PRIORITIES[source.sourceKind],
		canonicalSourcePriority: SOURCE_PRIORITIES[source.sourceKind],
		opaque: false,
	});
}

function normalizeSummarySource(
	database: Database.Database,
	source: NormalizationSource,
): StagedCandidate {
	const ordinal = summaryOrdinal(database, source);
	const key = `summary:${ordinal}`;
	const event = parseTranscriptEventAppendInput({
		schemaVersion: 1,
		sessionId: source.sessionId,
		eventId: semanticEventId(source.sessionId, key),
		eventType: "opaque_legacy",
		modelVisible: false,
		createdAt: source.sourceCreatedAt,
		payload: opaquePayload(source, "unsupported_shape"),
	});
	return Object.freeze({
		event,
		mergeKeys: Object.freeze([key]),
		orderKey: sourceOrderKey(source),
		orderSourcePriority: ORDER_PRIORITIES[source.sourceKind],
		canonicalSourcePriority: SOURCE_PRIORITIES[source.sourceKind],
		opaque: true,
	});
}

function compactionCandidate(
	database: Database.Database,
	source: NormalizationSource,
	payload: Readonly<Record<string, unknown>>,
): StagedCandidate {
	const windowId = optionalIdentity(payload.boundary_id)
		?? optionalIdentity(recordValue(payload.checkpoint).window_id);
	const sourceMessageCount = safeOptionalInteger(payload.source_message_count);
	if (!windowId || sourceMessageCount === undefined
		|| !Array.isArray(payload.replacement_messages)
		|| payload.replacement_messages.length > 4_096
		|| typeof payload.summary !== "string") {
		return opaqueCandidate(source, "projection_failure", false);
	}
	let replacement: readonly CanonicalConversationItem[];
	try {
		replacement = Object.freeze(payload.replacement_messages.map((item) => (
			canonicalConversationItem(stableJson(item), "compaction_boundary")
		)));
	} catch {
		return opaqueCandidate(source, "projection_failure", false);
	}
	const turnId = optionalIdentity(payload.turn_id);
	const ordinal = compactionOrdinal(database, source);
	const keys = Object.freeze([`compaction:${windowId}`, `summary:${ordinal}`]);
	return typedCandidate({
		source,
		turnId,
		createdAt: optionalTimestamp(payload.created_at) ?? source.sourceCreatedAt,
	}, "compaction", keys[0]!, {
		windowId,
		sourceProviderIndex: Math.max(0, sourceMessageCount - 1),
		replacement,
		summary: payload.summary,
		metadata: {
			source_message_count: sourceMessageCount,
			...(jsonRecord(payload.checkpoint) ? { checkpoint: jsonRecord(payload.checkpoint)! } : {}),
		},
	}, keys);
}

function rollbackCandidate(
	source: NormalizationSource,
	payload: Readonly<Record<string, unknown>>,
): StagedCandidate {
	const metadata = recordValue(payload.metadata);
	const turnId = optionalIdentity(payload.turn_id);
	const removed = stringArray(metadata.removed_turn_ids ?? payload.removed_turn_ids);
	const removedTurnIds = removed.length > 0 ? removed : turnId ? [turnId] : [];
	if (removedTurnIds.length === 0) return opaqueCandidate(source, "unsupported_shape", false);
	return typedCandidate({
		source,
		turnId,
		createdAt: sourceTimestamp(payload, source.sourceCreatedAt),
	}, "rollback", `rollback:${source.sourceIdentity}`, {
		removedTurnIds,
		reason: "legacy",
	}, Object.freeze([]));
}

function displayCandidate(
	source: NormalizationSource,
	payload: Readonly<Record<string, unknown>>,
	activityType: TranscriptDisplayActivityType,
): StagedCandidate {
	const metadata = recordValue(payload.metadata);
	return typedCandidate({
		source,
		turnId: optionalIdentity(payload.turn_id),
		createdAt: sourceTimestamp(payload, source.sourceCreatedAt),
	}, "display_activity", `display:${source.sourceIdentity}`, {
		activityType,
		...(typeof payload.text === "string" ? { text: payload.text } : {}),
		...(optionalIdentity(payload.call_id) ? { callId: optionalIdentity(payload.call_id) } : {}),
		...(optionalIdentity(payload.tool_name) ? { toolName: optionalIdentity(payload.tool_name) } : {}),
		...(optionalIdentity(metadata.status) ? { status: optionalIdentity(metadata.status) } : {}),
		...jsonMetadata(metadata, ["created_at"]),
	}, Object.freeze([]));
}

function typedCandidate<Type extends Exclude<TranscriptEventType, "opaque_legacy">>(
	common: Readonly<{
		readonly source: NormalizationSource;
		readonly turnId?: string;
		readonly providerIndex?: number;
		readonly createdAt: string;
	}>,
	eventType: Type,
	identity: string,
	payload: TranscriptEventPayloadByType[Type],
	mergeKeys: readonly string[],
): StagedCandidate {
	const event = parseTranscriptEventAppendInput({
		schemaVersion: 1,
		sessionId: common.source.sessionId,
		eventId: semanticEventId(common.source.sessionId, identity),
		...(common.turnId ? { turnId: common.turnId } : {}),
		eventType,
		modelVisible: common.providerIndex !== undefined,
		createdAt: common.createdAt,
		payload,
	});
	return Object.freeze({
		event,
		...(common.providerIndex === undefined ? {} : { providerIndex: common.providerIndex }),
		mergeKeys: Object.freeze([...new Set(mergeKeys)]),
		orderKey: sourceOrderKey(common.source),
		orderSourcePriority: ORDER_PRIORITIES[common.source.sourceKind],
		canonicalSourcePriority: SOURCE_PRIORITIES[common.source.sourceKind],
		opaque: false,
	});
}

function opaqueCandidate(
	source: NormalizationSource,
	errorCode: TranscriptLegacyErrorCode,
	modelVisible: boolean,
	providerIndex: number | undefined = modelVisible ? source.sourceOrder : undefined,
): StagedCandidate {
	const event = parseTranscriptEventAppendInput({
		schemaVersion: 1,
		sessionId: source.sessionId,
		eventId: deterministicLegacyTranscriptEventId({
			sessionId: source.sessionId,
			sourceKind: source.sourceKind,
			sourceIdentity: source.sourceIdentity,
		}),
		eventType: "opaque_legacy",
		modelVisible,
		createdAt: source.sourceCreatedAt,
		payload: opaquePayload(source, errorCode),
	});
	return Object.freeze({
		event,
		...(providerIndex === undefined ? {} : { providerIndex }),
		mergeKeys: Object.freeze([]),
		orderKey: sourceOrderKey(source),
		orderSourcePriority: ORDER_PRIORITIES[source.sourceKind],
		canonicalSourcePriority: SOURCE_PRIORITIES[source.sourceKind],
		opaque: true,
	});
}

function opaquePayload(
	source: NormalizationSource,
	errorCode: TranscriptLegacyErrorCode,
): Readonly<{
	readonly sourceKind: TranscriptLegacySourceKind;
	readonly sourceIdentity: string;
	readonly rawPayload: string;
	readonly errorCode: TranscriptLegacyErrorCode;
}> {
	return Object.freeze({
		sourceKind: source.sourceKind,
		sourceIdentity: source.sourceIdentity,
		rawPayload: source.payloadText,
		errorCode,
	});
}

function reconcileSource(
	database: Database.Database,
	source: NormalizationSource,
	candidate: StagedCandidate,
	batchId: number,
	mappedAt: string,
): "canonical" | "merged" | "opaque" {
	const matching = matchingEventIds(database, source.sessionId, candidate.mergeKeys);
	const targetEventId = targetEventIdForCandidate(database, source, candidate, matching);
	ensureCandidateEvent(database, source, candidate, targetEventId);
	for (const eventId of matching) {
		if (eventId === targetEventId) continue;
		consolidateEvents(database, source.sessionId, targetEventId, eventId);
	}
	mergeCandidateIntoEvent(database, source, candidate, targetEventId);
	for (const mergeKey of candidate.mergeKeys) {
		database.prepare(`
			INSERT INTO transcript_normalization_merge_keys (
				session_id, merge_key, event_id, staging_schema_version
			) VALUES (?, ?, ?, ?)
			ON CONFLICT(session_id, merge_key) DO UPDATE SET event_id = excluded.event_id
		`).run(
			source.sessionId,
			mergeKey,
			targetEventId,
			V9_TRANSCRIPT_NORMALIZATION_STAGING_VERSION,
		);
	}

	const event = requiredStagedEvent(database, source.sessionId, targetEventId);
	const disposition = event.eventType === "opaque_legacy"
		? "opaque" as const
		: event.canonicalSourceKind === source.sourceKind
			&& event.canonicalSourceRowid === source.sourceRowid
			? "canonical" as const
			: "merged" as const;
	database.prepare(`
		INSERT INTO transcript_normalization_source_map (
			source_kind, source_rowid, session_id, source_order, source_identity,
			source_hash, event_id, disposition, batch_id, mapped_at,
			staging_schema_version
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		source.sourceKind,
		source.sourceRowid,
		source.sessionId,
		source.sourceOrder,
		source.sourceIdentity,
		source.sourceHash,
		targetEventId,
		disposition,
		batchId,
		mappedAt,
		V9_TRANSCRIPT_NORMALIZATION_STAGING_VERSION,
	);
	normalizeEventDispositions(database, source.sessionId, targetEventId);
	return disposition;
}

function matchingEventIds(
	database: Database.Database,
	sessionId: string,
	mergeKeys: readonly string[],
): readonly string[] {
	if (mergeKeys.length === 0) return Object.freeze([]);
	const placeholders = mergeKeys.map(() => "?").join(", ");
	const rows = database.prepare(`
		SELECT DISTINCT event_id
		FROM transcript_normalization_merge_keys
		WHERE session_id = ? AND merge_key IN (${placeholders})
		ORDER BY event_id
	`).all(sessionId, ...mergeKeys) as readonly { readonly event_id: unknown }[];
	return Object.freeze(rows.flatMap((row) => typeof row.event_id === "string" ? [row.event_id] : []));
}

function targetEventIdForCandidate(
	database: Database.Database,
	source: NormalizationSource,
	candidate: StagedCandidate,
	matching: readonly string[],
): string {
	const existing = matching.map((eventId) => requiredStagedEvent(database, source.sessionId, eventId));
	const bestExistingPriority = Math.min(
		...existing.map((event) => event.canonicalSourcePriority),
		Number.POSITIVE_INFINITY,
	);
	if (candidate.canonicalSourcePriority < bestExistingPriority) return candidate.event.eventId;
	if (candidate.canonicalSourcePriority > bestExistingPriority) {
		return existing
			.filter((event) => event.canonicalSourcePriority === bestExistingPriority)
			.map((event) => event.eventId)
			.sort()[0] ?? candidate.event.eventId;
	}
	return [candidate.event.eventId, ...matching].sort()[0]!;
}

function ensureCandidateEvent(
	database: Database.Database,
	source: NormalizationSource,
	candidate: StagedCandidate,
	targetEventId: string,
): void {
	const existing = database.prepare(`
		SELECT 1 AS present FROM transcript_normalization_events
		WHERE session_id = ? AND event_id = ?
	`).get(source.sessionId, targetEventId);
	if (existing) return;
	const event = candidate.event.eventId === targetEventId
		? candidate.event
		: Object.freeze({ ...candidate.event, eventId: targetEventId });
	insertStagedEvent(database, source, candidate, event);
}

function insertStagedEvent(
	database: Database.Database,
	source: NormalizationSource,
	candidate: StagedCandidate,
	event: TranscriptEventAppendInput,
): void {
	const payloadJson = storedPayload(event);
	database.prepare(`
		INSERT INTO transcript_normalization_events (
			session_id, event_id, turn_id, event_type, provider_index, model_visible,
			payload_json, created_at, order_key, order_source_priority,
			canonical_source_kind, canonical_source_rowid, canonical_source_priority,
			event_hash, staging_schema_version
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		event.sessionId,
		event.eventId,
		event.turnId ?? null,
		event.eventType,
		candidate.providerIndex ?? null,
		event.modelVisible ? 1 : 0,
		payloadJson,
		event.createdAt,
		candidate.orderKey,
		candidate.orderSourcePriority,
		source.sourceKind,
		source.sourceRowid,
		candidate.canonicalSourcePriority,
		eventHash(event, candidate.providerIndex, candidate.orderKey),
		V9_TRANSCRIPT_NORMALIZATION_STAGING_VERSION,
	);
}

function consolidateEvents(
	database: Database.Database,
	sessionId: string,
	targetEventId: string,
	oldEventId: string,
): void {
	const target = requiredStagedEvent(database, sessionId, targetEventId);
	const old = requiredStagedEvent(database, sessionId, oldEventId);
	writeMergedEvent(database, mergeStoredEvents(target, old, targetEventId));
	database.prepare(`
		UPDATE transcript_normalization_source_map SET event_id = ?
		WHERE session_id = ? AND event_id = ?
	`).run(targetEventId, sessionId, oldEventId);
	database.prepare(`
		UPDATE transcript_normalization_merge_keys SET event_id = ?
		WHERE session_id = ? AND event_id = ?
	`).run(targetEventId, sessionId, oldEventId);
	database.prepare(`
		DELETE FROM transcript_normalization_events
		WHERE session_id = ? AND event_id = ?
	`).run(sessionId, oldEventId);
}

function mergeCandidateIntoEvent(
	database: Database.Database,
	source: NormalizationSource,
	candidate: StagedCandidate,
	targetEventId: string,
): void {
	const existing = requiredStagedEvent(database, source.sessionId, targetEventId);
	const incoming = storedEventFromCandidate(source, candidate, targetEventId);
	writeMergedEvent(database, mergeStoredEvents(existing, incoming, targetEventId));
}

function mergeStoredEvents(
	left: StoredStagedEvent,
	right: StoredStagedEvent,
	targetEventId: string,
): StoredStagedEvent {
	const canonical = compareCanonicalSources(left, right) <= 0 ? left : right;
	const other = canonical === left ? right : left;
	const merged = mergeEventPayload(canonical, other);
	const order = compareOrderSources(left, right) <= 0 ? left : right;
	const modelVisible = left.modelVisible || right.modelVisible;
	const providerIndex = modelVisible
		? minimumDefined(left.providerIndex, right.providerIndex)
		: undefined;
	if (modelVisible && providerIndex === undefined) {
		throw new StorageFailure("staged provider event has no provider index");
	}
	return Object.freeze({
		sessionId: canonical.sessionId,
		eventId: targetEventId,
		...(canonical.turnId ?? other.turnId ? { turnId: canonical.turnId ?? other.turnId } : {}),
		eventType: merged.eventType,
		...(providerIndex === undefined ? {} : { providerIndex }),
		modelVisible,
		payload: merged.payload,
		createdAt: preferredCreatedAt(left, right),
		orderKey: order.orderKey,
		orderSourcePriority: order.orderSourcePriority,
		canonicalSourceKind: canonical.canonicalSourceKind,
		canonicalSourceRowid: canonical.canonicalSourceRowid,
		canonicalSourcePriority: canonical.canonicalSourcePriority,
	});
}

function mergeEventPayload(
	canonical: StoredStagedEvent,
	other: StoredStagedEvent,
): Readonly<{ readonly eventType: TranscriptEventType; readonly payload: TranscriptJsonValue }> {
	const canonicalPayload = recordValue(canonical.payload);
	const otherPayload = recordValue(other.payload);
	if (canonical.eventType === "assistant_tool_call_batch"
		|| other.eventType === "assistant_tool_call_batch") {
		const batch = canonical.eventType === "assistant_tool_call_batch" ? canonicalPayload : otherPayload;
		const assistant = canonical.eventType === "assistant_output" ? canonicalPayload
			: other.eventType === "assistant_output" ? otherPayload : {};
		const calls = mergeToolCalls(
			canonical.eventType === "assistant_tool_call_batch" ? canonicalPayload.calls : undefined,
			other.eventType === "assistant_tool_call_batch" ? otherPayload.calls : undefined,
		);
		return Object.freeze({
			eventType: "assistant_tool_call_batch",
			payload: jsonValue({
				...batch,
				text: preferredText(batch.text, assistant.text),
				calls,
				...mergedAssistantBatchReadableProjection(
					canonicalPayload,
					otherPayload,
					canonical.eventType === "assistant_output"
						|| other.eventType === "assistant_output",
				),
			}),
		});
	}
	if (canonical.eventType !== other.eventType) {
		return Object.freeze({ eventType: canonical.eventType, payload: canonical.payload });
	}
	if (canonical.eventType === "tool_result") {
		const canonicalMetadata = recordValue(canonicalPayload.metadata);
		const otherMetadata = recordValue(otherPayload.metadata);
		return Object.freeze({
			eventType: canonical.eventType,
			payload: jsonValue({
				...canonicalPayload,
				summary: preferredSummary(canonicalPayload.summary, otherPayload.summary),
				...(Object.keys(canonicalMetadata).length + Object.keys(otherMetadata).length > 0
					? { metadata: { ...otherMetadata, ...canonicalMetadata } }
					: {}),
				...mergedReadableProjection(canonicalPayload, otherPayload),
			}),
		});
	}
	if (canonical.eventType === "assistant_output") {
		return Object.freeze({
			eventType: canonical.eventType,
			payload: jsonValue({
				...otherPayload,
				...canonicalPayload,
				text: preferredText(canonicalPayload.text, otherPayload.text),
				...mergedReadableProjection(canonicalPayload, otherPayload),
			}),
		});
	}
	if (canonical.eventType === "compaction") {
		return Object.freeze({
			eventType: canonical.eventType,
			payload: jsonValue({
				...canonicalPayload,
				summary: preferredSummary(canonicalPayload.summary, otherPayload.summary),
			}),
		});
	}
	return Object.freeze({
		eventType: canonical.eventType,
		payload: jsonValue({
			...canonicalPayload,
			...mergedReadableProjection(canonicalPayload, otherPayload),
		}),
	});
}

function mergedReadableProjection(
	leftPayload: Readonly<Record<string, unknown>>,
	rightPayload: Readonly<Record<string, unknown>>,
): Readonly<{ readonly readableProjection?: Readonly<Record<string, unknown>> }> {
	const left = recordValue(leftPayload.readableProjection);
	const right = recordValue(rightPayload.readableProjection);
	if (Object.keys(left).length === 0 && Object.keys(right).length === 0) return Object.freeze({});
	const leftCallIds = recordValue(left.toolCallItemIds);
	const rightCallIds = recordValue(right.toolCallItemIds);
	const hidden = left.hidden === false || right.hidden === false
		? false
		: left.hidden === true || right.hidden === true
			? true
			: undefined;
	const assistantPreambleVisible = left.assistantPreambleVisible === true
		|| right.assistantPreambleVisible === true
		? true
		: left.assistantPreambleVisible === false || right.assistantPreambleVisible === false
			? false
			: undefined;
	return Object.freeze({
		readableProjection: Object.freeze({
			...left,
			...right,
			...(hidden === undefined ? {} : { hidden }),
			...(assistantPreambleVisible === undefined ? {} : { assistantPreambleVisible }),
			...(Object.keys(leftCallIds).length + Object.keys(rightCallIds).length > 0
				? { toolCallItemIds: { ...leftCallIds, ...rightCallIds } }
				: {}),
		}),
	});
}

function mergedAssistantBatchReadableProjection(
	leftPayload: Readonly<Record<string, unknown>>,
	rightPayload: Readonly<Record<string, unknown>>,
	hasReadableAssistant: boolean,
): Readonly<{ readonly readableProjection?: Readonly<Record<string, unknown>> }> {
	const merged = mergedReadableProjection(leftPayload, rightPayload);
	if (!hasReadableAssistant) return merged;
	return Object.freeze({
		readableProjection: Object.freeze({
			...recordValue(merged.readableProjection),
			assistantPreambleVisible: true,
		}),
	});
}

function writeMergedEvent(database: Database.Database, event: StoredStagedEvent): void {
	const payloadJson = stableJson({ schemaVersion: 1, payload: event.payload });
	const appendInput = parseTranscriptEventAppendInput({
		schemaVersion: 1,
		sessionId: event.sessionId,
		eventId: event.eventId,
		...(event.turnId ? { turnId: event.turnId } : {}),
		eventType: event.eventType,
		modelVisible: event.modelVisible,
		createdAt: event.createdAt,
		payload: event.payload,
	});
	database.prepare(`
		UPDATE transcript_normalization_events
		SET turn_id = ?, event_type = ?, provider_index = ?, model_visible = ?,
		    payload_json = ?, created_at = ?, order_key = ?, order_source_priority = ?,
		    canonical_source_kind = ?, canonical_source_rowid = ?,
		    canonical_source_priority = ?, event_hash = ?
		WHERE session_id = ? AND event_id = ?
	`).run(
		event.turnId ?? null,
		event.eventType,
		event.providerIndex ?? null,
		event.modelVisible ? 1 : 0,
		payloadJson,
		event.createdAt,
		event.orderKey,
		event.orderSourcePriority,
		event.canonicalSourceKind,
		event.canonicalSourceRowid,
		event.canonicalSourcePriority,
		eventHash(appendInput, event.providerIndex, event.orderKey),
		event.sessionId,
		event.eventId,
	);
}

function storedEventFromCandidate(
	source: NormalizationSource,
	candidate: StagedCandidate,
	eventId: string,
): StoredStagedEvent {
	return Object.freeze({
		sessionId: candidate.event.sessionId,
		eventId,
		...(candidate.event.turnId ? { turnId: candidate.event.turnId } : {}),
		eventType: candidate.event.eventType,
		...(candidate.providerIndex === undefined ? {} : { providerIndex: candidate.providerIndex }),
		modelVisible: candidate.event.modelVisible,
		payload: jsonValue(candidate.event.payload),
		createdAt: candidate.event.createdAt,
		orderKey: candidate.orderKey,
		orderSourcePriority: candidate.orderSourcePriority,
		canonicalSourceKind: source.sourceKind,
		canonicalSourceRowid: source.sourceRowid,
		canonicalSourcePriority: candidate.canonicalSourcePriority,
	});
}

function requiredStagedEvent(
	database: Database.Database,
	sessionId: string,
	eventId: string,
): StoredStagedEvent {
	const row = database.prepare(`
		SELECT session_id, event_id, turn_id, event_type, provider_index, model_visible,
		       payload_json, created_at, order_key, order_source_priority,
		       canonical_source_kind, canonical_source_rowid, canonical_source_priority
		FROM transcript_normalization_events
		WHERE session_id = ? AND event_id = ?
	`).get(sessionId, eventId) as StagedEventRow | undefined;
	if (!row) throw new StorageFailure("staged transcript event does not exist");
	const stored = parseStoredPayload(row.payload_json);
	return Object.freeze({
		sessionId: nonEmptyString(row.session_id, "staged session id"),
		eventId: nonEmptyString(row.event_id, "staged event id"),
		...(typeof row.turn_id === "string" && row.turn_id ? { turnId: row.turn_id } : {}),
		eventType: transcriptEventType(row.event_type),
		...(row.provider_index === null ? {} : { providerIndex: safeInteger(row.provider_index, "provider index") }),
		modelVisible: row.model_visible === 1,
		payload: stored,
		createdAt: timestamp(row.created_at),
		orderKey: nonEmptyString(row.order_key, "staged order key"),
		orderSourcePriority: safeInteger(row.order_source_priority, "order source priority"),
		canonicalSourceKind: legacySourceKind(row.canonical_source_kind),
		canonicalSourceRowid: safeInteger(row.canonical_source_rowid, "canonical source rowid"),
		canonicalSourcePriority: safeInteger(
			row.canonical_source_priority,
			"canonical source priority",
		),
	});
}

function normalizeEventDispositions(
	database: Database.Database,
	sessionId: string,
	eventId: string,
): void {
	const event = requiredStagedEvent(database, sessionId, eventId);
	if (event.eventType === "opaque_legacy") {
		database.prepare(`
			UPDATE transcript_normalization_source_map SET disposition = 'opaque'
			WHERE session_id = ? AND event_id = ?
		`).run(sessionId, eventId);
		return;
	}
	database.prepare(`
		UPDATE transcript_normalization_source_map SET disposition = 'merged'
		WHERE session_id = ? AND event_id = ?
	`).run(sessionId, eventId);
	database.prepare(`
		UPDATE transcript_normalization_source_map SET disposition = 'canonical'
		WHERE session_id = ? AND event_id = ?
		  AND source_kind = ? AND source_rowid = ?
	`).run(
		sessionId,
		eventId,
		event.canonicalSourceKind,
		event.canonicalSourceRowid,
	);
}

function stagingResult(
	database: Database.Database,
	batchId: number | null,
	selectedSourceRowCount: number,
	stagedEventCount: number,
	mergedSourceRowCount: number,
	opaqueSourceRowCount: number,
): V9TranscriptNormalizationStagingBatchResult {
	const totalStagedSourceRowCount = count(
		database,
		"SELECT COUNT(*) AS count FROM transcript_normalization_source_map",
	);
	const totalStagedEventCount = count(
		database,
		"SELECT COUNT(*) AS count FROM transcript_normalization_events",
	);
	const remainingSourceRowCount = remainingSourceRows(database);
	const unresolvedSourceConflictCount = count(
		database,
		"SELECT COUNT(*) AS count FROM transcript_normalization_source_conflicts",
	);
	return Object.freeze({
		schemaVersion: 9,
		stagingSchemaVersion: V9_TRANSCRIPT_NORMALIZATION_STAGING_VERSION,
		batchId,
		selectedSourceRowCount,
		stagedEventCount,
		mergedSourceRowCount,
		opaqueSourceRowCount,
		totalStagedSourceRowCount,
		totalStagedEventCount,
		remainingSourceRowCount,
		excludedActiveSessionCount: activeSessionCount(database),
		complete: remainingSourceRowCount === 0 && unresolvedSourceConflictCount === 0,
	});
}

function batchMetrics(database: Database.Database, batchId: number): Readonly<{
	readonly eventCount: number;
	readonly mergedSourceRowCount: number;
	readonly opaqueSourceRowCount: number;
}> {
	const row = database.prepare(`
		SELECT
			(SELECT COUNT(*) FROM (
				SELECT session_id, event_id
				FROM transcript_normalization_source_map
				WHERE batch_id = ?
				GROUP BY session_id, event_id
			)) AS event_count,
			COALESCE(SUM(CASE WHEN disposition = 'merged' THEN 1 ELSE 0 END), 0)
				AS merged_source_row_count,
			COALESCE(SUM(CASE WHEN disposition = 'opaque' THEN 1 ELSE 0 END), 0)
				AS opaque_source_row_count
		FROM transcript_normalization_source_map
		WHERE batch_id = ?
	`).get(batchId, batchId) as {
		readonly event_count: unknown;
		readonly merged_source_row_count: unknown;
		readonly opaque_source_row_count: unknown;
	};
	return Object.freeze({
		eventCount: nonNegativeInteger(row.event_count, "batch event count"),
		mergedSourceRowCount: nonNegativeInteger(
			row.merged_source_row_count,
			"batch merged source count",
		),
		opaqueSourceRowCount: nonNegativeInteger(
			row.opaque_source_row_count,
			"batch opaque source count",
		),
	});
}

function remainingSourceRows(database: Database.Database): number {
	return count(database, `
		WITH active_sessions AS (
			SELECT session_id FROM runtime_turns WHERE status = 'in_progress'
			UNION
			SELECT session_id FROM session_state
			WHERE state_key IN ('pending_decision', 'suspended_turn', 'node_effect_checkpoint')
		), unmapped AS (
			SELECT messages.rowid
			FROM conversation_messages AS messages
			LEFT JOIN transcript_normalization_source_map AS mapped
			  ON mapped.source_kind = 'conversation_messages' AND mapped.source_rowid = messages.rowid
			WHERE mapped.source_rowid IS NULL
			  AND messages.session_id NOT IN (SELECT session_id FROM active_sessions)
			UNION ALL
			SELECT history.rowid FROM history_items AS history
			LEFT JOIN transcript_normalization_source_map AS mapped
			  ON mapped.source_kind = 'history_items' AND mapped.source_rowid = history.rowid
			WHERE mapped.source_rowid IS NULL
			  AND history.session_id NOT IN (SELECT session_id FROM active_sessions)
			UNION ALL
			SELECT rollouts.rowid FROM turn_rollouts AS rollouts
			LEFT JOIN transcript_normalization_source_map AS mapped
			  ON mapped.source_kind = 'turn_rollouts' AND mapped.source_rowid = rollouts.rowid
			WHERE mapped.source_rowid IS NULL
			  AND rollouts.session_id NOT IN (SELECT session_id FROM active_sessions)
			UNION ALL
			SELECT summaries.rowid FROM session_summaries AS summaries
			LEFT JOIN transcript_normalization_source_map AS mapped
			  ON mapped.source_kind = 'session_summaries' AND mapped.source_rowid = summaries.rowid
			WHERE mapped.source_rowid IS NULL
			  AND summaries.session_id NOT IN (SELECT session_id FROM active_sessions)
		)
		SELECT COUNT(*) AS count FROM unmapped
	`);
}

function activeSessionCount(database: Database.Database): number {
	return count(database, `
		SELECT COUNT(*) AS count FROM (
			SELECT session_id FROM runtime_turns WHERE status = 'in_progress'
			UNION
			SELECT session_id FROM session_state
			WHERE state_key IN ('pending_decision', 'suspended_turn', 'node_effect_checkpoint')
		)
	`);
}

function sessionConversationCount(database: Database.Database, sessionId: string): number {
	const row = database.prepare(`
		SELECT COUNT(*) AS count FROM conversation_messages WHERE session_id = ?
	`).get(sessionId) as { readonly count: unknown };
	return nonNegativeInteger(row.count, "conversation count");
}

function sessionHasCompaction(database: Database.Database, sessionId: string): boolean {
	return database.prepare(`
		SELECT 1 AS present FROM history_items
		WHERE session_id = ? AND CASE WHEN json_valid(payload_json)
			THEN json_extract(payload_json, '$.type') = 'compaction_boundary'
			ELSE 0 END
		LIMIT 1
	`).get(sessionId) !== undefined;
}

function historyProviderIndex(database: Database.Database, source: NormalizationSource): number {
	const row = database.prepare(`
		SELECT COUNT(*) - 1 AS provider_index
		FROM history_items
		WHERE session_id = ? AND sequence_no <= ? AND (
			json_valid(payload_json) = 0
			OR CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.type') IN (
				'user_message', 'assistant_message', 'tool_call', 'tool_result'
			) ELSE 0 END
		)
	`).get(source.sessionId, source.sourceOrder) as { readonly provider_index: unknown };
	return Math.max(0, nonNegativeInteger(row.provider_index, "history provider index"));
}

function compactionOrdinal(database: Database.Database, source: NormalizationSource): number {
	const row = database.prepare(`
		SELECT COUNT(*) AS count FROM history_items
		WHERE session_id = ? AND sequence_no <= ?
		  AND CASE WHEN json_valid(payload_json)
			THEN json_extract(payload_json, '$.type') = 'compaction_boundary'
			ELSE 0 END
	`).get(source.sessionId, source.sourceOrder) as { readonly count: unknown };
	return nonNegativeInteger(row.count, "compaction ordinal");
}

function summaryOrdinal(database: Database.Database, source: NormalizationSource): number {
	const row = database.prepare(`
		SELECT COUNT(*) AS count FROM session_summaries
		WHERE session_id = ? AND summary_index <= ?
	`).get(source.sessionId, source.sourceOrder) as { readonly count: unknown };
	return nonNegativeInteger(row.count, "summary ordinal");
}

function userMergeKeys(
	turnId: string | undefined,
	clientId: string,
	queueId: string | undefined,
	text: string,
	occurrenceKey?: string,
): readonly string[] {
	return Object.freeze([
		`user-client:${clientId}`,
		...(queueId ? [`user-queue:${queueId}`] : []),
		...(turnId ? [`user-turn-text:${turnId}:${sha256(text)}`] : []),
		...(occurrenceKey ? [occurrenceKey] : []),
	]);
}

function userOccurrenceKey(
	database: Database.Database,
	source: NormalizationSource,
	text: string,
): string | undefined {
	return textOccurrenceKey(database, source, text, "user");
}

function assistantMergeKeys(
	turnId: string | undefined,
	responseId: string | undefined,
	text: string,
	occurrenceKey?: string,
): readonly string[] {
	return Object.freeze([
		...(responseId ? [`assistant-response:${responseId}`] : []),
		...(turnId ? [`assistant-turn-text:${turnId}:${sha256(text)}`] : []),
		...(occurrenceKey ? [occurrenceKey] : []),
	]);
}

function assistantOccurrenceKey(
	database: Database.Database,
	source: NormalizationSource,
	text: string,
): string | undefined {
	return textOccurrenceKey(database, source, text, "assistant");
}

function textOccurrenceKey(
	database: Database.Database,
	source: NormalizationSource,
	text: string,
	kind: "user" | "assistant",
): string | undefined {
	if (source.sourceKind !== "conversation_messages" && source.sourceKind !== "history_items") {
		return undefined;
	}
	const conversation = database.prepare(`
		SELECT COUNT(*) AS total_count,
		       COALESCE(SUM(CASE WHEN message_index <= ? THEN 1 ELSE 0 END), 0) AS through_count
		FROM conversation_messages
		WHERE session_id = ? AND CASE WHEN json_valid(payload_json) THEN
		  json_extract(payload_json, '$.role') = ?
		  AND json_extract(payload_json, '$.content') = ?
		  AND (? = 'user' OR COALESCE(
		    json_array_length(json_extract(payload_json, '$.tool_calls')), 0
		  ) = 0)
		ELSE 0 END
	`).get(
		source.sourceKind === "conversation_messages" ? source.sourceOrder : Number.MAX_SAFE_INTEGER,
		source.sessionId,
		kind,
		text,
		kind,
	) as { readonly total_count: unknown; readonly through_count: unknown };
	const history = database.prepare(`
		SELECT COUNT(*) AS total_count,
		       COALESCE(SUM(CASE WHEN sequence_no <= ? THEN 1 ELSE 0 END), 0) AS through_count
		FROM history_items
		WHERE session_id = ? AND CASE WHEN json_valid(payload_json) THEN
		  json_extract(payload_json, '$.type') = ?
		  AND json_extract(payload_json, '$.text') = ?
		ELSE 0 END
	`).get(
		source.sourceKind === "history_items" ? source.sourceOrder : Number.MAX_SAFE_INTEGER,
		source.sessionId,
		`${kind}_message`,
		text,
	) as { readonly total_count: unknown; readonly through_count: unknown };
	const conversationTotal = nonNegativeInteger(
		conversation.total_count,
		`${kind} conversation occurrence total`,
	);
	const historyTotal = nonNegativeInteger(history.total_count, `${kind} history occurrence total`);
	if (conversationTotal === 0 || conversationTotal !== historyTotal) return undefined;
	const occurrence = nonNegativeInteger(
		source.sourceKind === "conversation_messages"
			? conversation.through_count
			: history.through_count,
		`${kind} occurrence`,
	);
	return occurrence > 0
		? `${kind}-text-occurrence:${sha256(text)}:${occurrence}`
		: undefined;
}

function toolBatchMergeKeys(
	turnId: string | undefined,
	responseId: string | undefined,
	callIds: readonly string[],
): readonly string[] {
	return Object.freeze([
		...(responseId ? [`assistant-response:${responseId}`] : []),
		...callIds.map((callId) => `tool-call:${callId}`),
		...(turnId && callIds.length > 0 ? [`tool-batch-turn:${turnId}:${callIds[0]}`] : []),
	]);
}

function contextMergeKeys(sourceId: string, text: string, itemId?: string): readonly string[] {
	return Object.freeze([
		`context-source:${sourceId}`,
		...(itemId ? [`context-item:${itemId}`] : []),
		`context-text:${sha256(text)}`,
	]);
}

function primaryEventKey(keys: readonly string[], source: NormalizationSource): string {
	return keys[0] ?? `${source.sourceKind}:${source.sourceIdentity}`;
}

function semanticEventId(sessionId: string, identity: string): string {
	return `event:${sha256(stableJson([sessionId, identity]))}`;
}

function sourceOrderKey(source: NormalizationSource): string {
	return `${ORDER_PRIORITIES[source.sourceKind]}:${String(source.sourceOrder).padStart(20, "0")}:${String(
		source.sourceRowid,
	).padStart(20, "0")}`;
}

function lifecycleOrderKey(
	database: Database.Database,
	source: NormalizationSource,
	turnId: string,
	phase: "completed" | "failed" | "interrupted",
): string {
	const row = database.prepare(`
		SELECT order_key FROM transcript_normalization_events
		WHERE session_id = ? AND turn_id = ?
		ORDER BY order_key DESC, event_id DESC
		LIMIT 1
	`).get(source.sessionId, turnId) as { readonly order_key: unknown } | undefined;
	if (typeof row?.order_key !== "string" || !row.order_key) return sourceOrderKey(source);
	return `${row.order_key}:lifecycle:${phase}:${String(source.sourceRowid).padStart(20, "0")}`;
}

function storedPayload(event: TranscriptEventAppendInput): string {
	return stableJson({ schemaVersion: event.schemaVersion, payload: event.payload });
}

function eventHash(
	event: TranscriptEventAppendInput,
	providerIndex: number | undefined,
	orderKey: string,
): string {
	return sha256(stableJson({
		sessionId: event.sessionId,
		eventId: event.eventId,
		turnId: event.turnId ?? null,
		eventType: event.eventType,
		providerIndex: providerIndex ?? null,
		modelVisible: event.modelVisible,
		payload: event.payload,
		createdAt: event.createdAt,
		orderKey,
	}));
}

function compareCanonicalSources(left: StoredStagedEvent, right: StoredStagedEvent): number {
	if (left.canonicalSourcePriority !== right.canonicalSourcePriority) {
		return left.canonicalSourcePriority - right.canonicalSourcePriority;
	}
	const kind = left.canonicalSourceKind.localeCompare(right.canonicalSourceKind);
	return kind === 0 ? left.canonicalSourceRowid - right.canonicalSourceRowid : kind;
}

function compareOrderSources(left: StoredStagedEvent, right: StoredStagedEvent): number {
	if (left.orderSourcePriority !== right.orderSourcePriority) {
		return left.orderSourcePriority - right.orderSourcePriority;
	}
	return left.orderKey.localeCompare(right.orderKey);
}

function preferredCreatedAt(left: StoredStagedEvent, right: StoredStagedEvent): string {
	const order = compareOrderSources(left, right);
	return order <= 0 ? left.createdAt : right.createdAt;
}

function preferredText(primary: unknown, secondary: unknown): string {
	if (typeof primary === "string" && primary) return primary;
	return typeof secondary === "string" ? secondary : "";
}

function preferredSummary(primary: unknown, secondary: unknown): string {
	const left = typeof primary === "string" ? primary : "";
	const right = typeof secondary === "string" ? secondary : "";
	if (!left || / complete$/u.test(left)) return right || left;
	return left;
}

function mergeToolCalls(left: unknown, right: unknown): readonly TranscriptJsonValue[] {
	const calls = new Map<string, TranscriptJsonValue>();
	for (const value of [...arrayValue(left), ...arrayValue(right)]) {
		const call = recordValue(value);
		if (typeof call.callId === "string" && !calls.has(call.callId)) {
			calls.set(call.callId, jsonValue(call));
		}
	}
	return Object.freeze([...calls.values()]);
}

function providerUsage(value: unknown): ProviderUsage | undefined {
	if (!isRecord(value)) return undefined;
	const usage: Record<string, number> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "number" && Number.isFinite(item) && item >= 0) usage[key] = item;
	}
	return Object.keys(usage).length > 0 ? Object.freeze(usage) : undefined;
}

function lifecyclePhase(value: unknown): "completed" | "failed" | "interrupted" | undefined {
	if (value === "completed") return "completed";
	if (value === "failed") return "failed";
	if (value === "interrupted") return "interrupted";
	return undefined;
}

function userSource(value: unknown, queueId: string | undefined): "submit" | "steer" | "queued" | "agent_mailbox" | "task_notification" | "approval_resume" {
	if (value === "steer" || value === "queued" || value === "agent_mailbox"
		|| value === "task_notification" || value === "approval_resume") return value;
	return queueId ? "queued" : "submit";
}

function sourceTimestamp(
	payload: Readonly<Record<string, unknown>>,
	fallback: string,
): string {
	return optionalTimestamp(payload.created_at)
		?? optionalTimestamp(recordValue(payload.metadata).created_at)
		?? fallback;
}

function legacyReadableProjection(
	payload: Readonly<Record<string, unknown>>,
	canonical: CanonicalConversationItem,
	searchVisible?: boolean,
): TranscriptReadableProjection {
	const metadata = recordValue(payload.metadata);
	const itemId = optionalIdentity(payload.id);
	const createdAt = optionalTimestamp(metadata.created_at) ?? null;
	if (canonical.type !== "assistant_tool_calls") {
		return Object.freeze({
			hidden: false,
			...(searchVisible === undefined ? {} : { searchVisible }),
			...(itemId ? { itemId } : {}),
			createdAt,
		});
	}
	const toolCallItemIds = itemId
		? Object.freeze(Object.fromEntries(canonical.calls.map((call) => [call.callId, itemId])))
		: undefined;
	return Object.freeze({
		hidden: false,
		...(searchVisible === undefined ? {} : { searchVisible }),
		createdAt,
		assistantPreambleVisible: canonical.text.trim().length > 0
			&& metadata.source === "node_runtime",
		...(toolCallItemIds ? { toolCallItemIds } : {}),
	});
}

function jsonMetadata(
	metadata: Readonly<Record<string, unknown>>,
	omit: readonly string[],
): Readonly<{ readonly metadata?: Readonly<Record<string, TranscriptJsonValue>> }> {
	const excluded = new Set(omit);
	const entries = Object.entries(metadata).flatMap(([key, value]) => {
		if (excluded.has(key) || !isJsonValue(value)) return [];
		return [[key, jsonValue(value)] as const];
	});
	return entries.length > 0
		? Object.freeze({ metadata: Object.freeze(Object.fromEntries(entries)) })
		: Object.freeze({});
}

function jsonRecord(value: unknown): Readonly<Record<string, TranscriptJsonValue>> | undefined {
	if (!isRecord(value) || !isJsonValue(value)) return undefined;
	return jsonValue(value) as Readonly<Record<string, TranscriptJsonValue>>;
}

function jsonValue(value: unknown): TranscriptJsonValue {
	if (!isJsonValue(value)) throw new StorageFailure("legacy transcript JSON value is invalid");
	return JSON.parse(stableJson(value)) as TranscriptJsonValue;
}

function isJsonValue(value: unknown): value is TranscriptJsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isRecord(value) && Object.values(value).every(isJsonValue);
}

function parseStoredPayload(value: unknown): TranscriptJsonValue {
	const parsed = parseJson(value);
	if (!parsed.valid || !isRecord(parsed.value) || parsed.value.schemaVersion !== 1
		|| !isRecord(parsed.value.payload) || !isJsonValue(parsed.value.payload)) {
		throw new StorageFailure("staged transcript event payload is invalid");
	}
	return jsonValue(parsed.value.payload);
}

function parseJson(value: unknown): Readonly<{
	readonly valid: true;
	readonly value: unknown;
}> | Readonly<{ readonly valid: false }> {
	if (typeof value !== "string") return Object.freeze({ valid: false });
	try {
		return Object.freeze({ valid: true, value: JSON.parse(value) as unknown });
	} catch {
		return Object.freeze({ valid: false });
	}
}

export function assertV9TranscriptNormalizationFreeSpace(
	dbPath: string,
	probe: ((dbPath: string) => number) | undefined,
): void {
	let availableFreeBytes: number;
	try {
		if (probe) {
			availableFreeBytes = probe(dbPath);
		} else {
			const fileSystem = statfsSync(dirname(dbPath));
			availableFreeBytes = Math.min(
				Number.MAX_SAFE_INTEGER,
				Number(fileSystem.bavail) * Number(fileSystem.bsize),
			);
		}
	} catch {
		throw new StorageFailure("unable to determine transcript normalization free space");
	}
	if (!Number.isSafeInteger(availableFreeBytes) || availableFreeBytes < 0) {
		throw new StorageFailure("transcript normalization free space metric is invalid");
	}
	if (availableFreeBytes < V9_TRANSCRIPT_NORMALIZATION_MINIMUM_FREE_BYTES) {
		throw new StorageFailure("insufficient free space for transcript normalization", {
			required_free_bytes: V9_TRANSCRIPT_NORMALIZATION_MINIMUM_FREE_BYTES,
			available_free_bytes: availableFreeBytes,
		});
	}
}

function assertMappedSourceHashes(database: Database.Database, limit: number): void {
	const conflicts = database.prepare(`
		SELECT conflicts.source_kind, conflicts.source_rowid, conflicts.detected_operation,
		       mapped.source_hash
		FROM transcript_normalization_source_conflicts AS conflicts
		JOIN transcript_normalization_source_map AS mapped
		  ON mapped.source_kind = conflicts.source_kind
		 AND mapped.source_rowid = conflicts.source_rowid
		ORDER BY CASE conflicts.source_kind
			WHEN 'conversation_messages' THEN 0
			WHEN 'history_items' THEN 1
			WHEN 'turn_rollouts' THEN 2
			ELSE 3 END,
			conflicts.source_rowid
		LIMIT ?
	`).all(limit) as readonly {
		readonly source_kind: unknown;
		readonly source_rowid: unknown;
		readonly detected_operation: unknown;
		readonly source_hash: unknown;
	}[];
	for (const conflict of conflicts) {
		const sourceKind = legacySourceKind(conflict.source_kind);
		const sourceRowid = safeInteger(conflict.source_rowid, "conflict source rowid");
		const sourceHash = nonEmptyString(conflict.source_hash, "conflict source hash");
		const payload = currentSourcePayload(database, sourceKind, sourceRowid);
		if (payload !== undefined && sha256(payload) === sourceHash) {
			database.prepare(`
				DELETE FROM transcript_normalization_source_conflicts
				WHERE source_kind = ? AND source_rowid = ?
			`).run(sourceKind, sourceRowid);
			continue;
		}
		throw new StorageFailure("transcript normalization source changed after staging", {
			source_kind: sourceKind,
			source_operation: conflict.detected_operation === "delete" ? "delete" : "update",
		});
	}
}

function currentSourcePayload(
	database: Database.Database,
	sourceKind: TranscriptLegacySourceKind,
	sourceRowid: number,
): string | undefined {
	const definition = sourceKind === "conversation_messages"
		? { table: "conversation_messages", column: "payload_json" }
		: sourceKind === "history_items"
			? { table: "history_items", column: "payload_json" }
			: sourceKind === "turn_rollouts"
				? { table: "turn_rollouts", column: "payload_json" }
				: { table: "session_summaries", column: "summary_text" };
	const row = database.prepare(`
		SELECT ${definition.column} AS payload FROM ${definition.table} WHERE rowid = ?
	`).get(sourceRowid) as { readonly payload: unknown } | undefined;
	return typeof row?.payload === "string" ? row.payload : undefined;
}

function assertV9(database: Database.Database): void {
	const row = database.prepare("SELECT version FROM schema_version LIMIT 1").get() as {
		readonly version: unknown;
	} | undefined;
	const actual = typeof row?.version === "number" ? row.version : null;
	if (actual !== 9) {
		throw new StorageFailure("unsupported session schema version for transcript normalization", {
			expected_version: 9,
			actual_version: actual,
		});
	}
}

function assertStagingSchema(database: Database.Database): void {
	const expected: Readonly<Record<string, readonly string[]>> = Object.freeze({
		transcript_normalization_events: Object.freeze([
			"session_id", "event_id", "turn_id", "event_type", "provider_index",
			"model_visible", "payload_json", "created_at", "order_key",
			"order_source_priority", "canonical_source_kind", "canonical_source_rowid",
			"canonical_source_priority", "event_hash", "staging_schema_version",
		]),
		transcript_normalization_batches: Object.freeze([
			"batch_id", "started_at", "completed_at", "source_row_count", "event_count",
			"merged_source_row_count", "opaque_source_row_count", "first_source_kind",
			"first_source_rowid", "last_source_kind", "last_source_rowid",
			"schema_version_before", "schema_version_after", "staging_schema_version",
		]),
		transcript_normalization_source_map: Object.freeze([
			"source_kind", "source_rowid", "session_id", "source_order", "source_identity",
			"source_hash", "event_id", "disposition", "batch_id", "mapped_at",
			"staging_schema_version",
		]),
		transcript_normalization_merge_keys: Object.freeze([
			"session_id", "merge_key", "event_id", "staging_schema_version",
		]),
		transcript_normalization_source_conflicts: Object.freeze([
			"source_kind", "source_rowid", "detected_operation", "staging_schema_version",
		]),
	});
	for (const [table, columns] of Object.entries(expected)) {
		const actual = (database.prepare(`PRAGMA table_info(${table})`).all() as readonly {
			readonly name: unknown;
		}[]).map((row) => String(row.name));
		if (stableJson(actual) !== stableJson(columns)) {
			throw new StorageFailure("transcript normalization staging schema is incompatible");
		}
	}
}

function count(database: Database.Database, sql: string): number {
	const row = database.prepare(sql).get() as { readonly count: unknown };
	return nonNegativeInteger(row.count, "normalization count");
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
	}
	return value;
}

function safeInteger(value: unknown, label: string): number {
	const candidate = typeof value === "bigint" ? Number(value) : Number(value);
	if (!Number.isSafeInteger(candidate) || candidate < 0) {
		throw new StorageFailure(`${label} is invalid`);
	}
	return candidate;
}

function safeOptionalInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}

function nonNegativeInteger(value: unknown, label: string): number {
	const candidate = Number(value);
	if (!Number.isSafeInteger(candidate) || candidate < 0) {
		throw new StorageFailure(`${label} is invalid`);
	}
	return candidate;
}

function minimumDefined(left: number | undefined, right: number | undefined): number | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return Math.min(left, right);
}

function fallbackIdentity(source: NormalizationSource, label: string): string {
	return `legacy:${label}:${sha256(stableJson([
		source.sourceKind,
		source.sessionId,
		source.sourceOrder,
		source.sourceIdentity,
	])).slice(0, 32)}`;
}

function historyClientUserId(value: unknown): string | undefined {
	const id = optionalIdentity(value);
	if (!id) return undefined;
	const marker = ":user:";
	const index = id.indexOf(marker);
	return index >= 0 ? optionalIdentity(id.slice(index + marker.length)) : undefined;
}

function boundedSourceIdentity(value: unknown, sourceOrder: number): string {
	const identity = typeof value === "string" && value ? value : String(sourceOrder);
	return identity.length <= 512 ? identity : `sha256:${sha256(identity)}`;
}

function nonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value || value.includes("\0")) {
		throw new StorageFailure(`${label} is invalid`);
	}
	return value;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string") throw new StorageFailure(`${label} is invalid`);
	return value;
}

function optionalIdentity(value: unknown): string | undefined {
	return typeof value === "string" && value && value.length <= 512 && !value.includes("\0")
		? value
		: undefined;
}

function optionalTimestamp(value: unknown): string | undefined {
	return typeof value === "string" && value && value.length <= 100 ? value : undefined;
}

function timestamp(value: unknown): string {
	const result = optionalTimestamp(value);
	if (!result) throw new StorageFailure("normalization timestamp is invalid");
	return result;
}

function knownConversationRole(value: unknown): boolean {
	return value === "user" || value === "assistant" || value === "tool" || value === "context";
}

function legacySourceKind(value: unknown): TranscriptLegacySourceKind {
	if (value === "conversation_messages" || value === "history_items"
		|| value === "turn_rollouts" || value === "session_summaries") return value;
	throw new StorageFailure("legacy transcript source kind is invalid");
}

function transcriptEventType(value: unknown): TranscriptEventType {
	if (value === "user_input" || value === "assistant_output"
		|| value === "assistant_tool_call_batch" || value === "tool_result"
		|| value === "context" || value === "display_activity"
		|| value === "turn_lifecycle" || value === "rollback"
		|| value === "compaction" || value === "opaque_legacy") return value;
	throw new StorageFailure("staged transcript event type is invalid");
}

function stringArray(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return Object.freeze([]);
	const strings = value.flatMap((item) => optionalIdentity(item) ? [optionalIdentity(item)!] : []);
	return strings.length === value.length ? Object.freeze([...new Set(strings)]) : Object.freeze([]);
}

function arrayValue(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : Object.freeze([]);
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
	return isRecord(value) ? value : Object.freeze({});
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
	const digest = createHash("sha256").update(value).digest("hex");
	if (!HASH_PATTERN.test(digest)) throw new StorageFailure("normalization hash is invalid");
	return digest;
}

function utcTimestamp(): string {
	return new Date().toISOString();
}
