import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { CanonicalConversationItem } from "@mycli/core";
import {
	canonicalConversationItem,
	conversationSearchRole,
} from "./legacy-provider-projection.ts";
import {
	SCHEMA_V10_LEGACY_CLEANUP_SQL,
	SCHEMA_V10_LINEAGE_SQL,
	SCHEMA_V10_TRANSCRIPT_SQL,
	SCHEMA_V10_VERSION,
} from "./schema.ts";
import { StorageFailure } from "./session-store.ts";
import { stableJson } from "./stable-json.ts";
import {
	parseTranscriptEventEnvelope,
	type TranscriptEventEnvelope,
} from "./transcript-events.ts";
import { projectTranscriptEventsToProviderItems } from "./transcript-provider-projector.ts";
import { projectTranscriptEventsToReadableItems } from "./transcript-readable-projector.ts";
import { projectTranscriptEventToSearchDocument } from "./transcript-search-projector.ts";
import {
	assertV9TranscriptNormalizationFreeSpace,
	reconcileV9TranscriptNormalizationBatchInTransaction,
	V9_TRANSCRIPT_NORMALIZATION_STAGING_VERSION,
} from "./v9-normalization-staging.ts";
import {
	createV9ProviderLedgerManifest,
	projectV9Lineage,
	projectV9ProviderWindow,
	projectV9ReadableTranscript,
	projectV9RecoveryState,
	type V9ProviderLedgerManifest,
} from "./v9-projection-manifest.ts";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_BUSY_TIMEOUT_MS = 60_000;
const DEFAULT_TAIL_BATCH_SIZE = 10_000;
const MAX_TAIL_BATCH_SIZE = 10_000;
const NORMALIZATION_MANIFEST_VERSION = 1;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

const NORMALIZATION_MANIFEST_SQL = `
CREATE TABLE transcript_normalization_manifest (
    manifest_id INTEGER PRIMARY KEY CHECK (manifest_id = 1),
    manifest_version INTEGER NOT NULL CHECK (manifest_version = 1),
    source_schema_version INTEGER NOT NULL CHECK (source_schema_version = 9),
    target_schema_version INTEGER NOT NULL CHECK (target_schema_version = 10),
    source_row_count INTEGER NOT NULL,
    event_count INTEGER NOT NULL,
    provider_sha256 TEXT NOT NULL CHECK (length(provider_sha256) = 64),
    readable_sha256 TEXT NOT NULL CHECK (length(readable_sha256) = 64),
    search_sha256 TEXT NOT NULL CHECK (length(search_sha256) = 64),
    lineage_sha256 TEXT NOT NULL CHECK (length(lineage_sha256) = 64),
    recovery_sha256 TEXT NOT NULL CHECK (length(recovery_sha256) = 64),
    provider_ledger_sha256 TEXT NOT NULL CHECK (length(provider_ledger_sha256) = 64),
    completed_at TEXT NOT NULL
);
`;

const DROP_STAGING_SQL = `
DROP TABLE transcript_normalization_source_conflicts;
DROP TABLE transcript_normalization_source_map;
DROP TABLE transcript_normalization_merge_keys;
DROP TABLE transcript_normalization_batches;
DROP TABLE transcript_normalization_events;
`;

export const V9_TRANSCRIPT_NORMALIZATION_CUTOVER_STAGES = Object.freeze([
	"after_tail_reconciliation",
	"after_source_validation",
	"after_staging_manifest_validation",
	"after_lineage_schema",
	"after_compaction_links",
	"after_transcript_schema",
	"after_event_install",
	"after_lineage_migration",
	"after_checkpoint_migration",
	"after_fts_validation",
	"after_final_manifest_validation",
	"after_manifest_write",
	"after_legacy_cleanup",
	"after_staging_cleanup",
	"before_version_marker",
	"after_version_marker",
] as const);

export type V9TranscriptNormalizationCutoverStage =
	(typeof V9_TRANSCRIPT_NORMALIZATION_CUTOVER_STAGES)[number];

export interface ApplyV9TranscriptNormalizationCutoverOptions {
	readonly dbPath: string;
	readonly tailBatchSize?: number;
	readonly busyTimeoutMs?: number;
	readonly clock?: () => string;
	readonly freeSpaceProbe?: (dbPath: string) => number;
	readonly failpoint?: (stage: V9TranscriptNormalizationCutoverStage) => void;
}

export interface V9TranscriptNormalizationCutoverResult {
	readonly schemaVersion: typeof SCHEMA_V10_VERSION;
	readonly stagingSchemaVersion: typeof V9_TRANSCRIPT_NORMALIZATION_STAGING_VERSION;
	readonly tailBatchCount: number;
	readonly reconciledTailSourceRowCount: number;
	readonly totalSourceRowCount: number;
	readonly installedEventCount: number;
	readonly migratedLineageCount: number;
	readonly migratedCheckpointCount: number;
	readonly manifestSha256: string;
}

interface ProjectionDigest {
	readonly status: "ok" | "error";
	readonly recordCount?: number;
	readonly sha256?: string;
	readonly errorCode?: "persistence_error" | "session_state_invalid";
}

interface NormalizationManifest {
	readonly provider: readonly Readonly<{ readonly sessionKey: string; readonly digest: ProjectionDigest }>[];
	readonly readable: readonly Readonly<{ readonly sessionKey: string; readonly digest: ProjectionDigest }>[];
	readonly search: readonly Readonly<{ readonly sessionKey: string; readonly digest: ProjectionDigest }>[];
	readonly lineage: readonly Readonly<{ readonly sessionKey: string; readonly digest: ProjectionDigest }>[];
	readonly recovery: readonly Readonly<{ readonly sessionKey: string; readonly digest: ProjectionDigest }>[];
	readonly providerLedger: V9ProviderLedgerManifest;
}

