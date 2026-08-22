import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { parseRuntimeTurnRecord } from "@mycli/contracts";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import {
	ApprovalConflictError,
	PROVIDER_REPLAY_STATE_MAX_JSON_CHARS,
	QueueConflictError,
	selectAgentForkConversation,
	turnAbortedContextItem,
} from "@mycli/core";
import type {
	CanonicalConversationItem,
	CanonicalContextMetadata,
	CanonicalMessage,
	CanonicalToolCall,
	ProviderReplayState,
	QueueSnapshot,
	RuntimeErrorCode,
} from "@mycli/core";
import { TOOL_RESULT_OUTPUT_MAX_CHARS } from "@mycli/core";
import Database from "better-sqlite3";
import {
	SCHEMA_V2_SQL,
	SCHEMA_V5_SQL,
	SCHEMA_V6_SQL,
	SCHEMA_V7_SQL,
	SCHEMA_V8_SQL,
	SCHEMA_V9_SQL,
	SCHEMA_VERSION,
	TRANSCRIPT_PROJECTION_INDEX_SQL,
} from "./schema.ts";
import {
	MessageIdConflictError,
	projectMutationMetadata,
	SessionStateError,
	StorageFailure,
} from "./session-store.ts";
import {
	shellHistoryItem,
	validateShellOutputChunk,
	validateShellOutputPageInput,
} from "./shell-transcript-store.ts";
import type {
	AppendSessionSummaryInput,
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
	ForkSessionInput,
	ForkSessionResult,
	ForkAgentConversationInput,
	ForkAgentConversationResult,
	ImportLegacyConversationInput,
	HistoryItemWindow,
	InterruptAmbiguousApprovalInput,
	ReserveTurnInput,
	RuntimeStateKey,
	SaveQueueSnapshotInput,
	SaveApprovalSuspensionInput,
	SaveClarificationSuspensionInput,
	SaveStateInput,
	SessionLineageNode,
	SessionListQuery,
	SessionEmptyCleanupResult,
	SessionMaintenanceCandidate,
	SessionMaintenanceOptions,
	SessionMaintenanceReport,
	SessionPayloadCleanupResult,
	SessionOrphanCleanupResult,
	SessionOverview,
	SessionSearchQuery,
	SessionSearchResult,
	SessionStore,
	SessionStorageMetrics,
	SessionVacuumResult,
	TurnReservation,
} from "./session-store.ts";
import type {
	LoadShellOutputPageInput,
	ShellOutputChunk,
	ShellOutputPage,
	UpsertShellSnapshotInput,
} from "./shell-transcript-store.ts";
import { SQLiteSessionStateRepository } from "./sqlite-session-state.ts";
import { stableJson } from "./stable-json.ts";
import { ftsMatchQuery, searchSnippet } from "./session-search.ts";
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
import type {
	AgentEffectAttempt,
	AgentEffectLedgerStore,
} from "./agent-effect-ledger.ts";
import {
	assertImagePathCount,
	canonicalImages,
	imageBlocks,
} from "./canonical-images.ts";
import {
	canonicalConversationItem,
	canonicalHistoryItem,
	conversationSearchRole,
	conversationSearchText,
	repairTerminalToolProtocol,
} from "./legacy-provider-projection.ts";

const PLAN_STATUSES = new Set(["pending", "in_progress", "completed"]);
const TOOL_ACTIVATION_NAME = /^[A-Za-z0-9_]{1,128}$/u;
const MAX_TOOL_ACTIVATION_NAMES = 16;
const MAX_SHELL_OUTPUT_PAGE_ROWS = 257;

export interface SQLiteSessionStoreOptions {
	readonly dbPath: string;
	readonly clock?: () => string;
	readonly busyTimeoutMs?: number;
	readonly ownerId?: string;
	readonly processId?: number;
	readonly isProcessAlive?: (processId: number) => boolean;
	readonly stateFailpoint?: (name: string) => void;
	readonly modelInputFailpoint?: (name: ModelInputLedgerFailpoint) => void;
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

export class SQLiteSessionStore implements SessionStore {
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
	readonly #stateFailpoint: (name: string) => void;
	readonly #dbPath: string;
	#closed = false;

