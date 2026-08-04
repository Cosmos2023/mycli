import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseRuntimeTurnRecord } from "@mycli/contracts";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import {
	ApprovalConflictError,
	QueueConflictError,
} from "@mycli/core";
import type {
	CanonicalConversationItem,
	CanonicalMessage,
	CanonicalToolCall,
	QueueSnapshot,
	RuntimeErrorCode,
} from "@mycli/core";
import Database from "better-sqlite3";
import {
	BACKFILL_SEARCH_SQL,
	SCHEMA_V2_SQL,
	SCHEMA_VERSION,
} from "./schema.ts";
import {
	MessageIdConflictError,
	projectMutationMetadata,
	SessionStateError,
	StorageFailure,
} from "./session-store.ts";
import type {
	AppendSessionSummaryInput,
	AppendAssistantToolCallsInput,
	AppendToolResultInput,
	ApprovalCheckpoint,
	ApprovalTransitionInput,
	CommitCompactionInput,
	CommitQueuedInputsInput,
	CompleteStoredTurnInput,
	FailStoredTurnInput,
	ImportLegacyConversationInput,
	ReserveTurnInput,
	RuntimeStateKey,
	SaveQueueSnapshotInput,
	SaveStateInput,
	SessionLineageNode,
	SessionListQuery,
	SessionOverview,
	SessionStore,
	TurnReservation,
} from "./session-store.ts";
import { SQLiteSessionStateRepository } from "./sqlite-session-state.ts";
import { stableJson } from "./stable-json.ts";

export interface SQLiteSessionStoreOptions {
	readonly dbPath: string;
	readonly clock?: () => string;
	readonly busyTimeoutMs?: number;
	readonly ownerId?: string;
	readonly processId?: number;
	readonly isProcessAlive?: (processId: number) => boolean;
	readonly stateFailpoint?: (name: string) => void;
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
	readonly #database: Database.Database;
	readonly #clock: () => string;
	readonly #ownerId: string;
	readonly #processId: number;
	readonly #isProcessAlive: (processId: number) => boolean;
	readonly #stateRepository: SQLiteSessionStateRepository;
	#closed = false;