interface StoredEventRow {
	readonly sequence_no?: unknown;
	readonly session_id: unknown;
	readonly event_id: unknown;
	readonly turn_id: unknown;
	readonly event_type: unknown;
	readonly provider_index: unknown;
	readonly model_visible: unknown;
	readonly payload_json: unknown;
	readonly created_at: unknown;
	readonly order_key?: unknown;
	readonly event_hash?: unknown;
}

interface LineageRow {
	readonly session_id: unknown;
	readonly parent_id: unknown;
	readonly fork_point: unknown;
}

interface LineageMigration {
	readonly sessionId: string;
	readonly parentId: string;
	readonly forkPoint: number;
	readonly forkEventSessionId?: string;
	readonly forkEventId?: string;
}

interface ProviderBoundary {
	readonly ownerSessionId: string;
	readonly event: TranscriptEventEnvelope;
}

export function applyV9TranscriptNormalizationCutover(
	options: ApplyV9TranscriptNormalizationCutoverOptions,
): V9TranscriptNormalizationCutoverResult {
	const tailBatchSize = boundedInteger(
		options.tailBatchSize ?? DEFAULT_TAIL_BATCH_SIZE,
		1,
		MAX_TAIL_BATCH_SIZE,
		"tailBatchSize",
	);
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
		throw cutoverError(error, "unable to open session storage for transcript normalization cutover");
	}

	try {
		database.exec("BEGIN IMMEDIATE");
		assertSingleV9Marker(database);
		let tailBatchCount = 0;
		let reconciledTailSourceRowCount = 0;
		for (;;) {
			const result = reconcileV9TranscriptNormalizationBatchInTransaction(database, {
				batchSize: tailBatchSize,
				clock,
			});
			if (result.batchId !== null) tailBatchCount += 1;
			reconciledTailSourceRowCount += result.selectedSourceRowCount;
			if (result.selectedSourceRowCount > 0) continue;
			if (result.excludedActiveSessionCount > 0) {
				throw new StorageFailure("active recovery sessions block transcript normalization cutover", {
					excluded_active_session_count: result.excludedActiveSessionCount,
				});
			}
			if (!result.complete) continue;
			break;
		}
		runFailpoint(options, "after_tail_reconciliation");

		const totalSourceRowCount = validateSourceCoverage(database);
		const sessionIds = sessionOrder(database);
		normalizeStagedProviderOnlyOrder(database, sessionIds);
		validateStagedEvents(database, sessionIds);
		runFailpoint(options, "after_source_validation");
		const legacyManifest = legacyNormalizationManifest(database, sessionIds);
		const stagedManifest = eventNormalizationManifest(database, sessionIds, "staging");
		assertManifestsEqual(legacyManifest, stagedManifest, "staging");
		runFailpoint(options, "after_staging_manifest_validation");

		database.exec(SCHEMA_V10_LINEAGE_SQL);
		runFailpoint(options, "after_lineage_schema");
		const lineage = prepareLineageMigration(database, sessionIds);
		linkCompactionSources(database, sessionIds);
		runFailpoint(options, "after_compaction_links");
		database.exec(SCHEMA_V10_TRANSCRIPT_SQL);
		runFailpoint(options, "after_transcript_schema");
		const installedEventCount = installTranscriptEvents(database, sessionIds, lineage);
		runFailpoint(options, "after_event_install");
		applyLineageMigration(database, lineage);
		runFailpoint(options, "after_lineage_migration");
		const migratedCheckpointCount = migrateCompactionCheckpoints(database);
		runFailpoint(options, "after_checkpoint_migration");
		validateInstalledTranscript(database, installedEventCount);
		runFailpoint(options, "after_fts_validation");
		const finalManifest = eventNormalizationManifest(database, sessionIds, "final");
		assertManifestsEqual(legacyManifest, finalManifest, "final");
		runFailpoint(options, "after_final_manifest_validation");

		const completedAt = timestamp(clock());
		database.exec(NORMALIZATION_MANIFEST_SQL);
		insertManifest(
			database,
			legacyManifest,
			totalSourceRowCount,
			installedEventCount,
			completedAt,
		);
		runFailpoint(options, "after_manifest_write");
		database.exec(SCHEMA_V10_LEGACY_CLEANUP_SQL);
		runFailpoint(options, "after_legacy_cleanup");
		database.exec(DROP_STAGING_SQL);
		runFailpoint(options, "after_staging_cleanup");
		runFailpoint(options, "before_version_marker");
		database.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_V10_VERSION);
		runFailpoint(options, "after_version_marker");
		database.exec("COMMIT");
		return Object.freeze({
			schemaVersion: SCHEMA_V10_VERSION,
			stagingSchemaVersion: V9_TRANSCRIPT_NORMALIZATION_STAGING_VERSION,
			tailBatchCount,
			reconciledTailSourceRowCount,
			totalSourceRowCount,
			installedEventCount,
			migratedLineageCount: lineage.length,
			migratedCheckpointCount,
			manifestSha256: digest(legacyManifest),
		});
	} catch (error) {
		if (database.inTransaction) database.exec("ROLLBACK");
		throw cutoverError(error, "v9 transcript normalization cutover failed");
	} finally {
		database.close();
	}
}

function runFailpoint(
	options: ApplyV9TranscriptNormalizationCutoverOptions,
	stage: V9TranscriptNormalizationCutoverStage,
): void {
	options.failpoint?.(stage);
}

function legacyNormalizationManifest(
	database: Database.Database,
	sessionIds: readonly string[],
): NormalizationManifest {
	const sessionSet = new Set(sessionIds);
	return manifestForSessions(database, sessionIds, {
		provider: (sessionId) => projectV9ProviderWindow(database, sessionId),
		readable: (sessionId) => projectV9ReadableTranscript(database, sessionId),
		search: (sessionId) => v9SearchDocuments(database, sessionId),
		lineage: (sessionId) => projectV9Lineage(database, sessionSet, sessionId),
		recovery: (sessionId) => normalizedRecovery(projectV9RecoveryState(database, sessionId)),
	});
}