	constructor(options: SQLiteSessionStoreOptions) {
		mkdirSync(dirname(options.dbPath), { recursive: true });
		this.#dbPath = options.dbPath;
		this.#clock = options.clock ?? utcTimestamp;
		this.#ownerId = options.ownerId ?? randomUUID();
		this.#processId = options.processId ?? process.pid;
		this.#isProcessAlive = options.isProcessAlive ?? processIsAlive;
		this.#stateFailpoint = options.stateFailpoint ?? (() => undefined);
		try {
			this.#database = new Database(options.dbPath, {
				timeout: options.busyTimeoutMs ?? 1000,
			});
			this.#configure(options.busyTimeoutMs ?? 1000);
			this.#initialize();
			this.#stateRepository = new SQLiteSessionStateRepository({
				database: this.#database,
				clock: this.#clock,
				write: <Result>(operation: () => Result) => this.#write(operation),
				...(options.stateFailpoint ? { failpoint: options.stateFailpoint } : {}),
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
				reserve: (input: ReserveAgentSpawnInput) =>
					this.#write(() =>
						Object.freeze({
							thread: this.agentThreads.reserve(input.thread),
							task: this.subagentTasks.reserve(input.task),
						}),
					),
			});
			this.agentMailbox = new SQLiteAgentMailboxRepository({
				database: this.#database,
				clock: this.#clock,
				write: <Result>(operation: () => Result) => this.#write(operation),
			});
			this.modelInputLedger = new SQLiteModelInputLedger({
				database: this.#database,
				write: <Result>(operation: () => Result) => this.#write(operation),
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
			throw storageError(error);
		}
	}

	reserveTurn(input: ReserveTurnInput): TurnReservation {
		this.#stateFailpoint("turn_before_reservation");
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
		const reservation = this.#write<TurnReservation>(() => {
			const existing = this.#loadTurn(input.sessionId, input.clientTurnId);
			if (existing) {
				if (existing.request_fingerprint !== input.requestFingerprint) {
					throw new MessageIdConflictError();
				}
				return { kind: "existing", turn: existing };
			}
			this.#touchSession(input);
			this.#insertRuntimeTurn(initial);
			if (input.source !== "agent_mailbox") {
				this.#appendConversationMessage(input.sessionId, userMessage(input));
				this.#appendHistoryItem(input.sessionId, userHistoryItem(input));
			}
			return { kind: "reserved", turn: initial };
		});
		if (reservation.kind === "reserved") this.#stateFailpoint("turn_after_reservation");
		return reservation;
	}

	loadTurn(sessionId: string, clientTurnId: string): RuntimeTurnRecord | undefined {
		try {
			return this.#loadTurn(sessionId, clientTurnId);
		} catch (error) {
			throw storageError(error);
		}
	}

	loadConversation(sessionId: string): readonly CanonicalMessage[] {
		return this.loadConversationItems(sessionId).flatMap((item): CanonicalMessage[] => {
			if (item.type === "user") {
				return [{ role: "user", content: item.text }];
			}
			if (item.type === "assistant") {
				return [{ role: "assistant", content: item.text }];
			}
			if (item.type === "assistant_tool_calls" && item.text) {
				return [{ role: "assistant", content: item.text }];
			}
			return [];
		});
	}

	loadConversationItems(sessionId: string): readonly CanonicalConversationItem[] {
		try {
			const compaction = this.#loadCompactionProjection(sessionId);
			const rows = this.#database.prepare(`
				SELECT payload_json
				FROM conversation_messages
				WHERE session_id = ?
					AND message_index >= ?
				ORDER BY message_index
			`).all(sessionId, compaction?.sourceMessageCount ?? 0) as readonly {
				readonly payload_json: unknown;
			}[];
			if (rows.length > 0 || compaction) {
				return repairTerminalToolProtocol([
					...(compaction?.replacement ?? []),
					...rows.map((row) => canonicalConversationItem(
					row.payload_json,
					"conversation_messages",
					)),
				], this.#activeToolCallIds(sessionId));
			}
			const historyRows = this.#database.prepare(`
				SELECT payload_json
				FROM history_items
				WHERE session_id = ?
				  AND json_extract(payload_json, '$.type') IN (
				    'user_message', 'assistant_message', 'tool_call', 'tool_result'
				  )
				ORDER BY sequence_no
			`).all(sessionId) as readonly { payload_json: unknown }[];
			return repairTerminalToolProtocol(
				historyRows.map((row) => canonicalHistoryItem(row.payload_json)),
				this.#activeToolCallIds(sessionId),
			);
		} catch (error) {
			throw storageError(error);
		}
	}

	loadToolActivations(sessionId: string, turnId: string): readonly string[] {
		try {
			const rows = this.#database.prepare(`
				SELECT payload_json
				FROM conversation_messages
				WHERE session_id = ?
				  AND json_extract(payload_json, '$.metadata.turn_id') = ?
				  AND json_extract(payload_json, '$.metadata.tool_name') = 'tool_search'
				ORDER BY message_index
			`).all(sessionId, turnId) as readonly { readonly payload_json: unknown }[];
			const names = new Set<string>();
			for (const row of rows) {
				const payload = parsedRecord(row.payload_json, "conversation_messages");
				const metadata = recordValue(payload.metadata);
				for (const name of persistedToolActivationNames(metadata.tool_activation)) {
					names.add(name);
				}
			}
			return Object.freeze([...names]);
		} catch (error) {
			throw storageError(error);
		}
	}

	#loadCompactionProjection(sessionId: string): {
		readonly sourceMessageCount: number;
		readonly replacement: readonly CanonicalConversationItem[];
	} | undefined {
		const row = this.#database.prepare(`
			SELECT payload_json
			FROM history_items
			WHERE session_id = ?
				AND json_extract(payload_json, '$.type') = 'compaction_boundary'
			ORDER BY sequence_no DESC
			LIMIT 1
		`).get(sessionId) as { readonly payload_json: unknown } | undefined;
		if (!row) return undefined;
		const payload = parseObjectJson(row.payload_json, "compaction_boundary");
		const sourceMessageCount = payload.source_message_count;
		const replacementMessages = payload.replacement_messages;
		if (!Number.isSafeInteger(sourceMessageCount) || Number(sourceMessageCount) < 0
			|| !Array.isArray(replacementMessages) || replacementMessages.length > 4_096) {
			throw new StorageFailure("invalid compaction boundary");
		}
		const count = this.#database.prepare(`
			SELECT COUNT(*) AS count
			FROM conversation_messages
			WHERE session_id = ?
		`).get(sessionId) as { readonly count: unknown };
		if (Number(sourceMessageCount) > Number(count.count)) {
			throw new StorageFailure("invalid compaction boundary");
		}
		return Object.freeze({
			sourceMessageCount: Number(sourceMessageCount),
			replacement: Object.freeze(replacementMessages.map((message) => (
				canonicalConversationItem(stableJson(message), "compaction_boundary")
			))),
		});
	}

	appendAssistantToolCalls(input: AppendAssistantToolCallsInput): void {
		this.#write(() => {
			const running = this.#requireRunningTurn(input.sessionId, input.clientTurnId);
			if (input.calls.length === 0) {
				throw new StorageFailure("assistant tool call batch is empty");
			}
			if (this.#pendingToolCalls(input.sessionId, running.turn_id).length > 0) {
				throw new StorageFailure("previous tool calls are still pending");
			}
			const knownIds = this.#knownToolCallIds(input.sessionId);
			const batchIds = new Set<string>();
			for (const call of input.calls) {
				if (!call.callId || !call.name || batchIds.has(call.callId) || knownIds.has(call.callId)) {
					throw new StorageFailure("invalid or duplicate tool call id");
				}
				batchIds.add(call.callId);
			}
			const parsedCalls = input.calls.map((call) => ({
				call,
				argumentsValue: toolArguments(call.argumentsJson),
			}));
			this.#appendConversationMessage(
				input.sessionId,
				assistantToolCallMessage(running, input, parsedCalls),
			);
			const threadId = this.#threadId(input.sessionId);
			if (input.assistantText.trim()) {
				this.#appendHistoryItem(
					input.sessionId,
					assistantToolPreambleHistoryItem(running, input, parsedCalls[0]!, threadId),
				);
			}
			for (const parsed of parsedCalls) {
				this.#appendHistoryItem(
					input.sessionId,
					toolCallHistoryItem(running, input, parsed, threadId),
				);
			}
			this.#touchExistingSession(input.sessionId, this.#clock());
		});
	}

	appendContextItem(input: AppendContextItemInput): void {
		this.#write(() => {
			this.#appendContextItemRecords(input);
			this.#touchExistingSession(input.sessionId, this.#clock());
		});
	}

	appendToolResult(input: AppendToolResultInput): void {
		this.#write(() => {
			const running = this.#requireRunningTurn(input.sessionId, input.clientTurnId);
			if (input.result.output.length > TOOL_RESULT_OUTPUT_MAX_CHARS) {
				throw new StorageFailure("tool result exceeds output limit");
			}
			const pending = this.#pendingToolCalls(input.sessionId, running.turn_id);
			const expected = pending[0];
			if (!expected || expected.callId !== input.result.callId) {
				throw new StorageFailure("tool results must preserve call order");
			}
			if (expected.name !== input.result.toolName) {
				throw new StorageFailure("tool result name does not match call");
			}
			if (input.planUpdate && (!input.result.success || input.result.toolName !== "update_plan")) {
				throw new StorageFailure("plan update requires a successful update_plan result");
			}
			this.#appendToolResultRecords(running, input);
			if (input.planUpdate) {
				this.#appendHistoryItem(
					input.sessionId,
					planUpdateHistoryItem(running, input, this.#threadId(input.sessionId)),
				);
			}
			if (input.contextItem) {
				this.#appendContextItemRecords({
					sessionId: input.sessionId,
					...input.contextItem,
				});
			}
			this.#touchExistingSession(input.sessionId, this.#clock());
		});
	}

	completeTurn(input: CompleteStoredTurnInput): RuntimeTurnRecord {
		return this.#write(() => {
			const running = this.#requireRunningTurn(input.sessionId, input.clientTurnId);
			const threadId = this.#threadId(input.sessionId);
			const result = {
				assistant_text: input.assistantText,
				...(input.responseId ? { response_id: input.responseId } : {}),
				usage: input.usage,
			};
			this.#appendConversationMessage(
				input.sessionId,
				assistantMessage(running, input),
			);
			this.#appendHistoryItem(
				input.sessionId,
				assistantHistoryItem(running, input, threadId),
			);
			this.#appendRollout(input.sessionId, completedRollout(running, input, threadId));
			this.#database.prepare(`
				UPDATE runtime_turns
				SET status = 'completed', error_code = NULL, result_json = ?, completed_at = ?,
					owner_id = NULL, owner_pid = NULL
				WHERE session_id = ? AND client_turn_id = ? AND status = 'in_progress'
			`).run(stableJson(result), input.completedAt, input.sessionId, input.clientTurnId);
			this.#touchExistingSession(input.sessionId, input.completedAt);
			return this.#requiredTurn(input.sessionId, input.clientTurnId);
		});
	}

	failTurn(input: FailStoredTurnInput): RuntimeTurnRecord {
		return this.#write(() => {
			const running = this.#requireRunningTurn(input.sessionId, input.clientTurnId);
			const status = input.code === "interrupted" ? "interrupted" : "failed";
			const interrupted = input.code === "interrupted";
			const interruptedAttempts = interrupted
				? this.#recoverInterruptedToolAttempts(running, input.completedAt)
				: new Map<string, AgentEffectAttempt>();
			for (const call of this.#pendingToolCalls(input.sessionId, running.turn_id)) {
				const recovered = interruptedToolResult(
					call,
					interruptedAttempts.get(call.callId),
					"Tool execution was interrupted before a result was persisted.",
				);
				this.#appendToolResultRecords(running, {
					sessionId: input.sessionId,
					clientTurnId: input.clientTurnId,
					result: interrupted ? recovered.result : {
						callId: call.callId,
						toolName: call.name,
						output: "Tool result unavailable because the turn failed before persistence completed.",
						success: false,
					},
					summary: interrupted
						? recovered.summary
						: `${call.name.slice(0, 128) || "Tool"} result unavailable`,
					...(interrupted
						? recovered.errorKind ? { errorKind: recovered.errorKind } : {}
						: { errorKind: "tool_result_unavailable" }),
					...(interrupted && recovered.metadata ? { metadata: recovered.metadata } : {}),
					});
				}
				if (interrupted) this.#appendInterruptedTurnMarker(running);
				this.#appendRollout(
				input.sessionId,
				failedRollout(running, input, status, this.#threadId(input.sessionId)),
			);
			this.#database.prepare(`
				UPDATE runtime_turns
				SET status = ?, error_code = ?, result_json = ?, completed_at = ?,
					owner_id = NULL, owner_pid = NULL
				WHERE session_id = ? AND client_turn_id = ? AND status = 'in_progress'
			`).run(
				status,
				input.code,
					stableJson({
						message: input.message,
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
	}

	recoverInterruptedTurns(): number {
		return this.#write(() => {
			const running = this.#database.prepare(`
				SELECT ${RUNTIME_TURN_COLUMNS}
				FROM runtime_turns
				WHERE status = 'in_progress'
				ORDER BY session_id, client_turn_id
			`).all() as readonly RuntimeTurnRow[];
			const orphaned = running.filter((row) => !ownedByLiveProcess(row, this.#isProcessAlive)
				&& !this.#stateRepository.isContinuationTurn(
					String(row.session_id),
					String(row.client_turn_id),
					String(row.turn_id),
				));
			for (const row of orphaned) {
				const turn = runtimeTurnFromRow(row);
				const completedAt = this.#clock();
				this.#recoverInterruptedTurnRecords(turn, completedAt, false);
			}
			return orphaned.length;
		});
	}

	recoverInterruptedTurn(
		sessionId: string,
		turnId: string,
		userInitiated = false,
	): RuntimeTurnRecord | undefined {
		return this.#write(() => {
			const row = this.#database.prepare(`
				SELECT ${RUNTIME_TURN_COLUMNS}
				FROM runtime_turns
				WHERE session_id = ? AND turn_id = ?
				LIMIT 1
			`).get(sessionId, turnId) as RuntimeTurnRow | undefined;
			if (!row) return undefined;
			const turn = runtimeTurnFromRow(row);
			if (turn.status === "in_progress") {
				this.#recoverInterruptedTurnRecords(turn, this.#clock(), userInitiated);
			} else if (turn.status === "interrupted" && userInitiated) {
				this.#appendInterruptedTurnMarker(turn);
			}
			return this.#requiredTurn(sessionId, turn.client_turn_id);
		});
	}

	listSessions(query: SessionListQuery = {}): readonly SessionOverview[] {
		return this.#stateRepository.listSessions(query);
	}

	loadSession(sessionId: string): SessionOverview | undefined {
		return this.#stateRepository.loadSession(sessionId);
	}

	loadSessionLineage(sessionId: string): readonly SessionLineageNode[] {
		return this.#stateRepository.loadSessionLineage(sessionId);
	}

	forkSession(input: ForkSessionInput): ForkSessionResult {
		const sourceSessionId = requiredSessionId(input.sourceSessionId, "source session");
		const targetSessionId = requiredSessionId(input.targetSessionId, "target session");
		if (sourceSessionId === targetSessionId) {
			throw new StorageFailure("target session already exists");
		}
		return this.#write(() => {
			const source = this.#database.prepare(`
				SELECT workspace_root, thread_id FROM sessions WHERE session_id = ?
			`).get(sourceSessionId) as {
				readonly workspace_root: unknown;
				readonly thread_id: unknown;
			} | undefined;
			if (!source) throw new StorageFailure("source session does not exist");
			const existing = this.#database.prepare(
				"SELECT 1 AS present FROM sessions WHERE session_id = ?",
			).get(targetSessionId);
			if (existing) throw new StorageFailure("target session already exists");

			const messageRows = this.#database.prepare(`
				SELECT message_index, payload_json
				FROM conversation_messages
				WHERE session_id = ?
				ORDER BY message_index
			`).all(sourceSessionId) as readonly {
				readonly message_index: number;
				readonly payload_json: unknown;
			}[];
			const forkPoint = input.forkPoint ?? messageRows.length;
			if (!Number.isSafeInteger(forkPoint) || forkPoint < 0 || forkPoint > messageRows.length) {
				throw new StorageFailure("fork point is outside the conversation");
			}

			const now = this.#clock();
			this.#database.prepare(`
				INSERT INTO sessions (
					session_id, workspace_root, thread_id, created_at,
					updated_at, last_active_at, status
				) VALUES (?, ?, ?, ?, ?, ?, 'active')
			`).run(targetSessionId, String(source.workspace_root), targetSessionId, now, now, now);
			this.#database.prepare(`
				INSERT INTO conversation_trees (session_id, parent_id, fork_point, updated_at)
				VALUES (?, ?, ?, ?)
			`).run(targetSessionId, sourceSessionId, forkPoint, now);

			const selectedRows = messageRows.slice(0, forkPoint);
			const insertMessage = this.#database.prepare(`
				INSERT INTO conversation_messages (session_id, message_index, payload_json)
				VALUES (?, ?, ?)
			`);
			const historyRefs = emptyForkHistoryRefs();
			for (const row of selectedRows) {
				const payload = parsedRecord(row.payload_json, "conversation_messages");
				collectForkHistoryRefs(historyRefs, payload);
				insertMessage.run(targetSessionId, row.message_index, stableJson(payload));
			}

			const insertHistory = this.#database.prepare(`
				INSERT INTO history_items (session_id, item_id, payload_json)
				VALUES (?, ?, ?)
			`);
			const historyRows = this.#database.prepare(`
				SELECT item_id, payload_json
				FROM history_items
				WHERE session_id = ?
				ORDER BY sequence_no
			`).all(sourceSessionId) as readonly {
				readonly item_id: unknown;
				readonly payload_json: unknown;
			}[];
			for (const row of historyRows) {
				const payload = parsedRecord(row.payload_json, "history_items");
				if (!forkIncludesHistoryItem(historyRefs, payload)) continue;
				insertHistory.run(
					targetSessionId,
					String(row.item_id),
					stableJson({ ...payload, thread_id: targetSessionId }),
				);
			}

			return Object.freeze({
				sourceSessionId,
				targetSessionId,
				forkPoint,
				messageCount: selectedRows.length,
			});
		});
	}

	forkAgentConversation(input: ForkAgentConversationInput): ForkAgentConversationResult {
		const sourceSessionId = requiredSessionId(input.sourceSessionId, "source session");
		const targetSessionId = requiredSessionId(input.targetSessionId, "target session");
		if (sourceSessionId === targetSessionId) {
			throw new StorageFailure("target agent session must differ from source session");
		}
		if (input.forkTurns === "none") {
			return Object.freeze({ sourceSessionId, targetSessionId, messageCount: 0 });
		}
		return this.#write(() => {
			const source = this.#database.prepare(
				"SELECT 1 AS present FROM sessions WHERE session_id = ?",
			).get(sourceSessionId);
			if (!source) throw new StorageFailure("source session does not exist");
			const existing = this.#database.prepare(
				"SELECT 1 AS present FROM sessions WHERE session_id = ?",
			).get(targetSessionId);
			if (existing) throw new StorageFailure("target session already exists");
			const completedTurnIds = new Set((this.#database.prepare(`
				SELECT turn_id
				FROM runtime_turns
				WHERE session_id = ? AND status = 'completed'
			`).all(sourceSessionId) as readonly { readonly turn_id: unknown }[])
				.map((row) => String(row.turn_id)));
			const rows = this.#database.prepare(`
				SELECT payload_json
				FROM conversation_messages
				WHERE session_id = ?
				ORDER BY message_index
			`).all(sourceSessionId) as readonly { readonly payload_json: unknown }[];
			let currentTurnCommitted = true;
			const sourceItems = rows.flatMap((row): CanonicalConversationItem[] => {
				const payload = parsedRecord(row.payload_json, "conversation_messages");
				const metadata = recordValue(payload.metadata);
				if (metadata.source === "task_notification" || metadata.source === "agent_mailbox") return [];
				const turnId = stringValue(metadata.turn_id);
				if (payload.role === "user" && turnId) {
					currentTurnCommitted = completedTurnIds.has(turnId);
				}
				if (turnId && !completedTurnIds.has(turnId)) return [];
				if (!turnId && !currentTurnCommitted) return [];
				return [canonicalConversationItem(stableJson(payload), "conversation_messages")];
			});
			const selected = selectAgentForkConversation(sourceItems, input.forkTurns);
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
				requiredSessionId(input.workspaceRoot, "workspace root"),
				requiredSessionId(input.targetThreadId, "target thread"),
				now,
				now,
				now,
			);
			const insert = this.#database.prepare(`
				INSERT INTO conversation_messages (session_id, message_index, payload_json)
				VALUES (?, ?, ?)
			`);
			for (const [index, item] of selected.entries()) {
				insert.run(targetSessionId, index, stableJson(agentForkMessage(item)));
			}
			return Object.freeze({
				sourceSessionId,
				targetSessionId,
				messageCount: selected.length,
			});
		});
	}

	searchMessages(query: string, options: SessionSearchQuery = {}): readonly SessionSearchResult[] {
		const match = ftsMatchQuery(query);
		if (!match) return Object.freeze([]);
		const limit = boundedOperationLimit(options.limit ?? 20, 100, "session search limit");
		const workspaceRoot = options.workspaceRoot?.trim();
		try {
			const rows = this.#database.prepare(`
				SELECT
					conversation_messages.session_id,
					conversation_messages.message_index,
					conversation_messages.payload_json
				FROM conversation_messages_fts
				JOIN conversation_messages
					ON conversation_messages.rowid = conversation_messages_fts.rowid
				JOIN sessions ON sessions.session_id = conversation_messages.session_id
				WHERE conversation_messages_fts MATCH ?
				${workspaceRoot ? "AND sessions.workspace_root = ?" : ""}
				ORDER BY conversation_messages_fts.rank, sessions.last_active_at DESC,
					conversation_messages.message_index ASC
				LIMIT ?
			`).all(...(workspaceRoot ? [match, workspaceRoot, limit] : [match, limit])) as readonly {
				readonly session_id: unknown;
				readonly message_index: unknown;
				readonly payload_json: unknown;
			}[];
			return Object.freeze(rows.flatMap((row): SessionSearchResult[] => {
				const item = canonicalConversationItem(row.payload_json, "conversation_messages");
				const content = conversationSearchText(item);
				if (!content) return [];
				return [Object.freeze({
					sessionId: String(row.session_id),
					messageIndex: Number(row.message_index),
					role: conversationSearchRole(item),
					snippet: searchSnippet(content, query),
				})];
			}));
		} catch (error) {
			throw storageError(error);
		}
	}

	sessionMaintenanceReport(options: SessionMaintenanceOptions = {}): SessionMaintenanceReport {
		const candidateLimit = boundedOperationLimit(
			options.candidateLimit ?? 5,
			100,
			"maintenance candidate limit",
		);
		const workspaceRoot = options.workspaceRoot?.trim();
		try {
			const where = workspaceRoot ? "WHERE sessions.workspace_root = ?" : "";
			const parameters = workspaceRoot ? [workspaceRoot] : [];
			const countRow = this.#database.prepare(`
				SELECT COUNT(*) AS count FROM sessions ${where}
			`).get(...parameters) as { readonly count: number };
			const candidates = this.#emptySessionCandidates(workspaceRoot);
			const payloads = this.#legacyPayloadMetrics(workspaceRoot);
			const metrics = this.#storageMetrics();
			return Object.freeze({
				workspaceSessionCount: Number(countRow.count),
				emptySessionCount: candidates.length,
				emptySessionCandidates: Object.freeze(candidates.slice(0, candidateLimit)),
				emptySessionCandidatesOmitted: Math.max(0, candidates.length - candidateLimit),
				...payloads,
				...metrics,
				freelistBytes: metrics.freelistCount * metrics.pageSize,
				dryRun: true,
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	cleanupLegacySessionPayloads(
		options: SessionMaintenanceOptions = {},
	): SessionPayloadCleanupResult {
		const payloadLimit = boundedOperationLimit(
			options.payloadLimit ?? 1_000,
			10_000,
			"maintenance payload limit",
		);
		const workspaceRoot = options.workspaceRoot?.trim();
		const applied = this.#write(() => {
			const rolloutCandidates = this.#legacyRolloutCandidateSql(workspaceRoot, true);
			const rolloutIds = (this.#database.prepare(rolloutCandidates.sql).all(
				...rolloutCandidates.parameters,
				payloadLimit,
			) as readonly { readonly candidate_rowid: unknown }[])
				.map((row) => Number(row.candidate_rowid));
			const rolloutBytes = this.#rolloutBytesReclaimable(rolloutIds);
			const rolloutResult = rolloutIds.length === 0
				? { changes: 0 }
				: this.#database.prepare(`
					UPDATE turn_rollouts
					SET payload_json = ${compactLegacyRolloutSql("turn_rollouts")}
					WHERE rowid IN (${rolloutIds.map(() => "?").join(", ")})
				`).run(...rolloutIds);

			const stateCandidates = this.#legacyStateCandidateSql(workspaceRoot, true);
			const stateIds = (this.#database.prepare(stateCandidates.sql).all(
				...stateCandidates.parameters,
				payloadLimit,
			) as readonly { readonly candidate_rowid: unknown }[])
				.map((row) => Number(row.candidate_rowid));
			const stateBytes = this.#statePayloadBytes(stateIds);
			const stateResult = stateIds.length === 0
				? { changes: 0 }
				: this.#database.prepare(`
					DELETE FROM session_state
					WHERE rowid IN (${stateIds.map(() => "?").join(", ")})
				`).run(...stateIds);

			return Object.freeze({
				compactedRolloutCount: rolloutResult.changes,
				deletedStateCount: stateResult.changes,
				removedPayloadBytes: rolloutBytes + stateBytes,
			});
		});
		const remaining = this.#legacyPayloadMetrics(workspaceRoot);
		return Object.freeze({
			compactedRolloutCount: applied.compactedRolloutCount,
			deletedStateCount: applied.deletedStateCount,
			removedPayloadBytes: applied.removedPayloadBytes,
			remainingCompactableRolloutCount: remaining.compactableRolloutCount,
			remainingRemovableStateCount: remaining.removableStateCount,
			...this.#storageMetrics(),
			dryRun: false,
		});
	}

	cleanupEmptySessions(options: SessionMaintenanceOptions = {}): SessionEmptyCleanupResult {
		const candidateLimit = boundedOperationLimit(
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
	}

	cleanupOrphanedSessionRows(): SessionOrphanCleanupResult {
		return this.#write(() => {
			const tables = [
				"conversation_messages",
				"conversation_trees",
				"history_items",
				"turn_rollouts",
				"session_state",
				"session_summaries",
				"runtime_turns",
			] as const;
			const deletedRowsByTable: Array<{ readonly table: string; readonly count: number }> = [];
			for (const table of tables) {
				const result = this.#database.prepare(`
					DELETE FROM ${table} WHERE session_id NOT IN (SELECT session_id FROM sessions)
				`).run();
				if (result.changes > 0) deletedRowsByTable.push({ table, count: result.changes });
			}
			const taskResult = this.#database.prepare(`
				DELETE FROM subagent_tasks
				WHERE parent_session_id NOT IN (SELECT session_id FROM sessions)
			`).run();
			if (taskResult.changes > 0) {
				deletedRowsByTable.push({ table: "subagent_tasks", count: taskResult.changes });
			}
			return Object.freeze({
				deletedRowsByTable: Object.freeze(deletedRowsByTable),
				totalDeletedRows: deletedRowsByTable.reduce((total, item) => total + item.count, 0),
				dryRun: false,
			});
		});
	}

	vacuumSessionStorage(): SessionVacuumResult {
		if (this.#closed) throw new StorageFailure("session store is closed");
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

	loadState(sessionId: string, key: RuntimeStateKey): unknown | undefined {
		return this.#stateRepository.loadState(sessionId, key);
	}

	saveState(input: SaveStateInput): void {
		this.#stateRepository.saveState(input);
	}

	saveQueueSnapshot(input: SaveQueueSnapshotInput): QueueSnapshot {
		return this.#stateRepository.saveQueueSnapshot(input);
	}

	deleteState(sessionId: string, key: RuntimeStateKey): void {
		this.#stateRepository.deleteState(sessionId, key);
	}

	appendSessionSummary(input: AppendSessionSummaryInput): void {
		this.#stateRepository.appendSessionSummary(input);
	}

	loadSessionSummaries(sessionId: string): readonly string[] {
		return this.#stateRepository.loadSessionSummaries(sessionId);
	}

	loadRecentSessionSummaries(sessionId: string, limit: number): readonly string[] {
		return this.#stateRepository.loadRecentSessionSummaries(sessionId, limit);
	}

	loadHistoryItems(sessionId: string): readonly Readonly<Record<string, unknown>>[] {
		return this.#stateRepository.loadHistoryItems(sessionId);
	}

	loadRecentHistoryItems(
		sessionId: string,
		limit: number,
	): readonly Readonly<Record<string, unknown>>[] {
		return this.#stateRepository.loadRecentHistoryItems(sessionId, limit);
	}

	loadTurnRollouts(sessionId: string): readonly Readonly<Record<string, unknown>>[] {
		return this.#stateRepository.loadTurnRollouts(sessionId);
	}

	loadRecentTurnRollouts(
		sessionId: string,
		limit: number,
	): readonly Readonly<Record<string, unknown>>[] {
		return this.#stateRepository.loadRecentTurnRollouts(sessionId, limit);
	}

	loadHistoryItemWindow(
		sessionId: string,
		beforeSequence: number | undefined,
		limit: number,
	): HistoryItemWindow {
		return this.#stateRepository.loadHistoryItemWindow(sessionId, beforeSequence, limit);
	}

	loadTurnRolloutsForTurns(
		sessionId: string,
		turnIds: readonly string[],
	): readonly Readonly<Record<string, unknown>>[] {
		return this.#stateRepository.loadTurnRolloutsForTurns(sessionId, turnIds);
	}

	upsertShellSnapshot(input: UpsertShellSnapshotInput): void {
		this.#write(() => {
			const payload = shellHistoryItem(input, this.#threadId(input.sessionId));
			if (input.outputChunk) {
				const chunk = validateShellOutputChunk(input.outputChunk);
				this.#database.prepare(`
					INSERT INTO shell_output_chunks (
						session_id, shell_id, call_id, event_sequence,
						cursor_start, cursor_end, omitted_before, output_text
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				`).run(
					input.sessionId,
					input.shellId,
					input.callId,
					chunk.sequence,
					chunk.cursorStart,
					chunk.cursorEnd,
					chunk.omittedBefore,
					chunk.output,
				);
			}
			const itemId = String(payload.id);
			const row = this.#database.prepare(`
				SELECT sequence_no
				FROM history_items
				WHERE session_id = ? AND item_id = ?
				ORDER BY sequence_no DESC
				LIMIT 1
			`).get(input.sessionId, itemId) as { sequence_no: number } | undefined;
			if (row) {
				this.#database.prepare(`
					UPDATE history_items
					SET payload_json = ?
					WHERE sequence_no = ?
				`).run(stableJson(payload), row.sequence_no);
			} else {
				this.#database.prepare(`
					INSERT INTO history_items (session_id, item_id, payload_json)
					VALUES (?, ?, ?)
				`).run(input.sessionId, itemId, stableJson(payload));
			}
		});
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
				if (selected.length > 0 && selectedChars + chunk.output.length > normalized.limitChars) break;
				selected.push(chunk);
				selectedChars += chunk.output.length;
			}
			const lastSequence = selected.at(-1)?.sequence;
			const hasMore = lastSequence !== undefined && (
				selected.length < rows.length || this.#database.prepare(`
					SELECT 1 AS present
					FROM shell_output_chunks
					WHERE session_id = ? AND shell_id = ?${callClause}
					  AND event_sequence > ?
					LIMIT 1
				`).get(...(
					normalized.callId === undefined
						? [normalized.sessionId, normalized.shellId, lastSequence]
						: [normalized.sessionId, normalized.shellId, normalized.callId, lastSequence]
				)) !== undefined
			);
			const totals = this.#database.prepare(`
				SELECT COUNT(*) AS chunk_count,
				       MIN(cursor_start) AS first_cursor,
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
				complete: available
					&& Number(totals.first_cursor) === 0
					&& omittedChars === 0
					&& capturedChars === outputChars,
				omittedChars,
				capturedChars,
				outputChars,
			});
		} catch (error) {
			throw storageError(error);
		}
	}

	importLegacyConversation(input: ImportLegacyConversationInput): boolean {
		return this.#stateRepository.importLegacyConversation(input);
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
		return this.#stateRepository.saveApprovalSuspension(input);
	}

	saveClarificationSuspension(input: SaveClarificationSuspensionInput): void {
		this.#stateRepository.saveClarificationSuspension(input);
	}

	commitClarificationResponse(input: CommitClarificationResponseInput): void {
		this.#stateRepository.commitClarificationResponse(input, () => {
			const running = this.#requireRunningTurn(input.sessionId, input.toolResult.clientTurnId);
			const expected = this.#pendingToolCalls(input.sessionId, running.turn_id)[0];
			if (!expected
				|| expected.callId !== input.toolResult.result.callId
				|| expected.name !== input.toolResult.result.toolName
				|| expected.callId !== input.requestId) {
				throw new StorageFailure("clarification response does not match pending call");
			}
			this.#appendToolResultRecords(running, input.toolResult);
		});
	}

	commitApprovalResult(input: CommitApprovalResultInput): ApprovalCheckpoint {
		return this.#stateRepository.commitApprovalResult(input, () => {
			const running = this.#requireRunningTurn(input.sessionId, input.toolResult.clientTurnId);
			const expected = this.#pendingToolCalls(input.sessionId, running.turn_id)[0];
			if (!expected
				|| expected.callId !== input.toolResult.result.callId
				|| expected.name !== input.toolResult.result.toolName) {
				throw new StorageFailure("approval tool result does not match pending call");
			}
			this.#appendToolResultRecords(running, input.toolResult);
		});
	}

	finalizeApprovalContinuation(input: FinalizeApprovalContinuationInput): void {
		this.#stateRepository.finalizeApprovalContinuation(input);
	}

	interruptAmbiguousApproval(input: InterruptAmbiguousApprovalInput): RuntimeTurnRecord {
		this.#stateRepository.interruptAmbiguousApproval(input, () => {
			const running = this.#requireRunningTurn(input.sessionId, input.clientTurnId);
			const expected = this.#pendingToolCalls(input.sessionId, running.turn_id)[0];
			if (!expected || expected.callId !== input.callId || expected.name !== input.toolName) {
				throw new StorageFailure("ambiguous approval call does not match pending call");
			}
			this.#appendToolResultRecords(running, {
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
				});
				this.#appendInterruptedTurnMarker(running);
				this.#appendRollout(input.sessionId, failedRollout(running, {
				sessionId: input.sessionId,
				clientTurnId: input.clientTurnId,
				code: "interrupted",
				message: "tool effect outcome is unknown",
				completedAt: input.completedAt,
			}, "interrupted", this.#threadId(input.sessionId)));
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
				input.completedAt,
				input.sessionId,
				input.clientTurnId,
			);
		});
		return this.#requiredTurn(input.sessionId, input.clientTurnId);
	}

	commitCompaction(input: CommitCompactionInput): void {
		this.#stateRepository.commitCompaction(input);
	}

	#legacyPayloadMetrics(workspaceRoot?: string): Readonly<{
		readonly compactableRolloutCount: number;
		readonly compactableRolloutBytes: number;
		readonly removableStateCount: number;
		readonly removableStateBytes: number;
		readonly estimatedPayloadBytesReclaimable: number;
	}> {
		const rollouts = this.#legacyRolloutCandidateSql(workspaceRoot, false);
		const rolloutRow = this.#database.prepare(`
			SELECT COUNT(*) AS count,
				COALESCE(SUM(
					length(CAST(turn_rollouts.payload_json AS BLOB))
					- length(CAST(${compactLegacyRolloutSql("turn_rollouts")} AS BLOB))
				), 0) AS bytes
			FROM turn_rollouts
			WHERE rowid IN (${rollouts.sql})
		`).get(...rollouts.parameters) as {
			readonly count: unknown;
			readonly bytes: unknown;
		};
		const states = this.#legacyStateCandidateSql(workspaceRoot, false);
		const stateRow = this.#database.prepare(`
			SELECT COUNT(*) AS count,
				COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS bytes
			FROM session_state
			WHERE rowid IN (${states.sql})
		`).get(...states.parameters) as {
			readonly count: unknown;
			readonly bytes: unknown;
		};
		const compactableRolloutBytes = Number(rolloutRow.bytes);
		const removableStateBytes = Number(stateRow.bytes);
		return Object.freeze({
			compactableRolloutCount: Number(rolloutRow.count),
			compactableRolloutBytes,
			removableStateCount: Number(stateRow.count),
			removableStateBytes,
			estimatedPayloadBytesReclaimable: compactableRolloutBytes + removableStateBytes,
		});
	}

	#legacyRolloutCandidateSql(
		workspaceRoot: string | undefined,
		bounded: boolean,
	): Readonly<{ readonly sql: string; readonly parameters: readonly string[] }> {
		return Object.freeze({
			sql: `
				SELECT turn_rollouts.rowid AS candidate_rowid
				FROM turn_rollouts
				JOIN sessions ON sessions.session_id = turn_rollouts.session_id
				WHERE json_valid(turn_rollouts.payload_json)
					AND json_type(turn_rollouts.payload_json, '$.events') = 'array'
					AND json_array_length(turn_rollouts.payload_json, '$.events') > 0
					AND json(json_extract(turn_rollouts.payload_json, '$.events')) !=
						json('[{"kind":"turn_item","payload":{"type":"approval_resolution"}}]')
					AND json_extract(turn_rollouts.payload_json, '$.status') IN (
						'completed', 'failed', 'interrupted', 'rejected'
					)
					AND NOT EXISTS (
						SELECT 1 FROM runtime_turns
						WHERE runtime_turns.session_id = turn_rollouts.session_id
							AND runtime_turns.status = 'in_progress'
					)
					AND NOT EXISTS (
						SELECT 1 FROM session_state
						WHERE session_state.session_id = turn_rollouts.session_id
							AND session_state.state_key IN ('pending_decision', 'suspended_turn')
					)
					${workspaceRoot ? "AND sessions.workspace_root = ?" : ""}
				ORDER BY turn_rollouts.rowid
				${bounded ? "LIMIT ?" : ""}
			`,
			parameters: Object.freeze(workspaceRoot ? [workspaceRoot] : []),
		});
	}

	#legacyStateCandidateSql(
		workspaceRoot: string | undefined,
		bounded: boolean,
	): Readonly<{ readonly sql: string; readonly parameters: readonly string[] }> {
		return Object.freeze({
			sql: `
				SELECT session_state.rowid AS candidate_rowid
				FROM session_state
				JOIN sessions ON sessions.session_id = session_state.session_id
				WHERE json_valid(session_state.payload_json)
					AND json_type(session_state.payload_json) IN ('object', 'array')
					AND (
						session_state.state_key = 'provider_timeline'
						OR (
							session_state.state_key = 'turn_record'
							AND json_extract(session_state.payload_json, '$.status') IN (
								'completed', 'failed', 'interrupted', 'rejected'
							)
						)
					)
					AND NOT EXISTS (
						SELECT 1 FROM runtime_turns
						WHERE runtime_turns.session_id = session_state.session_id
							AND runtime_turns.status = 'in_progress'
					)
					AND NOT EXISTS (
						SELECT 1 FROM session_state AS active_state
						WHERE active_state.session_id = session_state.session_id
							AND active_state.state_key IN ('pending_decision', 'suspended_turn')
					)
					${workspaceRoot ? "AND sessions.workspace_root = ?" : ""}
				ORDER BY session_state.rowid
				${bounded ? "LIMIT ?" : ""}
			`,
			parameters: Object.freeze(workspaceRoot ? [workspaceRoot] : []),
		});
	}

	#rolloutBytesReclaimable(rowIds: readonly number[]): number {
		if (rowIds.length === 0) return 0;
		const row = this.#database.prepare(`
			SELECT COALESCE(SUM(
				length(CAST(payload_json AS BLOB))
				- length(CAST(${compactLegacyRolloutSql("turn_rollouts")} AS BLOB))
			), 0) AS bytes
			FROM turn_rollouts
			WHERE rowid IN (${rowIds.map(() => "?").join(", ")})
		`).get(...rowIds) as { readonly bytes: unknown };
		return Number(row.bytes);
	}

	#statePayloadBytes(rowIds: readonly number[]): number {
		if (rowIds.length === 0) return 0;
		const row = this.#database.prepare(`
			SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS bytes
			FROM session_state
			WHERE rowid IN (${rowIds.map(() => "?").join(", ")})
		`).get(...rowIds) as { readonly bytes: unknown };
		return Number(row.bytes);
	}

	#emptySessionCandidates(workspaceRoot?: string): readonly SessionMaintenanceCandidate[] {
		const where = workspaceRoot ? "AND sessions.workspace_root = ?" : "";
		const parameters = workspaceRoot ? [workspaceRoot] : [];
		const rows = this.#database.prepare(`
			SELECT sessions.session_id, sessions.last_active_at, sessions.status
			FROM sessions
			WHERE NOT EXISTS (
				SELECT 1 FROM conversation_messages
				WHERE conversation_messages.session_id = sessions.session_id
			)
			AND NOT EXISTS (
				SELECT 1 FROM session_summaries
				WHERE session_summaries.session_id = sessions.session_id
			)
			AND NOT EXISTS (
				SELECT 1 FROM history_items
				WHERE history_items.session_id = sessions.session_id
			)
			AND NOT EXISTS (
				SELECT 1 FROM turn_rollouts
				WHERE turn_rollouts.session_id = sessions.session_id
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

	close(): void {
		if (!this.#closed) {
			try {
				this.#write(() => {
					this.#database.prepare(`
						UPDATE runtime_turns
						SET owner_id = NULL, owner_pid = NULL
						WHERE status = 'in_progress' AND owner_id = ?
					`).run(this.#ownerId);
				});
			} finally {
				this.#database.close();
				this.#closed = true;
			}
		}
	}

	#configure(busyTimeoutMs: number): void {
		try {
			this.#database.pragma("journal_mode = WAL");
		} catch (error) {
			const message = error instanceof Error ? error.message.toLowerCase() : "";
			if (!message.includes("locking protocol") && !message.includes("not authorized")) {
				throw error;
			}
			this.#database.pragma("journal_mode = DELETE");
		}
		this.#database.pragma("foreign_keys = ON");
		this.#database.pragma(`busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
	}

	#initialize(): void {
		const version = this.#schemaVersion();
		this.#assertSupportedSchemaVersion(version);
		if (version === SCHEMA_VERSION) {
			this.#ensureTranscriptProjectionIndexes();
			return;
		}

		this.#write(() => {
			const lockedVersion = this.#schemaVersion();
			this.#assertSupportedSchemaVersion(lockedVersion);
			if (lockedVersion === SCHEMA_VERSION) return;
			this.#database.exec(SCHEMA_V2_SQL);
			this.#ensureRuntimeTurnOwnershipColumns();
			this.#database.exec(SCHEMA_V5_SQL);
			this.#database.exec(SCHEMA_V6_SQL);
			this.#database.exec(SCHEMA_V7_SQL);
			this.#database.exec(SCHEMA_V8_SQL);
			this.#database.exec(SCHEMA_V9_SQL);
			this.#database.exec(TRANSCRIPT_PROJECTION_INDEX_SQL);
			this.#database.prepare("DELETE FROM schema_version").run();
			this.#database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
		});
	}

	#schemaVersion(): number | undefined {
		const versionTable = this.#database.prepare(`
			SELECT 1 AS present
			FROM sqlite_master
			WHERE type = 'table' AND name = 'schema_version'
		`).get() as { present: number } | undefined;
		if (!versionTable) return undefined;
		const version = this.#database.prepare(
			"SELECT version FROM schema_version LIMIT 1",
		).get() as { version: unknown } | undefined;
		if (!version) return undefined;
		return typeof version.version === "number" ? version.version : Number.NaN;
	}

	#assertSupportedSchemaVersion(version: number | undefined): void {
		if (version === undefined || [2, 3, 4, 5, 6, 7, 8, SCHEMA_VERSION].includes(version)) return;
		throw new StorageFailure("unsupported session schema version", {
			expected_version: SCHEMA_VERSION,
			actual_version: Number.isFinite(version) ? version : null,
		});
	}

	#ensureTranscriptProjectionIndexes(): void {
		if (this.#hasTranscriptProjectionIndexes()) return;
		this.#write(() => {
			if (this.#hasTranscriptProjectionIndexes()) return;
			this.#database.exec(TRANSCRIPT_PROJECTION_INDEX_SQL);
		});
	}

	#hasTranscriptProjectionIndexes(): boolean {
		const row = this.#database.prepare(`
			SELECT COUNT(*) AS count FROM sqlite_master
			WHERE type = 'index' AND name IN (
				'idx_history_items_session_sequence',
				'idx_turn_rollouts_session_sequence',
				'idx_turn_rollouts_session_turn_sequence',
				'idx_session_summaries_session_sequence'
			)
		`).get() as { readonly count: unknown };
		return Number(row.count) === 4;
	}

	#ensureRuntimeTurnOwnershipColumns(): void {
		const columns = new Set(
			(this.#database.prepare("PRAGMA table_info(runtime_turns)").all() as readonly { name: unknown }[])
				.map((row) => String(row.name)),
		);
		if (!columns.has("owner_id")) {
			this.#database.exec("ALTER TABLE runtime_turns ADD COLUMN owner_id TEXT");
		}
		if (!columns.has("owner_pid")) {
			this.#database.exec("ALTER TABLE runtime_turns ADD COLUMN owner_pid INTEGER");
		}
	}

	#write<Result>(operation: () => Result): Result {
		if (this.#closed) {
			throw new StorageFailure("session store is closed");
		}
		if (this.#database.inTransaction) {
			return operation();
		}
		try {
			this.#database.exec("BEGIN IMMEDIATE");
			const result = operation();
			this.#database.exec("COMMIT");
			return result;
		} catch (error) {
			if (this.#database.inTransaction) {
				this.#database.exec("ROLLBACK");
			}
			throw storageError(error);
		}
	}

	#touchSession(input: ReserveTurnInput): void {
		const now = this.#clock();
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
		`).run(
			input.sessionId,
			input.workspaceRoot,
			input.threadId,
			now,
			now,
			now,
		);
	}

	#touchExistingSession(sessionId: string, timestamp: string): void {
		this.#database.prepare(`
			UPDATE sessions
			SET updated_at = ?, last_active_at = ?
			WHERE session_id = ?
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
		if (!turn) {
			throw new StorageFailure("runtime turn does not exist");
		}
		return turn;
	}

	#threadId(sessionId: string): string {
		const row = this.#database.prepare(
			"SELECT thread_id FROM sessions WHERE session_id = ?",
		).get(sessionId) as { thread_id: unknown } | undefined;
		if (!row || typeof row.thread_id !== "string" || !row.thread_id) {
			throw new StorageFailure("session thread does not exist");
		}
		return row.thread_id;
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

	#knownToolCallIds(sessionId: string): Set<string> {
		const ids = new Set<string>();
		for (const item of this.#conversationItems(sessionId)) {
			if (item.type === "assistant_tool_calls") {
				for (const call of item.calls) {
					ids.add(call.callId);
				}
			}
		}
		return ids;
	}

	#pendingToolCalls(sessionId: string, turnId: string): CanonicalToolCall[] {
		const pending: CanonicalToolCall[] = [];
		for (const item of this.#conversationItems(sessionId, turnId)) {
			if (item.type === "assistant_tool_calls") {
				pending.push(...item.calls);
				continue;
			}
			if (item.type === "tool_result") {
				const index = pending.findIndex((call) => call.callId === item.callId);
				if (index >= 0) {
					pending.splice(index, 1);
				}
			}
		}
		return pending;
	}

	#conversationItems(sessionId: string, turnId?: string): readonly CanonicalConversationItem[] {
		const rows = this.#database.prepare(`
			SELECT payload_json
			FROM conversation_messages
			WHERE session_id = ?
			  ${turnId === undefined ? "" : `AND CASE
				WHEN json_valid(payload_json)
				THEN json_extract(payload_json, '$.metadata.turn_id')
			  END = ?`}
			ORDER BY message_index
		`).all(...(turnId === undefined ? [sessionId] : [sessionId, turnId])) as readonly {
			payload_json: unknown;
		}[];
		return rows.map((row) => canonicalConversationItem(
			row.payload_json,
			"conversation_messages",
		));
	}

	#activeToolCallIds(sessionId: string): ReadonlySet<string> {
		const rows = this.#database.prepare(`
			SELECT c.payload_json
			FROM conversation_messages c
			JOIN runtime_turns t
			  ON t.session_id = c.session_id
			 AND t.turn_id = json_extract(c.payload_json, '$.metadata.turn_id')
			WHERE c.session_id = ? AND t.status = 'in_progress'
			ORDER BY c.message_index
		`).all(sessionId) as readonly { payload_json: unknown }[];
		const callIds = new Set<string>();
		for (const row of rows) {
			const item = canonicalConversationItem(row.payload_json, "conversation_messages");
			if (item.type !== "assistant_tool_calls") continue;
			for (const call of item.calls) callIds.add(call.callId);
		}
		return callIds;
	}

	#appendToolResultRecords(
		turn: RuntimeTurnRecord,
		input: AppendToolResultInput,
	): void {
		validateToolResultEffects(input);
		const threadId = this.#threadId(input.sessionId);
		this.#appendConversationMessage(
			input.sessionId,
			toolResultMessage(turn, input),
		);
		this.#appendHistoryItem(
			input.sessionId,
			toolResultHistoryItem(turn, input, threadId),
		);
	}

	#appendContextItemRecords(input: AppendContextItemInput): void {
		validateContextItem(input);
		this.#appendConversationMessage(input.sessionId, contextMessage(input));
		this.#appendHistoryItem(input.sessionId, contextHistoryItem(input));
	}

	#appendInterruptedTurnMarker(turn: RuntimeTurnRecord): void {
		const marker = turnAbortedContextItem(turn.turn_id);
		const existing = this.#database.prepare(`
			SELECT 1 FROM history_items WHERE session_id = ? AND item_id = ? LIMIT 1
		`).get(turn.session_id, marker.itemId);
		if (existing) return;
		this.#appendContextItemRecords({
			sessionId: turn.session_id,
			itemId: marker.itemId,
			text: marker.item.text,
			metadata: marker.item.metadata,
		});
	}

	#recoverInterruptedTurnRecords(
		turn: RuntimeTurnRecord,
		completedAt: string,
		userInitiated: boolean,
	): void {
		const interruptedAttempts = this.#recoverInterruptedToolAttempts(turn, completedAt);
		let pendingCalls: readonly CanonicalToolCall[] = [];
		try {
			pendingCalls = this.#pendingToolCalls(turn.session_id, turn.turn_id);
		} catch (error) {
			if (!(error instanceof StorageFailure)) throw error;
		}
		for (const call of pendingCalls) {
			const recovered = interruptedToolResult(
				call,
				interruptedAttempts.get(call.callId),
				"Tool call interrupted before it completed.",
			);
			this.#appendToolResultRecords(turn, {
				sessionId: turn.session_id,
				clientTurnId: turn.client_turn_id,
				result: recovered.result,
				summary: recovered.summary,
				...(recovered.errorKind ? { errorKind: recovered.errorKind } : {}),
				...(recovered.metadata ? { metadata: recovered.metadata } : {}),
			});
		}
		if (userInitiated) this.#appendInterruptedTurnMarker(turn);
		this.#appendRollout(
			turn.session_id,
			recoveryRollout(turn, completedAt, this.#threadId(turn.session_id)),
		);
		this.#database.prepare(`
			UPDATE runtime_turns
			SET status = 'interrupted', error_code = 'interrupted',
				result_json = ?, completed_at = ?, owner_id = NULL, owner_pid = NULL
			WHERE session_id = ? AND client_turn_id = ? AND status = 'in_progress'
		`).run(
			stableJson({ message: userInitiated
				? "turn interrupted by user"
				: "turn interrupted during process restart" }),
			completedAt,
			turn.session_id,
			turn.client_turn_id,
		);
		this.#touchExistingSession(turn.session_id, completedAt);
	}

	#recoverInterruptedToolAttempts(
		turn: RuntimeTurnRecord,
		completedAt: string,
	): Map<string, AgentEffectAttempt> {
		return new Map(this.agentEffectLedger.recoverInterruptedTools({
			sessionId: turn.session_id,
			turnId: turn.turn_id,
			completedAt,
		}).map((attempt) => [attempt.externalId, attempt]));
	}

	#appendConversationMessage(sessionId: string, payload: Readonly<Record<string, unknown>>): void {
		const row = this.#database.prepare(`
			SELECT COALESCE(MAX(message_index), -1) + 1 AS next_index
			FROM conversation_messages
			WHERE session_id = ?
		`).get(sessionId) as { next_index: number };
		this.#database.prepare(`
			INSERT INTO conversation_messages (session_id, message_index, payload_json)
			VALUES (?, ?, ?)
		`).run(sessionId, row.next_index, stableJson(payload));
	}

	#appendHistoryItem(sessionId: string, payload: Readonly<Record<string, unknown>>): void {
		this.#database.prepare(`
			INSERT INTO history_items (session_id, item_id, payload_json)
			VALUES (?, ?, ?)
		`).run(sessionId, String(payload.id), stableJson(payload));
	}

	#appendRollout(sessionId: string, payload: Readonly<Record<string, unknown>>): void {
		this.#database.prepare(`
			INSERT INTO turn_rollouts (session_id, turn_id, payload_json)
			VALUES (?, ?, ?)
		`).run(sessionId, String(payload.turn_id), stableJson(payload));
	}
}

function interruptedToolResult(
	call: CanonicalToolCall,
	attempt: AgentEffectAttempt | undefined,
	interruptedOutput: string,
): Readonly<{
	result: AppendToolResultInput["result"];
	summary: string;
	errorKind?: string;
	metadata?: Readonly<Record<string, unknown>>;
}> {
	const completed = completedAttemptToolResult(call, attempt);
	if (completed) return completed;
	const toolName = call.name.slice(0, 128) || "Tool";
	const errorKind = attempt?.state === "effect_outcome_unknown"
		? "effect_outcome_unknown"
		: attempt?.state === "failed" || attempt?.state === "unknown"
			? attempt.state
			: "tool_interrupted";
	return Object.freeze({
		result: Object.freeze({
			callId: call.callId,
			toolName: call.name,
			output: errorKind === "effect_outcome_unknown"
				? "Tool outcome is unknown because interruption occurred after the effect started."
				: errorKind === "tool_interrupted"
					? attempt
						? "Tool execution was interrupted before a result was persisted."
						: interruptedOutput
					: "Tool result was not available after interruption.",
			success: false,
		}),
		summary: errorKind === "effect_outcome_unknown"
			? `${toolName} outcome unknown`
			: errorKind === "tool_interrupted"
				? `${toolName} interrupted`
				: `${toolName} result unavailable`,
		errorKind,
		metadata: Object.freeze({ synthetic: true, append_only: true }),
	});
}

function completedAttemptToolResult(
	call: CanonicalToolCall,
	attempt: AgentEffectAttempt | undefined,
): Readonly<{
	result: AppendToolResultInput["result"];
	summary: string;
	errorKind?: string;
	metadata?: Readonly<Record<string, unknown>>;
}> | undefined {
	if (attempt?.state !== "completed" || !attempt.result) return undefined;
	const result = attempt.result;
	if (result.callId !== call.callId
		|| result.toolName !== call.name
		|| typeof result.success !== "boolean"
		|| typeof result.modelOutput !== "string"
		|| typeof result.summary !== "string"
		|| typeof result.metadata !== "object"
		|| result.metadata === null
		|| Array.isArray(result.metadata)) {
		return undefined;
	}
	return Object.freeze({
		result: Object.freeze({
			callId: call.callId,
			toolName: call.name,
			output: result.modelOutput,
			success: result.success,
		}),
		summary: result.summary,
		...(typeof result.errorKind === "string" ? { errorKind: result.errorKind } : {}),
		metadata: Object.freeze({ ...result.metadata as Readonly<Record<string, unknown>> }),
	});
}

function shellOutputChunkFromRow(row: ShellOutputChunkRow): ShellOutputChunk {
	if (
		typeof row.event_sequence !== "number"
		|| typeof row.cursor_start !== "number"
		|| typeof row.cursor_end !== "number"
		|| typeof row.omitted_before !== "number"
		|| typeof row.output_text !== "string"
	) {
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

function userMessage(input: ReserveTurnInput): Readonly<Record<string, unknown>> {
	const images = canonicalImages(input.images ?? [], "reserved user message");
	assertImagePathCount(input.imagePaths ?? [], images);
	return {
		role: "user",
		content: input.userText,
		tool_call_id: null,
		response_id: null,
		metadata: {
			turn_id: input.turnId,
			client_turn_id: input.clientTurnId,
			client_user_message_id: input.clientUserMessageId,
			source: "submit",
			...(input.imagePaths && input.imagePaths.length > 0
				? { image_paths: [...input.imagePaths] }
				: {}),
		},
		blocks: imageBlocks(images),
		tool_calls: [],
	};
}

function userHistoryItem(input: ReserveTurnInput): Readonly<Record<string, unknown>> {
	return {
		id: `${input.turnId}:user:${input.clientUserMessageId}`,
		thread_id: input.threadId,
		turn_id: input.turnId,
		type: "user_message",
		text: input.userText,
		tool_name: null,
		call_id: null,
		metadata: {
			client_turn_id: input.clientTurnId,
			client_user_message_id: input.clientUserMessageId,
			source: "submit",
			image_paths: [...(input.imagePaths ?? [])],
		},
	};
}

function assistantMessage(
	turn: RuntimeTurnRecord,
	input: CompleteStoredTurnInput,
): Readonly<Record<string, unknown>> {
	return {
		role: "assistant",
		content: input.assistantText,
		tool_call_id: null,
		response_id: input.responseId ?? null,
		metadata: {
			turn_id: turn.turn_id,
			source: "node_runtime",
			...(input.providerState
				? { provider_state: persistedProviderState(input.providerState) }
				: {}),
		},
		blocks: [],
		tool_calls: [],
	};
}

interface ParsedToolCall {
	readonly call: CanonicalToolCall;
	readonly argumentsValue: Readonly<Record<string, unknown>>;
}

function assistantToolCallMessage(
	turn: RuntimeTurnRecord,
	input: AppendAssistantToolCallsInput,
	calls: readonly ParsedToolCall[],
): Readonly<Record<string, unknown>> {
	return {
		role: "assistant",
		content: input.assistantText,
		tool_call_id: null,
		response_id: input.responseId ?? null,
		metadata: {
			turn_id: turn.turn_id,
			source: "node_runtime",
			...(input.providerState
				? { provider_state: persistedProviderState(input.providerState) }
				: {}),
		},
		blocks: calls.map(({ call, argumentsValue }) => ({
			type: "tool_call",
			text: null,
			tool_name: call.name,
			tool_arguments: argumentsValue,
			call_id: call.callId,
			provider_id: null,
			metadata: {},
		})),
		tool_calls: calls.map(({ call, argumentsValue }) => ({
			name: call.name,
			arguments: argumentsValue,
			reason: "model requested tool",
			call_id: call.callId,
		})),
	};
}

function toolCallHistoryItem(
	turn: RuntimeTurnRecord,
	input: AppendAssistantToolCallsInput,
	parsed: ParsedToolCall,
	threadId: string,
): Readonly<Record<string, unknown>> {
	return {
		id: `${turn.turn_id}:tool-call:${parsed.call.callId}`,
		thread_id: threadId,
		turn_id: turn.turn_id,
		type: "tool_call",
		text: "",
		tool_name: parsed.call.name,
		call_id: parsed.call.callId,
		metadata: {
			arguments: parsed.argumentsValue,
			source: "node_runtime",
			...(input.responseId ? { response_id: input.responseId } : {}),
			...(input.providerState
				? { provider_state: persistedProviderState(input.providerState) }
				: {}),
		},
	};
}

function assistantToolPreambleHistoryItem(
	turn: RuntimeTurnRecord,
	input: AppendAssistantToolCallsInput,
	firstCall: ParsedToolCall,
	threadId: string,
): Readonly<Record<string, unknown>> {
	return {
		id: `${turn.turn_id}:assistant-tool-preamble:${firstCall.call.callId}`,
		thread_id: threadId,
		turn_id: turn.turn_id,
		type: "assistant_message",
		text: input.assistantText,
		tool_name: null,
		call_id: null,
		metadata: {
			source: "node_runtime",
			...(input.responseId ? { response_id: input.responseId } : {}),
			...(input.providerState
				? { provider_state: persistedProviderState(input.providerState) }
				: {}),
		},
	};
}

function toolResultMessage(
	turn: RuntimeTurnRecord,
	input: AppendToolResultInput,
): Readonly<Record<string, unknown>> {
	const metadata = toolResultMetadata(turn, input);
	const mutationMetadata = projectMutationMetadata(input.metadata, input.result.success);
	return {
		role: "tool",
		content: input.result.output,
		tool_call_id: input.result.callId,
		response_id: null,
		metadata,
		blocks: [{
			type: "tool_result",
			text: input.result.output,
			tool_name: input.result.toolName,
			tool_arguments: null,
			call_id: input.result.callId,
			provider_id: null,
			metadata: {
				success: input.result.success,
				...(input.errorKind ? { error_kind: input.errorKind } : {}),
				...(mutationMetadata.file_changes
					? { file_changes: mutationMetadata.file_changes }
					: {}),
			},
		}],
		tool_calls: [],
	};
}

function toolResultHistoryItem(
	turn: RuntimeTurnRecord,
	input: AppendToolResultInput,
	threadId: string,
): Readonly<Record<string, unknown>> {
	return {
		id: `${turn.turn_id}:tool-result:${input.result.callId}`,
		thread_id: threadId,
		turn_id: turn.turn_id,
		type: "tool_result",
		text: input.summary.slice(0, 500),
		tool_name: input.result.toolName,
		call_id: input.result.callId,
		metadata: {
			...toolResultMetadata(turn, input),
			transcript_content: input.result.output,
		},
	};
}

function planUpdateHistoryItem(
	turn: RuntimeTurnRecord,
	input: AppendToolResultInput,
	threadId: string,
): Readonly<Record<string, unknown>> {
	const update = input.planUpdate;
	if (!update) throw new StorageFailure("plan update is missing");
	if (!Array.isArray(update.items)) throw new StorageFailure("plan update items are invalid");
	if (update.items.length > 128) throw new StorageFailure("plan update exceeds item limit");
	let inProgress = 0;
	const items = update.items.map((item) => {
		if (
			typeof item !== "object"
			|| item === null
			|| typeof item.id !== "string"
			|| typeof item.text !== "string"
			|| !item.id.trim()
			|| item.id.length > 128
			|| !item.text.trim()
			|| item.text.length > 4_096
		) {
			throw new StorageFailure("plan update item is invalid");
		}
		if (!PLAN_STATUSES.has(item.status)) throw new StorageFailure("plan update status is invalid");
		if (item.status === "in_progress") inProgress += 1;
		return Object.freeze({
			id: item.id,
			text: item.text,
			status: item.status,
		});
	});
	if (inProgress > 1) throw new StorageFailure("plan update has multiple active items");
	if (
		update.explanation !== undefined
		&& (typeof update.explanation !== "string" || update.explanation.length > 4_096)
	) {
		throw new StorageFailure("plan update explanation exceeds limit");
	}
	return {
		id: `${turn.turn_id}:plan-update:${input.result.callId}`,
		thread_id: threadId,
		turn_id: turn.turn_id,
		type: "plan_update",
		text: "Updated Plan",
		tool_name: input.result.toolName,
		call_id: input.result.callId,
		metadata: {
			source: input.result.toolName,
			...(update.explanation ? { explanation: update.explanation } : {}),
			completed: items.filter((item) => item.status === "completed").length,
			total: items.length,
			items,
			model_visible: false,
		},
	};
}

function toolResultMetadata(
	turn: RuntimeTurnRecord,
	input: AppendToolResultInput,
): Readonly<Record<string, unknown>> {
	const mutationMetadata = projectMutationMetadata(input.metadata, input.result.success);
	return {
		turn_id: turn.turn_id,
		source: "node_runtime",
		tool_name: input.result.toolName,
		success: input.result.success,
		summary: input.summary.slice(0, 500),
		...(input.errorKind ? { error_kind: input.errorKind } : {}),
		...(["tool_interrupted", "effect_outcome_unknown"].includes(input.errorKind ?? "")
			? { synthetic: true, append_only: true }
			: {}),
		...(mutationMetadata.file_changes
			? { file_changes: mutationMetadata.file_changes }
			: {}),
		...(input.toolActivation ? {
			tool_activation: {
				version: 1,
				names: validatedToolActivationNames(input.toolActivation.names),
			},
		} : {}),
	};
}

function validateToolResultEffects(input: AppendToolResultInput): void {
	if (input.toolActivation) {
		if (!input.result.success || input.result.toolName !== "tool_search") {
			throw new StorageFailure("tool activation requires a successful tool_search result");
		}
		validatedToolActivationNames(input.toolActivation.names);
	}
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

function persistedToolActivationNames(value: unknown): readonly string[] {
	const activation = recordValue(value);
	if (activation.version !== 1 || !Array.isArray(activation.names)
		|| activation.names.length > MAX_TOOL_ACTIVATION_NAMES) return [];
	const names = activation.names.filter(
		(name): name is string => typeof name === "string" && TOOL_ACTIVATION_NAME.test(name),
	);
	return names.length === activation.names.length && new Set(names).size === names.length
		? names
		: [];
}

function assistantHistoryItem(
	turn: RuntimeTurnRecord,
	input: CompleteStoredTurnInput,
	threadId: string,
): Readonly<Record<string, unknown>> {
	return {
		id: `${turn.turn_id}:assistant:1`,
		thread_id: threadId,
		turn_id: turn.turn_id,
		type: "assistant_message",
		text: input.assistantText,
		tool_name: null,
		call_id: null,
		metadata: {
			source: "node_runtime",
			...(input.responseId ? { response_id: input.responseId } : {}),
			...(input.providerState
				? { provider_state: persistedProviderState(input.providerState) }
				: {}),
		},
	};
}

function contextMessage(input: AppendContextItemInput): Readonly<Record<string, unknown>> {
	return {
		role: "context",
		content: input.text,
		tool_call_id: null,
		response_id: null,
		metadata: { context: persistedContextMetadata(input.metadata) },
		blocks: [],
		tool_calls: [],
	};
}

function contextHistoryItem(input: AppendContextItemInput): Readonly<Record<string, unknown>> {
	return {
		id: input.itemId,
		thread_id: null,
		turn_id: null,
		type: "skill_instructions",
		text: input.text,
		tool_name: null,
		call_id: null,
		metadata: persistedContextMetadata(input.metadata),
	};
}

function completedRollout(
	turn: RuntimeTurnRecord,
	input: CompleteStoredTurnInput,
	threadId: string,
): Readonly<Record<string, unknown>> {
	return {
		thread_id: threadId,
		turn_id: turn.turn_id,
		status: "completed",
		started_at: turn.started_at,
		completed_at: input.completedAt,
		stop_reason: "assistant_completed",
		events: [],
		continuation_state: {
			...(input.responseId ? { response_id: input.responseId } : {}),
			usage: input.usage,
			...(input.lastTokenUsage ? { last_token_usage: input.lastTokenUsage } : {}),
		},
	};
}

function failedRollout(
	turn: RuntimeTurnRecord,
	input: FailStoredTurnInput,
	status: "failed" | "interrupted",
	threadId: string,
): Readonly<Record<string, unknown>> {
	return {
		thread_id: threadId,
		turn_id: turn.turn_id,
		status,
		started_at: turn.started_at,
		completed_at: input.completedAt,
		stop_reason: stopReason(input.code),
		events: [],
		continuation_state: {},
	};
}

function recoveryRollout(
	turn: RuntimeTurnRecord,
	completedAt: string,
	threadId: string,
): Readonly<Record<string, unknown>> {
	return {
		thread_id: threadId,
		turn_id: turn.turn_id,
		status: "interrupted",
		started_at: turn.started_at,
		completed_at: completedAt,
		stop_reason: "interrupted",
		events: [],
		continuation_state: {},
	};
}

function stopReason(code: RuntimeErrorCode): string {
	switch (code) {
		case "auth_error":
			return "auth_failed";
		case "rate_limited":
			return "rate_limited";
		case "context_window_exceeded":
			return "context_window_exceeded";
		case "retry_exhausted":
			return "retry_exhausted";
		case "interrupted":
			return "interrupted";
		case "provider_error":
			return "model_error";
		default:
			return "runtime_error";
	}
}

const MAX_CONTEXT_ITEM_ID_CHARS = 512;
const MAX_CONTEXT_TEXT_CHARS = 131_072;
const MAX_CONTEXT_CONTENT_CHARS = 65_536;
const MAX_CONTEXT_SOURCE_ID_CHARS = 128;
const PROVIDER_IDS = new Set(["openai", "codex", "compatible", "qwen", "deepseek", "anthropic"]);

function validateContextItem(input: AppendContextItemInput): void {
	const { metadata } = input;
	const validSource = metadata.sourceId.length > 0
		&& metadata.sourceId.length <= MAX_CONTEXT_SOURCE_ID_CHARS
		&& !metadata.sourceId.includes("/")
		&& !metadata.sourceId.includes("\\")
		&& !metadata.sourceId.includes("\0");
	if (
		input.itemId.length === 0
		|| input.itemId.length > MAX_CONTEXT_ITEM_ID_CHARS
		|| input.itemId.includes("\0")
		|| input.text.length > MAX_CONTEXT_TEXT_CHARS
			|| (metadata.kind !== "skill_instructions" && metadata.kind !== "turn_aborted")
		|| metadata.cacheClass !== "dynamic"
		|| metadata.durability !== "persistent"
		|| metadata.scope !== "transcript"
		|| !validSource
		|| !/^[a-f0-9]{64}$/u.test(metadata.contentSha256)
		|| !Number.isSafeInteger(metadata.contentLength)
		|| metadata.contentLength < 0
		|| metadata.contentLength > MAX_CONTEXT_CONTENT_CHARS
	) {
		throw new StorageFailure("invalid canonical context item");
	}
}

function persistedContextMetadata(
	metadata: CanonicalContextMetadata,
): Readonly<Record<string, unknown>> {
	return {
		kind: metadata.kind,
		...(metadata.role ? { role: metadata.role } : {}),
		cache_class: metadata.cacheClass,
		durability: metadata.durability,
		scope: metadata.scope,
		source_id: metadata.sourceId,
		content_sha256: metadata.contentSha256,
		content_length: metadata.contentLength,
	};
}

function persistedProviderState(state: ProviderReplayState): Readonly<Record<string, unknown>> {
	if (!PROVIDER_IDS.has(state.provider)) {
		throw new StorageFailure("invalid provider replay state");
	}
	if (state.tokenEstimate !== undefined
		&& (!Number.isSafeInteger(state.tokenEstimate) || state.tokenEstimate < 0)) {
		throw new StorageFailure("invalid provider replay state");
	}
	let json: string;
	try {
		json = stableJson(state.value);
	} catch {
		throw new StorageFailure("invalid provider replay state");
	}
	if (!json || json.length > PROVIDER_REPLAY_STATE_MAX_JSON_CHARS) {
		throw new StorageFailure("invalid provider replay state");
	}
	const value = JSON.parse(json) as unknown;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new StorageFailure("invalid provider replay state");
	}
	return {
		provider: state.provider,
		value: value as Readonly<Record<string, unknown>>,
		...(state.tokenEstimate === undefined ? {} : { tokenEstimate: state.tokenEstimate }),
	};
}

function toolArguments(value: string): Readonly<Record<string, unknown>> {
	try {
		const parsed = JSON.parse(value) as unknown;
		return recordValue(parsed);
	} catch {
		return {};
	}
}

function agentForkMessage(item: CanonicalConversationItem): Readonly<Record<string, unknown>> {
	if (item.type === "user") {
		return {
			role: "user",
			content: item.text,
			tool_call_id: null,
			response_id: null,
			metadata: { source: "agent_fork" },
			blocks: imageBlocks(item.images ?? []),
			tool_calls: [],
		};
	}
	if (item.type === "assistant") {
		return {
			role: "assistant",
			content: item.text,
			tool_call_id: null,
			response_id: null,
			metadata: { source: "agent_fork" },
			blocks: [],
			tool_calls: [],
		};
	}
	if (item.type === "assistant_tool_calls") {
		const calls = item.calls.map((call) => ({
			name: call.name,
			arguments: toolArguments(call.argumentsJson),
			reason: "forked agent context",
			call_id: call.callId,
		}));
		return {
			role: "assistant",
			content: item.text,
			tool_call_id: null,
			response_id: null,
			metadata: { source: "agent_fork" },
			blocks: [],
			tool_calls: calls,
		};
	}
	if (item.type === "context") {
		return {
			role: "context",
			content: item.text,
			tool_call_id: null,
			response_id: null,
			metadata: { source: "agent_fork", context: item.metadata },
			blocks: [],
			tool_calls: [],
		};
	}
	return {
		role: "tool",
		content: item.output,
		tool_call_id: item.callId,
		response_id: null,
		metadata: {
			source: "agent_fork",
			tool_name: item.toolName,
			success: item.success,
		},
		blocks: [],
		tool_calls: [],
	};
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	return value as Readonly<Record<string, unknown>>;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
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

function parseObjectJson(value: unknown, source: string): Record<string, unknown> {
	if (typeof value !== "string") {
		throw new StorageFailure(`invalid JSON in ${source}`);
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("not an object");
		}
		return parsed as Record<string, unknown>;
	} catch {
		throw new StorageFailure(`invalid JSON in ${source}`);
	}
}

function requiredSessionId(value: string, label: string): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
		throw new StorageFailure(`${label} id is invalid`);
	}
	return value.trim();
}

function parsedRecord(value: unknown, source: string): Readonly<Record<string, unknown>> {
	return parseObjectJson(value, source);
}

interface ForkHistoryRefs {
	readonly userTurnIds: Set<string>;
	readonly assistantTurnIds: Set<string>;
	readonly toolCallIds: Set<string>;
	readonly toolResultIds: Set<string>;
}

function emptyForkHistoryRefs(): ForkHistoryRefs {
	return {
		userTurnIds: new Set(),
		assistantTurnIds: new Set(),
		toolCallIds: new Set(),
		toolResultIds: new Set(),
	};
}

function collectForkHistoryRefs(
	refs: ForkHistoryRefs,
	payload: Readonly<Record<string, unknown>>,
): void {
	const turnId = stringValue(payload.turn_id) ?? stringValue(recordValue(payload.metadata).turn_id);
	if (payload.role === "user" && turnId) {
		refs.userTurnIds.add(turnId);
		return;
	}
	if (payload.role === "assistant") {
		const calls = Array.isArray(payload.tool_calls) ? payload.tool_calls.map(recordValue) : [];
		if (calls.length > 0) {
			for (const call of calls) {
				const callId = stringValue(call.call_id);
				if (callId) refs.toolCallIds.add(callId);
			}
		} else if (turnId) {
			refs.assistantTurnIds.add(turnId);
		}
		return;
	}
	if (payload.role === "tool") {
		const callId = stringValue(payload.tool_call_id);
		if (callId) refs.toolResultIds.add(callId);
	}
}

function forkIncludesHistoryItem(
	refs: ForkHistoryRefs,
	payload: Readonly<Record<string, unknown>>,
): boolean {
	const turnId = stringValue(payload.turn_id);
	const callId = stringValue(payload.call_id);
	if (payload.type === "user_message") return Boolean(turnId && refs.userTurnIds.has(turnId));
	if (payload.type === "assistant_message") {
		return Boolean(turnId && refs.assistantTurnIds.has(turnId));
	}
	if (payload.type === "tool_call") return Boolean(callId && refs.toolCallIds.has(callId));
	if (payload.type === "tool_result") return Boolean(callId && refs.toolResultIds.has(callId));
	return false;
}

function boundedOperationLimit(value: number, maximum: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
		throw new RangeError(`${label} must be between 0 and ${maximum}`);
	}
	return value;
}

function compactLegacyRolloutSql(table: "turn_rollouts"): string {
	return `CASE WHEN json_valid(${table}.payload_json) THEN json_set(
			${table}.payload_json,
			'$.events',
			CASE WHEN EXISTS (
				SELECT 1 FROM json_each(${table}.payload_json, '$.events') AS rollout_event
				WHERE CASE WHEN rollout_event.type = 'object' THEN
					json_extract(rollout_event.value, '$.kind') = 'turn_item'
					AND json_extract(rollout_event.value, '$.payload.type') = 'approval_resolution'
				ELSE 0 END
			) THEN json('[{"kind":"turn_item","payload":{"type":"approval_resolution"}}]')
			ELSE json('[]') END
		)
		ELSE ${table}.payload_json END`;
}

function utcTimestamp(): string {
	return new Date().toISOString().replace("Z", "+00:00");
}

function ownedByLiveProcess(
	row: RuntimeTurnRow,
	isProcessAlive: (processId: number) => boolean,
): boolean {
	return typeof row.owner_id === "string"
		&& row.owner_id.length > 0
		&& typeof row.owner_pid === "number"
		&& Number.isSafeInteger(row.owner_pid)
		&& row.owner_pid > 0
		&& isProcessAlive(row.owner_pid);
}

function processIsAlive(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		return error instanceof Error
			&& "code" in error
			&& error.code === "EPERM";
	}
}

function storageError(error: unknown): Error {
	if (
		error instanceof StorageFailure
		|| error instanceof MessageIdConflictError
		|| error instanceof SessionStateError
		|| error instanceof QueueConflictError
		|| error instanceof ApprovalConflictError
	) {
		return error;
	}
	const code = sqliteCode(error);
	if (code?.startsWith("SQLITE_BUSY") || code?.startsWith("SQLITE_LOCKED")) {
		return new StorageFailure("database is busy", { sqlite_code: code });
	}
	return new StorageFailure("storage operation failed", {
		...(code ? { sqlite_code: code } : {}),
	});
}

function sqliteCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return undefined;
	}
	return typeof error.code === "string" ? error.code.slice(0, 64) : undefined;
}