	constructor(options: SQLiteSessionStoreOptions) {
		mkdirSync(dirname(options.dbPath), { recursive: true });
		this.#clock = options.clock ?? utcTimestamp;
		this.#ownerId = options.ownerId ?? randomUUID();
		this.#processId = options.processId ?? process.pid;
		this.#isProcessAlive = options.isProcessAlive ?? processIsAlive;
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
			this.recoverInterruptedTurns();
		} catch (error) {
			throw storageError(error);
		}
	}

	reserveTurn(input: ReserveTurnInput): TurnReservation {
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
		return this.#write(() => {
			const existing = this.#loadTurn(input.sessionId, input.clientTurnId);
			if (existing) {
				if (existing.request_fingerprint !== input.requestFingerprint) {
					throw new MessageIdConflictError();
				}
				return { kind: "existing", turn: existing };
			}
			this.#touchSession(input);
			this.#insertRuntimeTurn(initial);
			this.#appendConversationMessage(input.sessionId, userMessage(input));
			this.#appendHistoryItem(input.sessionId, userHistoryItem(input));
			return { kind: "reserved", turn: initial };
		});
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
			const rows = this.#database.prepare(`
				SELECT payload_json
				FROM conversation_messages
				WHERE session_id = ?
				ORDER BY message_index
			`).all(sessionId) as readonly { payload_json: unknown }[];
			if (rows.length > 0) {
				return rows.map((row) => canonicalConversationItem(
					row.payload_json,
					"conversation_messages",
				));
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
			return historyRows.map((row) => canonicalHistoryItem(row.payload_json));
		} catch (error) {
			throw storageError(error);
		}
	}

	appendAssistantToolCalls(input: AppendAssistantToolCallsInput): void {
		this.#write(() => {
			const running = this.#requireRunningTurn(input.sessionId, input.clientTurnId);
			if (input.calls.length === 0) {
				throw new StorageFailure("assistant tool call batch is empty");
			}
			if (this.#pendingToolCalls(input.sessionId).length > 0) {
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
			for (const parsed of parsedCalls) {
				this.#appendHistoryItem(
					input.sessionId,
					toolCallHistoryItem(running, input, parsed, threadId),
				);
			}
			this.#touchExistingSession(input.sessionId, this.#clock());
		});
	}

	appendToolResult(input: AppendToolResultInput): void {
		this.#write(() => {
			const running = this.#requireRunningTurn(input.sessionId, input.clientTurnId);
			if (input.result.output.length > 8_000) {
				throw new StorageFailure("tool result exceeds output limit");
			}
			const pending = this.#pendingToolCalls(input.sessionId);
			const expected = pending[0];
			if (!expected || expected.callId !== input.result.callId) {
				throw new StorageFailure("tool results must preserve call order");
			}
			if (expected.name !== input.result.toolName) {
				throw new StorageFailure("tool result name does not match call");
			}
			this.#appendToolResultRecords(running, input);
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
				stableJson({ message: input.message }),
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
			const orphaned = running.filter((row) => !ownedByLiveProcess(row, this.#isProcessAlive));
			for (const row of orphaned) {
				const turn = runtimeTurnFromRow(row);
				const completedAt = this.#clock();
				let pendingCalls: readonly CanonicalToolCall[] = [];
				try {
					pendingCalls = this.#pendingToolCalls(turn.session_id);
				} catch (error) {
					if (!(error instanceof StorageFailure)) {
						throw error;
					}
				}
				for (const call of pendingCalls) {
					this.#appendToolResultRecords(turn, {
						sessionId: turn.session_id,
						clientTurnId: turn.client_turn_id,
						result: {
							callId: call.callId,
							toolName: call.name,
							output: "Tool call interrupted before it completed.",
							success: false,
						},
						summary: `${call.name} interrupted`,
						errorKind: "tool_interrupted",
					});
				}
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
					stableJson({ message: "turn interrupted during process restart" }),
					completedAt,
					turn.session_id,
					turn.client_turn_id,
				);
				this.#touchExistingSession(turn.session_id, completedAt);
			}
			return orphaned.length;
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

	loadHistoryItems(sessionId: string): readonly Readonly<Record<string, unknown>>[] {
		return this.#stateRepository.loadHistoryItems(sessionId);
	}

	loadTurnRollouts(sessionId: string): readonly Readonly<Record<string, unknown>>[] {
		return this.#stateRepository.loadTurnRollouts(sessionId);
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

	commitCompaction(input: CommitCompactionInput): void {
		this.#stateRepository.commitCompaction(input);
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
		this.#write(() => {
			const versionTable = this.#database.prepare(`
				SELECT 1 AS present
				FROM sqlite_master
				WHERE type = 'table' AND name = 'schema_version'
			`).get() as { present: number } | undefined;
			if (versionTable) {
				const version = this.#database.prepare(
					"SELECT version FROM schema_version LIMIT 1",
				).get() as { version: unknown } | undefined;
				if (version && version.version !== SCHEMA_VERSION) {
					throw new StorageFailure("unsupported session schema version", {
						expected_version: SCHEMA_VERSION,
						actual_version: typeof version.version === "number" ? version.version : null,
					});
				}
			}
			this.#database.exec(SCHEMA_V2_SQL);
			this.#ensureRuntimeTurnOwnershipColumns();
			this.#database.exec(BACKFILL_SEARCH_SQL);
			this.#database.prepare("DELETE FROM schema_version").run();
			this.#database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
		});
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

	#pendingToolCalls(sessionId: string): CanonicalToolCall[] {
		const pending: CanonicalToolCall[] = [];
		for (const item of this.#conversationItems(sessionId)) {
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

	#conversationItems(sessionId: string): readonly CanonicalConversationItem[] {
		const rows = this.#database.prepare(`
			SELECT payload_json
			FROM conversation_messages
			WHERE session_id = ?
			ORDER BY message_index
		`).all(sessionId) as readonly { payload_json: unknown }[];
		return rows.map((row) => canonicalConversationItem(
			row.payload_json,
			"conversation_messages",
		));
	}

	#appendToolResultRecords(
		turn: RuntimeTurnRecord,
		input: AppendToolResultInput,
	): void {
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

function userMessage(input: ReserveTurnInput): Readonly<Record<string, unknown>> {
	return {
		role: "user",
		content: input.userText,
		tool_call_id: null,
		response_id: null,
		metadata: {
			turn_id: input.turnId,
			client_turn_id: input.clientTurnId,
			source: "node_runtime",
		},
		blocks: [],
		tool_calls: [],
	};
}

function userHistoryItem(input: ReserveTurnInput): Readonly<Record<string, unknown>> {
	return {
		id: `${input.turnId}:user:${input.clientTurnId}`,
		thread_id: input.threadId,
		turn_id: input.turnId,
		type: "user_message",
		text: input.userText,
		tool_name: null,
		call_id: null,
		metadata: {
			client_turn_id: input.clientTurnId,
			source: "node_runtime",
			image_paths: [],
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
		metadata: { turn_id: turn.turn_id, source: "node_runtime" },
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
		metadata: { turn_id: turn.turn_id, source: "node_runtime" },
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
		text: input.assistantText,
		tool_name: parsed.call.name,
		call_id: parsed.call.callId,
		metadata: {
			arguments: parsed.argumentsValue,
			source: "node_runtime",
			...(input.responseId ? { response_id: input.responseId } : {}),
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
		...(input.errorKind === "tool_interrupted"
			? { synthetic: true, append_only: true }
			: {}),
		...(mutationMetadata.file_changes
			? { file_changes: mutationMetadata.file_changes }
			: {}),
	};
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
		},
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

function canonicalConversationItem(
	payloadJson: unknown,
	source: string,
): CanonicalConversationItem {
	const payload = parseObjectJson(payloadJson, source);
	if (payload.role === "user" && typeof payload.content === "string") {
		return { type: "user", text: payload.content };
	}
	if (payload.role === "assistant" && typeof payload.content === "string") {
		const calls = canonicalToolCalls(payload.tool_calls, source);
		if (calls.length > 0) {
			return {
				type: "assistant_tool_calls",
				text: payload.content,
				calls,
				...(typeof payload.response_id === "string"
					? { responseId: payload.response_id }
					: {}),
			};
		}
		return { type: "assistant", text: payload.content };
	}
	if (payload.role === "tool" && typeof payload.content === "string"
		&& typeof payload.tool_call_id === "string" && payload.tool_call_id) {
		const metadata = recordValue(payload.metadata);
		const block = firstBlock(payload.blocks, "tool_result");
		const blockMetadata = recordValue(block?.metadata);
		const toolName = stringValue(metadata.tool_name)
			?? stringValue(block?.tool_name)
			?? "Tool";
		const success = booleanValue(metadata.success)
			?? booleanValue(blockMetadata.success)
			?? true;
		return {
			type: "tool_result",
			callId: payload.tool_call_id,
			toolName,
			output: payload.content,
			success,
		};
	}
	throw new StorageFailure(`invalid canonical message in ${source}`);
}

function canonicalToolCalls(value: unknown, source: string): readonly CanonicalToolCall[] {
	if (value === undefined || value === null) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new StorageFailure(`invalid canonical message in ${source}`);
	}
	return value.map((raw) => {
		const call = recordValue(raw);
		const name = stringValue(call.name);
		const callId = stringValue(call.call_id);
		if (!name || !callId) {
			throw new StorageFailure(`invalid canonical message in ${source}`);
		}
		return {
			callId,
			name,
			argumentsJson: stableJson(recordValue(call.arguments)),
		};
	});
}

function canonicalHistoryItem(payloadJson: unknown): CanonicalConversationItem {
	const payload = parseObjectJson(payloadJson, "history_items");
	if (payload.type === "user_message" && typeof payload.text === "string") {
		return { type: "user", text: payload.text };
	}
	if (payload.type === "assistant_message" && typeof payload.text === "string") {
		return { type: "assistant", text: payload.text };
	}
	const metadata = recordValue(payload.metadata);
	if (payload.type === "tool_call") {
		const name = stringValue(payload.tool_name);
		const callId = stringValue(payload.call_id);
		if (!name || !callId) {
			throw new StorageFailure("invalid canonical message in history_items");
		}
		return {
			type: "assistant_tool_calls",
			text: stringValue(payload.text) ?? "",
			calls: [{
				callId,
				name,
				argumentsJson: stableJson(recordValue(metadata.arguments)),
			}],
			...(stringValue(metadata.response_id)
				? { responseId: stringValue(metadata.response_id) }
				: {}),
		};
	}
	if (payload.type === "tool_result") {
		const name = stringValue(payload.tool_name);
		const callId = stringValue(payload.call_id);
		const output = stringValue(metadata.transcript_content) ?? stringValue(payload.text);
		if (!name || !callId || output === undefined) {
			throw new StorageFailure("invalid canonical message in history_items");
		}
		return {
			type: "tool_result",
			callId,
			toolName: name,
			output,
			success: booleanValue(metadata.success) ?? true,
		};
	}
	throw new StorageFailure("invalid canonical message in history_items");
}

function toolArguments(value: string): Readonly<Record<string, unknown>> {
	try {
		const parsed = JSON.parse(value) as unknown;
		return recordValue(parsed);
	} catch {
		return {};
	}
}

function firstBlock(value: unknown, type: string): Readonly<Record<string, unknown>> | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.map(recordValue).find((block) => block.type === type);
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

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
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