function eventNormalizationManifest(
	database: Database.Database,
	sessionIds: readonly string[],
	source: "staging" | "final",
): NormalizationManifest {
	const sessionSet = new Set(sessionIds);
	return manifestForSessions(database, sessionIds, {
		provider: (sessionId) => providerProjection(eventProjection(database, sessionId, source)),
		readable: (sessionId) => projectTranscriptEventsToReadableItems(
			eventProjection(database, sessionId, source),
			{ limit: Number.MAX_SAFE_INTEGER },
		),
		search: (sessionId) => eventProjection(database, sessionId, source).flatMap((event) => {
			if (event.modelVisible && event.eventType === "opaque_legacy"
				&& event.payload.sourceKind === "conversation_messages") {
				throw new StorageFailure("opaque legacy search event is not projectable");
			}
			const document = projectTranscriptEventToSearchDocument(event);
			return document ? [document] : [];
		}),
		lineage: (sessionId) => projectV9Lineage(database, sessionSet, sessionId),
		recovery: (sessionId) => normalizedRecovery(projectV9RecoveryState(database, sessionId)),
	});
}

function manifestForSessions(
	database: Database.Database,
	sessionIds: readonly string[],
	projections: Readonly<{
		readonly provider: (sessionId: string) => readonly unknown[];
		readonly readable: (sessionId: string) => readonly unknown[];
		readonly search: (sessionId: string) => readonly unknown[];
		readonly lineage: (sessionId: string) => readonly unknown[];
		readonly recovery: (sessionId: string) => readonly unknown[];
	}>,
): NormalizationManifest {
	const projected = (operation: (sessionId: string) => readonly unknown[]) => Object.freeze(
		sessionIds.map((sessionId) => Object.freeze({
			sessionKey: sessionKey(sessionId),
			digest: projectionDigest(() => operation(sessionId)),
		})).sort((left, right) => left.sessionKey.localeCompare(right.sessionKey)),
	);
	return Object.freeze({
		provider: projected(projections.provider),
		readable: projected(projections.readable),
		search: projected(projections.search),
		lineage: projected(projections.lineage),
		recovery: projected(projections.recovery),
		providerLedger: createV9ProviderLedgerManifest(database),
	});
}

function projectionDigest(operation: () => readonly unknown[]): ProjectionDigest {
	try {
		const records = operation();
		return Object.freeze({ status: "ok", recordCount: records.length, sha256: digest(records) });
	} catch (error) {
		return Object.freeze({
			status: "error",
			errorCode: error instanceof StorageFailure
				&& error.diagnostics.state_key === "session_lineage"
				? "session_state_invalid"
				: "persistence_error",
		});
	}
}

function assertManifestsEqual(
	expected: NormalizationManifest,
	actual: NormalizationManifest,
	stage: "staging" | "final",
): void {
	for (const key of ["provider", "readable", "search", "lineage", "recovery"] as const) {
		if (stableJson(expected[key]) !== stableJson(actual[key])) {
			const mismatches = expected[key].flatMap((entry, index) => (
				stableJson(entry) === stableJson(actual[key][index]) ? [] : [index]
			));
			throw new StorageFailure("transcript normalization projection manifest mismatch", {
				projection: key,
				cutover_stage: stage,
				mismatch_count: mismatches.length,
				first_mismatch_index: mismatches[0] ?? null,
			});
		}
	}
	if (stableJson(expected.providerLedger) !== stableJson(actual.providerLedger)) {
		throw new StorageFailure("transcript normalization provider ledger manifest mismatch", {
			cutover_stage: stage,
		});
	}
}

function eventProjection(
	database: Database.Database,
	sessionId: string,
	source: "staging" | "final",
): readonly TranscriptEventEnvelope[] {
	if (source === "final") return finalLineageEvents(database, sessionId);
	return stagedEvents(database, sessionId);
}

function stagedEvents(database: Database.Database, sessionId: string): readonly TranscriptEventEnvelope[] {
	const rows = database.prepare(`
		SELECT session_id, event_id, turn_id, event_type, provider_index,
		       model_visible, payload_json, created_at, order_key, event_hash
		FROM transcript_normalization_events
		WHERE session_id = ?
		ORDER BY order_key, event_id
	`).all(sessionId) as readonly StoredEventRow[];
	return Object.freeze(rows.map((row, index) => eventFromRow(row, index + 1)));
}

function finalLocalEvents(database: Database.Database, sessionId: string): readonly TranscriptEventEnvelope[] {
	const rows = database.prepare(`
		SELECT sequence_no, session_id, event_id, turn_id, event_type,
		       provider_index, model_visible, payload_json, created_at
		FROM transcript_events WHERE session_id = ? ORDER BY sequence_no
	`).all(sessionId) as readonly StoredEventRow[];
	return Object.freeze(rows.map((row) => eventFromRow(row)));
}

function finalLineageEvents(
	database: Database.Database,
	sessionId: string,
	seen: ReadonlySet<string> = new Set<string>(),
): readonly TranscriptEventEnvelope[] {
	if (seen.has(sessionId) || seen.size >= 100) {
		throw new StorageFailure("persisted session lineage state is not usable", {
			state_key: "session_lineage",
		});
	}
	const row = database.prepare(`
		SELECT parent_id, fork_point, fork_event_session_id, fork_event_id
		FROM conversation_trees WHERE session_id = ?
	`).get(sessionId) as {
		readonly parent_id: unknown;
		readonly fork_point: unknown;
		readonly fork_event_session_id: unknown;
		readonly fork_event_id: unknown;
	} | undefined;
	const local = finalLocalEvents(database, sessionId);
	if (typeof row?.parent_id !== "string" || !row.parent_id) return local;
	const nextSeen = new Set(seen);
	nextSeen.add(sessionId);
	const parent = finalLineageEvents(database, row.parent_id, nextSeen);
	if (typeof row.fork_event_session_id !== "string" || !row.fork_event_session_id
		|| typeof row.fork_event_id !== "string" || !row.fork_event_id) {
		if (row.fork_point === 0) return local;
		throw new StorageFailure("persisted session lineage state is not usable", {
			state_key: "session_lineage",
		});
	}
	const boundary = parent.findIndex((event) => event.sessionId === row.fork_event_session_id
		&& event.eventId === row.fork_event_id);
	if (boundary < 0) {
		throw new StorageFailure("persisted session lineage state is not usable", {
			state_key: "session_lineage",
		});
	}
	return Object.freeze([...parent.slice(0, boundary + 1), ...local]);
}

