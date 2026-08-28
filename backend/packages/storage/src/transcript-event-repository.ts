import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
	parseRuntimeState,
	parseRuntimeTurnRecord,
	TURN_INTERRUPTED_NOTICE,
	turnCompletedDurationId,
	turnFailedNoticeId,
	turnFailureNotice,
	turnInterruptedNoticeId,
} from "@mycli/contracts";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import {
	selectAgentForkConversation,
	TOOL_RESULT_OUTPUT_MAX_CHARS,
	turnAbortedContextItem,
} from "@mycli/core";
import Database from "better-sqlite3";
import type {
	CanonicalConversationItem,
	CanonicalMessage,
	CanonicalToolCall,
	QueueSnapshot,
	QueuedInput,
	RuntimeErrorCode,
} from "@mycli/core";
import {
	SCHEMA_V2_SQL,
	SCHEMA_V5_SQL,
	SCHEMA_V6_SQL,
	SCHEMA_V7_SQL,
	SCHEMA_V8_SQL,
	SCHEMA_V10_SQL,
	SCHEMA_V10_VERSION,
	SCHEMA_V11_SQL,
	SCHEMA_V11_VERSION,
	SCHEMA_V12_SQL,
	SCHEMA_V12_VERSION,
	SESSION_RUNTIME_LEASE_SQL,
} from "./schema.ts";
import { runtimeErrorStopReason } from "./runtime-error-stop-reason.ts";
import {
	MessageIdConflictError,
	normalizeStoredTurnFailure,
	projectMutationMetadata,
	SessionInUseError,
	SessionStateError,
	StorageFailure,
} from "./session-store.ts";
import type {
	AppendAssistantToolCallsInput,
	AppendContextItemInput,
	AppendToolResultInput,
	ApprovalCheckpoint,
	ApprovalTransitionInput,
	CommitApprovalResultInput,
	CommitClarificationResponseInput,
	CommitCompactionInput,
	CommitQueuedInputsInput,
	CompleteStoredTurnInput,
	FailStoredTurnInput,
	FinalizeApprovalContinuationInput,
	ForkAgentConversationInput,
	ForkAgentConversationResult,
	ForkSessionInput,
	ForkSessionResult,
	InterruptAmbiguousApprovalInput,
	ImportLegacyConversationInput,
	ReserveTurnInput,
	RuntimeStateKey,
	SaveApprovalSuspensionInput,
	SaveClarificationSuspensionInput,
	SaveQueueSnapshotInput,
	SaveStateInput,
	SessionSearchQuery,
	SessionSearchResult,
	SessionContentBlobOrphanCleanupResult,
	SessionEmptyCleanupResult,
	SessionMaintenanceCandidate,
	SessionMaintenanceOptions,
	SessionMaintenanceReport,
	SessionOrphanCleanupResult,
	SessionPayloadCleanupResult,
	SessionStorageMetrics,
	SessionVacuumResult,
	SessionLineageNode,
	SessionLeaseStore,
	SessionListQuery,
	SessionOverview,
	TurnReservation,
} from "./session-store.ts";
import { ftsMatchQuery, searchSnippet } from "./session-search.ts";
import { canonicalConversationItem } from "./legacy-provider-projection.ts";
import { assertImagePathCount, canonicalImages } from "./canonical-images.ts";
import {
	parseTranscriptEventAppendInput,
	parseTranscriptEventEnvelope,
	type AppendTranscriptDisplayActivityInput,
	type TranscriptEventAppendInput,
	type TranscriptDisplayActivityType,
	type TranscriptEventEnvelope,
	type TranscriptJsonValue,
	type UserInputTranscriptPayload,
} from "./transcript-events.ts";
import { stableJson } from "./stable-json.ts";
import { SQLiteSessionStateRepository } from "./sqlite-session-state.ts";
import { SQLiteSubagentTaskRepository } from "./subagent-task-store.ts";
import type { SubagentTaskStore } from "./subagent-task-store.ts";
import { SQLiteAgentThreadRepository } from "./agent-thread-store.ts";
import type {
	AgentSpawnStore,
	AgentThreadStore,
	ReserveAgentSpawnInput,
} from "./agent-thread-store.ts";
import { SQLiteAgentMailboxRepository } from "./agent-mailbox-store.ts";
import type { AgentMailboxStore } from "./agent-mailbox-store.ts";
import { SQLiteModelInputLedger } from "./model-input-ledger.ts";
import type {
	ModelInputLedgerFailpoint,
	ModelInputLedgerStore,
} from "./model-input-ledger.ts";
import { SQLiteAgentEffectLedger } from "./agent-effect-ledger.ts";
import type { AgentEffectLedgerStore } from "./agent-effect-ledger.ts";
import { projectTranscriptEventsToProviderItems } from "./transcript-provider-projector.ts";
import { projectTranscriptEventsToReadableItems } from "./transcript-readable-projector.ts";
import { projectTranscriptEventToSearchDocument } from "./transcript-search-projector.ts";
import type { TranscriptItem } from "./transcript-projector.ts";
import {
	SESSION_CONTENT_BLOB_LOAD_MANY_MAX_IDS,
	SQLiteSessionContentBlobRepository,
} from "./session-content-blob-repository.ts";
import {
	externalizeTranscriptPayload,
	hydrateTranscriptPayload,
	type TranscriptPayloadBlobReference,
} from "./transcript-payload-blobs.ts";
import type { StoredSessionContentBlob } from "./session-content-blob.ts";
import {
	sanitizeShellSnapshotPayload,
	validateShellOutputChunk,
	validateShellOutputPageInput,
} from "./shell-transcript-store.ts";
import type {
	LoadShellOutputPageInput,
	ShellOutputChunk,
	ShellOutputPage,
	UpsertShellSnapshotInput,
} from "./shell-transcript-store.ts";

const DEFAULT_EVENT_WINDOW_LIMIT = 200;
const MAX_EVENT_WINDOW_LIMIT = 2_000;
const MAX_TURN_EVENT_LIMIT = 4_096;
const MAX_SOURCE_REFERENCE_COUNT = 500;
const RECENT_READABLE_RAW_EVENT_LIMIT = 2_000;
const RECENT_READABLE_ITEM_LIMIT = 500;
const READABLE_PAGE_RAW_WINDOW_SIZE = 2_000;
const READABLE_PAGE_MAX_ITEMS = 500;
const MAX_SHELL_OUTPUT_PAGE_ROWS = 257;
const TOOL_ACTIVATION_NAME = /^[A-Za-z0-9_]{1,128}$/u;
const MAX_TOOL_ACTIVATION_NAMES = 16;
const PLAN_STATUSES = new Set(["pending", "in_progress", "completed"]);
const COMPACTION_SUMMARY_MAX_CHARS = 131_072;
const INVALIDATED_RESPONSES_CONTINUATION = Object.freeze({
	response_id: null,
	request_signature: "",
	request_input: Object.freeze([]),
	response_output: Object.freeze([]),
	eligible: false,
	failure_reason: "compacted_history",
});
const RUNTIME_TURN_COLUMNS = `
session_id,
client_turn_id,
turn_id,
request_fingerprint,
status,
error_code,
result_json,
started_at,
completed_at,
owner_id,
owner_pid
`;

export interface TranscriptEventWindowOptions {
	readonly beforeSequence?: number;
	readonly afterSequence?: number;
	readonly limit?: number;
}

export interface TranscriptEventWindow {
	readonly events: readonly TranscriptEventEnvelope[];
	readonly hasMore: boolean;
}

export interface TranscriptTurnEventWindowOptions {
	readonly afterSequence?: number;
	readonly limit?: number;
}

export interface TranscriptReadablePageOptions {
	readonly beforeSequence?: number;
	readonly limit?: number;
}

export interface TranscriptReadablePage {
	readonly items: readonly TranscriptItem[];
	readonly nextBeforeSequence: number | null;
}

export interface TranscriptEventRepository extends SessionLeaseStore {
	appendEvent(input: TranscriptEventAppendInput): TranscriptEventEnvelope;
	reserveTurn(input: ReserveTurnInput): TurnReservation;
	loadTurn(sessionId: string, clientTurnId: string): RuntimeTurnRecord | undefined;
	loadConversation(sessionId: string): readonly CanonicalMessage[];
	appendAssistantToolCalls(input: AppendAssistantToolCallsInput): void;
	appendContextItem(input: AppendContextItemInput): void;
	appendToolResult(input: AppendToolResultInput): void;
	appendDisplayActivity(
		input: AppendTranscriptDisplayActivityInput,
	): TranscriptEventEnvelope<"display_activity">;
	completeTurn(input: CompleteStoredTurnInput): RuntimeTurnRecord;
	failTurn(input: FailStoredTurnInput): RuntimeTurnRecord;
	recoverInterruptedTurns(): number;
	recoverInterruptedTurn(
		sessionId: string,
		turnId: string,
		userInitiated?: boolean,
	): RuntimeTurnRecord | undefined;
	loadEvent(sessionId: string, eventId: string): TranscriptEventEnvelope | undefined;
	loadEventWindow(sessionId: string, options?: TranscriptEventWindowOptions): TranscriptEventWindow;
	loadTurnEventWindow(
		sessionId: string,
		turnId: string,
		options?: TranscriptTurnEventWindowOptions,
	): TranscriptEventWindow;
	loadLatestCompaction(sessionId: string): TranscriptEventEnvelope<"compaction"> | undefined;
	loadSourceEvents(
		sessionId: string,
		eventIds: readonly string[],
	): readonly TranscriptEventEnvelope[];
	loadConversationItems(sessionId: string): readonly CanonicalConversationItem[];
	listSessions(query?: SessionListQuery): readonly SessionOverview[];
	loadSession(sessionId: string): SessionOverview | undefined;
	loadSessionLineage(sessionId: string): readonly SessionLineageNode[];
	resolveResumeSessionId(sessionId: string): string;
	forkSession(input: ForkSessionInput): ForkSessionResult;
	forkAgentConversation(input: ForkAgentConversationInput): ForkAgentConversationResult;
	loadState(sessionId: string, key: RuntimeStateKey): unknown | undefined;
	saveState(input: SaveStateInput): void;
	saveQueueSnapshot(input: SaveQueueSnapshotInput): QueueSnapshot;
	deleteState(sessionId: string, key: RuntimeStateKey): void;
	loadCommittedQueueIds(sessionId: string): ReadonlySet<string>;
	commitQueuedInputs(input: CommitQueuedInputsInput): QueueSnapshot;
	compareAndSetApproval(input: ApprovalTransitionInput): ApprovalCheckpoint;
	saveApprovalSuspension(input: SaveApprovalSuspensionInput): ApprovalCheckpoint;
	saveClarificationSuspension(input: SaveClarificationSuspensionInput): void;
	commitClarificationResponse(input: CommitClarificationResponseInput): void;
	commitApprovalResult(input: CommitApprovalResultInput): ApprovalCheckpoint;
	finalizeApprovalContinuation(input: FinalizeApprovalContinuationInput): void;
	interruptAmbiguousApproval(input: InterruptAmbiguousApprovalInput): RuntimeTurnRecord;
	validateRecoveryReferences(sessionId: string): void;
	upsertShellSnapshot(input: UpsertShellSnapshotInput): void;
	loadShellOutputPage(input: LoadShellOutputPageInput): ShellOutputPage;
	loadHistoryItems(sessionId: string): readonly Readonly<Record<string, unknown>>[];
	loadSessionSummaries(sessionId: string): readonly string[];
	loadRecentSessionSummaries(sessionId: string, limit: number): readonly string[];
	loadTurnRollouts(sessionId: string): readonly Readonly<Record<string, unknown>>[];
	importLegacyConversation(input: ImportLegacyConversationInput): boolean;
	sessionMaintenanceReport(options?: SessionMaintenanceOptions): SessionMaintenanceReport;
	collectSessionContentBlobOrphans(): SessionContentBlobOrphanCleanupResult;
	cleanupLegacySessionPayloads(options?: SessionMaintenanceOptions): SessionPayloadCleanupResult;
	cleanupEmptySessions(options?: SessionMaintenanceOptions): SessionEmptyCleanupResult;
	cleanupOrphanedSessionRows(): SessionOrphanCleanupResult;
	vacuumSessionStorage(): SessionVacuumResult;
	commitCompaction(input: CommitCompactionInput): void;
	loadPendingToolCalls(sessionId: string, turnId: string): readonly CanonicalToolCall[];
	loadToolActivations(sessionId: string, turnId: string): readonly string[];
	loadContextItems(
		sessionId: string,
		turnId?: string,
	): readonly Extract<CanonicalConversationItem, { readonly type: "context" }>[];
	loadReadableTranscript(sessionId: string): readonly TranscriptItem[];
	hasTranscriptEvents(sessionId: string): boolean;
	loadRecentReadableTranscript(sessionId: string): readonly TranscriptItem[];
	loadReadableTranscriptPage(
		sessionId: string,
		options?: TranscriptReadablePageOptions,
	): TranscriptReadablePage;
	searchMessages(
		query: string,
		options?: SessionSearchQuery,
	): readonly SessionSearchResult[];
	rebuildSearchIndex(): void;
	close(): void;
}

export interface SQLiteTranscriptEventRepositoryOptions {
	readonly dbPath: string;
	readonly initializeSchemaVersion?:
		| typeof SCHEMA_V10_VERSION
		| typeof SCHEMA_V11_VERSION
		| typeof SCHEMA_V12_VERSION;
	readonly busyTimeoutMs?: number;
	readonly clock?: () => string;
	readonly ownerId?: string;
	readonly processId?: number;
	readonly isProcessAlive?: (processId: number) => boolean;
	readonly stateFailpoint?: (name: string) => void;
	readonly modelInputFailpoint?: (name: ModelInputLedgerFailpoint) => void;
}

interface TranscriptEventRow {
	readonly sequence_no: unknown;
	readonly session_id: unknown;
	readonly event_id: unknown;
	readonly turn_id: unknown;
	readonly event_type: unknown;
	readonly provider_index: unknown;
	readonly model_visible: unknown;
	readonly payload_json: unknown;
	readonly created_at: unknown;
}

interface TranscriptEventBlobReferenceRow {
	readonly sequence_no: unknown;
	readonly json_pointer: unknown;
	readonly blob_id: unknown;
}

interface RuntimeTurnRow {
	readonly session_id: unknown;
	readonly client_turn_id: unknown;
	readonly turn_id: unknown;
	readonly request_fingerprint: unknown;
	readonly status: unknown;
	readonly error_code: unknown;
	readonly result_json: unknown;
	readonly started_at: unknown;
	readonly completed_at: unknown;
	readonly owner_id: unknown;
	readonly owner_pid: unknown;
}

interface NormalizedSessionRow {
	readonly session_id: unknown;
	readonly workspace_root: unknown;
	readonly thread_id: unknown;
	readonly created_at: unknown;
	readonly updated_at: unknown;
	readonly last_active_at: unknown;
	readonly status: unknown;
}

interface ShellOutputChunkRow {
	readonly call_id: unknown;
	readonly event_sequence: unknown;
	readonly cursor_start: unknown;
	readonly cursor_end: unknown;
	readonly omitted_before: unknown;
	readonly output_text: unknown;
}

interface ShellOutputTotalsRow {
	readonly chunk_count: unknown;
	readonly first_cursor: unknown;
	readonly output_chars: unknown;
	readonly captured_chars: unknown;
	readonly omitted_chars: unknown;
	readonly call_id: unknown;
}

interface RollbackWindow {
	readonly markerSequence: number;
	readonly boundarySequence?: number;
	readonly removedTurnIds: ReadonlySet<string>;
}

interface NormalizedCompactionCheckpoint {
	readonly turnId: string;
	readonly reason: string;
	readonly phase: string;
	readonly windowNumber: number;
	readonly windowId: string;
	readonly historyItemCount: number;
	readonly inputHistoryHash: string;
	readonly replacementHistoryHash: string;
	readonly summaryRequestFingerprint: string;
	readonly updatedAt: string;
	readonly metadata: Readonly<Record<string, TranscriptJsonValue>>;
}

interface LineageLink {
	readonly sessionId: string;
	readonly parentId?: string;
	readonly forkPoint?: number;
	readonly forkEventSessionId?: string;
	readonly forkEventId?: string;
}

interface LineageEventSegment {
	readonly sessionId: string;
	readonly maxSequence?: number;
}

interface SearchVisibility {
	readonly sessionId: string;
	readonly lastActiveAt: string;
	readonly segments: readonly LineageEventSegment[];
}

export class SQLiteTranscriptEventRepository implements TranscriptEventRepository {
	readonly agentEffectLedger: AgentEffectLedgerStore;
	readonly agentMailbox: AgentMailboxStore;
	readonly agentSpawns: AgentSpawnStore;
	readonly agentThreads: AgentThreadStore;
	readonly modelInputLedger: ModelInputLedgerStore;
	readonly subagentTasks: SubagentTaskStore;
	readonly #database: Database.Database;
	readonly #clock: () => string;
	readonly #ownerId: string;
	readonly #processId: number;
	readonly #isProcessAlive: (processId: number) => boolean;
	readonly #stateRepository: SQLiteSessionStateRepository;
	readonly #contentBlobs: SQLiteSessionContentBlobRepository;
	readonly #dbPath: string;
	readonly #schemaVersion:
		| typeof SCHEMA_V10_VERSION
		| typeof SCHEMA_V11_VERSION
		| typeof SCHEMA_V12_VERSION;
	#closed = false;

