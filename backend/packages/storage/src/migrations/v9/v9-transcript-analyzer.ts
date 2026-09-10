import { createHash } from "node:crypto";
import { statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { StorageFailure } from "../../sessions/session-store.ts";

const DEFAULT_LARGE_STRING_BYTES = 128;
const MINIMUM_LARGE_STRING_BYTES = 32;
const MAXIMUM_LARGE_STRING_BYTES = 1_048_576;
const MIGRATION_SQLITE_OVERHEAD_RATIO = 1.2;
const MIGRATION_WAL_MINIMUM_BYTES = 64 * 1024 * 1024;
const MIGRATION_SAFETY_BYTES = 16 * 1024 * 1024;
const DISPLAY_HISTORY_TYPES = new Set([
	"reasoning",
	"approval_request",
	"approval_resolution",
	"clarification_request",
	"clarification_response",
	"warning",
	"capability",
	"tool_exposure",
	"contributed_tool",
	"context_baseline_update",
	"compaction",
	"file_change",
	"plan_update",
	"command_result",
	"turn_rollback",
	"shell",
	"status",
	"tool_activation",
]);

export type V9TranscriptTableName =
	| "conversation_messages"
	| "history_items"
	| "turn_rollouts"
	| "session_summaries";

export type V9TranscriptLegacyShape =
	| "canonical_user"
	| "canonical_assistant"
	| "canonical_assistant_tool_batch"
	| "canonical_tool_result"
	| "canonical_context"
	| "provider_history"
	| "display_history"
	| "compaction_boundary"
	| "schema_v1_rollout"
	| "legacy_rollout_events"
	| "compacted_terminal_rollout"
	| "legacy_summary"
	| "unknown_json"
	| "invalid_shape"
	| "invalid_json";

export interface V9TranscriptTableMetrics {
	readonly table: V9TranscriptTableName;
	readonly rowCount: number;
	readonly payloadBytes: number;
}

export interface V9TranscriptLegacyShapeCount {
	readonly table: V9TranscriptTableName;
	readonly shape: V9TranscriptLegacyShape;
	readonly rowCount: number;
}

export interface V9TranscriptLargeContentMetrics {
	readonly minimumStringBytes: number;
	readonly occurrenceCount: number;
	readonly uniqueFingerprintCount: number;
	readonly duplicateBytes: number;
	readonly crossTableDuplicateBytes: number;
}

export interface V9TranscriptTurnAmplificationMetrics {
	readonly turnCount: number;
	readonly attributedRowCount: number;
	readonly unattributedRowCount: number;
	readonly persistedPayloadBytes: number;
	readonly estimatedCanonicalPayloadBytes: number;
	readonly duplicateLargeContentBytes: number;
	readonly writeAmplificationRatio: number;
	readonly maximumTurnWriteAmplificationRatio: number;
}

export interface V9TranscriptInvalidProjectionMetrics {
	readonly providerSessionCount: number;
	readonly readableSessionCount: number;
	readonly invalidConversationRowCount: number;
	readonly invalidHistoryRowCount: number;
	readonly invalidRolloutRowCount: number;
}

export interface V9TranscriptMigrationHeadroom {
	readonly estimatedNormalizedPayloadBytes: number;
	readonly estimatedStagingBytes: number;
	readonly estimatedWalBytes: number;
	readonly safetyBytes: number;
	readonly reusableFreelistBytes: number;
	readonly requiredFreeBytes: number;
	readonly availableFreeBytes: number | null;
	readonly sufficientFreeSpace: boolean | null;
}

export interface V9TranscriptStorageAnalysis {
	readonly schemaVersion: 9;
	readonly databaseBytes: number;
	readonly totalPayloadBytes: number;
	readonly tables: readonly V9TranscriptTableMetrics[];
	readonly largeContent: V9TranscriptLargeContentMetrics;
	readonly perTurn: V9TranscriptTurnAmplificationMetrics;
	readonly legacyShapes: readonly V9TranscriptLegacyShapeCount[];
	readonly invalidProjections: V9TranscriptInvalidProjectionMetrics;
	readonly migrationHeadroom: V9TranscriptMigrationHeadroom;
}

export interface AnalyzeV9TranscriptStorageOptions {
	readonly dbPath: string;
	readonly minimumLargeStringBytes?: number;
}

interface TranscriptRow {
	readonly session_id: unknown;
	readonly source_order: unknown;
	readonly source_turn_id: unknown;
	readonly payload_json: unknown;
}

interface FingerprintCount {
	readonly bytes: number;
	count: number;
	readonly tableCounts: Map<V9TranscriptTableName, number>;
}

interface TurnAccumulator {
	rowCount: number;
	persistedPayloadBytes: number;
	readonly fingerprints: Map<string, FingerprintCount>;
}

interface CompactionCandidate {
	readonly sequenceNo: number;
	readonly valid: boolean;
	readonly sourceMessageCount?: number;
}

const TABLES: readonly Readonly<{
	table: V9TranscriptTableName;
	payloadColumn: "payload_json" | "summary_text";
	orderColumn: "message_index" | "sequence_no" | "summary_index";
	turnColumn?: "turn_id";
}>[] = Object.freeze([
	{ table: "conversation_messages", payloadColumn: "payload_json", orderColumn: "message_index" },
	{ table: "history_items", payloadColumn: "payload_json", orderColumn: "sequence_no" },
	{
		table: "turn_rollouts",
		payloadColumn: "payload_json",
		orderColumn: "sequence_no",
		turnColumn: "turn_id",
	},
	{ table: "session_summaries", payloadColumn: "summary_text", orderColumn: "summary_index" },
]);

export function analyzeV9TranscriptStorage(
	options: AnalyzeV9TranscriptStorageOptions,
): V9TranscriptStorageAnalysis {
	const minimumStringBytes = boundedMinimumStringBytes(options.minimumLargeStringBytes);
	let database: Database.Database;
	try {
		database = new Database(options.dbPath, { readonly: true, fileMustExist: true });
		database.pragma("query_only = ON");
	} catch {
		throw new StorageFailure("unable to open session storage for read-only analysis");
	}

	try {
		assertV9Database(database);
		const globalFingerprints = new Map<string, FingerprintCount>();
		const turns = new Map<string, TurnAccumulator>();
		const tableMetrics: V9TranscriptTableMetrics[] = [];
		const shapes = new Map<string, number>();
		const providerFailures = new Set<string>();
		const readableFailures = new Set<string>();
		const conversationProjectionFailures = new Map<string, number[]>();
		const fallbackHistoryFailures = new Set<string>();
		const conversationCounts = new Map<string, number>();
		const latestCompactions = new Map<string, CompactionCandidate>();
		let invalidConversationRowCount = 0;
		let invalidHistoryRowCount = 0;
		let invalidRolloutRowCount = 0;
		let attributedRowCount = 0;
		let unattributedRowCount = 0;

		for (const definition of TABLES) {
			const table = definition.table;
			const metrics = tableMetric(database, definition);
			tableMetrics.push(metrics);
			const turnSelection = definition.turnColumn
				? `${definition.turnColumn} AS source_turn_id`
				: "NULL AS source_turn_id";
			const rows = database.prepare(`
				SELECT session_id,
				       ${definition.orderColumn} AS source_order,
				       ${turnSelection},
				       ${definition.payloadColumn} AS payload_json
				FROM ${table}
				ORDER BY ${definition.orderColumn}
			`).iterate() as IterableIterator<TranscriptRow>;
			for (const row of rows) {
				const sessionId = typeof row.session_id === "string" ? row.session_id : "";
				const sourceOrder = safeNonNegativeInteger(row.source_order);
				const payloadText = typeof row.payload_json === "string" ? row.payload_json : "";
				const payloadBytes = Buffer.byteLength(payloadText);
				if (table === "conversation_messages") {
					conversationCounts.set(sessionId, (conversationCounts.get(sessionId) ?? 0) + 1);
				}

				const parsed = table === "session_summaries"
					? { valid: true as const, value: payloadText }
					: parseJson(payloadText);
				const shape = legacyShape(table, parsed);
				incrementShape(shapes, table, shape);
				const turnId = parsed.valid
					? transcriptTurnId(table, parsed.value, row.source_turn_id)
					: typeof row.source_turn_id === "string" ? row.source_turn_id : undefined;
				const turn = turnId ? turnAccumulator(turns, turnId) : undefined;
				if (turn) {
					turn.rowCount += 1;
					turn.persistedPayloadBytes += payloadBytes;
					attributedRowCount += 1;
				} else {
					unattributedRowCount += 1;
				}
				if (parsed.valid) {
					collectLargeStrings(
						parsed.value,
						table,
						minimumStringBytes,
						globalFingerprints,
						turn?.fingerprints,
					);
				}

				if (table === "conversation_messages") {
					if (!parsed.valid || !validConversationPayload(parsed.value)) {
						invalidConversationRowCount += 1;
						appendFailureIndex(conversationProjectionFailures, sessionId, sourceOrder);
					}
					continue;
				}
				if (table === "history_items") {
					if (!parsed.valid || !isRecord(parsed.value)) {
						invalidHistoryRowCount += 1;
						readableFailures.add(sessionId);
						if (!parsed.valid) providerFailures.add(sessionId);
						continue;
					}
					if (parsed.value.type === "compaction_boundary") {
						const compaction = compactionCandidate(parsed.value, sourceOrder);
						const previous = latestCompactions.get(sessionId);
						if (!previous || previous.sequenceNo < compaction.sequenceNo) {
							latestCompactions.set(sessionId, compaction);
						}
					} else if (providerHistoryType(parsed.value.type)
						&& !validProviderHistoryPayload(parsed.value)) {
						fallbackHistoryFailures.add(sessionId);
					}
					continue;
				}
				if (table === "turn_rollouts" && (!parsed.valid || !isRecord(parsed.value))) {
					invalidRolloutRowCount += 1;
					readableFailures.add(sessionId);
				}
			}
		}

		for (const [sessionId, failures] of conversationProjectionFailures) {
			const compaction = latestCompactions.get(sessionId);
			const providerStart = compaction?.valid ? compaction.sourceMessageCount ?? 0 : 0;
			if (failures.some((messageIndex) => messageIndex >= providerStart)) {
				providerFailures.add(sessionId);
			}
		}
		for (const [sessionId, compaction] of latestCompactions) {
			if (!compaction.valid
				|| (compaction.sourceMessageCount ?? 0) > (conversationCounts.get(sessionId) ?? 0)) {
				providerFailures.add(sessionId);
			}
		}
		for (const sessionId of fallbackHistoryFailures) {
			if ((conversationCounts.get(sessionId) ?? 0) === 0 && !latestCompactions.has(sessionId)) {
				providerFailures.add(sessionId);
			}
		}

		const largeContent = largeContentMetrics(globalFingerprints, minimumStringBytes);
		const totalPayloadBytes = tableMetrics.reduce((total, metric) => total + metric.payloadBytes, 0);
		const perTurn = turnAmplificationMetrics(
			turns,
			attributedRowCount,
			unattributedRowCount,
		);
		const pageSize = pragmaNumber(database, "page_size");
		const freelistCount = pragmaNumber(database, "freelist_count");
		return Object.freeze({
			schemaVersion: 9,
			databaseBytes: statSync(options.dbPath).size,
			totalPayloadBytes,
			tables: Object.freeze(tableMetrics),
			largeContent,
			perTurn,
			legacyShapes: shapeCounts(shapes),
			invalidProjections: Object.freeze({
				providerSessionCount: providerFailures.size,
				readableSessionCount: readableFailures.size,
				invalidConversationRowCount,
				invalidHistoryRowCount,
				invalidRolloutRowCount,
			}),
			migrationHeadroom: migrationHeadroom(
				options.dbPath,
				totalPayloadBytes,
				largeContent.duplicateBytes,
				pageSize * freelistCount,
			),
		});
	} catch (error) {
		if (error instanceof StorageFailure) throw error;
		throw new StorageFailure("v9 transcript analysis failed");
	} finally {
		database.close();
	}
}

function assertV9Database(database: Database.Database): void {
	const version = database.prepare("SELECT version FROM schema_version LIMIT 1").get() as {
		readonly version: unknown;
	} | undefined;
	if (version?.version !== 9) {
		throw new StorageFailure("v9 transcript analysis requires schema version 9", {
			expected_version: 9,
			actual_version: typeof version?.version === "number" ? version.version : null,
		});
	}
	const required = new Set(TABLES.map((definition) => definition.table));
	for (const row of database.prepare(`
		SELECT name FROM sqlite_master WHERE type = 'table'
	`).all() as readonly { readonly name: unknown }[]) {
		if (typeof row.name === "string") required.delete(row.name as V9TranscriptTableName);
	}
	if (required.size > 0) throw new StorageFailure("v9 transcript storage is incomplete");
}

function tableMetric(
	database: Database.Database,
	definition: (typeof TABLES)[number],
): V9TranscriptTableMetrics {
	const row = database.prepare(`
		SELECT COUNT(*) AS row_count,
		       COALESCE(SUM(length(CAST(${definition.payloadColumn} AS BLOB))), 0) AS payload_bytes
		FROM ${definition.table}
	`).get() as { readonly row_count: unknown; readonly payload_bytes: unknown };
	return Object.freeze({
		table: definition.table,
		rowCount: safeNonNegativeInteger(row.row_count),
		payloadBytes: safeNonNegativeInteger(row.payload_bytes),
	});
}

function legacyShape(
	table: V9TranscriptTableName,
	parsed: Readonly<{ valid: boolean; value?: unknown }>,
): V9TranscriptLegacyShape {
	if (!parsed.valid) return "invalid_json";
	if (table === "session_summaries") return "legacy_summary";
	if (!isRecord(parsed.value)) return "invalid_shape";
	if (table === "conversation_messages") {
		if (parsed.value.role === "user") {
			return validConversationPayload(parsed.value) ? "canonical_user" : "invalid_shape";
		}
		if (parsed.value.role === "assistant") {
			if (!validConversationPayload(parsed.value)) return "invalid_shape";
			return Array.isArray(parsed.value.tool_calls) && parsed.value.tool_calls.length > 0
				? "canonical_assistant_tool_batch"
				: "canonical_assistant";
		}
		if (parsed.value.role === "tool") {
			return validConversationPayload(parsed.value) ? "canonical_tool_result" : "invalid_shape";
		}
		if (parsed.value.role === "context") {
			return validConversationPayload(parsed.value) ? "canonical_context" : "invalid_shape";
		}
		return "unknown_json";
	}
	if (table === "history_items") {
		if (parsed.value.type === "compaction_boundary") return "compaction_boundary";
		if (providerHistoryType(parsed.value.type)) return "provider_history";
		return typeof parsed.value.type === "string" && DISPLAY_HISTORY_TYPES.has(parsed.value.type)
			? "display_history"
			: "unknown_json";
	}
	if (parsed.value.schema_version === 1 && Array.isArray(parsed.value.events)) {
		return "schema_v1_rollout";
	}
	if (Array.isArray(parsed.value.events) && parsed.value.events.length > 0) {
		return "legacy_rollout_events";
	}
	if (Array.isArray(parsed.value.events) && parsed.value.events.length === 0
		&& terminalRolloutStatus(parsed.value.status)) {
		return "compacted_terminal_rollout";
	}
	return "unknown_json";
}

function validConversationPayload(value: unknown): boolean {
	if (!isRecord(value) || typeof value.content !== "string") return false;
	if (value.role === "user") {
		return value.blocks === undefined || validImageBlocks(value.blocks);
	}
	if (value.role === "assistant") {
		return (value.tool_calls === undefined || value.tool_calls === null
			|| validToolCalls(value.tool_calls)) && validPersistedProviderState(recordValue(value.metadata).provider_state);
	}
	if (value.role === "context") {
		return isRecord(recordValue(value.metadata).context);
	}
	return value.role === "tool" && typeof value.tool_call_id === "string" && Boolean(value.tool_call_id);
}

function validProviderHistoryPayload(value: Readonly<Record<string, unknown>>): boolean {
	if ((value.type === "user_message" || value.type === "assistant_message")
		&& typeof value.text === "string") return true;
	if (value.type === "skill_instructions") {
		return typeof value.text === "string" && isRecord(value.metadata);
	}
	if (value.type === "tool_call") {
		return typeof value.call_id === "string" && Boolean(value.call_id)
			&& typeof value.tool_name === "string" && Boolean(value.tool_name)
			&& isRecord(recordValue(value.metadata).arguments);
	}
	if (value.type === "tool_result") {
		const metadata = recordValue(value.metadata);
		return typeof value.call_id === "string" && Boolean(value.call_id)
			&& typeof value.tool_name === "string" && Boolean(value.tool_name)
			&& (typeof metadata.transcript_content === "string" || typeof value.text === "string");
	}
	return false;
}

function compactionCandidate(
	payload: Readonly<Record<string, unknown>>,
	sequenceNo: number,
): CompactionCandidate {
	const sourceMessageCount = safeOptionalNonNegativeInteger(payload.source_message_count);
	const replacement = payload.replacement_messages;
	const valid = sourceMessageCount !== undefined
		&& Array.isArray(replacement)
		&& replacement.length <= 4_096
		&& replacement.every(validConversationPayload);
	return Object.freeze({
		sequenceNo,
		valid,
		...(sourceMessageCount === undefined ? {} : { sourceMessageCount }),
	});
}

function validToolCalls(value: unknown): boolean {
	return Array.isArray(value) && value.every((raw) => {
		if (!isRecord(raw)) return false;
		return typeof raw.call_id === "string" && Boolean(raw.call_id)
			&& typeof raw.name === "string" && Boolean(raw.name)
			&& isRecord(raw.arguments);
	});
}

function validImageBlocks(value: unknown): boolean {
	return Array.isArray(value) && value.every((raw) => {
		if (!isRecord(raw) || raw.type !== "image") return true;
		return typeof raw.media_type === "string" && typeof raw.data === "string" && Boolean(raw.data);
	});
}

function validPersistedProviderState(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	return isRecord(value)
		&& typeof value.provider === "string"
		&& isRecord(value.value)
		&& (value.tokenEstimate === undefined
			|| typeof value.tokenEstimate === "number"
				&& Number.isSafeInteger(value.tokenEstimate)
				&& value.tokenEstimate >= 0);
}

function providerHistoryType(value: unknown): boolean {
	return value === "user_message"
		|| value === "assistant_message"
		|| value === "skill_instructions"
		|| value === "tool_call"
		|| value === "tool_result";
}

function transcriptTurnId(
	table: V9TranscriptTableName,
	value: unknown,
	sourceTurnId: unknown,
): string | undefined {
	if (table === "session_summaries") return undefined;
	if (table === "turn_rollouts" && typeof sourceTurnId === "string" && sourceTurnId) {
		return sourceTurnId;
	}
	if (!isRecord(value)) return undefined;
	if (typeof value.turn_id === "string" && value.turn_id) return value.turn_id;
	const metadata = recordValue(value.metadata);
	return typeof metadata.turn_id === "string" && metadata.turn_id ? metadata.turn_id : undefined;
}

function collectLargeStrings(
	value: unknown,
	table: V9TranscriptTableName,
	minimumBytes: number,
	global: Map<string, FingerprintCount>,
	turn: Map<string, FingerprintCount> | undefined,
): void {
	if (typeof value === "string") {
		const bytes = Buffer.byteLength(value);
		if (bytes < minimumBytes) return;
		const fingerprint = `${bytes}:${createHash("sha256").update(value).digest("hex")}`;
		incrementFingerprint(global, fingerprint, bytes, table);
		if (turn) incrementFingerprint(turn, fingerprint, bytes, table);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectLargeStrings(item, table, minimumBytes, global, turn);
		return;
	}
	if (!isRecord(value)) return;
	for (const item of Object.values(value)) {
		collectLargeStrings(item, table, minimumBytes, global, turn);
	}
}

function incrementFingerprint(
	counts: Map<string, FingerprintCount>,
	fingerprint: string,
	bytes: number,
	table: V9TranscriptTableName,
): void {
	const existing = counts.get(fingerprint);
	if (existing) {
		existing.count += 1;
		existing.tableCounts.set(table, (existing.tableCounts.get(table) ?? 0) + 1);
		return;
	}
	counts.set(fingerprint, {
		bytes,
		count: 1,
		tableCounts: new Map([[table, 1]]),
	});
}

function largeContentMetrics(
	fingerprints: ReadonlyMap<string, FingerprintCount>,
	minimumStringBytes: number,
): V9TranscriptLargeContentMetrics {
	let occurrences = 0;
	let duplicateBytes = 0;
	let crossTableDuplicateBytes = 0;
	for (const count of fingerprints.values()) {
		occurrences += count.count;
		duplicateBytes += count.bytes * Math.max(0, count.count - 1);
		const maximumInOneTable = Math.max(...count.tableCounts.values());
		crossTableDuplicateBytes += count.bytes * Math.max(0, count.count - maximumInOneTable);
	}
	return Object.freeze({
		minimumStringBytes,
		occurrenceCount: occurrences,
		uniqueFingerprintCount: fingerprints.size,
		duplicateBytes,
		crossTableDuplicateBytes,
	});
}

function turnAmplificationMetrics(
	turns: ReadonlyMap<string, TurnAccumulator>,
	attributedRowCount: number,
	unattributedRowCount: number,
): V9TranscriptTurnAmplificationMetrics {
	let persistedPayloadBytes = 0;
	let duplicateLargeContentBytes = 0;
	let maximumRatio = 1;
	for (const turn of turns.values()) {
		persistedPayloadBytes += turn.persistedPayloadBytes;
		const duplicates = duplicateFingerprintBytes(turn.fingerprints);
		duplicateLargeContentBytes += duplicates;
		maximumRatio = Math.max(
			maximumRatio,
			ratio(turn.persistedPayloadBytes, turn.persistedPayloadBytes - duplicates),
		);
	}
	const estimatedCanonicalPayloadBytes = Math.max(
		0,
		persistedPayloadBytes - duplicateLargeContentBytes,
	);
	return Object.freeze({
		turnCount: turns.size,
		attributedRowCount,
		unattributedRowCount,
		persistedPayloadBytes,
		estimatedCanonicalPayloadBytes,
		duplicateLargeContentBytes,
		writeAmplificationRatio: ratio(persistedPayloadBytes, estimatedCanonicalPayloadBytes),
		maximumTurnWriteAmplificationRatio: roundedRatio(maximumRatio),
	});
}

function migrationHeadroom(
	dbPath: string,
	totalPayloadBytes: number,
	duplicateBytes: number,
	reusableFreelistBytes: number,
): V9TranscriptMigrationHeadroom {
	const estimatedNormalizedPayloadBytes = Math.max(0, totalPayloadBytes - duplicateBytes);
	const estimatedStagingBytes = Math.ceil(
		estimatedNormalizedPayloadBytes * MIGRATION_SQLITE_OVERHEAD_RATIO,
	);
	const estimatedWalBytes = Math.max(
		MIGRATION_WAL_MINIMUM_BYTES,
		Math.ceil(estimatedStagingBytes * 0.25),
	);
	const requiredFreeBytes = Math.max(
		0,
		estimatedStagingBytes + estimatedWalBytes + MIGRATION_SAFETY_BYTES - reusableFreelistBytes,
	);
	const availableFreeBytes = filesystemFreeBytes(dbPath);
	return Object.freeze({
		estimatedNormalizedPayloadBytes,
		estimatedStagingBytes,
		estimatedWalBytes,
		safetyBytes: MIGRATION_SAFETY_BYTES,
		reusableFreelistBytes,
		requiredFreeBytes,
		availableFreeBytes,
		sufficientFreeSpace: availableFreeBytes === null ? null : availableFreeBytes >= requiredFreeBytes,
	});
}

function filesystemFreeBytes(dbPath: string): number | null {
	try {
		const stats = statfsSync(dirname(dbPath));
		return Number(stats.bavail) * Number(stats.bsize);
	} catch {
		return null;
	}
}

function turnAccumulator(turns: Map<string, TurnAccumulator>, turnId: string): TurnAccumulator {
	const existing = turns.get(turnId);
	if (existing) return existing;
	const created: TurnAccumulator = {
		rowCount: 0,
		persistedPayloadBytes: 0,
		fingerprints: new Map(),
	};
	turns.set(turnId, created);
	return created;
}

function shapeCounts(counts: ReadonlyMap<string, number>): readonly V9TranscriptLegacyShapeCount[] {
	const tableOrder = new Map(TABLES.map((definition, index) => [definition.table, index]));
	return Object.freeze([...counts.entries()].map(([key, rowCount]) => {
		const [table, shape] = key.split("\0") as [V9TranscriptTableName, V9TranscriptLegacyShape];
		return Object.freeze({ table, shape, rowCount });
	}).sort((left, right) => (
		(tableOrder.get(left.table) ?? 0) - (tableOrder.get(right.table) ?? 0)
		|| left.shape.localeCompare(right.shape)
	)));
}

function incrementShape(
	counts: Map<string, number>,
	table: V9TranscriptTableName,
	shape: V9TranscriptLegacyShape,
): void {
	const key = `${table}\0${shape}`;
	counts.set(key, (counts.get(key) ?? 0) + 1);
}

function appendFailureIndex(
	failures: Map<string, number[]>,
	sessionId: string,
	messageIndex: number,
): void {
	const current = failures.get(sessionId);
	if (current) current.push(messageIndex);
	else failures.set(sessionId, [messageIndex]);
}

function duplicateFingerprintBytes(fingerprints: ReadonlyMap<string, FingerprintCount>): number {
	let bytes = 0;
	for (const count of fingerprints.values()) bytes += count.bytes * Math.max(0, count.count - 1);
	return bytes;
}

function parseJson(value: string): Readonly<{ valid: true; value: unknown }> | Readonly<{ valid: false }> {
	try {
		return { valid: true, value: JSON.parse(value) as unknown };
	} catch {
		return { valid: false };
	}
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
	return isRecord(value) ? value : {};
}

function terminalRolloutStatus(value: unknown): boolean {
	return value === "completed" || value === "failed" || value === "interrupted";
}

function boundedMinimumStringBytes(value: number | undefined): number {
	const candidate = value ?? DEFAULT_LARGE_STRING_BYTES;
	if (!Number.isSafeInteger(candidate)
		|| candidate < MINIMUM_LARGE_STRING_BYTES
		|| candidate > MAXIMUM_LARGE_STRING_BYTES) {
		throw new RangeError(
			`minimumLargeStringBytes must be between ${MINIMUM_LARGE_STRING_BYTES} and ${MAXIMUM_LARGE_STRING_BYTES}`,
		);
	}
	return candidate;
}

function pragmaNumber(database: Database.Database, name: "page_size" | "freelist_count"): number {
	const row = database.pragma(name, { simple: true });
	return safeNonNegativeInteger(row);
}

function safeOptionalNonNegativeInteger(value: unknown): number | undefined {
	return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function safeNonNegativeInteger(value: unknown): number {
	return safeOptionalNonNegativeInteger(value) ?? 0;
}

function ratio(numerator: number, denominator: number): number {
	if (numerator === 0) return 1;
	if (denominator <= 0) return numerator;
	return roundedRatio(numerator / denominator);
}

function roundedRatio(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