function providerProjection(events: readonly TranscriptEventEnvelope[]): readonly CanonicalConversationItem[] {
	const compaction = [...events].reverse().find((event) => event.eventType === "compaction");
	if (compaction?.eventType !== "compaction") {
		return projectTranscriptEventsToProviderItems(events.filter((event) => event.modelVisible));
	}
	const source = compaction.payload.sourceEventId
		? events.find((event) => event.eventId === compaction.payload.sourceEventId)
		: events.find((event) => event.modelVisible
			&& event.providerIndex === compaction.payload.sourceProviderIndex);
	if (!source || !source.modelVisible || source.sequenceNo >= compaction.sequenceNo
		|| source.providerIndex !== compaction.payload.sourceProviderIndex) {
		throw new StorageFailure("compaction source event is invalid");
	}
	return projectTranscriptEventsToProviderItems(
		events.filter((event) => event.modelVisible && event.sequenceNo > compaction.sequenceNo),
		{ replacement: compaction.payload.replacement },
	);
}

function v9SearchDocuments(
	database: Database.Database,
	sessionId: string,
): readonly Readonly<{ readonly messageIndex: number; readonly role: string; readonly text: string }>[] {
	const rows = database.prepare(`
		SELECT message_index, payload_json FROM conversation_messages
		WHERE session_id = ? ORDER BY message_index
	`).all(sessionId) as readonly {
		readonly message_index: unknown;
		readonly payload_json: unknown;
	}[];
	return Object.freeze(rows.map((row) => {
		const item = canonicalConversationItem(row.payload_json, "conversation_messages");
		return Object.freeze({
			messageIndex: nonNegativeInteger(row.message_index, "message index"),
			role: conversationSearchRole(item),
			text: searchableItemText(item),
		});
	}));
}

function searchableItemText(item: CanonicalConversationItem): string {
	switch (item.type) {
		case "user":
		case "assistant":
		case "assistant_tool_calls":
		case "context": return item.text;
		case "tool_result": return item.output;
	}
}

function normalizedRecovery(rows: readonly unknown[]): readonly unknown[] {
	return Object.freeze(rows.map((value) => {
		if (!isRecord(value) || value.table !== "session_state" || !isRecord(value.row)
			|| value.row.state_key !== "compact_checkpoint"
			|| typeof value.row.payload_json !== "string") return value;
		const payload = parseRecordJson(value.row.payload_json, "compact_checkpoint");
		const semantic: Record<string, unknown> = { ...payload };
		delete semantic.replacement_messages;
		delete semantic.transcript_event_id;
		return Object.freeze({
			...value,
			row: Object.freeze({ ...value.row, payload_json: stableJson(semantic) }),
		});
	}));
}

function validateSourceCoverage(database: Database.Database): number {
	const sourceCount = count(database, `
		SELECT COUNT(*) AS count FROM (
			SELECT rowid FROM conversation_messages
			UNION ALL SELECT rowid FROM history_items
			UNION ALL SELECT rowid FROM turn_rollouts
			UNION ALL SELECT rowid FROM session_summaries
		)
	`);
	const mappedCount = count(database, "SELECT COUNT(*) AS count FROM transcript_normalization_source_map");
	if (sourceCount !== mappedCount) {
		throw new StorageFailure("transcript normalization source coverage is incomplete", {
			source_row_count: sourceCount,
			mapped_source_row_count: mappedCount,
		});
	}
	const rows = database.prepare(`
		SELECT mapped.source_kind, mapped.source_rowid, mapped.source_hash,
		       CASE mapped.source_kind
			 WHEN 'conversation_messages' THEN (
			   SELECT payload_json FROM conversation_messages WHERE rowid = mapped.source_rowid
			 )
			 WHEN 'history_items' THEN (
			   SELECT payload_json FROM history_items WHERE rowid = mapped.source_rowid
			 )
			 WHEN 'turn_rollouts' THEN (
			   SELECT payload_json FROM turn_rollouts WHERE rowid = mapped.source_rowid
			 )
			 ELSE (
			   SELECT summary_text FROM session_summaries WHERE rowid = mapped.source_rowid
			 ) END AS current_payload
		FROM transcript_normalization_source_map AS mapped
		ORDER BY mapped.source_kind, mapped.source_rowid
	`).iterate() as IterableIterator<{
		readonly source_kind: unknown;
		readonly source_rowid: unknown;
		readonly source_hash: unknown;
		readonly current_payload: unknown;
	}>;
	for (const row of rows) {
		if (typeof row.current_payload !== "string" || typeof row.source_hash !== "string"
			|| sha256(row.current_payload) !== row.source_hash) {
			throw new StorageFailure("transcript normalization source changed after staging", {
				source_kind: boundedSourceKind(row.source_kind),
				source_operation: "update",
			});
		}
	}
	return sourceCount;
}