	constructor(options: SQLiteTranscriptEventRepositoryOptions) {
		this.#dbPath = options.dbPath;
		this.#clock = options.clock ?? utcTimestamp;
		this.#ownerId = options.ownerId ?? randomUUID();
		this.#processId = options.processId ?? process.pid;
		this.#isProcessAlive = options.isProcessAlive ?? processIsAlive;
		mkdirSync(dirname(options.dbPath), { recursive: true, mode: 0o700 });
		this.#database = new Database(options.dbPath);
		try {
			this.#configure(options.busyTimeoutMs ?? 1_000);
			const version = schemaVersion(this.#database);
			if (version.kind === "empty") {
				this.#schemaVersion = options.initializeSchemaVersion ?? SCHEMA_V10_VERSION;
				initializeTranscriptSchema(this.#database, this.#schemaVersion);
			} else if (version.kind === "version") {
				this.#schemaVersion = transcriptSchemaVersion(version.value);
			} else {
				throw new StorageFailure("session schema version marker is invalid");
			}
			this.#database.exec(SESSION_RUNTIME_LEASE_SQL);
			this.#reconcileStaleSessionRuntimeLeases();
			this.#contentBlobs = new SQLiteSessionContentBlobRepository({
				database: this.#database,
				clock: this.#clock,
				write: <Result>(operation: () => Result) => this.#write(operation),
			});
			this.#stateRepository = new SQLiteSessionStateRepository({
				database: this.#database,
				clock: this.#clock,
				write: <Result>(operation: () => Result) => this.#write(operation),
				...(options.stateFailpoint ? { failpoint: options.stateFailpoint } : {}),
				transcriptAdapter: {
					loadCommittedQueueIds: (sessionId) => this.#committedQueueIds(sessionId),
					appendQueuedInput: ({ sessionId, turnId, record, images }) => {
						this.#insertEvent(parseTranscriptEventAppendInput({
							schemaVersion: 1,
							sessionId,
							eventId: semanticEventId(turnId, "queued-user", record.queueId),
							turnId,
							eventType: "user_input",
							modelVisible: true,
							createdAt: record.updatedAt,
							payload: {
								text: record.text,
								clientUserMessageId: record.clientTurnId,
								queueId: record.queueId,
								source: queuedInputSource(record),
								...(images.length > 0 ? { images } : {}),
							},
						}));
					},
				},
			});
			this.subagentTasks = new SQLiteSubagentTaskRepository({
				database: this.#database,
				clock: this.#clock,
				write: <Result>(operation: () => Result) => this.#write(operation),
			});
			this.agentThreads = new SQLiteAgentThreadRepository({
				database: this.#database,
				clock: this.#clock,
				write: <Result>(operation: () => Result) => this.#write(operation),
				isProcessAlive: this.#isProcessAlive,
			});
			this.agentSpawns = Object.freeze({
				reserve: (input: ReserveAgentSpawnInput) => this.#write(() => Object.freeze({
					thread: this.agentThreads.reserve(input.thread),
					task: this.subagentTasks.reserve(input.task),
				})),
			});
			this.agentMailbox = new SQLiteAgentMailboxRepository({
				database: this.#database,
				clock: this.#clock,
				write: <Result>(operation: () => Result) => this.#write(operation),
			});
			this.modelInputLedger = new SQLiteModelInputLedger({
				database: this.#database,
				write: <Result>(operation: () => Result) => this.#write(operation),
				...(usesContentBlobs(this.#schemaVersion)
					? { contentBlobs: this.#contentBlobs }
					: {}),
				requestStorage: this.#schemaVersion === SCHEMA_V12_VERSION ? "timeline" : "blob",
				...(options.modelInputFailpoint ? { failpoint: options.modelInputFailpoint } : {}),
			});
			this.agentEffectLedger = new SQLiteAgentEffectLedger({
				database: this.#database,
				write: <Result>(operation: () => Result) => this.#write(operation),
			});
			this.agentThreads.projectLegacyTasks();
			this.agentThreads.reconcileStaleRuntimes("agent runtime owner unavailable after restart");
			this.recoverInterruptedTurns();
		} catch (error) {
			this.#database.close();
			throw storageError(error);
		}
	}

	acquireSessionLease(sessionId: string): boolean {
		try {
			const normalizedSessionId = identity(sessionId, "sessionId");
			return this.#write(() => this.#acquireSessionLeaseRecord(normalizedSessionId));
		} catch (error) {
			throw storageError(error);
		}
	}

	releaseSessionLease(sessionId: string): void {
		try {
			const normalizedSessionId = identity(sessionId, "sessionId");
			this.#write(() => {
				this.#database.prepare(`
					DELETE FROM session_runtime_leases
					WHERE session_id = ? AND owner_id = ?
				`).run(normalizedSessionId, this.#ownerId);
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	appendEvent(input: TranscriptEventAppendInput): TranscriptEventEnvelope {
		try {
			const normalized = parseTranscriptEventAppendInput(input);
			return this.#write(() => this.#insertEvent(normalized));
		} catch (error) {
			throw storageError(error);
		}
	}

	reserveTurn(input: ReserveTurnInput): TurnReservation {
		try {
			const initial = parseRuntimeTurnRecord({
				schema_version: 1,
				session_id: input.sessionId,
				client_turn_id: input.clientTurnId,
				turn_id: input.turnId,
				request_fingerprint: input.requestFingerprint,
				status: "in_progress",
				error_code: null,
				result: null,
				started_at: input.startedAt,
				completed_at: null,
			});
			return this.#write<TurnReservation>(() => {
				const existing = this.#loadTurn(input.sessionId, input.clientTurnId);
				if (existing) {
					if (existing.request_fingerprint !== input.requestFingerprint) {
						throw new MessageIdConflictError();
					}
					return Object.freeze({ kind: "existing", turn: existing });
				}
				this.#touchSession(input);
				this.#insertRuntimeTurn(initial);
				if (input.source !== "agent_mailbox") {
					const images = canonicalImages(input.images ?? [], "reserved user message");
					assertImagePathCount(input.imagePaths ?? [], images);
					this.#insertEvent(parseTranscriptEventAppendInput({
						schemaVersion: 1,
						sessionId: input.sessionId,
						eventId: semanticEventId(input.turnId, "user", input.clientUserMessageId),
						turnId: input.turnId,
						eventType: "user_input",
						modelVisible: true,
						createdAt: input.startedAt,
						payload: {
							text: input.userText,
							clientUserMessageId: input.clientUserMessageId,
							source: "submit",
							...(images.length > 0 ? { images } : {}),
						},
					}));
				}
				return Object.freeze({ kind: "reserved", turn: initial });
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	loadTurn(sessionId: string, clientTurnId: string): RuntimeTurnRecord | undefined {
		try {
			return this.#loadTurn(
				identity(sessionId, "sessionId"),
				identity(clientTurnId, "clientTurnId"),
			);
		} catch (error) {
			throw storageError(error);
		}
	}

	loadConversation(sessionId: string): readonly CanonicalMessage[] {
		return Object.freeze(this.loadConversationItems(sessionId).flatMap((item): CanonicalMessage[] => {
			if (item.type === "user") return [{ role: "user", content: item.text }];
			if (item.type === "assistant") return [{ role: "assistant", content: item.text }];
			if (item.type === "assistant_tool_calls" && item.text) {
				return [{ role: "assistant", content: item.text }];
			}
			return [];
		}));
	}

	listSessions(query: SessionListQuery = {}): readonly SessionOverview[] {
		try {
			const limit = query.limit ?? 20;
			const offset = query.offset ?? 0;
			if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1_000) {
				throw new RangeError("session list limit must be between 0 and 1000");
			}
			if (!Number.isSafeInteger(offset) || offset < 0) {
				throw new RangeError("session list offset must be a non-negative safe integer");
			}
			const workspaceRoot = query.workspaceRoot?.trim();
			const rows = this.#database.prepare(`
				SELECT session_id, workspace_root, thread_id, created_at,
				       updated_at, last_active_at, status
				FROM sessions
				${workspaceRoot ? "WHERE workspace_root = ?" : ""}
				ORDER BY last_active_at DESC, session_id DESC
				LIMIT ? OFFSET ?
			`).all(...(
				workspaceRoot ? [workspaceRoot, limit, offset] : [limit, offset]
			)) as readonly NormalizedSessionRow[];
			return Object.freeze(rows.map((row) => this.#sessionOverview(row)));
		} catch (error) {
			throw storageError(error);
		}
	}

	loadSession(sessionId: string): SessionOverview | undefined {
		try {
			const row = this.#database.prepare(`
				SELECT session_id, workspace_root, thread_id, created_at,
				       updated_at, last_active_at, status
				FROM sessions WHERE session_id = ?
			`).get(identity(sessionId, "sessionId")) as NormalizedSessionRow | undefined;
			return row ? this.#sessionOverview(row) : undefined;
		} catch (error) {
			throw storageError(error);
		}
	}

	loadSessionLineage(sessionId: string): readonly SessionLineageNode[] {
		try {
			const lineage: SessionLineageNode[] = [];
			const seen = new Set<string>();
			let current = identity(sessionId, "sessionId");
			for (let depth = 0; depth < 100; depth += 1) {
				if (seen.has(current)) throw new StorageFailure("session lineage contains a cycle");
				seen.add(current);
				const link = this.#lineageLink(current, true);
				lineage.push(Object.freeze({
					sessionId: link.sessionId,
					...(link.parentId ? { parentId: link.parentId } : {}),
					...(link.forkPoint === undefined ? {} : { forkPoint: link.forkPoint }),
					...(link.forkEventSessionId
						? { forkEventSessionId: link.forkEventSessionId }
						: {}),
					...(link.forkEventId ? { forkEventId: link.forkEventId } : {}),
				}));
				if (!link.parentId) return Object.freeze(lineage.reverse());
				current = link.parentId;
			}
			throw new StorageFailure("session lineage exceeds depth limit");
		} catch (error) {
			throw storageError(error);
		}
	}

	resolveResumeSessionId(sessionId: string): string {
		try {
			let current = identity(sessionId, "sessionId");
			if (!this.#sessionExists(current)) throw new StorageFailure("session does not exist");
			const seen = new Set<string>();
			for (let depth = 0; depth < 100; depth += 1) {
				if (seen.has(current)) throw new StorageFailure("session lineage contains a cycle");
				seen.add(current);
				const child = this.#database.prepare(`
					SELECT trees.session_id
					FROM conversation_trees AS trees
					JOIN sessions ON sessions.session_id = trees.session_id
					WHERE trees.parent_id = ?
					ORDER BY sessions.last_active_at DESC, sessions.updated_at DESC,
					         trees.session_id DESC
					LIMIT 1
				`).get(current) as { readonly session_id: unknown } | undefined;
				if (!child) return current;
				current = identity(child.session_id, "childSessionId");
			}
			throw new StorageFailure("session lineage exceeds depth limit");
		} catch (error) {
			throw storageError(error);
		}
	}

	forkSession(input: ForkSessionInput): ForkSessionResult {
		try {
			return this.#write(() => {
				const sourceSessionId = identity(input.sourceSessionId, "sourceSessionId");
				const targetSessionId = identity(input.targetSessionId, "targetSessionId");
				if (sourceSessionId === targetSessionId || this.#sessionExists(targetSessionId)) {
					throw new StorageFailure("target session already exists");
				}
				const source = this.#sessionIdentity(sourceSessionId);
				const boundary = this.#forkBoundary(sourceSessionId, input);
				this.#acquireSessionLeaseRecord(targetSessionId);
				const now = this.#clock();
				this.#database.prepare(`
					INSERT INTO sessions (
						session_id, workspace_root, thread_id, created_at,
						updated_at, last_active_at, status
					) VALUES (?, ?, ?, ?, ?, ?, 'active')
				`).run(
					targetSessionId,
					source.workspaceRoot,
					targetSessionId,
					now,
					now,
					now,
				);
				this.#database.prepare(`
					INSERT INTO conversation_trees (
						session_id, parent_id, fork_point,
						fork_event_session_id, fork_event_id, updated_at
					) VALUES (?, ?, ?, ?, ?, ?)
				`).run(
					targetSessionId,
					sourceSessionId,
					boundary.forkPoint,
					boundary.event?.sessionId ?? null,
					boundary.event?.eventId ?? null,
					now,
				);
				this.#database.prepare(`
					INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
					SELECT ?, state_key, payload_json, ?
					FROM session_state
					WHERE session_id = ? AND state_key = 'session_preferences'
				`).run(targetSessionId, now, sourceSessionId);
				return Object.freeze({
					sourceSessionId,
					targetSessionId,
					forkPoint: boundary.forkPoint,
					...(boundary.event ? {
						forkEventSessionId: boundary.event.sessionId,
						forkEventId: boundary.event.eventId,
					} : {}),
					messageCount: boundary.forkPoint,
				});
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	forkAgentConversation(input: ForkAgentConversationInput): ForkAgentConversationResult {
		try {
			const sourceSessionId = identity(input.sourceSessionId, "sourceSessionId");
			const targetSessionId = identity(input.targetSessionId, "targetSessionId");
			if (sourceSessionId === targetSessionId) {
				throw new StorageFailure("target agent session must differ from source session");
			}
			return this.#write(() => {
				this.#acquireSessionLeaseRecord(targetSessionId);
				if (input.forkTurns === "none") {
					return Object.freeze({ sourceSessionId, targetSessionId, messageCount: 0 });
				}
				if (!this.#sessionExists(sourceSessionId)) {
					throw new StorageFailure("source session does not exist");
				}
				if (this.#sessionExists(targetSessionId)) {
					throw new StorageFailure("target session already exists");
				}
				const selected = selectAgentForkConversation(
					this.#shareableProviderItems(sourceSessionId),
					input.forkTurns,
				);
				if (selected.length === 0) {
					return Object.freeze({ sourceSessionId, targetSessionId, messageCount: 0 });
				}
				const now = this.#clock();
				this.#database.prepare(`
					INSERT INTO sessions (
						session_id, workspace_root, thread_id, created_at,
						updated_at, last_active_at, status
					) VALUES (?, ?, ?, ?, ?, ?, 'active')
				`).run(
					targetSessionId,
					identity(input.workspaceRoot, "workspaceRoot"),
					identity(input.targetThreadId, "targetThreadId"),
					now,
					now,
					now,
				);
				this.#appendAgentForkItems(targetSessionId, selected, now);
				return Object.freeze({ sourceSessionId, targetSessionId, messageCount: selected.length });
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	appendAssistantToolCalls(input: AppendAssistantToolCallsInput): void {
		try {
			this.#write(() => {
				const turn = this.#requireRunningTurn(input.sessionId, input.clientTurnId);
				if (input.calls.length === 0) {
					throw new StorageFailure("assistant tool call batch is empty");
				}
				if (this.loadPendingToolCalls(input.sessionId, turn.turn_id).length > 0) {
					throw new StorageFailure("previous tool calls are still pending");
				}
				const calls = normalizedToolCalls(input.calls);
				const knownIds = this.#knownToolCallIds(input.sessionId);
				for (const call of calls) {
					if (knownIds.has(call.callId)) {
						throw new StorageFailure("invalid or duplicate tool call id");
					}
				}
				this.#insertEvent(parseTranscriptEventAppendInput({
					schemaVersion: 1,
					sessionId: input.sessionId,
					eventId: semanticEventId(turn.turn_id, "tool-batch", calls[0]!.callId),
					turnId: turn.turn_id,
					eventType: "assistant_tool_call_batch",
					modelVisible: true,
					createdAt: this.#clock(),
					payload: {
						text: input.assistantText,
						calls,
						...(input.responseId ? { responseId: input.responseId } : {}),
						...(input.providerState ? { providerState: input.providerState } : {}),
					},
				}));
				this.#touchExistingSession(input.sessionId, this.#clock());
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	appendContextItem(input: AppendContextItemInput): void {
		try {
			this.#write(() => {
				this.#appendContextEvent(input, this.#clock());
				this.#touchExistingSession(input.sessionId, this.#clock());
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	appendToolResult(input: AppendToolResultInput): void {
		try {
			this.#write(() => {
				const turn = this.#requireRunningTurn(input.sessionId, input.clientTurnId);
				if (input.result.output.length > TOOL_RESULT_OUTPUT_MAX_CHARS) {
					throw new StorageFailure("tool result exceeds output limit");
				}
				const expected = this.loadPendingToolCalls(input.sessionId, turn.turn_id)[0];
				if (!expected || expected.callId !== input.result.callId) {
					throw new StorageFailure("tool results must preserve call order");
				}
				if (expected.name !== input.result.toolName) {
					throw new StorageFailure("tool result name does not match call");
				}
				validateToolResultEffects(input);
				this.#appendToolResultEvent(turn, input, this.#clock());
				if (input.planUpdate) {
					const plan = planDisplayPayload(input);
					this.#appendDisplayActivityEvent({
						sessionId: input.sessionId,
						eventId: semanticEventId(turn.turn_id, "plan", input.result.callId),
						turnId: turn.turn_id,
						activityType: "plan",
						text: plan.text,
						metadata: plan.metadata,
						createdAt: this.#clock(),
					});
				}
				if (input.toolActivation) {
					this.#appendDisplayActivityEvent({
						sessionId: input.sessionId,
						eventId: semanticEventId(turn.turn_id, "tool-activation", input.result.callId),
						turnId: turn.turn_id,
						activityType: "tool_activation",
						callId: input.result.callId,
						toolName: input.result.toolName,
						status: "completed",
						metadata: {
							tool_activation: {
								version: 1,
								names: validatedToolActivationNames(input.toolActivation.names),
							},
						},
						createdAt: this.#clock(),
					});
				}
				if (input.contextItem) {
					this.#appendContextEvent({
						sessionId: input.sessionId,
						...input.contextItem,
					}, this.#clock());
				}
				this.#touchExistingSession(input.sessionId, this.#clock());
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	appendDisplayActivity(
		input: AppendTranscriptDisplayActivityInput,
	): TranscriptEventEnvelope<"display_activity"> {
		try {
			return this.#write(() => {
				const event = this.#appendDisplayActivityEvent(input);
				this.#touchExistingSession(input.sessionId, input.createdAt);
				return event;
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	completeTurn(input: CompleteStoredTurnInput): RuntimeTurnRecord {
		try {
			return this.#write(() => {
				const turn = this.#requireRunningTurn(input.sessionId, input.clientTurnId);
				const durationMs = completedTurnDurationMs(turn, input.completedAt);
				this.#insertEvent(parseTranscriptEventAppendInput({
					schemaVersion: 1,
					sessionId: input.sessionId,
					eventId: semanticEventId(turn.turn_id, "assistant"),
					turnId: turn.turn_id,
					eventType: "assistant_output",
					modelVisible: true,
					createdAt: input.completedAt,
					payload: {
						text: input.assistantText,
						...(input.responseId ? { responseId: input.responseId } : {}),
						...(input.providerState ? { providerState: input.providerState } : {}),
					},
				}));
				if (durationMs !== undefined) {
					this.#appendDisplayActivityEvent({
						sessionId: input.sessionId,
						eventId: turnCompletedDurationId(turn.turn_id),
						turnId: turn.turn_id,
						activityType: "turn_completed",
						status: "completed",
						metadata: { duration_ms: durationMs },
						createdAt: input.completedAt,
					});
				}
				this.#appendLifecycleEvent(turn, "completed", input.completedAt, {
					usage: input.usage,
					...(input.lastTokenUsage ? {
						diagnostics: { last_token_usage: input.lastTokenUsage },
					} : {}),
				});
				this.#database.prepare(`
					UPDATE runtime_turns
					SET status = 'completed', error_code = NULL, result_json = ?, completed_at = ?,
						owner_id = NULL, owner_pid = NULL
					WHERE session_id = ? AND client_turn_id = ? AND status = 'in_progress'
				`).run(stableJson({
					assistant_text: input.assistantText,
					...(input.responseId ? { response_id: input.responseId } : {}),
					usage: input.usage,
				}), input.completedAt, input.sessionId, input.clientTurnId);
				this.#touchExistingSession(input.sessionId, input.completedAt);
				return this.#requiredTurn(input.sessionId, input.clientTurnId);
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	failTurn(input: FailStoredTurnInput): RuntimeTurnRecord {
		try {
			return this.#write(() => {
				const turn = this.#requireRunningTurn(input.sessionId, input.clientTurnId);
				const status = input.code === "interrupted" ? "interrupted" : "failed";
				const failureInput = normalizeStoredTurnFailure(input);
				for (const call of this.loadPendingToolCalls(input.sessionId, turn.turn_id)) {
					this.#appendSyntheticToolResult(turn, call, status, input.completedAt);
				}
				if (status === "interrupted") {
					this.#appendTurnAbortedEvent(turn, input.completedAt);
					this.#appendInterruptedTurnDisplay(turn, input.completedAt);
				} else {
					this.#appendFailedTurnDisplay(
						turn,
						input.code,
						input.completedAt,
						failureInput.message,
						failureInput.additionalDetails,
					);
				}
				this.#appendLifecycleEvent(turn, status, input.completedAt, {
					errorCode: input.code,
						message: failureInput.message,
						...(failureInput.additionalDetails
							? { additionalDetails: failureInput.additionalDetails }
							: {}),
						...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
				});
				this.#database.prepare(`
					UPDATE runtime_turns
					SET status = ?, error_code = ?, result_json = ?, completed_at = ?,
						owner_id = NULL, owner_pid = NULL
					WHERE session_id = ? AND client_turn_id = ? AND status = 'in_progress'
				`).run(
					status,
					input.code,
						stableJson({
							message: failureInput.message,
							...(failureInput.additionalDetails
								? { additional_details: failureInput.additionalDetails }
								: {}),
							...(input.diagnostics && Object.keys(input.diagnostics).length > 0
							? { diagnostics: input.diagnostics }
							: {}),
					}),
					input.completedAt,
					input.sessionId,
					input.clientTurnId,
				);
				this.#touchExistingSession(input.sessionId, input.completedAt);
				return this.#requiredTurn(input.sessionId, input.clientTurnId);
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	recoverInterruptedTurns(): number {
		try {
			return this.#write(() => {
				const rows = this.#database.prepare(`
					SELECT ${RUNTIME_TURN_COLUMNS}
					FROM runtime_turns
					WHERE status = 'in_progress'
					ORDER BY session_id, client_turn_id
				`).all() as readonly RuntimeTurnRow[];
				const orphaned = rows.map(runtimeTurnWithOwnerFromRow).filter(({ turn, owner }) => (
					(owner.processId === undefined || !this.#isProcessAlive(owner.processId))
					&& !this.#isContinuationTurn(turn)
				));
				for (const { turn } of orphaned) {
					const completedAt = this.#clock();
					for (const call of this.loadPendingToolCalls(turn.session_id, turn.turn_id)) {
						this.#appendSyntheticToolResult(turn, call, "interrupted", completedAt);
					}
					this.#appendInterruptedTurnDisplay(turn, completedAt);
					this.#appendLifecycleEvent(turn, "interrupted", completedAt, {
						errorCode: "interrupted",
						message: "turn interrupted during process restart",
					});
					this.#database.prepare(`
						UPDATE runtime_turns
						SET status = 'interrupted', error_code = 'interrupted',
							result_json = ?, completed_at = ?, owner_id = NULL, owner_pid = NULL
						WHERE session_id = ? AND client_turn_id = ? AND status = 'in_progress'
					`).run(
						stableJson({ message: "turn interrupted during process restart" }),
						completedAt,
						turn.session_id,
						turn.client_turn_id,
					);
					this.#touchExistingSession(turn.session_id, completedAt);
				}
				return orphaned.length;
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	recoverInterruptedTurn(
		sessionId: string,
		turnId: string,
		userInitiated = false,
	): RuntimeTurnRecord | undefined {
		try {
			return this.#write(() => {
				const normalizedSessionId = identity(sessionId, "sessionId");
				const normalizedTurnId = identity(turnId, "turnId");
				const row = this.#database.prepare(`
					SELECT ${RUNTIME_TURN_COLUMNS}
					FROM runtime_turns
					WHERE session_id = ? AND turn_id = ? LIMIT 1
				`).get(normalizedSessionId, normalizedTurnId) as RuntimeTurnRow | undefined;
				if (!row) return undefined;
				const turn = runtimeTurnFromRow(row);
				if (turn.status !== "in_progress") {
					if (turn.status === "interrupted" && userInitiated) {
						this.#appendInterruptedTurnDisplay(turn, turn.completed_at ?? this.#clock());
					}
					return turn;
				}
				const completedAt = this.#clock();
				for (const call of this.loadPendingToolCalls(normalizedSessionId, normalizedTurnId)) {
					this.#appendSyntheticToolResult(turn, call, "interrupted", completedAt);
				}
				this.#appendTurnAbortedEvent(turn, completedAt);
				this.#appendInterruptedTurnDisplay(turn, completedAt);
				this.#appendLifecycleEvent(turn, "interrupted", completedAt, {
					errorCode: "interrupted",
					message: "turn interrupted by runtime owner",
				});
				this.#database.prepare(`
					UPDATE runtime_turns
					SET status = 'interrupted', error_code = 'interrupted', result_json = ?,
						completed_at = ?, owner_id = NULL, owner_pid = NULL
					WHERE session_id = ? AND client_turn_id = ? AND status = 'in_progress'
				`).run(
					stableJson({ message: "turn interrupted by runtime owner" }),
					completedAt,
					normalizedSessionId,
					turn.client_turn_id,
				);
				this.#touchExistingSession(normalizedSessionId, completedAt);
				return this.#requiredTurn(normalizedSessionId, turn.client_turn_id);
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	loadEvent(sessionId: string, eventId: string): TranscriptEventEnvelope | undefined {
		try {
			const row = this.#database.prepare(`
				SELECT sequence_no, session_id, event_id, turn_id, event_type,
				       provider_index, model_visible, payload_json, created_at
				FROM transcript_events
				WHERE session_id = ? AND event_id = ?
			`).get(sessionId, eventId) as TranscriptEventRow | undefined;
			return row ? this.#eventFromRow(row) : undefined;
		} catch (error) {
			throw storageError(error);
		}
	}

	loadEventWindow(
		sessionId: string,
		options: TranscriptEventWindowOptions = {},
	): TranscriptEventWindow {
		try {
			const normalizedSessionId = identity(sessionId, "sessionId");
			const before = optionalSequence(options.beforeSequence, "beforeSequence");
			const after = optionalSequence(options.afterSequence, "afterSequence");
			if (before !== undefined && after !== undefined) {
				throw new RangeError("beforeSequence and afterSequence are mutually exclusive");
			}
			const limit = boundedLimit(options.limit, MAX_EVENT_WINDOW_LIMIT);
			if (after !== undefined) {
				return this.#eventWindow(
					`session_id = ? AND sequence_no > ?`,
					[normalizedSessionId, after],
					"ASC",
					limit,
					false,
				);
			}
			return this.#eventWindow(
				before === undefined ? "session_id = ?" : "session_id = ? AND sequence_no < ?",
				before === undefined ? [normalizedSessionId] : [normalizedSessionId, before],
				"DESC",
				limit,
				true,
			);
		} catch (error) {
			throw storageError(error);
		}
	}

	loadTurnEventWindow(
		sessionId: string,
		turnId: string,
		options: TranscriptTurnEventWindowOptions = {},
	): TranscriptEventWindow {
		try {
			const normalizedSessionId = identity(sessionId, "sessionId");
			const normalizedTurnId = identity(turnId, "turnId");
			const after = optionalSequence(options.afterSequence, "afterSequence") ?? 0;
			const limit = boundedLimit(options.limit, MAX_TURN_EVENT_LIMIT);
			return this.#eventWindow(
				"session_id = ? AND turn_id = ? AND sequence_no > ?",
				[normalizedSessionId, normalizedTurnId, after],
				"ASC",
				limit,
				false,
			);
		} catch (error) {
			throw storageError(error);
		}
	}

	loadLatestCompaction(sessionId: string): TranscriptEventEnvelope<"compaction"> | undefined {
		try {
			const normalizedSessionId = identity(sessionId, "sessionId");
			if (this.#hasLineageParent(normalizedSessionId)) {
				const segments = this.#lineageSegments(normalizedSessionId);
				if (!this.#lineageHasRollback(segments)) {
					return this.#latestCompactionInSegments(segments);
				}
				const events = this.#allEvents(normalizedSessionId);
				const rollbacks = rollbackWindowsFromEvents(events);
				return latestCompactionFromEvents(
					events.filter((event) => eventSurvivesRollbacks(event, rollbacks)),
				);
			}
			const rollbackWindows = this.#rollbackWindows(normalizedSessionId);
			const rows = this.#database.prepare(`
				SELECT sequence_no, session_id, event_id, turn_id, event_type,
				       provider_index, model_visible, payload_json, created_at
				FROM transcript_events
				WHERE session_id = ? AND event_type = 'compaction'
				ORDER BY sequence_no DESC
			`).iterate(normalizedSessionId) as IterableIterator<TranscriptEventRow>;
			for (const row of rows) {
				const event = this.#eventFromRow(row);
				if (event.eventType !== "compaction") {
					throw new StorageFailure("latest compaction event has an invalid type");
				}
				if (!eventSurvivesRollbacks(event, rollbackWindows)) continue;
				if (!this.#hasValidCompactionSource(event, rollbackWindows)) continue;
				return event;
			}
			return undefined;
		} catch (error) {
			throw storageError(error);
		}
	}

	loadSourceEvents(
		sessionId: string,
		eventIds: readonly string[],
	): readonly TranscriptEventEnvelope[] {
		try {
			const normalizedSessionId = identity(sessionId, "sessionId");
			if (!Array.isArray(eventIds) || eventIds.length > MAX_SOURCE_REFERENCE_COUNT) {
				throw new RangeError(`eventIds must contain at most ${MAX_SOURCE_REFERENCE_COUNT} entries`);
			}
			const ids = eventIds.map((eventId) => identity(eventId, "eventId"));
			if (new Set(ids).size !== ids.length) {
				throw new RangeError("eventIds must be unique");
			}
			if (ids.length === 0) return Object.freeze([]);
			const rows = this.#database.prepare(`
				SELECT sequence_no, session_id, event_id, turn_id, event_type,
				       provider_index, model_visible, payload_json, created_at
				FROM transcript_events
				WHERE session_id = ? AND event_id IN (${ids.map(() => "?").join(", ")})
			`).all(normalizedSessionId, ...ids) as readonly TranscriptEventRow[];
			const events = this.#eventsFromRows(rows);
			const byId = new Map(events.map((event) => [event.eventId, event]));
			if (byId.size !== ids.length) {
				throw new StorageFailure("transcript event source reference is missing", {
					missing_count: ids.length - byId.size,
				});
			}
			return Object.freeze(ids.map((eventId) => byId.get(eventId)!));
		} catch (error) {
			throw storageError(error);
		}
	}

	loadConversationItems(sessionId: string): readonly CanonicalConversationItem[] {
		try {
			const normalizedSessionId = identity(sessionId, "sessionId");
			if (this.#hasLineageParent(normalizedSessionId)) {
				const segments = this.#lineageSegments(normalizedSessionId);
				if (!this.#lineageHasRollback(segments)) {
					const compaction = this.#latestCompactionInSegments(segments);
					return projectTranscriptEventsToProviderItems(
						this.#providerEventsInSegments(
							segments,
							compaction?.sequenceNo ?? 0,
						),
						{
							...(compaction ? { replacement: compaction.payload.replacement } : {}),
							activeToolCallIds: this.#activeToolCallIds(normalizedSessionId),
						},
					);
				}
				const events = this.#allEvents(normalizedSessionId);
				const rollbackWindows = rollbackWindowsFromEvents(events);
				const surviving = events.filter(
					(event) => eventSurvivesRollbacks(event, rollbackWindows),
				);
				const compaction = latestCompactionFromEvents(surviving);
				return projectTranscriptEventsToProviderItems(
					surviving.filter((event) => (
						event.modelVisible && event.sequenceNo > (compaction?.sequenceNo ?? 0)
					)),
					{
						...(compaction ? { replacement: compaction.payload.replacement } : {}),
						activeToolCallIds: this.#activeToolCallIds(normalizedSessionId),
					},
				);
			}
			const compaction = this.loadLatestCompaction(normalizedSessionId);
			const rollbackWindows = this.#rollbackWindows(normalizedSessionId);
			const events = this.#providerEvents(
				normalizedSessionId,
				compaction?.sequenceNo ?? 0,
			).filter((event) => eventSurvivesRollbacks(event, rollbackWindows));
			return projectTranscriptEventsToProviderItems(events, {
				...(compaction ? { replacement: compaction.payload.replacement } : {}),
				activeToolCallIds: this.#activeToolCallIds(normalizedSessionId),
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	loadState(sessionId: string, key: RuntimeStateKey): unknown | undefined {
		try {
			const normalizedSessionId = identity(sessionId, "sessionId");
			const state = this.#stateRepository.loadState(normalizedSessionId, key);
			if (key !== "compact_checkpoint" || !isRecord(state)
				|| typeof state.transcript_event_id !== "string") return state;
			const event = this.loadEvent(normalizedSessionId, state.transcript_event_id);
			if (event?.eventType !== "compaction"
				|| event.payload.windowId !== state.window_id) {
				throw new StorageFailure("compact checkpoint transcript reference is invalid");
			}
			return state;
		} catch (error) {
			throw storageError(error);
		}
	}

	saveState(input: SaveStateInput): void {
		this.#validateStandaloneStateReference(input.sessionId, input.key, input.payload);
		this.#stateRepository.saveState(input);
	}

	saveQueueSnapshot(input: SaveQueueSnapshotInput): QueueSnapshot {
		return this.#stateRepository.saveQueueSnapshot(input);
	}

	deleteState(sessionId: string, key: RuntimeStateKey): void {
		this.#stateRepository.deleteState(identity(sessionId, "sessionId"), key);
	}

	loadCommittedQueueIds(sessionId: string): ReadonlySet<string> {
		return this.#stateRepository.loadCommittedQueueIds(sessionId);
	}

	commitQueuedInputs(input: CommitQueuedInputsInput): QueueSnapshot {
		return this.#stateRepository.commitQueuedInputs(input);
	}

	compareAndSetApproval(input: ApprovalTransitionInput): ApprovalCheckpoint {
		return this.#stateRepository.compareAndSetApproval(input);
	}

	saveApprovalSuspension(input: SaveApprovalSuspensionInput): ApprovalCheckpoint {
		this.#assertContinuationToolCall(
			input.sessionId,
			input.checkpoint.clientTurnId,
			input.checkpoint.turnId,
			input.checkpoint.callId,
			input.checkpoint.toolName,
			true,
		);
		const sourceEventId = this.#toolCallEventId(
			input.sessionId,
			input.checkpoint.turnId,
			input.checkpoint.callId,
		);
		return this.#stateRepository.saveApprovalSuspension({
			...input,
			suspendedTurn: {
				...input.suspendedTurn,
				payload: {
					...input.suspendedTurn.payload,
					conversation: [],
					transcript_event_id: sourceEventId,
				},
			},
		});
	}

	saveClarificationSuspension(input: SaveClarificationSuspensionInput): void {
		const payload = input.suspendedTurn.payload;
		const clarification = isRecord(payload.pending_clarification)
			? payload.pending_clarification
			: undefined;
		const call = isRecord(clarification?.tool_call) ? clarification.tool_call : undefined;
		this.#assertContinuationToolCall(
			input.sessionId,
			identity(payload.client_turn_id, "clientTurnId"),
			identity(payload.turn_id, "turnId"),
			identity(call?.call_id, "callId"),
			identity(call?.name, "toolName"),
			true,
		);
		const sourceEventId = this.#toolCallEventId(
			input.sessionId,
			identity(payload.turn_id, "turnId"),
			identity(call?.call_id, "callId"),
		);
		this.#stateRepository.saveClarificationSuspension({
			...input,
			suspendedTurn: {
				...input.suspendedTurn,
				payload: {
					...payload,
					conversation: [],
					transcript_event_id: sourceEventId,
				},
			},
		});
	}

	commitClarificationResponse(input: CommitClarificationResponseInput): void {
		this.#stateRepository.commitClarificationResponse(input, () => {
			this.#assertToolResultMatchesPending(input.toolResult);
			if (input.toolResult.result.callId !== input.requestId) {
				throw new StorageFailure("clarification response does not match pending call");
			}
			const turn = this.#requireRunningTurn(input.sessionId, input.toolResult.clientTurnId);
			this.appendToolResult(input.toolResult);
			this.#appendDisplayActivityEvent({
				sessionId: input.sessionId,
				eventId: clarificationResponseEventId(input.requestId),
				turnId: turn.turn_id,
				activityType: "clarification_response",
				text: input.display.response,
				callId: input.requestId,
				toolName: input.toolResult.result.toolName,
				status: "answered",
				metadata: {
					request_id: input.requestId,
					...(input.display.header ? { header: input.display.header } : {}),
					question: input.display.question,
					response: input.display.response,
					multi_select: input.display.multiSelect,
				},
				createdAt: this.#clock(),
			});
		});
	}

	commitApprovalResult(input: CommitApprovalResultInput): ApprovalCheckpoint {
		return this.#stateRepository.commitApprovalResult(input, () => {
			this.#assertToolResultMatchesPending(input.toolResult);
			this.appendToolResult(input.toolResult);
		});
	}

	finalizeApprovalContinuation(input: FinalizeApprovalContinuationInput): void {
		this.#stateRepository.finalizeApprovalContinuation(input);
	}

	interruptAmbiguousApproval(input: InterruptAmbiguousApprovalInput): RuntimeTurnRecord {
		this.#stateRepository.interruptAmbiguousApproval(input, () => {
			const turn = this.#requireRunningTurn(input.sessionId, input.clientTurnId);
			this.#assertContinuationToolCall(
				input.sessionId,
				input.clientTurnId,
				turn.turn_id,
				input.callId,
				input.toolName,
				true,
			);
			const completedAt = input.completedAt;
			this.#appendToolResultEvent(turn, {
				sessionId: input.sessionId,
				clientTurnId: input.clientTurnId,
				result: {
					callId: input.callId,
					toolName: input.toolName,
					output: "Tool effect outcome is unknown after interruption.",
					success: false,
				},
				summary: `${input.toolName.slice(0, 128) || "Tool"} outcome unknown`,
				errorKind: input.errorKind,
			}, completedAt);
			this.#appendTurnAbortedEvent(turn, completedAt);
			this.#appendInterruptedTurnDisplay(turn, completedAt);
			this.#appendLifecycleEvent(turn, "interrupted", completedAt, {
				errorCode: "interrupted",
				message: "tool effect outcome is unknown",
				diagnostics: { error_kind: input.errorKind },
			});
			this.#database.prepare(`
				UPDATE runtime_turns
				SET status = 'interrupted', error_code = 'interrupted', result_json = ?,
					completed_at = ?, owner_id = NULL, owner_pid = NULL
				WHERE session_id = ? AND client_turn_id = ? AND status = 'in_progress'
			`).run(
				stableJson({
					message: "tool effect outcome is unknown",
					error_kind: input.errorKind,
				}),
				completedAt,
				input.sessionId,
				input.clientTurnId,
			);
		});
		return this.#requiredTurn(input.sessionId, input.clientTurnId);
	}

	validateRecoveryReferences(sessionId: string): void {
		try {
			const normalizedSessionId = identity(sessionId, "sessionId");
			for (const key of [
				"input_queue",
				"compact_checkpoint",
				"responses_continuation_state",
			] as const) this.loadState(normalizedSessionId, key);
			const suspended = this.#stateRepository.loadState(normalizedSessionId, "suspended_turn");
			if (suspended !== undefined) this.#validateSuspendedReference(normalizedSessionId, suspended);
			const effect = this.#stateRepository.loadState(normalizedSessionId, "node_effect_checkpoint");
			if (effect !== undefined) this.#validateEffectReference(normalizedSessionId, effect);
		} catch (error) {
			throw storageError(error);
		}
	}

	upsertShellSnapshot(input: UpsertShellSnapshotInput): void {
		try {
			this.#write(() => {
				const sessionId = identity(input.sessionId, "sessionId");
				const callId = identity(input.callId, "callId");
				const shellId = identity(input.shellId, "shellId");
				const metadata = sanitizeShellSnapshotPayload(input.payload, shellId);
				if (input.outputChunk) {
					const chunk = validateShellOutputChunk(input.outputChunk);
					this.#database.prepare(`
						INSERT INTO shell_output_chunks (
							session_id, shell_id, call_id, event_sequence,
							cursor_start, cursor_end, omitted_before, output_text
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					`).run(
						sessionId,
						shellId,
						callId,
						chunk.sequence,
						chunk.cursorStart,
						chunk.cursorEnd,
						chunk.omittedBefore,
						chunk.output,
					);
				}
				const eventId = semanticEventId(
					sessionId,
					"shell",
					callId,
					shellId,
					stableJson(metadata),
				);
				if (!this.loadEvent(sessionId, eventId)) {
					this.#appendDisplayActivityEvent({
						sessionId,
						eventId,
						turnId: callId,
						activityType: "shell",
						callId,
						toolName: "Shell",
						status: shellStatus(metadata),
						metadata: transcriptJsonRecord(metadata),
						createdAt: shellTimestamp(metadata) ?? this.#clock(),
					});
				}
				this.#touchExistingSession(sessionId, this.#clock());
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	loadShellOutputPage(input: LoadShellOutputPageInput): ShellOutputPage {
		try {
			const normalized = validateShellOutputPageInput(input);
			const callClause = normalized.callId === undefined ? "" : " AND call_id = ?";
			const queryParameters = normalized.callId === undefined
				? [normalized.sessionId, normalized.shellId, normalized.afterSequence]
				: [normalized.sessionId, normalized.shellId, normalized.callId, normalized.afterSequence];
			const rows = this.#database.prepare(`
				SELECT call_id, event_sequence, cursor_start, cursor_end,
				       omitted_before, output_text
				FROM shell_output_chunks
				WHERE session_id = ? AND shell_id = ?${callClause}
				  AND event_sequence > ?
				ORDER BY event_sequence
				LIMIT ${MAX_SHELL_OUTPUT_PAGE_ROWS}
			`).all(...queryParameters) as readonly ShellOutputChunkRow[];
			const selected: ShellOutputChunk[] = [];
			let selectedChars = 0;
			for (const row of rows) {
				const chunk = shellOutputChunkFromRow(row);
				if (selected.length > 0
					&& selectedChars + chunk.output.length > normalized.limitChars) break;
				selected.push(chunk);
				selectedChars += chunk.output.length;
			}
			const lastSequence = selected.at(-1)?.sequence;
			const hasMore = lastSequence !== undefined && (
				selected.length < rows.length || this.#database.prepare(`
					SELECT 1 AS present FROM shell_output_chunks
					WHERE session_id = ? AND shell_id = ?${callClause}
					  AND event_sequence > ? LIMIT 1
				`).get(...(
					normalized.callId === undefined
						? [normalized.sessionId, normalized.shellId, lastSequence]
						: [normalized.sessionId, normalized.shellId, normalized.callId, lastSequence]
				)) !== undefined
			);
			const totals = this.#database.prepare(`
				SELECT COUNT(*) AS chunk_count, MIN(cursor_start) AS first_cursor,
				       MAX(cursor_end) AS output_chars,
				       COALESCE(SUM(LENGTH(output_text)), 0) AS captured_chars,
				       COALESCE(SUM(omitted_before), 0) AS omitted_chars,
				       MIN(call_id) AS call_id
				FROM shell_output_chunks
				WHERE session_id = ? AND shell_id = ?${callClause}
			`).get(...(
				normalized.callId === undefined
					? [normalized.sessionId, normalized.shellId]
					: [normalized.sessionId, normalized.shellId, normalized.callId]
			)) as ShellOutputTotalsRow;
			const chunkCount = Number(totals.chunk_count ?? 0);
			const outputChars = Number(totals.output_chars ?? 0);
			const capturedChars = Number(totals.captured_chars ?? 0);
			const omittedChars = Number(totals.omitted_chars ?? 0);
			const available = chunkCount > 0;
			return Object.freeze({
				sessionId: normalized.sessionId,
				shellId: normalized.shellId,
				...(typeof totals.call_id === "string" ? { callId: totals.call_id } : {}),
				chunks: Object.freeze(selected),
				nextAfterSequence: hasMore ? lastSequence ?? null : null,
				available,
				complete: available && Number(totals.first_cursor) === 0
					&& omittedChars === 0 && capturedChars === outputChars,
				omittedChars,
				capturedChars,
				outputChars,
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	loadHistoryItems(sessionId: string): readonly Readonly<Record<string, unknown>>[] {
		try {
			const normalizedSessionId = identity(sessionId, "sessionId");
			const session = this.loadSession(normalizedSessionId);
			if (!session) return Object.freeze([]);
			return projectEventsToLegacyHistory(
				this.#allEvents(normalizedSessionId),
				session.threadId,
			);
		} catch (error) {
			throw storageError(error);
		}
	}

	loadSessionSummaries(sessionId: string): readonly string[] {
		try {
			const normalizedSessionId = identity(sessionId, "sessionId");
			if (this.#hasLineageParent(normalizedSessionId)) {
				return Object.freeze(this.#allEvents(normalizedSessionId).flatMap((event) => (
					event.eventType === "compaction" ? [event.payload.summary] : []
				)));
			}
			const rows = this.#database.prepare(`
				SELECT sequence_no, session_id, event_id, turn_id, event_type,
				       provider_index, model_visible, payload_json, created_at
				FROM transcript_events
				WHERE session_id = ? AND event_type = 'compaction'
				ORDER BY sequence_no
			`).all(normalizedSessionId) as readonly TranscriptEventRow[];
			return Object.freeze(this.#eventsFromRows(rows).map((event) => {
				if (event.eventType !== "compaction") {
					throw new StorageFailure("compaction summary event has an invalid type");
				}
				return event.payload.summary;
			}));
		} catch (error) {
			throw storageError(error);
		}
	}

	loadRecentSessionSummaries(sessionId: string, limit: number): readonly string[] {
		try {
			const normalizedSessionId = identity(sessionId, "sessionId");
			const bounded = boundedLimit(limit, 2_000);
			const segments: readonly LineageEventSegment[] = this.#hasLineageParent(normalizedSessionId)
				? this.#lineageSegments(normalizedSessionId)
				: Object.freeze([{ sessionId: normalizedSessionId }]);
			const rows = segments.flatMap((segment) => (
				this.#database.prepare(`
					SELECT sequence_no, session_id, event_id, turn_id, event_type,
					       provider_index, model_visible, payload_json, created_at
					FROM transcript_events
					WHERE session_id = ? AND event_type = 'compaction'
					${segment.maxSequence === undefined ? "" : "AND sequence_no <= ?"}
					ORDER BY sequence_no DESC
					LIMIT ?
				`).all(...(
					segment.maxSequence === undefined
						? [segment.sessionId, bounded]
						: [segment.sessionId, segment.maxSequence, bounded]
				)) as readonly TranscriptEventRow[]
			));
			const events = [...this.#eventsFromRows(rows)]
				.sort((left, right) => right.sequenceNo - left.sequenceNo);
			return Object.freeze(events.slice(0, bounded).reverse().map((event) => {
				if (event.eventType !== "compaction") {
					throw new StorageFailure("compaction summary event has an invalid type");
				}
				return event.payload.summary;
			}));
		} catch (error) {
			throw storageError(error);
		}
	}

	loadTurnRollouts(sessionId: string): readonly Readonly<Record<string, unknown>>[] {
		try {
			const normalizedSessionId = identity(sessionId, "sessionId");
			const session = this.loadSession(normalizedSessionId);
			if (!session) return Object.freeze([]);
			const lifecycleRows = this.#database.prepare(`
				SELECT sequence_no, session_id, event_id, turn_id, event_type,
				       provider_index, model_visible, payload_json, created_at
				FROM transcript_events
				WHERE session_id = ? AND event_type = 'turn_lifecycle'
				ORDER BY sequence_no
			`).all(normalizedSessionId) as readonly TranscriptEventRow[];
			const terminalByTurn = new Map<string, TranscriptEventEnvelope<"turn_lifecycle">>();
			for (const event of this.#eventsFromRows(lifecycleRows)) {
				if (event.eventType !== "turn_lifecycle" || !event.turnId
					|| event.payload.phase === "started") continue;
				terminalByTurn.set(event.turnId, event);
			}
			const rows = this.#database.prepare(`
				SELECT ${RUNTIME_TURN_COLUMNS}
				FROM runtime_turns
				WHERE session_id = ? AND status != 'in_progress'
				ORDER BY started_at, turn_id
			`).all(normalizedSessionId) as readonly RuntimeTurnRow[];
			return Object.freeze(rows.flatMap((row): Readonly<Record<string, unknown>>[] => {
				const turn = runtimeTurnFromRow(row);
				const lifecycle = terminalByTurn.get(turn.turn_id);
				if (!lifecycle) return [];
				const result = isRecord(turn.result) ? turn.result : {};
				const diagnostics = lifecycle.payload.diagnostics;
				const lastTokenUsage = isRecord(diagnostics?.last_token_usage)
					? diagnostics.last_token_usage
					: undefined;
				return [Object.freeze({
					thread_id: session.threadId,
					turn_id: turn.turn_id,
					status: turn.status,
					started_at: turn.started_at,
					completed_at: turn.completed_at,
					stop_reason: normalizedStopReason(turn.status, turn.error_code),
					events: Object.freeze([]),
					continuation_state: Object.freeze({
						...(typeof result.response_id === "string"
							? { response_id: result.response_id }
							: {}),
						...(lifecycle.payload.usage ? { usage: lifecycle.payload.usage } : {}),
						...(lastTokenUsage ? { last_token_usage: lastTokenUsage } : {}),
					}),
				})];
			}));
		} catch (error) {
			throw storageError(error);
		}
	}

	importLegacyConversation(input: ImportLegacyConversationInput): boolean {
		try {
			const sessionId = identity(input.sessionId, "sessionId");
			const workspaceRoot = identity(input.workspaceRoot, "workspaceRoot");
			const threadId = identity(input.threadId, "threadId");
			const items = input.messages.map((message) => {
				const item = canonicalConversationItem(stableJson(message), "legacy snapshot");
				if (item.type === "context") {
					throw new StorageFailure("invalid legacy conversation message");
				}
				return item;
			});
			if (items.length === 0) throw new StorageFailure("invalid legacy conversation message");
			return this.#write(() => {
				if (this.#database.prepare(`
					SELECT 1 FROM transcript_events WHERE session_id = ? LIMIT 1
				`).get(sessionId)) return false;
				const now = this.#clock();
				this.#touchSessionIdentity(sessionId, workspaceRoot, threadId, now);
				for (const [index, item] of items.entries()) {
					this.#insertEvent(legacyImportEvent(sessionId, item, index, now));
				}
				return true;
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	commitCompaction(input: CommitCompactionInput): void {
		try {
			this.#write(() => {
				const sessionId = identity(input.sessionId, "sessionId");
				if (!input.replacementItems) {
					throw new StorageFailure("normalized compaction requires canonical replacement items");
				}
				const checkpoint = normalizedCompactionCheckpoint(input.checkpoint);
				const source = this.#latestProviderEvent(sessionId);
				if (!source || source.providerIndex === undefined) {
					throw new StorageFailure("compaction source event does not exist");
				}
				const event = this.#insertEvent(parseTranscriptEventAppendInput({
					schemaVersion: 1,
					sessionId,
					eventId: `compaction:${checkpoint.windowId}`,
					turnId: checkpoint.turnId,
					eventType: "compaction",
					modelVisible: false,
					createdAt: checkpoint.updatedAt,
					payload: {
						windowId: checkpoint.windowId,
						sourceEventId: source.eventId,
						sourceProviderIndex: source.providerIndex,
						replacement: input.replacementItems,
						summary: boundedCompactionSummary(input.summary),
						metadata: checkpoint.metadata,
					},
				}));
				const session = this.#sessionIdentity(sessionId);
				this.#stateRepository.saveState({
					sessionId,
					workspaceRoot: session.workspaceRoot,
					threadId: session.threadId,
					key: "compact_checkpoint",
					payload: {
						version: 1,
						turn_id: checkpoint.turnId,
						reason: checkpoint.reason,
						phase: checkpoint.phase,
						window_number: checkpoint.windowNumber,
						window_id: checkpoint.windowId,
						history_item_count: checkpoint.historyItemCount,
						input_history_hash: checkpoint.inputHistoryHash,
						replacement_history_hash: checkpoint.replacementHistoryHash,
						transcript_event_id: event.eventId,
						status: "completed",
						summary_request_fingerprint: checkpoint.summaryRequestFingerprint,
						updated_at: checkpoint.updatedAt,
					},
				});
				this.#stateRepository.saveState({
					sessionId,
					workspaceRoot: session.workspaceRoot,
					threadId: session.threadId,
					key: "responses_continuation_state",
					payload: INVALIDATED_RESPONSES_CONTINUATION,
				});
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	loadPendingToolCalls(sessionId: string, turnId: string): readonly CanonicalToolCall[] {
		try {
			const events = this.#turnProviderEvents(
				identity(sessionId, "sessionId"),
				identity(turnId, "turnId"),
			);
			const callIds = new Set(events.flatMap((event) => (
				event.eventType === "assistant_tool_call_batch"
					? event.payload.calls.map((call) => call.callId)
					: []
			)));
			const items = projectTranscriptEventsToProviderItems(events, {
				activeToolCallIds: callIds,
			});
			const pending: CanonicalToolCall[] = [];
			for (const item of items) {
				if (item.type === "assistant_tool_calls") pending.push(...item.calls);
				if (item.type !== "tool_result") continue;
				const index = pending.findIndex((call) => call.callId === item.callId);
				if (index >= 0) pending.splice(index, 1);
			}
			return Object.freeze(pending);
		} catch (error) {
			throw storageError(error);
		}
	}

	loadToolActivations(sessionId: string, turnId: string): readonly string[] {
		try {
			const events = this.#turnEvents(
				identity(sessionId, "sessionId"),
				identity(turnId, "turnId"),
			);
			const names = new Set<string>();
			for (const event of events) {
				const activation = event.eventType === "tool_result"
					&& event.payload.result.toolName === "tool_search"
					&& event.payload.result.success
					? event.payload.metadata?.tool_activation
					: event.eventType === "display_activity"
						&& event.payload.activityType === "tool_activation"
						? event.payload.metadata?.tool_activation
						: undefined;
				for (const name of toolActivationNames(activation)) {
					names.add(name);
				}
			}
			return Object.freeze([...names]);
		} catch (error) {
			throw storageError(error);
		}
	}

	loadContextItems(
		sessionId: string,
		turnId?: string,
	): readonly Extract<CanonicalConversationItem, { readonly type: "context" }>[] {
		try {
			const normalizedSessionId = identity(sessionId, "sessionId");
			const normalizedTurnId = turnId === undefined ? undefined : identity(turnId, "turnId");
			const rows = this.#database.prepare(`
				SELECT sequence_no, session_id, event_id, turn_id, event_type,
				       provider_index, model_visible, payload_json, created_at
				FROM transcript_events
				WHERE session_id = ? AND event_type = 'context' AND model_visible = 1
				${normalizedTurnId === undefined ? "" : "AND turn_id = ?"}
				ORDER BY sequence_no
			`).all(...(
				normalizedTurnId === undefined
					? [normalizedSessionId]
					: [normalizedSessionId, normalizedTurnId]
			)) as readonly TranscriptEventRow[];
			return Object.freeze(this.#eventsFromRows(rows).map((event) => {
				if (event.eventType !== "context") {
					throw new StorageFailure("context transcript event has an invalid type");
				}
				return Object.freeze({
					type: "context" as const,
					text: event.payload.text,
					metadata: event.payload.metadata,
				});
			}));
		} catch (error) {
			throw storageError(error);
		}
	}

	loadReadableTranscript(sessionId: string): readonly TranscriptItem[] {
		try {
			return projectTranscriptEventsToReadableItems(
				this.#allEvents(identity(sessionId, "sessionId")),
				{ limit: Number.MAX_SAFE_INTEGER },
			);
		} catch (error) {
			throw storageError(error);
		}
	}

	hasTranscriptEvents(sessionId: string): boolean {
		try {
			const normalizedSessionId = identity(sessionId, "sessionId");
			if (this.#hasLineageParent(normalizedSessionId)) {
				return this.#allEvents(normalizedSessionId).length > 0;
			}
			return this.#database.prepare(`
				SELECT 1 AS present FROM transcript_events WHERE session_id = ? LIMIT 1
			`).get(normalizedSessionId) !== undefined;
		} catch (error) {
			throw storageError(error);
		}
	}

	loadRecentReadableTranscript(sessionId: string): readonly TranscriptItem[] {
		try {
			const normalizedSessionId = identity(sessionId, "sessionId");
			if (this.#hasLineageParent(normalizedSessionId)) {
				const all = this.#allEvents(normalizedSessionId);
				const selected = all.slice(-RECENT_READABLE_RAW_EVENT_LIMIT);
				const preceding = all.at(-(RECENT_READABLE_RAW_EVENT_LIMIT + 1));
				return projectTranscriptEventsToReadableItems(
					withoutPartialEarliestEventTurn(selected, preceding),
					{ limit: RECENT_READABLE_ITEM_LIMIT },
				);
			}
			const rows = this.#database.prepare(`
				SELECT sequence_no, session_id, event_id, turn_id, event_type,
				       provider_index, model_visible, payload_json, created_at
				FROM transcript_events
				WHERE session_id = ?
				ORDER BY sequence_no DESC
				LIMIT ?
			`).all(
				normalizedSessionId,
				RECENT_READABLE_RAW_EVENT_LIMIT + 1,
			) as readonly TranscriptEventRow[];
			const selectedRows = rows.slice(0, RECENT_READABLE_RAW_EVENT_LIMIT);
			const precedingRow = rows.at(RECENT_READABLE_RAW_EVENT_LIMIT);
			const hydrated = this.#eventsFromRows(precedingRow
				? [...selectedRows, precedingRow]
				: selectedRows);
			const selected = [...hydrated.slice(0, selectedRows.length)].reverse();
			const events = withoutPartialEarliestEventTurn(
				selected,
				precedingRow ? hydrated.at(-1) : undefined,
			);
			return projectTranscriptEventsToReadableItems(events, {
				limit: RECENT_READABLE_ITEM_LIMIT,
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	loadReadableTranscriptPage(
		sessionId: string,
		options: TranscriptReadablePageOptions = {},
	): TranscriptReadablePage {
		try {
			const normalizedSessionId = identity(sessionId, "sessionId");
			const limit = boundedLimit(options.limit, READABLE_PAGE_MAX_ITEMS);
			if (this.#hasLineageParent(normalizedSessionId)) {
				return readablePageFromEvents(
					this.#allEvents(normalizedSessionId),
					options.beforeSequence,
					limit,
				);
			}
			let before = optionalSequence(options.beforeSequence, "beforeSequence");
			let pending: EventGroup | undefined;
			const visibleGroups: VisibleEventGroup[] = [];
			let exhausted = false;

			while (visibleItemCount(visibleGroups) < limit && !exhausted) {
				const rows = this.#database.prepare(`
					SELECT sequence_no, session_id, event_id, turn_id, event_type,
					       provider_index, model_visible, payload_json, created_at
					FROM transcript_events
					WHERE session_id = ?
					${before === undefined ? "" : "AND sequence_no < ?"}
					ORDER BY sequence_no DESC
					LIMIT ?
				`).all(...(
					before === undefined
						? [normalizedSessionId, READABLE_PAGE_RAW_WINDOW_SIZE]
						: [normalizedSessionId, before, READABLE_PAGE_RAW_WINDOW_SIZE]
				)) as readonly TranscriptEventRow[];
				if (rows.length === 0) {
					exhausted = true;
					break;
				}
				const events = [...this.#eventsFromRows(rows)];
				before = events.at(-1)!.sequenceNo;
				const grouped = completeEventGroups(events, pending);
				pending = grouped.pending;
				const hasMoreRows = rows.length === READABLE_PAGE_RAW_WINDOW_SIZE
					&& this.#hasEventBefore(normalizedSessionId, before);
				if (!hasMoreRows && pending) {
					grouped.complete.push(pending);
					pending = undefined;
				}
				visibleGroups.push(...projectVisibleEventGroups(grouped.complete));
				exhausted = !hasMoreRows;
			}

			const selected: VisibleEventGroup[] = [];
			let selectedItems = 0;
			for (const group of visibleGroups) {
				selected.push(group);
				selectedItems += group.items.length;
				if (selectedItems >= limit) break;
			}
			const items = Object.freeze(selected.reverse().flatMap((group) => group.items));
			const oldestSequence = selected.reduce(
				(value, group) => Math.min(value, group.oldestSequence),
				Number.MAX_SAFE_INTEGER,
			);
			const hasOlder = selected.length > 0 && (
				!exhausted || pending !== undefined || selected.length < visibleGroups.length
			);
			return Object.freeze({
				items,
				nextBeforeSequence: hasOlder ? oldestSequence : null,
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	searchMessages(
		query: string,
		options: SessionSearchQuery = {},
	): readonly SessionSearchResult[] {
		const match = ftsMatchQuery(query);
		if (!match) return Object.freeze([]);
		const limit = searchLimit(options.limit);
		const workspaceRoot = options.workspaceRoot?.trim();
		try {
			const visibility = this.#searchVisibility(workspaceRoot);
			const rows = this.#database.prepare(`
				SELECT
					transcript_events_fts.rank AS search_rank,
					events.sequence_no,
					events.session_id,
					events.event_id,
					events.turn_id,
					events.event_type,
					events.provider_index,
					events.model_visible,
					events.payload_json,
					events.created_at
				FROM transcript_events_fts
				JOIN transcript_events events
					ON events.sequence_no = transcript_events_fts.rowid
				JOIN sessions ON sessions.session_id = events.session_id
				WHERE transcript_events_fts MATCH ?
					AND events.model_visible = 1
					AND events.provider_index IS NOT NULL
					AND COALESCE(
						json_extract(events.payload_json, '$.payload.readableProjection.searchVisible'), 1
					) != 0
					${workspaceRoot ? "AND sessions.workspace_root = ?" : ""}
				ORDER BY transcript_events_fts.rank, sessions.last_active_at DESC,
					events.provider_index ASC
				LIMIT ?
			`).all(...(
				workspaceRoot ? [match, workspaceRoot, limit] : [match, limit]
			)) as readonly (TranscriptEventRow & { readonly search_rank: unknown })[];
			const expanded = this.#eventsFromRows(rows).flatMap((event, index) => {
				const row = rows[index]!;
				const document = projectTranscriptEventToSearchDocument(event);
				if (!document) return [];
				const rank = typeof row.search_rank === "number" ? row.search_rank : 0;
				return visibility.flatMap((target) => target.segments.some((segment) => (
					segment.sessionId === event.sessionId
					&& (segment.maxSequence === undefined || event.sequenceNo <= segment.maxSequence)
				)) ? [Object.freeze({
					rank,
					lastActiveAt: target.lastActiveAt,
					result: Object.freeze({
						sessionId: target.sessionId,
						messageIndex: document.messageIndex,
						role: document.role,
						snippet: searchSnippet(document.text, query),
					}),
				})] : []);
			});
			expanded.sort((left, right) => left.rank - right.rank
				|| right.lastActiveAt.localeCompare(left.lastActiveAt)
				|| left.result.messageIndex - right.result.messageIndex
				|| left.result.sessionId.localeCompare(right.result.sessionId));
			return Object.freeze(expanded.slice(0, limit).map((entry) => entry.result));
		} catch (error) {
			throw storageError(error);
		}
	}

	rebuildSearchIndex(): void {
		try {
			this.#write(() => {
				if (this.#schemaVersion === SCHEMA_V10_VERSION) {
					this.#database.prepare(`
						INSERT INTO transcript_events_fts(transcript_events_fts) VALUES ('rebuild')
					`).run();
					return;
				}
				this.#database.prepare("DELETE FROM transcript_events_fts").run();
				const rows = this.#database.prepare(`
					SELECT sequence_no, session_id, event_id, turn_id, event_type,
					       provider_index, model_visible, payload_json, created_at
					FROM transcript_events
					WHERE model_visible = 1
					ORDER BY sequence_no
				`).all() as readonly TranscriptEventRow[];
				const insert = this.#database.prepare(`
					INSERT INTO transcript_events_fts(rowid, payload_json) VALUES (?, ?)
				`);
				for (const event of this.#eventsFromRows(rows)) {
					if (!searchableTranscriptEvent(event)) continue;
					insert.run(event.sequenceNo, canonicalEventPayloadJson(event));
				}
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	#searchVisibility(workspaceRoot: string | undefined): readonly SearchVisibility[] {
		const rows = this.#database.prepare(`
			SELECT session_id, last_active_at FROM sessions
			${workspaceRoot ? "WHERE workspace_root = ?" : ""}
			ORDER BY session_id
		`).all(...(workspaceRoot ? [workspaceRoot] : [])) as readonly {
			readonly session_id: unknown;
			readonly last_active_at: unknown;
		}[];
		return Object.freeze(rows.map((row) => {
			const sessionId = identity(row.session_id, "sessionId");
			return Object.freeze({
				sessionId,
				lastActiveAt: identity(row.last_active_at, "lastActiveAt"),
				segments: this.#lineageSegments(sessionId),
			});
		}));
	}

	sessionMaintenanceReport(options: SessionMaintenanceOptions = {}): SessionMaintenanceReport {
		try {
			const candidateLimit = maintenanceLimit(
				options.candidateLimit ?? 5,
				100,
				"maintenance candidate limit",
			);
			const workspaceRoot = options.workspaceRoot?.trim();
			const where = workspaceRoot ? "WHERE workspace_root = ?" : "";
			const parameters = workspaceRoot ? [workspaceRoot] : [];
			const row = this.#database.prepare(`
				SELECT COUNT(*) AS count FROM sessions ${where}
			`).get(...parameters) as { readonly count: unknown };
			const candidates = this.#emptySessionCandidates(workspaceRoot);
			const storage = this.#storageMetrics();
			return Object.freeze({
				workspaceSessionCount: Number(row.count),
				emptySessionCount: candidates.length,
				emptySessionCandidates: Object.freeze(candidates.slice(0, candidateLimit)),
				emptySessionCandidatesOmitted: Math.max(0, candidates.length - candidateLimit),
				compactableRolloutCount: 0,
				compactableRolloutBytes: 0,
				removableStateCount: 0,
				removableStateBytes: 0,
				estimatedPayloadBytesReclaimable: 0,
				...storage,
				freelistBytes: storage.freelistCount * storage.pageSize,
				...(usesContentBlobs(this.#schemaVersion)
					? { contentBlobs: this.#contentBlobs.metrics() }
					: {}),
				dryRun: true,
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	collectSessionContentBlobOrphans(): SessionContentBlobOrphanCleanupResult {
		if (!usesContentBlobs(this.#schemaVersion)) {
			throw new StorageFailure("session content blob collection requires a blob-backed schema", {
				expected_version: SCHEMA_V12_VERSION,
				actual_version: this.#schemaVersion,
			});
		}
		try {
			return this.#write(() => {
				const collected = this.#contentBlobs.collectOrphans();
				const storage = this.#storageMetrics();
				return Object.freeze({
					...collected,
					...storage,
					freelistBytes: storage.freelistCount * storage.pageSize,
					dryRun: false,
				});
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	cleanupLegacySessionPayloads(
		options: SessionMaintenanceOptions = {},
	): SessionPayloadCleanupResult {
		maintenanceLimit(
			options.payloadLimit ?? 1_000,
			10_000,
			"maintenance payload limit",
		);
		return Object.freeze({
			compactedRolloutCount: 0,
			deletedStateCount: 0,
			removedPayloadBytes: 0,
			remainingCompactableRolloutCount: 0,
			remainingRemovableStateCount: 0,
			...this.#storageMetrics(),
			dryRun: false,
		});
	}

	cleanupEmptySessions(options: SessionMaintenanceOptions = {}): SessionEmptyCleanupResult {
		try {
			const candidateLimit = maintenanceLimit(
				options.candidateLimit ?? 5,
				100,
				"maintenance candidate limit",
			);
			const deletedSessionIds = this.#write(() => {
				const ids = this.#emptySessionCandidates(options.workspaceRoot?.trim())
					.slice(0, candidateLimit)
					.map((candidate) => candidate.sessionId);
				if (ids.length > 0) {
					this.#database.prepare(`
						DELETE FROM sessions WHERE session_id IN (${ids.map(() => "?").join(", ")})
					`).run(...ids);
				}
				return ids;
			});
			const report = this.sessionMaintenanceReport(options);
			return Object.freeze({
				deletedSessionIds: Object.freeze(deletedSessionIds),
				workspaceSessionCount: report.workspaceSessionCount,
				emptySessionCount: report.emptySessionCount,
				emptySessionCandidatesOmitted: report.emptySessionCandidatesOmitted,
				dbSizeBytes: report.dbSizeBytes,
				pageCount: report.pageCount,
				freelistCount: report.freelistCount,
				pageSize: report.pageSize,
				dryRun: false,
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	cleanupOrphanedSessionRows(): SessionOrphanCleanupResult {
		try {
			return this.#write(() => {
				const liveSessionIds = this.#liveRuntimeSessionIds();
				const liveSessionParameters = liveSessionIds.length > 0
					? [JSON.stringify(liveSessionIds)]
					: [];
				const liveSessionClause = liveSessionIds.length > 0
					? "AND session_id NOT IN (SELECT value FROM json_each(?))"
					: "";
				const tables = [
					"conversation_trees",
					"session_state",
					"runtime_turns",
					"shell_output_chunks",
				] as const;
				const deletedRowsByTable: Array<{ readonly table: string; readonly count: number }> = [];
				for (const table of tables) {
					const result = this.#database.prepare(`
						DELETE FROM ${table} WHERE session_id NOT IN (SELECT session_id FROM sessions)
						${liveSessionClause}
					`).run(...liveSessionParameters);
					if (result.changes > 0) deletedRowsByTable.push({ table, count: result.changes });
				}
				const liveParentClause = liveSessionIds.length > 0
					? "AND parent_session_id NOT IN (SELECT value FROM json_each(?))"
					: "";
				const taskResult = this.#database.prepare(`
					DELETE FROM subagent_tasks
					WHERE parent_session_id NOT IN (SELECT session_id FROM sessions)
					${liveParentClause}
				`).run(...liveSessionParameters);
				if (taskResult.changes > 0) {
					deletedRowsByTable.push({ table: "subagent_tasks", count: taskResult.changes });
				}
				return Object.freeze({
					deletedRowsByTable: Object.freeze(deletedRowsByTable),
					totalDeletedRows: deletedRowsByTable.reduce(
						(total, item) => total + item.count,
						0,
					),
					dryRun: false,
				});
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	vacuumSessionStorage(): SessionVacuumResult {
		if (this.#closed) throw new StorageFailure("transcript event repository is closed");
		try {
			const before = this.#storageMetrics();
			this.#database.exec("VACUUM");
			const after = this.#storageMetrics();
			return Object.freeze({
				beforeDbSizeBytes: before.dbSizeBytes,
				afterDbSizeBytes: after.dbSizeBytes,
				beforePageCount: before.pageCount,
				afterPageCount: after.pageCount,
				beforeFreelistCount: before.freelistCount,
				afterFreelistCount: after.freelistCount,
				pageSize: after.pageSize,
				dryRun: false,
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	close(): void {
		if (this.#closed) return;
		try {
			this.#write(() => {
				this.#database.prepare(`
					UPDATE runtime_turns
					SET owner_id = NULL, owner_pid = NULL
					WHERE status = 'in_progress' AND owner_id = ?
				`).run(this.#ownerId);
				this.#database.prepare(`
					DELETE FROM session_runtime_leases
					WHERE owner_id = ?
				`).run(this.#ownerId);
			});
		} finally {
			this.#database.close();
			this.#closed = true;
		}
	}

	#write<Result>(operation: () => Result): Result {
		if (this.#closed) throw new StorageFailure("transcript event repository is closed");
		if (this.#database.inTransaction) return operation();
		try {
			this.#database.exec("BEGIN IMMEDIATE");
			const result = operation();
			this.#database.exec("COMMIT");
			return result;
		} catch (error) {
			if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	#acquireSessionLeaseRecord(sessionId: string): boolean {
		const agentOwner = this.#database.prepare(`
			SELECT owner_pid
			FROM agent_runtime_leases
			WHERE thread_id = ?
		`).get(sessionId) as { readonly owner_pid: unknown } | undefined;
		if (typeof agentOwner?.owner_pid === "number"
			&& Number.isSafeInteger(agentOwner.owner_pid)
			&& agentOwner.owner_pid > 0
			&& this.#isProcessAlive(agentOwner.owner_pid)) {
			throw new SessionInUseError();
		}
		const current = this.#database.prepare(`
			SELECT owner_id, owner_pid
			FROM session_runtime_leases
			WHERE session_id = ?
		`).get(sessionId) as {
			readonly owner_id: unknown;
			readonly owner_pid: unknown;
		} | undefined;
		const now = this.#clock();
		if (!current) {
			this.#database.prepare(`
				INSERT INTO session_runtime_leases (
					session_id, owner_id, owner_pid, acquired_at, updated_at
				) VALUES (?, ?, ?, ?, ?)
			`).run(sessionId, this.#ownerId, this.#processId, now, now);
			return true;
		}
		if (current.owner_id === this.#ownerId) {
			this.#database.prepare(`
				UPDATE session_runtime_leases
				SET owner_pid = ?, updated_at = ?
				WHERE session_id = ? AND owner_id = ?
			`).run(this.#processId, now, sessionId, this.#ownerId);
			return false;
		}
		if (typeof current.owner_pid === "number"
			&& Number.isSafeInteger(current.owner_pid)
			&& current.owner_pid > 0
			&& this.#isProcessAlive(current.owner_pid)) {
			throw new SessionInUseError();
		}
		this.#database.prepare(`
			UPDATE session_runtime_leases
			SET owner_id = ?, owner_pid = ?, acquired_at = ?, updated_at = ?
			WHERE session_id = ?
		`).run(this.#ownerId, this.#processId, now, now, sessionId);
		return true;
	}

	#insertEvent(input: TranscriptEventAppendInput): TranscriptEventEnvelope {
		const providerIndex = input.modelVisible
			? nextProviderIndex(this.#database, input.sessionId)
			: undefined;
		const canonicalStoredValue = Object.freeze({
			schemaVersion: input.schemaVersion,
			payload: input.payload,
		}) as unknown as TranscriptJsonValue;
		const canonicalPayloadJson = stableJson(canonicalStoredValue);
		const externalized = usesContentBlobs(this.#schemaVersion)
			? externalizeTranscriptPayload(canonicalStoredValue)
			: undefined;
		if (externalized) {
			for (const blob of externalized.blobs) this.#contentBlobs.putEncoded(blob);
		}
		const payloadJson = externalized
			? stableJson(externalized.storedValue)
			: canonicalPayloadJson;
		const result = this.#database.prepare(`
			INSERT INTO transcript_events (
				session_id, event_id, turn_id, event_type, provider_index,
				model_visible, payload_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			input.sessionId,
			input.eventId,
			input.turnId ?? null,
			input.eventType,
			providerIndex ?? null,
			input.modelVisible ? 1 : 0,
			payloadJson,
			input.createdAt,
		);
		const event = parseTranscriptEventEnvelope({
			...input,
			sequenceNo: Number(result.lastInsertRowid),
			...(providerIndex === undefined ? {} : { providerIndex }),
		});
		if (externalized) {
			this.#contentBlobs.linkTranscriptEvent(
				event.sequenceNo,
				externalized.references,
			);
		}
		if (usesContentBlobs(this.#schemaVersion) && searchableTranscriptEvent(event)) {
			this.#database.prepare(`
				INSERT INTO transcript_events_fts(rowid, payload_json) VALUES (?, ?)
			`).run(event.sequenceNo, canonicalPayloadJson);
		}
		return event;
	}

	#touchSession(input: ReserveTurnInput): void {
		const now = this.#clock();
		this.#touchSessionIdentity(
			input.sessionId,
			input.workspaceRoot,
			input.threadId,
			now,
		);
	}

	#touchSessionIdentity(
		sessionId: string,
		workspaceRoot: string,
		threadId: string,
		timestamp: string,
	): void {
		this.#database.prepare(`
			INSERT INTO sessions (
				session_id, workspace_root, thread_id, created_at,
				updated_at, last_active_at, status
			) VALUES (?, ?, ?, ?, ?, ?, 'active')
			ON CONFLICT(session_id) DO UPDATE SET
				workspace_root = excluded.workspace_root,
				thread_id = excluded.thread_id,
				updated_at = excluded.updated_at,
				last_active_at = excluded.last_active_at
		`).run(sessionId, workspaceRoot, threadId, timestamp, timestamp, timestamp);
	}

	#touchExistingSession(sessionId: string, timestamp: string): void {
		this.#database.prepare(`
			UPDATE sessions SET updated_at = ?, last_active_at = ? WHERE session_id = ?
		`).run(timestamp, timestamp, sessionId);
	}

	#insertRuntimeTurn(turn: RuntimeTurnRecord): void {
		this.#database.prepare(`
			INSERT INTO runtime_turns (${RUNTIME_TURN_COLUMNS})
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			turn.session_id,
			turn.client_turn_id,
			turn.turn_id,
			turn.request_fingerprint,
			turn.status,
			turn.error_code,
			turn.result === null ? null : stableJson(turn.result),
			turn.started_at,
			turn.completed_at,
			this.#ownerId,
			this.#processId,
		);
	}

	#loadTurn(sessionId: string, clientTurnId: string): RuntimeTurnRecord | undefined {
		const row = this.#database.prepare(`
			SELECT ${RUNTIME_TURN_COLUMNS}
			FROM runtime_turns
			WHERE session_id = ? AND client_turn_id = ?
		`).get(sessionId, clientTurnId) as RuntimeTurnRow | undefined;
		return row ? runtimeTurnFromRow(row) : undefined;
	}

	#requiredTurn(sessionId: string, clientTurnId: string): RuntimeTurnRecord {
		const turn = this.#loadTurn(sessionId, clientTurnId);
		if (!turn) throw new StorageFailure("runtime turn does not exist");
		return turn;
	}

	#requireRunningTurn(sessionId: string, clientTurnId: string): RuntimeTurnRecord {
		const turn = this.#requiredTurn(sessionId, clientTurnId);
		if (turn.status !== "in_progress") {
			throw new StorageFailure("invalid runtime turn transition", {
				current_status: turn.status,
			});
		}
		return turn;
	}

	#assertToolResultMatchesPending(input: AppendToolResultInput): void {
		const turn = this.#requireRunningTurn(input.sessionId, input.clientTurnId);
		const expected = this.loadPendingToolCalls(input.sessionId, turn.turn_id)[0];
		if (!expected || expected.callId !== input.result.callId
			|| expected.name !== input.result.toolName) {
			throw new StorageFailure("continuation tool result does not match pending call");
		}
	}

	#assertContinuationToolCall(
		sessionId: string,
		clientTurnId: string,
		turnId: string,
		callId: string,
		toolName: string,
		requirePending: boolean,
	): void {
		const turn = this.#requireRunningTurn(sessionId, clientTurnId);
		if (turn.turn_id !== turnId) {
			throw new SessionStateError("session_state_invalid", "suspended_turn");
		}
		const call = this.#turnEvents(sessionId, turnId).flatMap((event) => (
			event.eventType === "assistant_tool_call_batch" ? event.payload.calls : []
		)).find((candidate) => candidate.callId === callId && candidate.name === toolName);
		if (!call) throw new SessionStateError("session_state_invalid", "suspended_turn");
		if (requirePending && !this.loadPendingToolCalls(sessionId, turnId).some(
			(candidate) => candidate.callId === callId && candidate.name === toolName,
		)) {
			throw new SessionStateError("session_state_invalid", "suspended_turn");
		}
	}

	#toolCallEventId(sessionId: string, turnId: string, callId: string): string {
		const event = this.#turnEvents(sessionId, turnId).find((candidate) => (
			candidate.eventType === "assistant_tool_call_batch"
			&& candidate.payload.calls.some((call) => call.callId === callId)
		));
		if (!event) throw new SessionStateError("session_state_invalid", "suspended_turn");
		return event.eventId;
	}

	#validateStandaloneStateReference(
		sessionId: string,
		key: RuntimeStateKey,
		payload: unknown,
	): void {
		if (key === "compact_checkpoint" && isRecord(payload)
			&& typeof payload.transcript_event_id === "string") {
			const event = this.loadEvent(sessionId, payload.transcript_event_id);
			if (event?.eventType !== "compaction" || event.payload.windowId !== payload.window_id) {
				throw new SessionStateError("session_state_invalid", "compact_checkpoint");
			}
		}
		if (key !== "responses_continuation_state") return;
		const state = parseRuntimeState({ kind: "responses_continuation", version: 1, payload });
		if (state.kind !== "responses_continuation" || !state.payload.eligible) return;
		const responseId = identity(state.payload.response_id, "responseId");
		const found = this.#allEvents(sessionId).some((event) => (
			(event.eventType === "assistant_output"
				|| event.eventType === "assistant_tool_call_batch")
			&& event.payload.responseId === responseId
		));
		if (!found) {
			throw new SessionStateError("session_state_invalid", "responses_continuation_state");
		}
	}

	#validateSuspendedReference(sessionId: string, payload: unknown): void {
		const state = parseRuntimeState({ kind: "suspended_turn", version: 1, payload });
		if (state.kind !== "suspended_turn") {
			throw new SessionStateError("session_state_invalid", "suspended_turn");
		}
		const clientTurnId = identity(state.payload.client_turn_id, "clientTurnId");
		const turnId = identity(state.payload.turn_id, "turnId");
		if (typeof state.payload.transcript_event_id === "string") {
			const event = this.loadEvent(sessionId, state.payload.transcript_event_id);
			if (event?.eventType !== "assistant_tool_call_batch" || event.turnId !== turnId) {
				throw new SessionStateError("session_state_invalid", "suspended_turn");
			}
		}
		if (state.payload.pending_clarification) {
			const call = state.payload.pending_clarification.tool_call;
			this.#assertContinuationToolCall(
				sessionId,
				clientTurnId,
				turnId,
				state.payload.pending_clarification.request_id,
				call.name,
				true,
			);
			return;
		}
		const pendingPayload = this.#stateRepository.loadState(sessionId, "pending_decision");
		if (pendingPayload === undefined) {
			throw new SessionStateError("session_state_invalid", "pending_decision");
		}
		const pending = parseRuntimeState({ kind: "pending_decision", version: 1, payload: pendingPayload });
		if (pending.kind !== "pending_decision") {
			throw new SessionStateError("session_state_invalid", "pending_decision");
		}
		this.#assertContinuationToolCall(
			sessionId,
			clientTurnId,
			turnId,
			pending.payload.tool_call.call_id,
			pending.payload.tool_call.name,
			true,
		);
	}

	#validateEffectReference(sessionId: string, payload: unknown): void {
		const state = parseRuntimeState({ kind: "effect_checkpoint", version: 1, payload });
		if (state.kind !== "effect_checkpoint") {
			throw new SessionStateError("session_state_invalid", "node_effect_checkpoint");
		}
		this.#assertContinuationToolCall(
			sessionId,
			state.payload.client_turn_id,
			state.payload.turn_id,
			state.payload.call_id,
			state.payload.tool_name,
			["waiting", "approved", "executing"].includes(state.payload.status),
		);
	}

	#isContinuationTurn(turn: RuntimeTurnRecord): boolean {
		if (!this.#stateRepository.isContinuationTurn(
			turn.session_id,
			turn.client_turn_id,
			turn.turn_id,
		)) return false;
		const suspended = this.#stateRepository.loadState(turn.session_id, "suspended_turn");
		if (suspended === undefined) {
			throw new SessionStateError("session_state_invalid", "suspended_turn");
		}
		this.#validateSuspendedReference(turn.session_id, suspended);
		const effect = this.#stateRepository.loadState(turn.session_id, "node_effect_checkpoint");
		if (effect !== undefined) this.#validateEffectReference(turn.session_id, effect);
		return true;
	}

	#knownToolCallIds(sessionId: string): ReadonlySet<string> {
		const rows = this.#database.prepare(`
			SELECT sequence_no, session_id, event_id, turn_id, event_type,
			       provider_index, model_visible, payload_json, created_at
			FROM transcript_events
			WHERE session_id = ? AND event_type = 'assistant_tool_call_batch'
			ORDER BY sequence_no
		`).all(sessionId) as readonly TranscriptEventRow[];
		const ids = new Set<string>();
		for (const event of this.#eventsFromRows(rows)) {
			if (event.eventType !== "assistant_tool_call_batch") continue;
			for (const call of event.payload.calls) ids.add(call.callId);
		}
		return ids;
	}

	#committedQueueIds(sessionId: string): ReadonlySet<string> {
		const rows = this.#database.prepare(`
			SELECT sequence_no, session_id, event_id, turn_id, event_type,
			       provider_index, model_visible, payload_json, created_at
			FROM transcript_events
			WHERE session_id = ? AND event_type = 'user_input'
			ORDER BY sequence_no
		`).all(sessionId) as readonly TranscriptEventRow[];
		return new Set(this.#eventsFromRows(rows).flatMap((event) => {
			return event.eventType === "user_input" && event.payload.queueId
				? [event.payload.queueId]
				: [];
		}));
	}

	#appendContextEvent(input: AppendContextItemInput, createdAt: string): void {
		this.#insertEvent(parseTranscriptEventAppendInput({
			schemaVersion: 1,
			sessionId: input.sessionId,
			eventId: semanticEventId(input.sessionId, "context", input.itemId),
			eventType: "context",
			modelVisible: true,
			createdAt,
			payload: {
				itemId: input.itemId,
				text: input.text,
				metadata: input.metadata,
			},
		}));
	}

	#appendDisplayActivityEvent(
		input: AppendTranscriptDisplayActivityInput,
	): TranscriptEventEnvelope<"display_activity"> {
		const event = this.#insertEvent(parseTranscriptEventAppendInput({
			schemaVersion: 1,
			sessionId: input.sessionId,
			eventId: input.eventId,
			...(input.turnId ? { turnId: input.turnId } : {}),
			eventType: "display_activity",
			modelVisible: false,
			createdAt: input.createdAt,
			payload: {
				activityType: input.activityType,
				...(input.text === undefined ? {} : { text: input.text }),
				...(input.callId ? { callId: input.callId } : {}),
				...(input.toolName ? { toolName: input.toolName } : {}),
				...(input.status ? { status: input.status } : {}),
				...(input.metadata ? { metadata: input.metadata } : {}),
			},
		}));
		if (event.eventType !== "display_activity") {
			throw new StorageFailure("display transcript event has an invalid type");
		}
		return event;
	}

	#appendToolResultEvent(
		turn: RuntimeTurnRecord,
		input: AppendToolResultInput,
		createdAt: string,
	): void {
		this.#insertEvent(parseTranscriptEventAppendInput({
			schemaVersion: 1,
			sessionId: input.sessionId,
			eventId: semanticEventId(turn.turn_id, "tool-result", input.result.callId),
			turnId: turn.turn_id,
			eventType: "tool_result",
			modelVisible: true,
			createdAt,
			payload: {
				result: input.result,
				summary: input.summary.slice(0, 500),
				...(input.errorKind ? { errorKind: input.errorKind } : {}),
				...eventToolResultMetadata(input),
			},
		}));
	}

	#appendSyntheticToolResult(
		turn: RuntimeTurnRecord,
		call: CanonicalToolCall,
		status: "failed" | "interrupted",
		createdAt: string,
	): void {
		const interrupted = status === "interrupted";
		this.#appendToolResultEvent(turn, {
			sessionId: turn.session_id,
			clientTurnId: turn.client_turn_id,
			result: {
				callId: call.callId,
				toolName: call.name,
				output: interrupted
					? "Tool execution was interrupted before a result was persisted."
					: "Tool result unavailable because the turn failed before persistence completed.",
				success: false,
			},
			summary: `${call.name.slice(0, 128) || "Tool"} ${interrupted ? "interrupted" : "result unavailable"}`,
			errorKind: interrupted ? "tool_interrupted" : "tool_result_unavailable",
			metadata: { synthetic: true, append_only: true },
		}, createdAt);
	}

	#appendTurnAbortedEvent(turn: RuntimeTurnRecord, createdAt: string): void {
		const marker = turnAbortedContextItem(turn.turn_id);
		this.#appendContextEvent({
			sessionId: turn.session_id,
			itemId: marker.itemId,
			text: marker.item.text,
			metadata: marker.item.metadata,
		}, createdAt);
	}

	#appendInterruptedTurnDisplay(turn: RuntimeTurnRecord, createdAt: string): void {
		const eventId = turnInterruptedNoticeId(turn.turn_id);
		const existing = this.#database.prepare(`
			SELECT 1 FROM transcript_events
			WHERE session_id = ? AND event_id = ? LIMIT 1
		`).get(turn.session_id, eventId);
		if (existing) return;
		this.#appendDisplayActivityEvent({
			sessionId: turn.session_id,
			eventId,
			turnId: turn.turn_id,
			activityType: "warning",
			text: TURN_INTERRUPTED_NOTICE,
			status: "interrupted",
			metadata: {
				event_kind: "turn_interrupted",
				interrupted_turn_id: turn.turn_id,
				status: "interrupted",
			},
			createdAt,
		});
	}

	#appendFailedTurnDisplay(
		turn: RuntimeTurnRecord,
		code: RuntimeErrorCode,
		createdAt: string,
		message?: string,
		additionalDetails?: string,
	): void {
		const eventId = turnFailedNoticeId(turn.turn_id);
		const existing = this.#database.prepare(`
			SELECT 1 FROM transcript_events
			WHERE session_id = ? AND event_id = ? LIMIT 1
		`).get(turn.session_id, eventId);
		if (existing) return;
		this.#appendDisplayActivityEvent({
			sessionId: turn.session_id,
			eventId,
			turnId: turn.turn_id,
			activityType: "error",
			text: turnFailureNotice(code, message),
			status: "failed",
			metadata: {
				event_kind: "turn_failed",
				failed_turn_id: turn.turn_id,
				status: "failed",
					code,
					source: "runtime",
					...(additionalDetails ? { additional_details: additionalDetails } : {}),
				},
			createdAt,
		});
	}

	#appendLifecycleEvent(
		turn: RuntimeTurnRecord,
		phase: "completed" | "failed" | "interrupted",
		createdAt: string,
		details: Readonly<Record<string, unknown>>,
	): void {
		this.#insertEvent(parseTranscriptEventAppendInput({
			schemaVersion: 1,
			sessionId: turn.session_id,
			eventId: semanticEventId(turn.turn_id, "lifecycle", phase),
			turnId: turn.turn_id,
			eventType: "turn_lifecycle",
			modelVisible: false,
			createdAt,
			payload: { phase, ...details },
		}));
	}

	#emptySessionCandidates(workspaceRoot?: string): readonly SessionMaintenanceCandidate[] {
		const where = workspaceRoot ? "AND sessions.workspace_root = ?" : "";
		const liveSessionIds = this.#liveRuntimeSessionIds();
		const liveSessionClause = liveSessionIds.length > 0
			? "AND sessions.session_id NOT IN (SELECT value FROM json_each(?))"
			: "";
		const parameters = [
			...(workspaceRoot ? [workspaceRoot] : []),
			...(liveSessionIds.length > 0 ? [JSON.stringify(liveSessionIds)] : []),
		];
		const rows = this.#database.prepare(`
			SELECT sessions.session_id, sessions.last_active_at, sessions.status
			FROM sessions
			WHERE NOT EXISTS (
				SELECT 1 FROM transcript_events
				WHERE transcript_events.session_id = sessions.session_id
			)
			AND NOT EXISTS (
				SELECT 1 FROM session_state
				WHERE session_state.session_id = sessions.session_id
			)
			AND NOT EXISTS (
				SELECT 1 FROM conversation_trees
				WHERE conversation_trees.session_id = sessions.session_id
					AND conversation_trees.parent_id IS NOT NULL
			)
			AND NOT EXISTS (
				SELECT 1 FROM conversation_trees
				WHERE conversation_trees.parent_id = sessions.session_id
			)
			${where}
			${liveSessionClause}
			ORDER BY sessions.last_active_at ASC, sessions.session_id ASC
		`).all(...parameters) as readonly {
			readonly session_id: unknown;
			readonly last_active_at: unknown;
			readonly status: unknown;
		}[];
		return Object.freeze(rows.map((row) => Object.freeze({
			sessionId: String(row.session_id),
			lastActiveAt: String(row.last_active_at),
			status: String(row.status),
		})));
	}

	#liveRuntimeSessionIds(): readonly string[] {
		const rows = this.#database.prepare(`
			SELECT session_id, owner_pid FROM session_runtime_leases
			UNION ALL
			SELECT thread_id AS session_id, owner_pid FROM agent_runtime_leases
		`).all() as readonly {
			readonly session_id: unknown;
			readonly owner_pid: unknown;
		}[];
		const sessionIds = new Set<string>();
		for (const row of rows) {
			if (typeof row.session_id !== "string" || row.session_id.length === 0
				|| typeof row.owner_pid !== "number" || !Number.isSafeInteger(row.owner_pid)
				|| row.owner_pid <= 0 || !this.#isProcessAlive(row.owner_pid)) {
				continue;
			}
			sessionIds.add(row.session_id);
		}
		return Object.freeze([...sessionIds]);
	}

	#reconcileStaleSessionRuntimeLeases(): void {
		this.#write(() => {
			const rows = this.#database.prepare(`
				SELECT rowid, owner_pid FROM session_runtime_leases
			`).all() as readonly {
				readonly rowid: unknown;
				readonly owner_pid: unknown;
			}[];
			const staleRowIds = rows.flatMap((row): number[] => {
				if (typeof row.rowid !== "number" || !Number.isSafeInteger(row.rowid)) return [];
				if (typeof row.owner_pid !== "number" || !Number.isSafeInteger(row.owner_pid)
					|| row.owner_pid <= 0 || !this.#isProcessAlive(row.owner_pid)) {
					return [row.rowid];
				}
				return [];
			});
			if (staleRowIds.length === 0) return;
			this.#database.prepare(`
				DELETE FROM session_runtime_leases
				WHERE rowid IN (SELECT value FROM json_each(?))
			`).run(JSON.stringify(staleRowIds));
		});
	}

	#storageMetrics(): SessionStorageMetrics {
		const metric = (name: "page_count" | "freelist_count" | "page_size"): number =>
			Number(this.#database.pragma(name, { simple: true }));
		return Object.freeze({
			dbSizeBytes: statSync(this.#dbPath).size,
			pageCount: metric("page_count"),
			freelistCount: metric("freelist_count"),
			pageSize: metric("page_size"),
		});
	}

	#configure(busyTimeoutMs: number): void {
		this.#database.pragma("journal_mode = WAL");
		this.#database.pragma("foreign_keys = ON");
		this.#database.pragma(`busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
	}

	#eventWindow(
		where: string,
		parameters: readonly unknown[],
		direction: "ASC" | "DESC",
		limit: number,
		reverse: boolean,
	): TranscriptEventWindow {
		const rows = this.#database.prepare(`
			SELECT sequence_no, session_id, event_id, turn_id, event_type,
			       provider_index, model_visible, payload_json, created_at
			FROM transcript_events
			WHERE ${where}
			ORDER BY sequence_no ${direction}
			LIMIT ?
		`).all(...parameters, limit + 1) as readonly TranscriptEventRow[];
		const hasMore = rows.length > limit;
		const selected = [...this.#eventsFromRows(rows.slice(0, limit))];
		if (reverse) selected.reverse();
		return Object.freeze({ events: Object.freeze(selected), hasMore });
	}

	#eventFromRow(row: TranscriptEventRow): TranscriptEventEnvelope {
		return this.#eventsFromRows([row])[0]!;
	}

	#eventsFromRows(rows: readonly TranscriptEventRow[]): readonly TranscriptEventEnvelope[] {
		if (rows.length === 0) return Object.freeze([]);
		if (this.#schemaVersion === SCHEMA_V10_VERSION) {
			return Object.freeze(rows.map((row) => eventFromRow(row)));
		}

		const sequenceNumbers = rows.map((row) => eventSequence(row.sequence_no));
		const referencesBySequence = new Map<number, TranscriptPayloadBlobReference[]>();
		for (let offset = 0; offset < sequenceNumbers.length; offset += 500) {
			const batch = sequenceNumbers.slice(offset, offset + 500);
			const references = this.#database.prepare(`
				SELECT sequence_no, json_pointer, blob_id
				FROM transcript_event_blob_refs
				WHERE sequence_no IN (${batch.map(() => "?").join(", ")})
				ORDER BY sequence_no, json_pointer
			`).all(...batch) as readonly TranscriptEventBlobReferenceRow[];
			for (const row of references) {
				if (typeof row.sequence_no !== "number" || typeof row.json_pointer !== "string"
					|| typeof row.blob_id !== "string") {
					throw new StorageFailure("transcript event blob reference row is invalid");
				}
				const selected = referencesBySequence.get(row.sequence_no) ?? [];
				selected.push(Object.freeze({
					jsonPointer: row.json_pointer,
					blobId: row.blob_id,
				}));
				referencesBySequence.set(row.sequence_no, selected);
			}
		}

		const contentIds = [...new Set(
			[...referencesBySequence.values()].flatMap((references) => (
				references.map((reference) => reference.blobId)
			)),
		)];
		const contentById = new Map<string, StoredSessionContentBlob>();
		for (let offset = 0; offset < contentIds.length;
			offset += SESSION_CONTENT_BLOB_LOAD_MANY_MAX_IDS) {
			const batch = contentIds.slice(offset, offset + SESSION_CONTENT_BLOB_LOAD_MANY_MAX_IDS);
			const loaded = this.#contentBlobs.loadMany(batch);
			for (const [index, blob] of loaded.entries()) {
				if (blob) contentById.set(batch[index]!, blob);
			}
		}
		const hydrationCache = new Map<string, string>();
		return Object.freeze(rows.map((row, index) => eventFromRow(row, (storedValue) => {
			const references = referencesBySequence.get(sequenceNumbers[index]!) ?? [];
			if (references.length === 0) return storedValue;
			return hydrateTranscriptPayload(
				storedValue,
				references,
				(blobId) => contentById.get(blobId),
				{ cache: hydrationCache },
			);
		})));
	}

	#rollbackWindows(sessionId: string): readonly RollbackWindow[] {
		const rows = this.#database.prepare(`
			SELECT sequence_no, session_id, event_id, turn_id, event_type,
			       provider_index, model_visible, payload_json, created_at
			FROM transcript_events
			WHERE session_id = ? AND event_type = 'rollback'
			ORDER BY sequence_no
		`).all(sessionId) as readonly TranscriptEventRow[];
		if (rows.length === 0) return Object.freeze([]);
		return rollbackWindowsFromEvents(this.#localEvents(sessionId));
	}

	#hasValidCompactionSource(
		compaction: TranscriptEventEnvelope<"compaction">,
		rollbackWindows: readonly RollbackWindow[],
	): boolean {
		if (!compaction.payload.sourceEventId) return true;
		const row = this.#database.prepare(`
			SELECT sequence_no, session_id, event_id, turn_id, event_type,
			       provider_index, model_visible, payload_json, created_at
			FROM transcript_events
			WHERE session_id = ? AND event_id = ?
		`).get(compaction.sessionId, compaction.payload.sourceEventId) as TranscriptEventRow | undefined;
		if (!row) return false;
		const source = this.#eventFromRow(row);
		return source.sequenceNo < compaction.sequenceNo
			&& source.modelVisible
			&& source.providerIndex === compaction.payload.sourceProviderIndex
			&& eventSurvivesRollbacks(source, rollbackWindows);
	}

	#latestProviderEvent(sessionId: string): TranscriptEventEnvelope | undefined {
		const row = this.#database.prepare(`
			SELECT sequence_no, session_id, event_id, turn_id, event_type,
			       provider_index, model_visible, payload_json, created_at
			FROM transcript_events
			WHERE session_id = ? AND model_visible = 1
			ORDER BY provider_index DESC
			LIMIT 1
		`).get(sessionId) as TranscriptEventRow | undefined;
		return row ? this.#eventFromRow(row) : undefined;
	}

	#sessionIdentity(sessionId: string): Readonly<{
		readonly workspaceRoot: string;
		readonly threadId: string;
	}> {
		const row = this.#database.prepare(`
			SELECT workspace_root, thread_id FROM sessions WHERE session_id = ?
		`).get(sessionId) as {
			readonly workspace_root: unknown;
			readonly thread_id: unknown;
		} | undefined;
		if (!row || typeof row.workspace_root !== "string" || !row.workspace_root
			|| typeof row.thread_id !== "string" || !row.thread_id) {
			throw new StorageFailure("session identity does not exist");
		}
		return Object.freeze({ workspaceRoot: row.workspace_root, threadId: row.thread_id });
	}

	#sessionOverview(row: NormalizedSessionRow): SessionOverview {
		const sessionId = identity(row.session_id, "sessionId");
		const segments = this.#lineageSegments(sessionId);
		let messageCount = 0;
		let summaryCount = 0;
		for (const segment of segments) {
			const counts = this.#database.prepare(`
				SELECT
					COALESCE(MAX(provider_index), -1) + 1 AS provider_count,
					SUM(CASE WHEN event_type = 'compaction' THEN 1 ELSE 0 END) AS summary_count
				FROM transcript_events
				WHERE session_id = ?
				${segment.maxSequence === undefined ? "" : "AND sequence_no <= ?"}
			`).get(...(
				segment.maxSequence === undefined
					? [segment.sessionId]
					: [segment.sessionId, segment.maxSequence]
			)) as { readonly provider_count: unknown; readonly summary_count: unknown };
			messageCount = Math.max(messageCount, Number(counts.provider_count ?? 0));
			summaryCount += Number(counts.summary_count ?? 0);
		}
		const link = this.#lineageLink(sessionId, true);
		return Object.freeze({
			sessionId,
			workspaceRoot: identity(row.workspace_root, "workspaceRoot"),
			threadId: identity(row.thread_id, "threadId"),
			createdAt: identity(row.created_at, "createdAt"),
			updatedAt: identity(row.updated_at, "updatedAt"),
			lastActiveAt: identity(row.last_active_at, "lastActiveAt"),
			status: identity(row.status, "status"),
			messageCount,
			summaryCount,
			...(link.parentId ? { parentId: link.parentId } : {}),
			...(link.forkPoint === undefined ? {} : { forkPoint: link.forkPoint }),
		});
	}

	#sessionExists(sessionId: string): boolean {
		return this.#database.prepare(
			"SELECT 1 AS present FROM sessions WHERE session_id = ?",
		).get(sessionId) !== undefined;
	}

	#lineageLink(sessionId: string, required: boolean): LineageLink {
		const row = this.#database.prepare(`
			SELECT sessions.session_id, trees.parent_id, trees.fork_point,
			       trees.fork_event_session_id, trees.fork_event_id
			FROM sessions
			LEFT JOIN conversation_trees AS trees ON trees.session_id = sessions.session_id
			WHERE sessions.session_id = ?
		`).get(sessionId) as {
			readonly session_id: unknown;
			readonly parent_id: unknown;
			readonly fork_point: unknown;
			readonly fork_event_session_id: unknown;
			readonly fork_event_id: unknown;
		} | undefined;
		if (!row) {
			if (required) throw new StorageFailure("session does not exist");
			return Object.freeze({ sessionId });
		}
		const forkPoint = typeof row.fork_point === "number"
			&& Number.isSafeInteger(row.fork_point)
			&& row.fork_point >= 0
			? row.fork_point
			: undefined;
		return Object.freeze({
			sessionId: String(row.session_id),
			...(typeof row.parent_id === "string" && row.parent_id
				? { parentId: row.parent_id }
				: {}),
			...(forkPoint === undefined ? {} : { forkPoint }),
			...(typeof row.fork_event_session_id === "string" && row.fork_event_session_id
				? { forkEventSessionId: row.fork_event_session_id }
				: {}),
			...(typeof row.fork_event_id === "string" && row.fork_event_id
				? { forkEventId: row.fork_event_id }
				: {}),
		});
	}

	#hasLineageParent(sessionId: string): boolean {
		return this.#lineageLink(sessionId, false).parentId !== undefined;
	}

	#providerEvents(sessionId: string, afterSequence: number): readonly TranscriptEventEnvelope[] {
		const rows = this.#database.prepare(`
			SELECT sequence_no, session_id, event_id, turn_id, event_type,
			       provider_index, model_visible, payload_json, created_at
			FROM transcript_events
			WHERE session_id = ? AND model_visible = 1 AND sequence_no > ?
			ORDER BY sequence_no
		`).all(sessionId, afterSequence) as readonly TranscriptEventRow[];
		return this.#eventsFromRows(rows);
	}

	#turnProviderEvents(
		sessionId: string,
		turnId: string,
	): readonly TranscriptEventEnvelope[] {
		const rows = this.#database.prepare(`
			SELECT sequence_no, session_id, event_id, turn_id, event_type,
			       provider_index, model_visible, payload_json, created_at
			FROM transcript_events
			WHERE session_id = ? AND turn_id = ? AND model_visible = 1
			ORDER BY sequence_no
		`).all(sessionId, turnId) as readonly TranscriptEventRow[];
		return this.#eventsFromRows(rows);
	}

	#turnEvents(sessionId: string, turnId: string): readonly TranscriptEventEnvelope[] {
		const rows = this.#database.prepare(`
			SELECT sequence_no, session_id, event_id, turn_id, event_type,
			       provider_index, model_visible, payload_json, created_at
			FROM transcript_events
			WHERE session_id = ? AND turn_id = ?
			ORDER BY sequence_no
		`).all(sessionId, turnId) as readonly TranscriptEventRow[];
		return this.#eventsFromRows(rows);
	}

	#activeToolCallIds(sessionId: string): ReadonlySet<string> {
		const rows = this.#database.prepare(`
			SELECT events.sequence_no, events.session_id, events.event_id, events.turn_id,
			       events.event_type, events.provider_index, events.model_visible,
			       events.payload_json, events.created_at
			FROM transcript_events events
			JOIN runtime_turns turns
			  ON turns.session_id = events.session_id AND turns.turn_id = events.turn_id
			WHERE events.session_id = ?
			  AND turns.status = 'in_progress'
			  AND events.event_type = 'assistant_tool_call_batch'
			ORDER BY events.sequence_no
		`).all(sessionId) as readonly TranscriptEventRow[];
		const ids = new Set<string>();
		for (const event of this.#eventsFromRows(rows)) {
			if (event.eventType !== "assistant_tool_call_batch") continue;
			for (const call of event.payload.calls) ids.add(call.callId);
		}
		return ids;
	}

	#localEvents(sessionId: string): readonly TranscriptEventEnvelope[] {
		const rows = this.#database.prepare(`
			SELECT sequence_no, session_id, event_id, turn_id, event_type,
			       provider_index, model_visible, payload_json, created_at
			FROM transcript_events
			WHERE session_id = ?
			ORDER BY sequence_no
		`).all(sessionId) as readonly TranscriptEventRow[];
		return this.#eventsFromRows(rows);
	}

	#allEvents(
		sessionId: string,
		seen: ReadonlySet<string> = new Set<string>(),
	): readonly TranscriptEventEnvelope[] {
		if (seen.has(sessionId)) throw new StorageFailure("session lineage contains a cycle");
		if (seen.size >= 100) throw new StorageFailure("session lineage exceeds depth limit");
		const link = this.#lineageLink(sessionId, true);
		const local = this.#localEvents(sessionId);
		if (!link.parentId) return local;
		const nextSeen = new Set(seen);
		nextSeen.add(sessionId);
		const parent = this.#allEvents(link.parentId, nextSeen);
		const prefix = lineagePrefix(parent, link);
		return Object.freeze([...prefix, ...local]);
	}

	#lineageSegments(
		sessionId: string,
		seen: ReadonlySet<string> = new Set<string>(),
	): readonly LineageEventSegment[] {
		if (seen.has(sessionId)) throw new StorageFailure("session lineage contains a cycle");
		if (seen.size >= 100) throw new StorageFailure("session lineage exceeds depth limit");
		const link = this.#lineageLink(sessionId, true);
		if (!link.parentId) return Object.freeze([{ sessionId }]);
		if (!link.forkEventId || !link.forkEventSessionId) {
			const parent = this.#allEvents(link.parentId, new Set([...seen, sessionId]));
			const prefix = lineagePrefix(parent, link);
			return Object.freeze([
				...segmentsForMaterializedPrefix(prefix),
				{ sessionId },
			]);
		}
		const parentSegments = [...this.#lineageSegments(link.parentId, new Set([...seen, sessionId]))];
		const ownerIndex = parentSegments.findIndex(
			(segment) => segment.sessionId === link.forkEventSessionId,
		);
		if (ownerIndex < 0) throw new StorageFailure("lineage fork event owner is not an ancestor");
		const boundary = this.#database.prepare(`
			SELECT sequence_no FROM transcript_events
			WHERE session_id = ? AND event_id = ?
		`).get(link.forkEventSessionId, link.forkEventId) as {
			readonly sequence_no: unknown;
		} | undefined;
		if (!boundary || !Number.isSafeInteger(boundary.sequence_no)) {
			throw new StorageFailure("lineage fork event does not exist in parent prefix");
		}
		const sequenceNo = Number(boundary.sequence_no);
		const owner = parentSegments[ownerIndex]!;
		if (owner.maxSequence !== undefined && sequenceNo > owner.maxSequence) {
			throw new StorageFailure("lineage fork event is outside the parent prefix");
		}
		return Object.freeze([
			...parentSegments.slice(0, ownerIndex),
			{ sessionId: owner.sessionId, maxSequence: sequenceNo },
			{ sessionId },
		]);
	}

	#lineageHasRollback(segments: readonly LineageEventSegment[]): boolean {
		return segments.some((segment) => this.#database.prepare(`
			SELECT 1 AS present FROM transcript_events
			WHERE session_id = ? AND event_type = 'rollback'
			${segment.maxSequence === undefined ? "" : "AND sequence_no <= ?"}
			LIMIT 1
		`).get(...(
			segment.maxSequence === undefined
				? [segment.sessionId]
				: [segment.sessionId, segment.maxSequence]
		)) !== undefined);
	}

	#latestCompactionInSegments(
		segments: readonly LineageEventSegment[],
	): TranscriptEventEnvelope<"compaction"> | undefined {
		let latest: TranscriptEventEnvelope<"compaction"> | undefined;
		for (const segment of segments) {
			const row = this.#database.prepare(`
				SELECT sequence_no, session_id, event_id, turn_id, event_type,
				       provider_index, model_visible, payload_json, created_at
				FROM transcript_events
				WHERE session_id = ? AND event_type = 'compaction'
				${segment.maxSequence === undefined ? "" : "AND sequence_no <= ?"}
				ORDER BY sequence_no DESC
				LIMIT 1
			`).get(...(
				segment.maxSequence === undefined
					? [segment.sessionId]
					: [segment.sessionId, segment.maxSequence]
			)) as TranscriptEventRow | undefined;
			if (!row) continue;
			const event = this.#eventFromRow(row);
			if (event.eventType !== "compaction") {
				throw new StorageFailure("latest compaction event has an invalid type");
			}
			if (!latest || event.sequenceNo > latest.sequenceNo) latest = event;
		}
		if (!latest?.payload.sourceEventId) return latest;
		const source = this.#eventInSegments(segments, latest.payload.sourceEventId);
		return source?.modelVisible
			&& source.sequenceNo < latest.sequenceNo
			&& source.providerIndex === latest.payload.sourceProviderIndex
			? latest
			: undefined;
	}

	#eventInSegments(
		segments: readonly LineageEventSegment[],
		eventId: string,
	): TranscriptEventEnvelope | undefined {
		for (const segment of segments) {
			const row = this.#database.prepare(`
				SELECT sequence_no, session_id, event_id, turn_id, event_type,
				       provider_index, model_visible, payload_json, created_at
				FROM transcript_events
				WHERE session_id = ? AND event_id = ?
				${segment.maxSequence === undefined ? "" : "AND sequence_no <= ?"}
			`).get(...(
				segment.maxSequence === undefined
					? [segment.sessionId, eventId]
					: [segment.sessionId, eventId, segment.maxSequence]
			)) as TranscriptEventRow | undefined;
			if (row) return this.#eventFromRow(row);
		}
		return undefined;
	}

	#providerEventsInSegments(
		segments: readonly LineageEventSegment[],
		afterSequence: number,
	): readonly TranscriptEventEnvelope[] {
		const events = segments.flatMap((segment) => {
			const rows = this.#database.prepare(`
				SELECT sequence_no, session_id, event_id, turn_id, event_type,
				       provider_index, model_visible, payload_json, created_at
				FROM transcript_events
				WHERE session_id = ? AND model_visible = 1 AND sequence_no > ?
				${segment.maxSequence === undefined ? "" : "AND sequence_no <= ?"}
				ORDER BY sequence_no
			`).all(...(
				segment.maxSequence === undefined
					? [segment.sessionId, afterSequence]
					: [segment.sessionId, afterSequence, segment.maxSequence]
			)) as readonly TranscriptEventRow[];
			return [...this.#eventsFromRows(rows)];
		});
		return Object.freeze(events.sort((left, right) => left.sequenceNo - right.sequenceNo));
	}

	#forkBoundary(
		sessionId: string,
		input: ForkSessionInput,
	): Readonly<{ readonly forkPoint: number; readonly event?: TranscriptEventEnvelope }> {
		const events = this.#allEvents(sessionId);
		const rollbacks = rollbackWindowsFromEvents(events);
		const surviving = events.filter((event) => eventSurvivesRollbacks(event, rollbacks));
		const completed = surviving.filter((event): event is TranscriptEventEnvelope<"turn_lifecycle"> => (
			event.eventType === "turn_lifecycle" && event.payload.phase === "completed"
		));
		let event: TranscriptEventEnvelope | undefined;
		if (input.forkEventId !== undefined) {
			const eventId = identity(input.forkEventId, "forkEventId");
			const matches = completed.filter((candidate) => candidate.eventId === eventId);
			if (matches.length !== 1) {
				throw new StorageFailure("fork event is not a unique completed turn boundary");
			}
			event = matches[0];
		}
		if (input.forkPoint !== undefined) {
			if (!Number.isSafeInteger(input.forkPoint) || input.forkPoint < 0) {
				throw new StorageFailure("fork point is outside the conversation");
			}
			if (input.forkPoint === 0) {
				if (event) throw new StorageFailure("fork point does not match fork event");
				return Object.freeze({ forkPoint: 0 });
			}
			const matching = completed.filter((candidate) => (
				providerBoundaryAfter(surviving, candidate.sequenceNo) === input.forkPoint
			));
			if (matching.length !== 1 || event && event !== matching[0]) {
				throw new StorageFailure("fork point splits a turn or tool lifecycle");
			}
			event = matching[0];
		}
		event ??= completed.at(-1);
		if (!event) return Object.freeze({ forkPoint: 0 });
		return Object.freeze({
			forkPoint: providerBoundaryAfter(surviving, event.sequenceNo),
			event,
		});
	}

	#shareableProviderItems(sessionId: string): readonly CanonicalConversationItem[] {
		const events = this.#allEvents(sessionId);
		const rollbacks = rollbackWindowsFromEvents(events);
		const surviving = events.filter((event) => eventSurvivesRollbacks(event, rollbacks));
		const compaction = latestCompactionFromEvents(surviving);
		const completedTurnIds = new Set(surviving.flatMap((event) => (
			event.eventType === "turn_lifecycle" && event.payload.phase === "completed" && event.turnId
				? [event.turnId]
				: []
		)));
		const suffix = surviving.filter((event) => event.sequenceNo > (compaction?.sequenceNo ?? 0)
			&& event.modelVisible
			&& (!event.turnId || completedTurnIds.has(event.turnId))
			&& !(event.eventType === "user_input"
				&& (event.payload.source === "agent_mailbox"
					|| event.payload.source === "task_notification")));
		return projectTranscriptEventsToProviderItems(suffix, {
			...(compaction ? { replacement: compaction.payload.replacement } : {}),
		});
	}

	#appendAgentForkItems(
		sessionId: string,
		items: readonly CanonicalConversationItem[],
		createdAt: string,
	): void {
		let turnNumber = 0;
		let turnId: string | undefined;
		const completeTurn = (): void => {
			if (!turnId) return;
			this.#insertEvent(parseTranscriptEventAppendInput({
				schemaVersion: 1,
				sessionId,
				eventId: semanticEventId(sessionId, "fork-lifecycle", turnId),
				turnId,
				eventType: "turn_lifecycle",
				modelVisible: false,
				createdAt,
				payload: { phase: "completed" },
			}));
		};
		for (const [index, item] of items.entries()) {
			if (item.type === "user") {
				completeTurn();
				turnNumber += 1;
				turnId = `${sessionId}:fork:${turnNumber}`;
			}
			const eventId = semanticEventId(sessionId, "fork-item", String(index));
			switch (item.type) {
				case "user":
					this.#insertEvent(parseTranscriptEventAppendInput({
						schemaVersion: 1,
						sessionId,
						eventId,
						turnId: turnId!,
						eventType: "user_input",
						modelVisible: true,
						createdAt,
						payload: {
							text: item.text,
							clientUserMessageId: eventId,
							source: "agent_mailbox",
							...(item.images ? { images: item.images } : {}),
						},
					}));
					break;
				case "assistant":
					this.#insertEvent(parseTranscriptEventAppendInput({
						schemaVersion: 1, sessionId, eventId,
						...(turnId ? { turnId } : {}),
						eventType: "assistant_output", modelVisible: true, createdAt,
						payload: { text: item.text },
					}));
					break;
				case "assistant_tool_calls":
					this.#insertEvent(parseTranscriptEventAppendInput({
						schemaVersion: 1, sessionId, eventId,
						...(turnId ? { turnId } : {}),
						eventType: "assistant_tool_call_batch", modelVisible: true, createdAt,
						payload: { text: item.text, calls: item.calls },
					}));
					break;
				case "tool_result":
					this.#insertEvent(parseTranscriptEventAppendInput({
						schemaVersion: 1, sessionId, eventId,
						...(turnId ? { turnId } : {}),
						eventType: "tool_result", modelVisible: true, createdAt,
						payload: {
							result: {
								callId: item.callId,
								toolName: item.toolName,
								output: item.output,
								success: item.success,
							},
							summary: item.output.slice(0, 500),
						},
					}));
					break;
				case "context":
					this.#insertEvent(parseTranscriptEventAppendInput({
						schemaVersion: 1, sessionId, eventId,
						...(turnId ? { turnId } : {}),
						eventType: "context", modelVisible: true, createdAt,
						payload: { itemId: eventId, text: item.text, metadata: item.metadata },
					}));
					break;
			}
		}
		completeTurn();
	}

	#hasEventBefore(sessionId: string, sequenceNo: number): boolean {
		return this.#database.prepare(`
			SELECT 1 AS present FROM transcript_events
			WHERE session_id = ? AND sequence_no < ? LIMIT 1
		`).get(sessionId, sequenceNo) !== undefined;
	}
}

interface EventGroup {
	readonly turnIds: Set<string>;
	readonly callIds: Set<string>;
	readonly events: TranscriptEventEnvelope[];
	oldestSequence: number;
}

interface VisibleEventGroup {
	readonly oldestSequence: number;
	readonly items: readonly TranscriptItem[];
}

export function createV10SessionDatabase(options: SQLiteTranscriptEventRepositoryOptions): void {
	const repository = new SQLiteTranscriptEventRepository({
		...options,
		initializeSchemaVersion: SCHEMA_V10_VERSION,
	});
	repository.close();
}

export function createV11SessionDatabase(options: SQLiteTranscriptEventRepositoryOptions): void {
	const repository = new SQLiteTranscriptEventRepository({
		...options,
		initializeSchemaVersion: SCHEMA_V11_VERSION,
	});
	repository.close();
}

export function createV12SessionDatabase(options: SQLiteTranscriptEventRepositoryOptions): void {
	const repository = new SQLiteTranscriptEventRepository({
		...options,
		initializeSchemaVersion: SCHEMA_V12_VERSION,
	});
	repository.close();
}

function normalizedToolCalls(calls: readonly CanonicalToolCall[]): readonly CanonicalToolCall[] {
	return Object.freeze(calls.map((call) => Object.freeze({
		callId: call.callId,
		name: call.name,
		argumentsJson: stableJson(toolArguments(call.argumentsJson)),
	})));
}

function toolArguments(value: string): Readonly<Record<string, unknown>> {
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function validateToolResultEffects(input: AppendToolResultInput): void {
	if (input.planUpdate && (!input.result.success || input.result.toolName !== "update_plan")) {
		throw new StorageFailure("plan update requires a successful update_plan result");
	}
	if (input.planUpdate) planDisplayPayload(input);
	if (!input.toolActivation) return;
	if (!input.result.success || input.result.toolName !== "tool_search") {
		throw new StorageFailure("tool activation requires a successful tool_search result");
	}
	validatedToolActivationNames(input.toolActivation.names);
}

function planDisplayPayload(input: AppendToolResultInput): Readonly<{
	readonly text: string;
	readonly metadata: Readonly<Record<string, TranscriptJsonValue>>;
}> {
	const update = input.planUpdate;
	if (!update || !Array.isArray(update.items)) {
		throw new StorageFailure("plan update items are invalid");
	}
	if (update.items.length > 128) throw new StorageFailure("plan update exceeds item limit");
	let inProgress = 0;
	const items = update.items.map((item) => {
		if (typeof item !== "object" || item === null
			|| typeof item.id !== "string" || !item.id.trim() || item.id.length > 128
			|| typeof item.text !== "string" || !item.text.trim() || item.text.length > 4_096) {
			throw new StorageFailure("plan update item is invalid");
		}
		if (!PLAN_STATUSES.has(item.status)) {
			throw new StorageFailure("plan update status is invalid");
		}
		if (item.status === "in_progress") inProgress += 1;
		return Object.freeze({ id: item.id, text: item.text, status: item.status });
	});
	if (inProgress > 1) throw new StorageFailure("plan update has multiple active items");
	if (update.explanation !== undefined
		&& (typeof update.explanation !== "string" || update.explanation.length > 4_096)) {
		throw new StorageFailure("plan update explanation exceeds limit");
	}
	return Object.freeze({
		text: "Updated Plan",
		metadata: Object.freeze({
			source: input.result.toolName,
			...(update.explanation ? { explanation: update.explanation } : {}),
			completed: items.filter((item) => item.status === "completed").length,
			total: items.length,
			items,
			model_visible: false,
		}),
	});
}

function eventToolResultMetadata(
	input: AppendToolResultInput,
): Readonly<{ readonly metadata?: Readonly<Record<string, unknown>> }> {
	const mutation = projectMutationMetadata(input.metadata, input.result.success);
	const metadata = {
		...(mutation.file_changes ? { file_changes: mutation.file_changes } : {}),
		...(["tool_interrupted", "effect_outcome_unknown"].includes(input.errorKind ?? "")
			? { synthetic: true, append_only: true }
			: {}),
	};
	return Object.keys(metadata).length > 0 ? { metadata } : {};
}

function validatedToolActivationNames(value: readonly string[]): readonly string[] {
	if (!Array.isArray(value) || value.length > MAX_TOOL_ACTIVATION_NAMES) {
		throw new StorageFailure("tool activation exceeds name limit");
	}
	const names = value.map((name) => {
		if (typeof name !== "string" || !TOOL_ACTIVATION_NAME.test(name)) {
			throw new StorageFailure("tool activation name is invalid");
		}
		return name;
	});
	if (new Set(names).size !== names.length) {
		throw new StorageFailure("tool activation names must be unique");
	}
	return Object.freeze(names);
}

function semanticEventId(...parts: readonly string[]): string {
	const digest = createHash("sha256").update(stableJson(parts)).digest("hex");
	return `event:${digest}`;
}

function completedTurnDurationMs(
	turn: RuntimeTurnRecord,
	completedAt: string,
): number | undefined {
	const startedAtMs = Date.parse(turn.started_at);
	const completedAtMs = Date.parse(completedAt);
	if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs) || completedAtMs < startedAtMs) {
		return undefined;
	}
	return Math.min(86_400_000, completedAtMs - startedAtMs);
}

function clarificationResponseEventId(requestId: string): string {
	return semanticEventId("clarification-response", requestId);
}

function queuedInputSource(record: QueuedInput): UserInputTranscriptPayload["source"] {
	if (record.source === "agent_mailbox") return "agent_mailbox";
	if (record.source === "task_notification") return "task_notification";
	return record.kind === "pending_steer" ? "steer" : "queued";
}

function legacyHistoryActivityType(activityType: TranscriptDisplayActivityType): string {
	switch (activityType) {
		case "plan": return "plan_update";
		case "shell": return "shell_session";
		case "tool_activation": return "tool_exposure";
		case "context_baseline": return "context_baseline_update";
		default: return activityType;
	}
}

function projectEventsToLegacyHistory(
	events: readonly TranscriptEventEnvelope[],
	threadId: string,
): readonly Readonly<Record<string, unknown>>[] {
	return Object.freeze(events.flatMap((event): Readonly<Record<string, unknown>>[] => {
		const turnId = event.turnId;
		switch (event.eventType) {
			case "user_input": {
				const id = turnId
					? event.payload.queueId
						? `${turnId}:queue:${event.payload.queueId}`
						: `${turnId}:user:${event.payload.clientUserMessageId}`
					: event.eventId;
				return [Object.freeze({
					id,
					thread_id: threadId,
					turn_id: turnId ?? null,
					type: "user_message",
					text: event.payload.text,
					tool_name: null,
					call_id: null,
					metadata: Object.freeze({
						client_user_message_id: event.payload.clientUserMessageId,
						source: event.payload.source,
						...(event.payload.queueId ? { queue_id: event.payload.queueId } : {}),
						image_paths: Object.freeze([]),
					}),
				})];
			}
			case "assistant_output":
				return [Object.freeze({
					id: turnId ? `${turnId}:assistant:1` : event.eventId,
					thread_id: threadId,
					turn_id: turnId ?? null,
					type: "assistant_message",
					text: event.payload.text,
					tool_name: null,
					call_id: null,
					metadata: Object.freeze({
						source: "node_runtime",
						...(event.payload.responseId ? { response_id: event.payload.responseId } : {}),
						...(event.payload.providerState
							? { provider_state: event.payload.providerState }
							: {}),
					}),
				})];
			case "assistant_tool_call_batch": {
				const first = event.payload.calls[0];
				return [
					...(event.payload.text.trim() && first ? [Object.freeze({
						id: turnId
							? `${turnId}:assistant-tool-preamble:${first.callId}`
							: `${event.eventId}:preamble`,
						thread_id: threadId,
						turn_id: turnId ?? null,
						type: "assistant_message",
						text: event.payload.text,
						tool_name: null,
						call_id: null,
						metadata: Object.freeze({ source: "node_runtime" }),
					})] : []),
					...event.payload.calls.map((call) => Object.freeze({
						id: turnId ? `${turnId}:tool-call:${call.callId}` : `${event.eventId}:${call.callId}`,
						thread_id: threadId,
						turn_id: turnId ?? null,
						type: "tool_call",
						text: "",
						tool_name: call.name,
						call_id: call.callId,
						metadata: Object.freeze({
							arguments: toolArguments(call.argumentsJson),
							source: "node_runtime",
							...(event.payload.responseId ? { response_id: event.payload.responseId } : {}),
						}),
					})),
				];
			}
			case "tool_result":
				return [Object.freeze({
					id: turnId
						? `${turnId}:tool-result:${event.payload.result.callId}`
						: event.eventId,
					thread_id: threadId,
					turn_id: turnId ?? null,
					type: "tool_result",
					text: event.payload.summary,
					tool_name: event.payload.result.toolName,
					call_id: event.payload.result.callId,
					metadata: Object.freeze({
						success: event.payload.result.success,
						transcript_content: event.payload.result.output,
						...(event.payload.errorKind ? { error_kind: event.payload.errorKind } : {}),
						...(event.payload.metadata ?? {}),
					}),
				})];
			case "context":
				return [Object.freeze({
					id: event.payload.itemId,
					thread_id: threadId,
					turn_id: turnId ?? null,
					type: event.payload.metadata.kind,
					text: event.payload.text,
					tool_name: null,
					call_id: null,
					metadata: event.payload.metadata,
				})];
			case "display_activity":
				return [Object.freeze({
					id: event.eventId,
					thread_id: threadId,
					turn_id: turnId ?? null,
					type: legacyHistoryActivityType(event.payload.activityType),
					text: event.payload.text ?? "",
					tool_name: event.payload.toolName ?? null,
					call_id: event.payload.callId ?? null,
					metadata: event.payload.metadata ?? Object.freeze({}),
				})];
			default:
				return [];
		}
	}));
}

function legacyImportEvent(
	sessionId: string,
	item: Exclude<CanonicalConversationItem, { readonly type: "context" }>,
	index: number,
	createdAt: string,
): TranscriptEventAppendInput {
	const eventId = semanticEventId(sessionId, "legacy-import", String(index));
	if (item.type === "user") {
		return parseTranscriptEventAppendInput({
			schemaVersion: 1,
			sessionId,
			eventId,
			eventType: "user_input",
			modelVisible: true,
			createdAt,
			payload: {
				text: item.text,
				clientUserMessageId: `legacy:${index}`,
				source: "submit",
				...(item.images && item.images.length > 0 ? { images: item.images } : {}),
			},
		});
	}
	if (item.type === "assistant") {
		return parseTranscriptEventAppendInput({
			schemaVersion: 1,
			sessionId,
			eventId,
			eventType: "assistant_output",
			modelVisible: true,
			createdAt,
			payload: {
				text: item.text,
				...(item.providerState ? { providerState: item.providerState } : {}),
			},
		});
	}
	if (item.type === "assistant_tool_calls") {
		return parseTranscriptEventAppendInput({
			schemaVersion: 1,
			sessionId,
			eventId,
			eventType: "assistant_tool_call_batch",
			modelVisible: true,
			createdAt,
			payload: {
				text: item.text,
				calls: item.calls,
				...(item.responseId ? { responseId: item.responseId } : {}),
				...(item.providerState ? { providerState: item.providerState } : {}),
			},
		});
	}
	return parseTranscriptEventAppendInput({
		schemaVersion: 1,
		sessionId,
		eventId,
		eventType: "tool_result",
		modelVisible: true,
		createdAt,
		payload: {
			result: {
				callId: item.callId,
				toolName: item.toolName,
				output: item.output,
				success: item.success,
			},
			summary: `${item.toolName.slice(0, 128) || "Tool"} result`,
		},
	});
}

function normalizedStopReason(
	status: RuntimeTurnRecord["status"],
	errorCode: RuntimeTurnRecord["error_code"],
): string {
	if (status === "completed") return "assistant_completed";
	return runtimeErrorStopReason(errorCode);
}

function maintenanceLimit(value: number, maximum: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new RangeError(`${label} must be between 1 and ${maximum}`);
	}
	return value;
}

function runtimeTurnFromRow(row: RuntimeTurnRow): RuntimeTurnRecord {
	return parseRuntimeTurnRecord({
		schema_version: 1,
		session_id: row.session_id,
		client_turn_id: row.client_turn_id,
		turn_id: row.turn_id,
		request_fingerprint: row.request_fingerprint,
		status: row.status,
		error_code: row.error_code,
		result: row.result_json === null ? null : parseObjectJson(row.result_json, "runtime_turns"),
		started_at: row.started_at,
		completed_at: row.completed_at,
	});
}

function runtimeTurnWithOwnerFromRow(row: RuntimeTurnRow): Readonly<{
	readonly turn: RuntimeTurnRecord;
	readonly owner: Readonly<{ readonly processId?: number }>;
}> {
	return Object.freeze({
		turn: runtimeTurnFromRow(row),
		owner: Object.freeze({
			...(typeof row.owner_pid === "number"
				&& Number.isSafeInteger(row.owner_pid)
				&& row.owner_pid > 0
				? { processId: row.owner_pid }
				: {}),
		}),
	});
}

function parseObjectJson(value: unknown, source: string): Readonly<Record<string, unknown>> {
	if (typeof value !== "string") throw new StorageFailure(`invalid JSON in ${source}`);
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!isRecord(parsed)) throw new Error("not an object");
		return parsed;
	} catch {
		throw new StorageFailure(`invalid JSON in ${source}`);
	}
}

function normalizedCompactionCheckpoint(
	value: Readonly<Record<string, unknown>>,
): NormalizedCompactionCheckpoint {
	const state = parseRuntimeState({ kind: "compact_checkpoint", version: 1, payload: value });
	if (state.kind !== "compact_checkpoint" || state.payload.status !== "completed") {
		throw new StorageFailure("completed compaction checkpoint is invalid");
	}
	const summaryRequestFingerprint = identity(
		state.payload.summary_request_fingerprint,
		"summaryRequestFingerprint",
	);
	const updatedAt = identity(state.payload.updated_at, "updatedAt");
	return Object.freeze({
		turnId: state.payload.turn_id,
		reason: state.payload.reason,
		phase: state.payload.phase,
		windowNumber: state.payload.window_number,
		windowId: state.payload.window_id,
		historyItemCount: state.payload.history_item_count,
		inputHistoryHash: state.payload.input_history_hash,
		replacementHistoryHash: state.payload.replacement_history_hash,
		summaryRequestFingerprint,
		updatedAt,
		metadata: Object.freeze({
			reason: state.payload.reason,
			phase: state.payload.phase,
			window_number: state.payload.window_number,
			history_item_count: state.payload.history_item_count,
			input_history_hash: state.payload.input_history_hash,
			replacement_history_hash: state.payload.replacement_history_hash,
			summary_request_fingerprint: summaryRequestFingerprint,
		}),
	});
}

function boundedCompactionSummary(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > COMPACTION_SUMMARY_MAX_CHARS) {
		throw new StorageFailure("compaction summary is invalid");
	}
	return value;
}

function shellOutputChunkFromRow(row: ShellOutputChunkRow): ShellOutputChunk {
	if (typeof row.event_sequence !== "number"
		|| typeof row.cursor_start !== "number"
		|| typeof row.cursor_end !== "number"
		|| typeof row.omitted_before !== "number"
		|| typeof row.output_text !== "string") {
		throw new StorageFailure("invalid shell output chunk row");
	}
	return validateShellOutputChunk({
		sequence: row.event_sequence,
		cursorStart: row.cursor_start,
		cursorEnd: row.cursor_end,
		omittedBefore: row.omitted_before,
		output: row.output_text,
	});
}

function transcriptJsonRecord(
	value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, TranscriptJsonValue>> {
	return JSON.parse(stableJson(value)) as Readonly<Record<string, TranscriptJsonValue>>;
}

function shellStatus(metadata: Readonly<Record<string, unknown>>): string {
	for (const key of ["terminal_state", "process_state"] as const) {
		if (typeof metadata[key] === "string" && metadata[key]) return metadata[key];
	}
	return "running";
}

function shellTimestamp(metadata: Readonly<Record<string, unknown>>): string | undefined {
	for (const key of ["completed_at", "started_at"] as const) {
		if (typeof metadata[key] === "string" && metadata[key]) return metadata[key];
	}
	return undefined;
}

function eventSurvivesRollbacks(
	event: TranscriptEventEnvelope,
	windows: readonly RollbackWindow[],
): boolean {
	for (const window of windows) {
		if (event.sequenceNo >= window.markerSequence) continue;
		if (event.turnId && window.removedTurnIds.has(event.turnId)) return false;
		if (window.boundarySequence !== undefined && event.sequenceNo > window.boundarySequence) {
			return false;
		}
	}
	return true;
}

function rollbackWindowsFromEvents(
	events: readonly TranscriptEventEnvelope[],
): readonly RollbackWindow[] {
	const byIdentity = new Map(events.map((event) => [
		`${event.sessionId}\0${event.eventId}`,
		event,
	]));
	return Object.freeze(events.flatMap((event): RollbackWindow[] => {
		if (event.eventType !== "rollback") return [];
		let boundarySequence: number | undefined;
		if (event.payload.boundaryEventId) {
			const sameSession = byIdentity.get(`${event.sessionId}\0${event.payload.boundaryEventId}`);
			const anySession = sameSession ?? events.find(
				(candidate) => candidate.eventId === event.payload.boundaryEventId,
			);
			if (!anySession || anySession.sequenceNo >= event.sequenceNo) {
				throw new StorageFailure("rollback transcript boundary is invalid");
			}
			boundarySequence = anySession.sequenceNo;
		}
		return [Object.freeze({
			markerSequence: event.sequenceNo,
			...(boundarySequence === undefined ? {} : { boundarySequence }),
			removedTurnIds: new Set(event.payload.removedTurnIds),
		})];
	}));
}

function latestCompactionFromEvents(
	events: readonly TranscriptEventEnvelope[],
): TranscriptEventEnvelope<"compaction"> | undefined {
	const byIdentity = new Map(events.map((event) => [
		`${event.sessionId}\0${event.eventId}`,
		event,
	]));
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index]!;
		if (event.eventType !== "compaction") continue;
		if (!event.payload.sourceEventId) return event;
		const source = byIdentity.get(`${event.sessionId}\0${event.payload.sourceEventId}`)
			?? events.find((candidate) => candidate.eventId === event.payload.sourceEventId);
		if (source?.modelVisible
			&& source.sequenceNo < event.sequenceNo
			&& source.providerIndex === event.payload.sourceProviderIndex) return event;
	}
	return undefined;
}

function providerBoundaryAfter(
	events: readonly TranscriptEventEnvelope[],
	sequenceNo: number,
): number {
	let boundary = 0;
	for (const event of events) {
		if (event.sequenceNo > sequenceNo) break;
		if (event.modelVisible && event.providerIndex !== undefined) {
			boundary = Math.max(boundary, event.providerIndex + 1);
		}
	}
	return boundary;
}

function lineagePrefix(
	parent: readonly TranscriptEventEnvelope[],
	link: LineageLink,
): readonly TranscriptEventEnvelope[] {
	if (!link.parentId) return Object.freeze([]);
	if (link.forkEventId && link.forkEventSessionId) {
		const index = parent.findIndex((event) => event.sessionId === link.forkEventSessionId
			&& event.eventId === link.forkEventId);
		if (index < 0) throw new StorageFailure("lineage fork event does not exist in parent prefix");
		return Object.freeze(parent.slice(0, index + 1));
	}
	const forkPoint = link.forkPoint ?? 0;
	if (forkPoint === 0) return Object.freeze([]);
	const lifecycle = parent.find((event) => event.eventType === "turn_lifecycle"
		&& event.payload.phase === "completed"
		&& providerBoundaryAfter(parent, event.sequenceNo) === forkPoint);
	if (!lifecycle) throw new StorageFailure("legacy fork point splits a turn or tool lifecycle");
	const index = parent.indexOf(lifecycle);
	return Object.freeze(parent.slice(0, index + 1));
}

function segmentsForMaterializedPrefix(
	events: readonly TranscriptEventEnvelope[],
): readonly LineageEventSegment[] {
	const order: string[] = [];
	const maximum = new Map<string, number>();
	for (const event of events) {
		if (!maximum.has(event.sessionId)) order.push(event.sessionId);
		maximum.set(event.sessionId, event.sequenceNo);
	}
	return Object.freeze(order.map((sessionId) => Object.freeze({
		sessionId,
		maxSequence: maximum.get(sessionId)!,
	})));
}

function readablePageFromEvents(
	events: readonly TranscriptEventEnvelope[],
	beforeSequence: number | undefined,
	limit: number,
): TranscriptReadablePage {
	const before = optionalSequence(beforeSequence, "beforeSequence");
	const descending = [...events]
		.filter((event) => before === undefined || event.sequenceNo < before)
		.reverse();
	let offset = 0;
	let pending: EventGroup | undefined;
	const visibleGroups: VisibleEventGroup[] = [];
	while (visibleItemCount(visibleGroups) < limit && offset < descending.length) {
		const window = descending.slice(offset, offset + READABLE_PAGE_RAW_WINDOW_SIZE);
		offset += window.length;
		const grouped = completeEventGroups(window, pending);
		pending = grouped.pending;
		if (offset >= descending.length && pending) {
			grouped.complete.push(pending);
			pending = undefined;
		}
		visibleGroups.push(...projectVisibleEventGroups(grouped.complete));
	}
	const selected: VisibleEventGroup[] = [];
	let selectedItems = 0;
	for (const group of visibleGroups) {
		selected.push(group);
		selectedItems += group.items.length;
		if (selectedItems >= limit) break;
	}
	const oldestSequence = selected.reduce(
		(value, group) => Math.min(value, group.oldestSequence),
		Number.MAX_SAFE_INTEGER,
	);
	return Object.freeze({
		items: Object.freeze(selected.reverse().flatMap((group) => group.items)),
		nextBeforeSequence: selected.length > 0
			&& (offset < descending.length || pending !== undefined || selected.length < visibleGroups.length)
			? oldestSequence
			: null,
	});
}

function utcTimestamp(): string {
	return new Date().toISOString().replace("Z", "+00:00");
}

function processIsAlive(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		return isRecord(error) && error.code === "EPERM";
	}
}

function initializeTranscriptSchema(
	database: Database.Database,
	version:
		| typeof SCHEMA_V10_VERSION
		| typeof SCHEMA_V11_VERSION
		| typeof SCHEMA_V12_VERSION,
): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec(SCHEMA_V2_SQL);
		database.exec(SCHEMA_V5_SQL);
		database.exec(SCHEMA_V6_SQL);
		database.exec(SCHEMA_V7_SQL);
		database.exec(SCHEMA_V8_SQL);
		database.exec(version === SCHEMA_V12_VERSION
			? SCHEMA_V12_SQL
			: version === SCHEMA_V11_VERSION ? SCHEMA_V11_SQL : SCHEMA_V10_SQL);
		database.prepare("DELETE FROM schema_version").run();
		database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function schemaVersion(database: Database.Database):
	| Readonly<{ kind: "empty" }>
	| Readonly<{ kind: "invalid" }>
	| Readonly<{ kind: "version"; value: number }> {
	const table = database.prepare(`
		SELECT 1 AS present FROM sqlite_master
		WHERE type = 'table' AND name = 'schema_version'
	`).get();
	if (!table) {
		const objects = database.prepare(`
			SELECT COUNT(*) AS count FROM sqlite_master
			WHERE name NOT LIKE 'sqlite_%'
		`).get() as { readonly count: unknown };
		return Number(objects.count) === 0 ? { kind: "empty" } : { kind: "invalid" };
	}
	const row = database.prepare("SELECT version FROM schema_version LIMIT 1").get() as {
		readonly version: unknown;
	} | undefined;
	if (!row || typeof row.version !== "number") return { kind: "invalid" };
	return { kind: "version", value: row.version };
}

function transcriptSchemaVersion(
	version: number,
): typeof SCHEMA_V10_VERSION | typeof SCHEMA_V11_VERSION | typeof SCHEMA_V12_VERSION {
	if (version === SCHEMA_V10_VERSION || version === SCHEMA_V11_VERSION
		|| version === SCHEMA_V12_VERSION) return version;
	throw new StorageFailure("unsupported transcript event schema version", {
		expected_version: SCHEMA_V12_VERSION,
		actual_version: Number.isFinite(version) ? version : null,
	});
}

function usesContentBlobs(
	version: typeof SCHEMA_V10_VERSION | typeof SCHEMA_V11_VERSION | typeof SCHEMA_V12_VERSION,
): boolean {
	return version === SCHEMA_V11_VERSION || version === SCHEMA_V12_VERSION;
}

function searchableTranscriptEvent(event: TranscriptEventEnvelope): boolean {
	if (!event.modelVisible) return false;
	if (event.eventType === "opaque_legacy") {
		return event.payload.sourceKind === "conversation_messages";
	}
	if (event.eventType !== "user_input" && event.eventType !== "assistant_output"
		&& event.eventType !== "assistant_tool_call_batch" && event.eventType !== "tool_result"
		&& event.eventType !== "context") return false;
	return event.payload.readableProjection?.searchVisible !== false;
}

function canonicalEventPayloadJson(event: TranscriptEventEnvelope): string {
	return stableJson({ schemaVersion: event.schemaVersion, payload: event.payload });
}

function nextProviderIndex(database: Database.Database, sessionId: string): number {
	const row = database.prepare(`
		SELECT MAX(provider_index) AS max_index
		FROM transcript_events
		WHERE session_id = ? AND provider_index IS NOT NULL
	`).get(sessionId) as { readonly max_index: unknown };
	if (typeof row.max_index === "number" && Number.isSafeInteger(row.max_index)
		&& row.max_index >= 0) return row.max_index + 1;
	const lineage = database.prepare(`
		SELECT fork_point FROM conversation_trees WHERE session_id = ?
	`).get(sessionId) as { readonly fork_point: unknown } | undefined;
	const nextIndex = lineage?.fork_point ?? 0;
	if (!Number.isSafeInteger(nextIndex) || Number(nextIndex) < 0) {
		throw new StorageFailure("next transcript provider index is invalid");
	}
	return Number(nextIndex);
}

function eventFromRow(
	row: TranscriptEventRow,
	hydrate?: (storedValue: TranscriptJsonValue) => TranscriptJsonValue,
): TranscriptEventEnvelope {
	const storedValue = parseStoredPayload(row.payload_json);
	const stored = hydrate ? hydrate(storedValue) : storedValue;
	if (!isRecord(stored)) throw new StorageFailure("invalid transcript event payload");
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

function parseStoredPayload(value: unknown): TranscriptJsonValue {
	try {
		const parsed = JSON.parse(String(value)) as unknown;
		if (!isRecord(parsed)
			|| Object.keys(parsed).some((key) => key !== "schemaVersion" && key !== "payload")
			|| !("schemaVersion" in parsed)
			|| !("payload" in parsed)) {
			throw new Error("invalid stored payload");
		}
		return parsed as TranscriptJsonValue;
	} catch {
		throw new StorageFailure("invalid transcript event payload");
	}
}

function eventSequence(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new StorageFailure("transcript event sequence is invalid");
	}
	return value;
}

function storageError(error: unknown): Error {
	if (error instanceof StorageFailure
		|| error instanceof SessionInUseError
		|| error instanceof SessionStateError
		|| error instanceof RangeError) return error;
	const code = sqliteCode(error);
	return new StorageFailure("transcript event storage operation failed", {
		...(code ? { sqlite_code: code } : {}),
	});
}

function identity(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > 512 || value.includes("\0")) {
		throw new RangeError(`${field} is invalid`);
	}
	return value;
}

function optionalSequence(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || Number(value) < 1) {
		throw new RangeError(`${field} must be a positive integer`);
	}
	return Number(value);
}

function boundedLimit(value: number | undefined, maximum: number): number {
	const limit = value ?? DEFAULT_EVENT_WINDOW_LIMIT;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
		throw new RangeError(`limit must be between 1 and ${maximum}`);
	}
	return limit;
}

function searchLimit(value: number | undefined): number {
	const limit = value ?? 20;
	if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100) {
		throw new RangeError("session search limit must be between 0 and 100");
	}
	return limit;
}

function toolActivationNames(value: unknown): readonly string[] {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.names)
		|| value.names.length > 16) return [];
	const names = value.names.filter(
		(name): name is string => typeof name === "string" && /^[A-Za-z0-9_]{1,128}$/u.test(name),
	);
	return names.length === value.names.length && new Set(names).size === names.length ? names : [];
}

function completeEventGroups(
	events: readonly TranscriptEventEnvelope[],
	pending: EventGroup | undefined,
): { complete: EventGroup[]; pending: EventGroup | undefined } {
	const complete: EventGroup[] = [];
	let current = pending;
	for (const event of events) {
		if (current && sameEventGroup(current, event)) {
			current.events.push(event);
			addEventGroupIdentity(current, event);
			current.oldestSequence = event.sequenceNo;
			continue;
		}
		if (current) complete.push(current);
		current = {
			turnIds: new Set(event.turnId ? [event.turnId] : []),
			callIds: new Set(readableEventCallIds(event)),
			events: [event],
			oldestSequence: event.sequenceNo,
		};
	}
	return { complete, pending: current };
}

function sameEventGroup(group: EventGroup, event: TranscriptEventEnvelope): boolean {
	if (event.turnId && group.turnIds.has(event.turnId)) return true;
	if (readableEventCallIds(event).some((callId) => group.callIds.has(callId))) return true;
	if (isTurnAbortedContext(event) && group.turnIds.size === 1) return true;
	if (
		event.turnId
		&& group.turnIds.size === 0
		&& group.events.some(isTurnAbortedContext)
	) return true;
	return group.turnIds.size === 0
		&& event.turnId === undefined
		&& group.oldestSequence === event.sequenceNo + 1;
}

function isTurnAbortedContext(event: TranscriptEventEnvelope): boolean {
	return event.eventType === "context" && event.payload.metadata.kind === "turn_aborted";
}

function addEventGroupIdentity(group: EventGroup, event: TranscriptEventEnvelope): void {
	if (event.turnId) group.turnIds.add(event.turnId);
	for (const callId of readableEventCallIds(event)) group.callIds.add(callId);
}

function readableEventCallIds(event: TranscriptEventEnvelope): readonly string[] {
	switch (event.eventType) {
		case "assistant_tool_call_batch":
			return event.payload.calls.map((call) => call.callId);
		case "tool_result":
			return [event.payload.result.callId];
		case "display_activity":
			return event.payload.callId ? [event.payload.callId] : [];
		default:
			return [];
	}
}

function projectVisibleEventGroups(groups: readonly EventGroup[]): readonly VisibleEventGroup[] {
	return groups.flatMap((group): VisibleEventGroup[] => {
		const items = projectTranscriptEventsToReadableItems(
			[...group.events].reverse(),
			{ limit: Number.MAX_SAFE_INTEGER },
		);
		return items.length === 0 ? [] : [{ oldestSequence: group.oldestSequence, items }];
	});
}

function visibleItemCount(groups: readonly VisibleEventGroup[]): number {
	return groups.reduce((count, group) => count + group.items.length, 0);
}

function withoutPartialEarliestEventTurn(
	events: readonly TranscriptEventEnvelope[],
	preceding: TranscriptEventEnvelope | undefined,
): readonly TranscriptEventEnvelope[] {
	const earliestTurnId = events[0]?.turnId;
	if (!earliestTurnId || preceding?.turnId !== earliestTurnId) return events;
	const firstCompleteTurn = events.findIndex((event) => event.turnId !== earliestTurnId);
	return firstCompleteTurn < 0 ? [] : events.slice(firstCompleteTurn);
}

function sqliteCode(error: unknown): string | undefined {
	if (!isRecord(error) || typeof error.code !== "string") return undefined;
	return error.code.slice(0, 64);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