function validateStagedEvents(database: Database.Database, sessionIds: readonly string[]): void {
	for (const [sessionOrdinal, sessionId] of sessionIds.entries()) {
		const requireProviderOrder = hasValidLegacyProviderProjection(database, sessionId);
		const rows = database.prepare(`
			SELECT session_id, event_id, turn_id, event_type, provider_index,
			       model_visible, payload_json, created_at, order_key, event_hash
			FROM transcript_normalization_events
			WHERE session_id = ? ORDER BY order_key, event_id
		`).all(sessionId) as readonly StoredEventRow[];
		let providerIndex = -1;
		for (const [index, row] of rows.entries()) {
			const event = eventFromRow(row, index + 1);
			if (event.modelVisible) {
				if (event.providerIndex === undefined
					|| (requireProviderOrder && event.providerIndex <= providerIndex)) {
					throw new StorageFailure("staged provider event order is invalid", {
						session_ordinal: sessionOrdinal,
						event_ordinal: index,
						previous_provider_index: providerIndex,
						current_provider_index: event.providerIndex ?? null,
						event_type: event.eventType,
					});
				}
				providerIndex = Math.max(providerIndex, event.providerIndex);
			}
			if (typeof row.order_key !== "string" || typeof row.event_hash !== "string"
				|| stagedEventHash(event, row.order_key) !== row.event_hash) {
				throw new StorageFailure("staged transcript event hash is invalid");
			}
		}
	}
}

function normalizeStagedProviderOnlyOrder(
	database: Database.Database,
	sessionIds: readonly string[],
): void {
	const update = database.prepare(`
		UPDATE transcript_normalization_events SET order_key = ?, event_hash = ?
		WHERE session_id = ? AND event_id = ?
	`);
	for (const sessionId of sessionIds) {
		if (!hasValidLegacyProviderProjection(database, sessionId)) continue;
		const rows = database.prepare(`
			SELECT session_id, event_id, turn_id, event_type, provider_index,
			       model_visible, payload_json, created_at, order_key, event_hash
			FROM transcript_normalization_events
			WHERE session_id = ? ORDER BY order_key, event_id
		`).all(sessionId) as readonly StoredEventRow[];
		const entries = rows.map((row, index) => Object.freeze({
			row,
			event: eventFromRow(row, index + 1),
		}));
		const providerOnly = entries.filter(({ event }) => isProviderOnlyEvent(event)).sort(
			(left, right) => requiredProviderIndex(left.event) - requiredProviderIndex(right.event),
		);
		if (providerOnly.length === 0) continue;
		const providerOnlyIds = new Set(providerOnly.map(({ event }) => event.eventId));
		const ordered = entries.filter(({ event }) => !providerOnlyIds.has(event.eventId));
		for (const entry of providerOnly) {
			const providerIndex = requiredProviderIndex(entry.event);
			const barrier = ordered.findIndex(({ event }) => providerOrderBarrier(event, providerIndex));
			ordered.splice(barrier < 0 ? ordered.length : barrier, 0, entry);
		}
		for (const [index, entry] of ordered.entries()) {
			const orderKey = `normalized:${String(index).padStart(20, "0")}`;
			if (entry.row.order_key === orderKey) continue;
			update.run(
				orderKey,
				stagedEventHash(entry.event, orderKey),
				sessionId,
				entry.event.eventId,
			);
		}
	}
}

function isProviderOnlyEvent(event: TranscriptEventEnvelope): boolean {
	if (!event.modelVisible || !("readableProjection" in event.payload)) return false;
	return event.payload.readableProjection?.hidden === true;
}

function requiredProviderIndex(event: TranscriptEventEnvelope): number {
	if (!event.modelVisible || event.providerIndex === undefined) {
		throw new StorageFailure("staged provider event has no provider index");
	}
	return event.providerIndex;
}

function providerOrderBarrier(event: TranscriptEventEnvelope, providerIndex: number): boolean {
	if (event.modelVisible && event.providerIndex !== undefined) {
		return event.providerIndex > providerIndex;
	}
	return event.eventType === "compaction"
		&& event.payload.sourceProviderIndex >= providerIndex;
}

function hasValidLegacyProviderProjection(
	database: Database.Database,
	sessionId: string,
): boolean {
	try {
		projectV9ProviderWindow(database, sessionId);
		return true;
	} catch {
		return false;
	}
}

function prepareLineageMigration(
	database: Database.Database,
	sessionIds: readonly string[],
): readonly LineageMigration[] {
	const rows = database.prepare(`
		SELECT session_id, parent_id, fork_point FROM conversation_trees
		WHERE parent_id IS NOT NULL ORDER BY session_id
	`).all() as readonly LineageRow[];
	const known = new Set(sessionIds);
	return Object.freeze(rows.map((row) => {
		const sessionId = identity(row.session_id, "lineage session id");
		const parentId = identity(row.parent_id, "lineage parent id");
		const forkPoint = nonNegativeInteger(row.fork_point, "lineage fork point");
		if (!known.has(sessionId) || !known.has(parentId)) {
			throw new StorageFailure("persisted session lineage state is not usable", {
				state_key: "session_lineage",
			});
		}
		const childProviderCount = count(database, `
			SELECT COUNT(*) AS count FROM transcript_normalization_events
			WHERE session_id = ? AND model_visible = 1
		`, sessionId);
		if (forkPoint > childProviderCount) {
			throw new StorageFailure("persisted session lineage state is not usable", {
				state_key: "session_lineage",
			});
		}
		if (forkPoint === 0) return Object.freeze({ sessionId, parentId, forkPoint });
		const providerBoundary = resolveProviderBoundary(database, parentId, forkPoint - 1);
		assertCompleteForkBoundary(database, parentId, forkPoint, providerBoundary);
		const boundary = terminalBoundary(database, providerBoundary);
		return Object.freeze({
			sessionId,
			parentId,
			forkPoint,
			forkEventSessionId: boundary.ownerSessionId,
			forkEventId: boundary.event.eventId,
		});
	}));
}

function resolveProviderBoundary(
	database: Database.Database,
	sessionId: string,
	providerIndex: number,
	seen: ReadonlySet<string> = new Set<string>(),
): ProviderBoundary {
	if (seen.has(sessionId) || seen.size >= 100) {
		throw new StorageFailure("persisted session lineage state is not usable", {
			state_key: "session_lineage",
		});
	}
	const lineage = database.prepare(`
		SELECT parent_id, fork_point FROM conversation_trees WHERE session_id = ?
	`).get(sessionId) as { readonly parent_id: unknown; readonly fork_point: unknown } | undefined;
	if (typeof lineage?.parent_id === "string" && lineage.parent_id
		&& Number.isSafeInteger(lineage.fork_point) && providerIndex < Number(lineage.fork_point)) {
		const nextSeen = new Set(seen);
		nextSeen.add(sessionId);
		return resolveProviderBoundary(database, lineage.parent_id, providerIndex, nextSeen);
	}
	const rows = database.prepare(`
		SELECT session_id, event_id, turn_id, event_type, provider_index,
		       model_visible, payload_json, created_at, order_key, event_hash
		FROM transcript_normalization_events
		WHERE session_id = ? AND provider_index = ?
	`).all(sessionId, providerIndex) as readonly StoredEventRow[];
	if (rows.length !== 1) {
		throw new StorageFailure("lineage fork provider boundary is invalid", {
			state_key: "session_lineage",
		});
	}
	return Object.freeze({
		ownerSessionId: sessionId,
		event: eventFromRow(rows[0]!, providerIndex + 1),
	});
}

function assertCompleteForkBoundary(
	database: Database.Database,
	materializedSessionId: string,
	forkPoint: number,
	boundary: ProviderBoundary,
): void {
	const direct = stagedEvents(database, materializedSessionId)
		.filter((event) => event.modelVisible && (event.providerIndex ?? -1) < forkPoint);
	const projected = projectTranscriptEventsToProviderItems(direct);
	const pending = new Set<string>();
	for (const item of projected) {
		if (item.type === "assistant_tool_calls") {
			for (const call of item.calls) pending.add(call.callId);
		} else if (item.type === "tool_result") {
			pending.delete(item.callId);
		}
	}
	if (pending.size > 0) {
		throw new StorageFailure("legacy fork point splits a turn or tool lifecycle", {
			state_key: "session_lineage",
		});
	}
	if (!boundary.event.turnId) return;
	const later = database.prepare(`
		SELECT 1 AS present FROM transcript_normalization_events
		WHERE session_id = ? AND turn_id = ? AND model_visible = 1 AND provider_index >= ?
		LIMIT 1
	`).get(materializedSessionId, boundary.event.turnId, forkPoint);
	if (later) {
		throw new StorageFailure("legacy fork point splits a turn or tool lifecycle", {
			state_key: "session_lineage",
		});
	}
}

function terminalBoundary(
	database: Database.Database,
	providerBoundary: ProviderBoundary,
): ProviderBoundary {
	if (!providerBoundary.event.turnId) return providerBoundary;
	const row = database.prepare(`
		SELECT session_id, event_id, turn_id, event_type, provider_index,
		       model_visible, payload_json, created_at, order_key, event_hash
		FROM transcript_normalization_events
		WHERE session_id = ? AND turn_id = ? AND event_type = 'turn_lifecycle'
		ORDER BY order_key DESC, event_id DESC LIMIT 1
	`).get(
		providerBoundary.ownerSessionId,
		providerBoundary.event.turnId,
	) as StoredEventRow | undefined;
	return row
		? Object.freeze({
			ownerSessionId: providerBoundary.ownerSessionId,
			event: eventFromRow(row, providerBoundary.event.sequenceNo + 1),
		})
		: providerBoundary;
}

function linkCompactionSources(database: Database.Database, sessionIds: readonly string[]): void {
	for (const sessionId of sessionIds) {
		const rows = database.prepare(`
			SELECT session_id, event_id, turn_id, event_type, provider_index,
			       model_visible, payload_json, created_at, order_key, event_hash
			FROM transcript_normalization_events
			WHERE session_id = ? AND event_type = 'compaction'
		`).all(sessionId) as readonly StoredEventRow[];
		for (const row of rows) {
			const event = eventFromRow(row, 1);
			if (event.eventType !== "compaction" || typeof row.order_key !== "string") {
				throw new StorageFailure("staged compaction event is invalid");
			}
			const source = resolveProviderBoundary(database, sessionId, event.payload.sourceProviderIndex);
			const payload = Object.freeze({ ...event.payload, sourceEventId: source.event.eventId });
			const payloadJson = stableJson({ schemaVersion: 1, payload });
			const linked = parseTranscriptEventEnvelope({ ...event, payload });
			database.prepare(`
				UPDATE transcript_normalization_events
				SET payload_json = ?, event_hash = ?
				WHERE session_id = ? AND event_id = ?
			`).run(
				payloadJson,
				stagedEventHash(linked, row.order_key),
				sessionId,
				event.eventId,
			);
		}
	}
}

function installTranscriptEvents(
	database: Database.Database,
	sessionIds: readonly string[],
	lineage: readonly LineageMigration[],
): number {
	const prefixes = new Map(lineage.map((entry) => [entry.sessionId, entry.forkPoint]));
	const insert = database.prepare(`
		INSERT INTO transcript_events (
			session_id, event_id, turn_id, event_type, provider_index,
			model_visible, payload_json, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`);
	let count = 0;
	for (const sessionId of sessionIds) {
		const forkPoint = prefixes.get(sessionId) ?? 0;
		const rows = database.prepare(`
			SELECT session_id, event_id, turn_id, event_type, provider_index,
			       model_visible, payload_json, created_at, order_key, event_hash
			FROM transcript_normalization_events
			WHERE session_id = ? ORDER BY order_key, event_id
		`).all(sessionId) as readonly StoredEventRow[];
		for (const row of rows) {
			if (forkPoint > 0 && row.model_visible === 1
				&& typeof row.provider_index === "number" && row.provider_index < forkPoint) continue;
			insert.run(
				row.session_id,
				row.event_id,
				row.turn_id,
				row.event_type,
				row.provider_index,
				row.model_visible,
				row.payload_json,
				row.created_at,
			);
			count += 1;
		}
	}
	return count;
}

function applyLineageMigration(
	database: Database.Database,
	lineage: readonly LineageMigration[],
): void {
	const update = database.prepare(`
		UPDATE conversation_trees
		SET fork_event_session_id = ?, fork_event_id = ?
		WHERE session_id = ? AND parent_id = ? AND fork_point = ?
	`);
	for (const entry of lineage) {
		const result = update.run(
			entry.forkEventSessionId ?? null,
			entry.forkEventId ?? null,
			entry.sessionId,
			entry.parentId,
			entry.forkPoint,
		);
		if (result.changes !== 1) {
			throw new StorageFailure("lineage migration target changed during cutover", {
				state_key: "session_lineage",
			});
		}
	}
}

function migrateCompactionCheckpoints(database: Database.Database): number {
	const rows = database.prepare(`
		SELECT session_id, payload_json FROM session_state
		WHERE state_key = 'compact_checkpoint' ORDER BY session_id
	`).all() as readonly { readonly session_id: unknown; readonly payload_json: unknown }[];
	const update = database.prepare(`
		UPDATE session_state SET payload_json = ?
		WHERE session_id = ? AND state_key = 'compact_checkpoint'
	`);
	for (const row of rows) {
		const sessionId = identity(row.session_id, "checkpoint session id");
		const checkpoint = parseRecordJson(row.payload_json, "compact_checkpoint");
		const windowId = identity(checkpoint.window_id, "checkpoint window id");
		const eventRows = database.prepare(`
			SELECT event_id, payload_json FROM transcript_events
			WHERE session_id = ? AND event_type = 'compaction'
			ORDER BY sequence_no
		`).all(sessionId) as readonly { readonly event_id: unknown; readonly payload_json: unknown }[];
		const event = eventRows.find((candidate) => {
			const stored = parseRecordJson(candidate.payload_json, "compaction event");
			return isRecord(stored.payload) && stored.payload.windowId === windowId;
		});
		if (!event || typeof event.event_id !== "string") {
			throw new StorageFailure("compact checkpoint transcript reference is invalid", {
				state_key: "compact_checkpoint",
			});
		}
		const storedEvent = parseRecordJson(event.payload_json, "compaction event");
		const compactionPayload = isRecord(storedEvent.payload) ? storedEvent.payload : {};
		if (!Array.isArray(checkpoint.replacement_messages)
			|| !Array.isArray(compactionPayload.replacement)) {
			throw new StorageFailure("compact checkpoint replacement is invalid", {
				state_key: "compact_checkpoint",
			});
		}
		let replacement: readonly CanonicalConversationItem[];
		try {
			replacement = Object.freeze(checkpoint.replacement_messages.map((item) => (
				canonicalConversationItem(stableJson(item), "compact_checkpoint")
			)));
		} catch {
			throw new StorageFailure("compact checkpoint replacement is invalid", {
				state_key: "compact_checkpoint",
			});
		}
		if (stableJson(replacement) !== stableJson(compactionPayload.replacement)) {
			throw new StorageFailure("compact checkpoint replacement does not match transcript event", {
				state_key: "compact_checkpoint",
			});
		}
		const state: Record<string, unknown> = { ...checkpoint };
		delete state.replacement_messages;
		delete state.transcript_event_id;
		update.run(stableJson({ ...state, transcript_event_id: event.event_id }), sessionId);
	}
	return rows.length;
}

function validateInstalledTranscript(database: Database.Database, expectedCount: number): void {
	const eventCount = count(database, "SELECT COUNT(*) AS count FROM transcript_events");
	if (eventCount !== expectedCount) throw new StorageFailure("installed transcript event count is invalid");
	const expectedSearchCount = count(database, `
		SELECT COUNT(*) AS count FROM transcript_events
		WHERE (model_visible = 1 AND event_type IN (
			'user_input', 'assistant_output', 'assistant_tool_call_batch', 'tool_result', 'context'
		) AND COALESCE(
			json_extract(payload_json, '$.payload.readableProjection.searchVisible'), 1
		) != 0) OR (
			model_visible = 1 AND event_type = 'opaque_legacy'
			AND json_extract(payload_json, '$.payload.sourceKind') = 'conversation_messages'
		)
	`);
	const ftsCount = count(database, "SELECT COUNT(*) AS count FROM transcript_events_fts_docsize");
	if (expectedSearchCount !== ftsCount) {
		throw new StorageFailure("transcript event search projection count is invalid");
	}
}

function assertSingleV9Marker(database: Database.Database): void {
	const row = database.prepare(`
		SELECT COUNT(*) AS count, MIN(version) AS minimum, MAX(version) AS maximum
		FROM schema_version
	`).get() as {
		readonly count: unknown;
		readonly minimum: unknown;
		readonly maximum: unknown;
	};
	if (row.count !== 1 || row.minimum !== 9 || row.maximum !== 9) {
		throw new StorageFailure("unsupported session schema version for transcript normalization", {
			expected_version: 9,
			actual_version: typeof row.minimum === "number" ? row.minimum : null,
		});
	}
}

function insertManifest(
	database: Database.Database,
	manifest: NormalizationManifest,
	sourceRowCount: number,
	eventCount: number,
	completedAt: string,
): void {
	database.prepare(`
		INSERT INTO transcript_normalization_manifest (
			manifest_id, manifest_version, source_schema_version, target_schema_version,
			source_row_count, event_count, provider_sha256, readable_sha256,
			search_sha256, lineage_sha256, recovery_sha256,
			provider_ledger_sha256, completed_at
		) VALUES (1, ?, 9, 10, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		NORMALIZATION_MANIFEST_VERSION,
		sourceRowCount,
		eventCount,
		digest(manifest.provider),
		digest(manifest.readable),
		digest(manifest.search),
		digest(manifest.lineage),
		digest(manifest.recovery),
		manifest.providerLedger.sha256,
		completedAt,
	);
}

function sessionOrder(database: Database.Database): readonly string[] {
	const rows = database.prepare(`
		SELECT sessions.session_id, trees.parent_id
		FROM sessions LEFT JOIN conversation_trees AS trees
		  ON trees.session_id = sessions.session_id
		ORDER BY sessions.session_id
	`).all() as readonly { readonly session_id: unknown; readonly parent_id: unknown }[];
	const parents = new Map<string, string | undefined>();
	for (const row of rows) {
		const sessionId = identity(row.session_id, "session id");
		parents.set(sessionId, typeof row.parent_id === "string" && row.parent_id
			? row.parent_id
			: undefined);
	}
	const depths = new Map<string, number>();
	const depth = (sessionId: string, seen: ReadonlySet<string> = new Set<string>()): number => {
		const known = depths.get(sessionId);
		if (known !== undefined) return known;
		if (seen.has(sessionId) || seen.size >= 100) {
			throw new StorageFailure("persisted session lineage state is not usable", {
				state_key: "session_lineage",
			});
		}
		const parent = parents.get(sessionId);
		if (!parent) {
			depths.set(sessionId, 0);
			return 0;
		}
		if (!parents.has(parent)) {
			throw new StorageFailure("persisted session lineage state is not usable", {
				state_key: "session_lineage",
			});
		}
		const nextSeen = new Set(seen);
		nextSeen.add(sessionId);
		const result = depth(parent, nextSeen) + 1;
		depths.set(sessionId, result);
		return result;
	};
	return Object.freeze([...parents.keys()].sort((left, right) => (
		depth(left) - depth(right) || left.localeCompare(right)
	)));
}

function eventFromRow(row: StoredEventRow, fallbackSequence?: number): TranscriptEventEnvelope {
	const stored = parseRecordJson(row.payload_json, "transcript event");
	const sequenceNo = Number.isSafeInteger(row.sequence_no)
		? Number(row.sequence_no)
		: fallbackSequence;
	if (!sequenceNo || sequenceNo < 1) throw new StorageFailure("transcript event sequence is invalid");
	return parseTranscriptEventEnvelope({
		schemaVersion: stored.schemaVersion,
		sequenceNo,
		sessionId: row.session_id,
		eventId: row.event_id,
		...(typeof row.turn_id === "string" && row.turn_id ? { turnId: row.turn_id } : {}),
		eventType: row.event_type,
		...(typeof row.provider_index === "number" ? { providerIndex: row.provider_index } : {}),
		modelVisible: row.model_visible === 1,
		createdAt: row.created_at,
		payload: stored.payload,
	});
}

function stagedEventHash(event: TranscriptEventEnvelope, orderKey: string): string {
	return sha256(stableJson({
		sessionId: event.sessionId,
		eventId: event.eventId,
		turnId: event.turnId ?? null,
		eventType: event.eventType,
		providerIndex: event.providerIndex ?? null,
		modelVisible: event.modelVisible,
		payload: event.payload,
		createdAt: event.createdAt,
		orderKey,
	}));
}

function parseRecordJson(value: unknown, source: string): Readonly<Record<string, unknown>> {
	try {
		const parsed = JSON.parse(String(value)) as unknown;
		if (!isRecord(parsed)) throw new Error("not an object");
		return Object.freeze(parsed);
	} catch {
		throw new StorageFailure(`invalid JSON in ${source}`);
	}
}

function count(database: Database.Database, sql: string, ...parameters: readonly unknown[]): number {
	const row = database.prepare(sql).get(...parameters) as { readonly count: unknown };
	return nonNegativeInteger(row.count, "normalization count");
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
	}
	return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
	const candidate = Number(value);
	if (!Number.isSafeInteger(candidate) || candidate < 0) {
		throw new StorageFailure(`${label} is invalid`);
	}
	return candidate;
}

function identity(value: unknown, label: string): string {
	if (typeof value !== "string" || !value || value.includes("\0") || value.length > 512) {
		throw new StorageFailure(`${label} is invalid`);
	}
	return value;
}

function timestamp(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 100) {
		throw new StorageFailure("normalization timestamp is invalid");
	}
	return value;
}

function boundedSourceKind(value: unknown): string {
	return value === "conversation_messages" || value === "history_items"
		|| value === "turn_rollouts" || value === "session_summaries"
		? value
		: "unknown";
}

function digest(value: unknown): string {
	return sha256(stableJson(value));
}

function sessionKey(sessionId: string): string {
	return sha256(`v10-normalization-manifest\0${sessionId}`);
}

function sha256(value: string): string {
	const result = createHash("sha256").update(value).digest("hex");
	if (!HASH_PATTERN.test(result)) throw new StorageFailure("normalization hash is invalid");
	return result;
}

function utcTimestamp(): string {
	return new Date().toISOString();
}

function cutoverError(error: unknown, fallback: string): Error {
	if (error instanceof StorageFailure || error instanceof RangeError) return error;
	const code = sqliteCode(error);
	if (code?.startsWith("SQLITE_BUSY") || code?.startsWith("SQLITE_LOCKED")) {
		return new StorageFailure("database is busy", { sqlite_code: code });
	}
	return new StorageFailure(fallback, { ...(code ? { sqlite_code: code } : {}) });
}

function sqliteCode(error: unknown): string | undefined {
	return isRecord(error) && typeof error.code === "string" ? error.code.slice(0, 64) : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
