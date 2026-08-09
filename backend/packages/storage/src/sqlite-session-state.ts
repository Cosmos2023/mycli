import { ContractValidationError, parseRuntimeState } from "@mycli/contracts";
import {
	ApprovalConflictError,
	QueueConflictError,
	transitionApproval,
} from "@mycli/core";
import type {
	ApprovalResolution,
	CanonicalImage,
	QueueSnapshot,
	QueuedInput,
} from "@mycli/core";
import type Database from "better-sqlite3";
import {
	SessionStateError,
	StorageFailure,
} from "./session-store.ts";
import type {
	AppendSessionSummaryInput,
	ApprovalCheckpoint,
	ApprovalTransitionInput,
	CommitApprovalResultInput,
	CommitClarificationResponseInput,
	CommitCompactionInput,
	CommitQueuedInputsInput,
	FinalizeApprovalContinuationInput,
	ImportLegacyConversationInput,
	InterruptAmbiguousApprovalInput,
	RuntimeStateKey,
	SaveQueueSnapshotInput,
	SaveApprovalSuspensionInput,
	SaveClarificationSuspensionInput,
	SaveStateInput,
	SessionLineageNode,
	SessionListQuery,
	SessionOverview,
	SessionStateStore,
} from "./session-store.ts";
import { stableJson } from "./stable-json.ts";
import {
	assertImagePathCount,
	canonicalImages,
	imageBlocks,
} from "./canonical-images.ts";

export interface SQLiteSessionStateRepositoryOptions {
	readonly database: Database.Database;
	readonly clock: () => string;
	readonly write: <Result>(operation: () => Result) => Result;
	readonly failpoint?: (name: string) => void;
}

interface SessionOverviewRow {
	readonly session_id: unknown;
	readonly workspace_root: unknown;
	readonly thread_id: unknown;
	readonly created_at: unknown;
	readonly updated_at: unknown;
	readonly last_active_at: unknown;
	readonly status: unknown;
	readonly message_count: unknown;
	readonly summary_count: unknown;
	readonly parent_id: unknown;
	readonly fork_point: unknown;
}

const VALIDATED_STATE_KINDS: Partial<Record<RuntimeStateKey,
	| "input_queue"
	| "pending_decision"
	| "suspended_turn"
	| "compact_checkpoint"
	| "responses_continuation"
	| "effect_checkpoint">> = {
	input_queue: "input_queue",
	pending_decision: "pending_decision",
	suspended_turn: "suspended_turn",
	compact_checkpoint: "compact_checkpoint",
	responses_continuation_state: "responses_continuation",
	node_effect_checkpoint: "effect_checkpoint",
};

const CONTINUATION_INVALIDATED = Object.freeze({
	response_id: null,
	request_signature: "",
	request_input: Object.freeze([]),
	response_output: Object.freeze([]),
	eligible: false,
	failure_reason: "compacted_history",
});

export class SQLiteSessionStateRepository implements SessionStateStore {
	readonly #database: Database.Database;
	readonly #clock: () => string;
	readonly #writeTransaction: <Result>(operation: () => Result) => Result;
	readonly #failpoint: (name: string) => void;

	constructor(options: SQLiteSessionStateRepositoryOptions) {
		this.#database = options.database;
		this.#clock = options.clock;
		this.#writeTransaction = options.write;
		this.#failpoint = options.failpoint ?? (() => undefined);
	}

	listSessions(query: SessionListQuery = {}): readonly SessionOverview[] {
		return this.#read(() => {
			const { limit, offset } = page(query);
			const workspaceRoot = query.workspaceRoot?.trim();
			const where = workspaceRoot ? "WHERE sessions.workspace_root = ?" : "";
			const parameters = workspaceRoot
				? [workspaceRoot, limit, offset]
				: [limit, offset];
			const rows = this.#database.prepare(`
				${sessionOverviewSelect()}
				${where}
				ORDER BY sessions.last_active_at DESC, sessions.session_id DESC
				LIMIT ? OFFSET ?
			`).all(...parameters) as readonly SessionOverviewRow[];
			return Object.freeze(rows.map(sessionOverviewFromRow));
		});
	}

	loadSession(sessionId: string): SessionOverview | undefined {
		return this.#read(() => {
			const row = this.#database.prepare(`
				${sessionOverviewSelect()}
				WHERE sessions.session_id = ?
			`).get(nonEmpty(sessionId, "sessionId")) as SessionOverviewRow | undefined;
			return row ? sessionOverviewFromRow(row) : undefined;
		});
	}

	loadSessionLineage(sessionId: string): readonly SessionLineageNode[] {
		return this.#read(() => {
			let current = nonEmpty(sessionId, "sessionId");
			if (!this.#sessionExists(current)) {
				return Object.freeze([]);
			}
			const lineage: SessionLineageNode[] = [];
			const seen = new Set<string>();
			for (let depth = 0; depth < 100; depth += 1) {
				if (seen.has(current)) {
					throw new SessionStateError("session_state_invalid", "session_lineage");
				}
				seen.add(current);
				const row = this.#database.prepare(`
					SELECT session_id, parent_id, fork_point
					FROM conversation_trees
					WHERE session_id = ?
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
				lineage.push(Object.freeze({
					sessionId: current,
					...(parentId ? { parentId } : {}),
					...(forkPoint === undefined ? {} : { forkPoint }),
				}));
				if (!parentId) {
					return Object.freeze(lineage.reverse());
				}
				if (!this.#sessionExists(parentId)) {
					throw new SessionStateError("session_state_invalid", "session_lineage");
				}
				current = parentId;
			}
			throw new SessionStateError("session_state_invalid", "session_lineage");
		});
	}

	loadState(sessionId: string, key: RuntimeStateKey): unknown | undefined {
		return this.#read(() => {
			const row = this.#database.prepare(`
				SELECT payload_json
				FROM session_state
				WHERE session_id = ? AND state_key = ?
			`).get(nonEmpty(sessionId, "sessionId"), key) as {
				readonly payload_json: unknown;
			} | undefined;
			if (!row) return undefined;
			return freezeJson(parseStateJson(row.payload_json, key));
		});
	}

	saveState(input: SaveStateInput): void {
		const payload = validateStatePayload(input.key, input.payload);
		this.#writeTransaction(() => {
			this.#touchSession(input.sessionId, input.workspaceRoot, input.threadId);
			this.#upsertState(input.sessionId, input.key, payload);
		});
	}

	saveQueueSnapshot(input: SaveQueueSnapshotInput): QueueSnapshot {
		const sessionId = nonEmpty(input.sessionId, "sessionId");
		if (input.snapshot.sessionId !== sessionId) {
			throw new QueueConflictError("queue snapshot session does not match save session");
		}
		return this.#writeTransaction(() => {
			const row = this.#database.prepare(`
				SELECT payload_json FROM session_state
				WHERE session_id = ? AND state_key = 'input_queue'
			`).get(sessionId) as { readonly payload_json: unknown } | undefined;
			const previous = row
				? parseStateJson(row.payload_json, "input_queue")
				: {};
			if (!isRecord(previous)) {
				throw new SessionStateError("session_state_invalid", "input_queue");
			}
			const current = row ? queueSnapshotFromPayload(previous) : undefined;
			const payload = queuePayload(input.snapshot, previous);
			const candidate = queueSnapshotFromPayload(payload);
			if (!current && candidate.revision !== 1) {
				throw new QueueConflictError("initial queue snapshot revision must be one");
			}
			if (current) {
				if (stableJson(payload) === stableJson(previous)) return current;
				if (candidate.revision !== increment(current.revision, "queue revision")) {
					throw new QueueConflictError("queue snapshot revision is stale");
				}
			}
			this.#touchSession(sessionId, input.workspaceRoot, input.threadId);
			this.#upsertState(sessionId, "input_queue", payload);
			return candidate;
		});
	}

	deleteState(sessionId: string, key: RuntimeStateKey): void {
		this.#writeTransaction(() => {
			this.#database.prepare(
				"DELETE FROM session_state WHERE session_id = ? AND state_key = ?",
			).run(nonEmpty(sessionId, "sessionId"), key);
		});
	}

	appendSessionSummary(input: AppendSessionSummaryInput): void {
		const summary = boundedSummary(input.summary);
		this.#writeTransaction(() => {
			this.#touchSession(input.sessionId, input.workspaceRoot, input.threadId);
			this.#insertSummary(input.sessionId, summary);
		});
	}

	loadSessionSummaries(sessionId: string): readonly string[] {
		return this.#read(() => Object.freeze(
			(this.#database.prepare(`
				SELECT summary_text
				FROM session_summaries
				WHERE session_id = ?
				ORDER BY summary_index
			`).all(nonEmpty(sessionId, "sessionId")) as readonly { summary_text: unknown }[])
				.map((row) => String(row.summary_text)),
		));
	}

	loadHistoryItems(sessionId: string): readonly Readonly<Record<string, unknown>>[] {
		return this.#loadObjectRows("history_items", "sequence_no", sessionId);
	}

	loadTurnRollouts(sessionId: string): readonly Readonly<Record<string, unknown>>[] {
		return this.#loadObjectRows("turn_rollouts", "sequence_no", sessionId);
	}

	importLegacyConversation(input: ImportLegacyConversationInput): boolean {
		const sessionId = nonEmpty(input.sessionId, "sessionId");
		const messages = input.messages.map(validateLegacyConversationMessage);
		if (messages.length === 0) {
			throw new StorageFailure("invalid legacy conversation message");
		}
		return this.#writeTransaction(() => {
			const existing = this.#database.prepare(`
				SELECT 1 FROM conversation_messages
				WHERE session_id = ? LIMIT 1
			`).get(sessionId);
			if (existing) return false;
			this.#touchSession(sessionId, input.workspaceRoot, input.threadId);
			const insert = this.#database.prepare(`
				INSERT INTO conversation_messages (session_id, message_index, payload_json)
				VALUES (?, ?, ?)
			`);
			for (const [index, message] of messages.entries()) {
				insert.run(sessionId, index, stableJson(message));
			}
			return true;
		});
	}

	loadCommittedQueueIds(sessionId: string): ReadonlySet<string> {
		const ids = new Set<string>();
		for (const item of this.loadHistoryItems(sessionId)) {
			const metadata = recordValue(item.metadata);
			if (typeof metadata.queue_id === "string" && metadata.queue_id) {
				ids.add(metadata.queue_id);
			}
		}
		return ids;
	}

	commitQueuedInputs(input: CommitQueuedInputsInput): QueueSnapshot {
		return this.#writeTransaction(() => {
			const sessionId = nonEmpty(input.sessionId, "sessionId");
			const turnId = nonEmpty(input.turnId, "turnId");
			const raw = this.#requiredStateObject(sessionId, "input_queue");
			const current = queueSnapshotFromPayload(raw);
			const committedIds = new Set(this.#committedQueueIdsInTransaction(sessionId));
			const removeIds = new Set<string>();
			let appended = false;
			for (const record of input.records) {
				if (record.sessionId !== sessionId) {
					throw new QueueConflictError("queued input session does not match commit session");
				}
				const existing = activeQueueRecords(current).find(
					(item) => item.queueId === record.queueId,
				);
				if (committedIds.has(record.queueId)) {
					if (existing) removeIds.add(record.queueId);
					continue;
				}
				if (!existing || !queueRecordsEqual(existing, record)) {
					throw new QueueConflictError("queued input is not pending with the expected payload");
				}
				if (record.kind === "pending_steer"
					&& record.targetTurnId !== turnId
					&& record.targetTurnId !== "turn_pending") {
					throw new QueueConflictError("pending steer targets a different turn");
				}
				const images = canonicalImages(
					input.imagesByQueueId?.get(record.queueId) ?? [],
					"queued user message",
				);
				assertImagePathCount(record.imagePaths, images);
				this.#appendConversationMessage(
					sessionId,
					queuedUserMessage(record, turnId, images),
				);
				this.#appendHistoryItem(
					sessionId,
					queuedHistoryItem(record, turnId, this.#threadId(sessionId)),
				);
				committedIds.add(record.queueId);
				removeIds.add(record.queueId);
				appended = true;
			}
			if (appended) this.#failpoint("queue_commit_after_history");
			if (removeIds.size === 0) return current;
			const next = freezeQueueSnapshot({
				...current,
				revision: increment(current.revision, "queue revision"),
				pendingSteers: current.pendingSteers.filter(
					(record) => !removeIds.has(record.queueId),
				),
				rejectedSteers: current.rejectedSteers.filter(
					(record) => !removeIds.has(record.queueId),
				),
				followUps: current.followUps.filter(
					(record) => !removeIds.has(record.queueId),
				),
			});
			this.#upsertState(sessionId, "input_queue", queuePayload(next, raw));
			this.#touchExistingSession(sessionId);
			return next;
		});
	}

	compareAndSetApproval(input: ApprovalTransitionInput): ApprovalCheckpoint {
		return this.#writeTransaction(() => this.#transitionApproval(input));
	}

	saveApprovalSuspension(input: SaveApprovalSuspensionInput): ApprovalCheckpoint {
		const sessionId = nonEmpty(input.sessionId, "sessionId");
		const pending = validateStatePayload("pending_decision", input.pendingDecision.payload);
		const suspended = validateStatePayload("suspended_turn", input.suspendedTurn.payload);
		const turnRecord = validateStatePayload("turn_record", input.turnRecord);
		const effect = validateStatePayload(
			"node_effect_checkpoint",
			approvalCheckpointPayload(input.checkpoint),
		);
		if (input.checkpoint.status !== "waiting"
			|| input.checkpoint.sessionId !== sessionId
			|| input.checkpoint.callId !== input.checkpoint.decisionId
			|| recordValue(pending).tool_call === undefined
			|| requiredString(recordValue(recordValue(pending).tool_call).call_id, "call_id")
				!== input.checkpoint.callId
			|| requiredString(recordValue(suspended).session_id, "session_id") !== sessionId
			|| requiredString(recordValue(suspended).client_turn_id, "client_turn_id")
				!== input.checkpoint.clientTurnId
			|| requiredString(recordValue(suspended).turn_id, "turn_id") !== input.checkpoint.turnId) {
			throw new SessionStateError("session_state_invalid", "node_effect_checkpoint");
		}
		return this.#writeTransaction(() => {
			this.#touchSession(sessionId, input.workspaceRoot, input.threadId);
			this.#upsertState(sessionId, "pending_decision", pending);
			this.#upsertState(sessionId, "suspended_turn", suspended);
			this.#upsertState(sessionId, "turn_record", turnRecord);
			this.#upsertState(sessionId, "node_effect_checkpoint", effect);
			this.#failpoint("approval_suspend_after_states");
			return approvalCheckpointFromPayload(recordValue(effect));
		});
	}

	saveClarificationSuspension(input: SaveClarificationSuspensionInput): void {
		const sessionId = nonEmpty(input.sessionId, "sessionId");
		const suspended = validateStatePayload("suspended_turn", input.suspendedTurn.payload);
		const turnRecord = validateStatePayload("turn_record", input.turnRecord);
		const payload = recordValue(suspended);
		const clarification = recordValue(payload.pending_clarification);
		const call = recordValue(clarification.tool_call);
		if (requiredString(payload.session_id, "session_id") !== sessionId
			|| requiredString(payload.client_turn_id, "client_turn_id")
				!== requiredString(recordValue(turnRecord).client_turn_id, "client_turn_id")
			|| requiredString(payload.turn_id, "turn_id")
				!== requiredString(recordValue(turnRecord).turn_id, "turn_id")
			|| requiredString(clarification.request_id, "request_id")
				!== requiredString(call.call_id, "call_id")) {
			throw new SessionStateError("session_state_invalid", "suspended_turn");
		}
		this.#writeTransaction(() => {
			this.#touchSession(sessionId, input.workspaceRoot, input.threadId);
			this.#upsertState(sessionId, "suspended_turn", suspended);
			this.#upsertState(sessionId, "turn_record", turnRecord);
			this.#failpoint("clarification_suspend_after_states");
		});
	}

	commitClarificationResponse(
		input: CommitClarificationResponseInput,
		commitToolResult: () => void,
	): void {
		this.#writeTransaction(() => {
			const suspended = this.#requiredStateObject(input.sessionId, "suspended_turn");
			const clarification = recordValue(suspended.pending_clarification);
			if (requiredString(clarification.request_id, "request_id")
				!== nonEmpty(input.requestId, "requestId")) {
				throw new SessionStateError("session_state_invalid", "suspended_turn");
			}
			commitToolResult();
			this.#failpoint("clarification_response_after_tool");
			this.#deleteClarificationContinuation(input.sessionId);
			this.#touchExistingSession(input.sessionId);
		});
	}

	commitApprovalResult(
		input: CommitApprovalResultInput,
		commitToolResult: () => void,
	): ApprovalCheckpoint {
		return this.#writeTransaction(() => {
			const current = approvalCheckpointFromPayload(
				this.#requiredStateObject(input.sessionId, "node_effect_checkpoint"),
			);
			const currentResolution = approvalResolution(current);
			const nextResolution = transitionApproval(currentResolution, input.transition);
			if (nextResolution === currentResolution) return current;
			if (current.status !== input.expectedStatus) {
				throw new ApprovalConflictError(current.status, input.transition.type);
			}
			commitToolResult();
			this.#failpoint("approval_result_after_tool");
			const payload = effectPayload(
				approvalCheckpointPayload(current),
				nextResolution,
				this.#clock(),
			);
			this.#upsertState(input.sessionId, "node_effect_checkpoint", payload);
			this.#touchExistingSession(input.sessionId);
			return approvalCheckpointFromPayload(payload);
		});
	}

	finalizeApprovalContinuation(input: FinalizeApprovalContinuationInput): void {
		this.#writeTransaction(() => {
			const checkpoint = approvalCheckpointFromPayload(
				this.#requiredStateObject(input.sessionId, "node_effect_checkpoint"),
			);
			if (checkpoint.decisionId !== nonEmpty(input.decisionId, "decisionId")
				|| checkpoint.status !== "completed" && checkpoint.status !== "rejected") {
				throw new ApprovalConflictError(checkpoint.status, "complete_effect");
			}
			this.#deleteApprovalContinuation(input.sessionId, true);
			this.#touchExistingSession(input.sessionId);
		});
	}

	interruptAmbiguousApproval(
		input: InterruptAmbiguousApprovalInput,
		commitInterruption: () => void,
	): void {
		this.#writeTransaction(() => {
			const checkpoint = approvalCheckpointFromPayload(
				this.#requiredStateObject(input.sessionId, "node_effect_checkpoint"),
			);
			if (checkpoint.status !== "executing"
				|| checkpoint.clientTurnId !== input.clientTurnId
				|| checkpoint.callId !== input.callId
				|| checkpoint.toolName !== input.toolName) {
				throw new ApprovalConflictError(checkpoint.status, "complete_effect");
			}
			commitInterruption();
			this.#failpoint("approval_interrupt_after_result");
			this.#deleteApprovalContinuation(input.sessionId, true);
			this.#touchExistingSession(input.sessionId);
		});
	}

	isContinuationTurn(
		sessionId: string,
		clientTurnId: string,
		turnId: string,
	): boolean {
		const rows = this.#database.prepare(`
			SELECT state_key, payload_json FROM session_state
			WHERE session_id = ? AND state_key IN (
				'pending_decision', 'suspended_turn', 'node_effect_checkpoint'
			)
		`).all(sessionId) as readonly { state_key: RuntimeStateKey; payload_json: unknown }[];
		if (rows.length === 0) return false;
		const states = new Map(rows.map((row) => [
			row.state_key,
			parseStateJson(row.payload_json, row.state_key),
		]));
		const pending = recordValue(states.get("pending_decision"));
		const suspended = recordValue(states.get("suspended_turn"));
		const effect = states.get("node_effect_checkpoint");
		const clarification = recordValue(suspended.pending_clarification);
		if (Object.keys(clarification).length > 0) {
			const call = recordValue(clarification.tool_call);
			return states.size === 1
				&& requiredString(suspended.session_id, "session_id") === sessionId
				&& requiredString(suspended.client_turn_id, "client_turn_id") === clientTurnId
				&& requiredString(suspended.turn_id, "turn_id") === turnId
				&& requiredString(clarification.request_id, "request_id")
					=== requiredString(call.call_id, "call_id");
		}
		if (states.size !== 3 || !isRecord(effect)) {
			throw new SessionStateError("session_state_invalid", "suspended_turn");
		}
		const checkpoint = approvalCheckpointFromPayload(effect);
		const pendingCallId = requiredString(
			recordValue(recordValue(pending).tool_call).call_id,
			"call_id",
		);
		return requiredString(suspended.session_id, "session_id") === sessionId
			&& requiredString(suspended.client_turn_id, "client_turn_id") === clientTurnId
			&& requiredString(suspended.turn_id, "turn_id") === turnId
			&& checkpoint.sessionId === sessionId
			&& checkpoint.clientTurnId === clientTurnId
			&& checkpoint.turnId === turnId
			&& checkpoint.callId === pendingCallId
			&& new Set<ApprovalResolution["status"]>([
				"waiting",
				"approved",
				"executing",
				"completed",
				"rejected",
			])
				.has(checkpoint.status);
	}

	commitCompaction(input: CommitCompactionInput): void {
		const sessionId = nonEmpty(input.sessionId, "sessionId");
		const summary = boundedSummary(input.summary);
		const messages = input.replacementMessages.map(validateMessage);
		const checkpoint = validateStatePayload("compact_checkpoint", {
			...input.checkpoint,
			replacement_messages: messages,
		});
		const continuation = validateStatePayload(
			"responses_continuation_state",
			CONTINUATION_INVALIDATED,
		);
		this.#writeTransaction(() => {
			if (!this.#sessionExists(sessionId)) {
				throw new StorageFailure("session does not exist");
			}
			const row = this.#database.prepare(`
				SELECT COUNT(*) AS count
				FROM conversation_messages
				WHERE session_id = ?
			`).get(sessionId) as { readonly count: unknown };
			const boundaryId = requiredString(recordValue(checkpoint).window_id, "window_id");
			this.#appendHistoryItem(sessionId, {
				id: `compaction:${boundaryId}`,
				type: "compaction_boundary",
				schema_version: 1,
				boundary_id: boundaryId,
				turn_id: requiredString(recordValue(checkpoint).turn_id, "turn_id"),
				source_message_count: Number(row.count),
				summary,
				replacement_messages: messages,
				checkpoint,
				created_at: this.#clock(),
			});
			this.#failpoint("compact_after_replacement");
			this.#insertSummary(sessionId, summary);
			this.#upsertState(sessionId, "compact_checkpoint", checkpoint);
			this.#upsertState(sessionId, "responses_continuation_state", continuation);
			this.#touchExistingSession(sessionId);
		});
	}

	#requiredStateObject(
		sessionId: string,
		key: RuntimeStateKey,
	): Readonly<Record<string, unknown>> {
		const row = this.#database.prepare(`
			SELECT payload_json FROM session_state
			WHERE session_id = ? AND state_key = ?
		`).get(nonEmpty(sessionId, "sessionId"), key) as { payload_json: unknown } | undefined;
		if (!row) throw new SessionStateError("session_state_invalid", key);
		const payload = parseStateJson(row.payload_json, key);
		if (!isRecord(payload)) throw new SessionStateError("session_state_invalid", key);
		return payload;
	}

	#transitionApproval(input: ApprovalTransitionInput): ApprovalCheckpoint {
		const raw = this.#requiredStateObject(input.sessionId, "node_effect_checkpoint");
		const checkpoint = approvalCheckpointFromPayload(raw);
		const currentResolution = approvalResolution(checkpoint);
		const nextResolution = transitionApproval(currentResolution, input.transition);
		if (nextResolution === currentResolution) return checkpoint;
		if (checkpoint.status !== input.expectedStatus) {
			throw new ApprovalConflictError(checkpoint.status, input.transition.type);
		}
		const payload = effectPayload(raw, nextResolution, this.#clock());
		this.#upsertState(input.sessionId, "node_effect_checkpoint", payload);
		this.#touchExistingSession(input.sessionId);
		return approvalCheckpointFromPayload(payload);
	}

	#deleteApprovalContinuation(sessionId: string, includeCheckpoint = false): void {
		this.#database.prepare(`
			DELETE FROM session_state
			WHERE session_id = ? AND state_key IN (
				'pending_decision', 'suspended_turn', 'turn_record'
				${includeCheckpoint ? ", 'node_effect_checkpoint'" : ""}
			)
		`).run(sessionId);
	}

	#deleteClarificationContinuation(sessionId: string): void {
		this.#database.prepare(`
			DELETE FROM session_state
			WHERE session_id = ? AND state_key IN ('suspended_turn', 'turn_record')
		`).run(sessionId);
	}

	#loadObjectRows(
		table: "history_items" | "turn_rollouts",
		orderColumn: "sequence_no",
		sessionId: string,
	): readonly Readonly<Record<string, unknown>>[] {
		return this.#read(() => Object.freeze(
			(this.#database.prepare(`
				SELECT payload_json FROM ${table}
				WHERE session_id = ? ORDER BY ${orderColumn}
			`).all(nonEmpty(sessionId, "sessionId")) as readonly { payload_json: unknown }[])
				.map((row) => freezeJson(parseObjectJson(row.payload_json, table))),
		));
	}

	#committedQueueIdsInTransaction(sessionId: string): readonly string[] {
		const ids: string[] = [];
		const rows = this.#database.prepare(`
			SELECT payload_json FROM history_items
			WHERE session_id = ? ORDER BY sequence_no
		`).all(sessionId) as readonly { payload_json: unknown }[];
		for (const row of rows) {
			const item = parseObjectJson(row.payload_json, "history_items");
			const metadata = recordValue(item.metadata);
			if (typeof metadata.queue_id === "string" && metadata.queue_id) {
				ids.push(metadata.queue_id);
			}
		}
		return ids;
	}

	#touchSession(sessionId: string, workspaceRoot: string, threadId: string): void {
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
			nonEmpty(sessionId, "sessionId"),
			nonEmpty(workspaceRoot, "workspaceRoot"),
			nonEmpty(threadId, "threadId"),
			now,
			now,
			now,
		);
	}

	#touchExistingSession(sessionId: string): void {
		const now = this.#clock();
		this.#database.prepare(`
			UPDATE sessions SET updated_at = ?, last_active_at = ?
			WHERE session_id = ?
		`).run(now, now, sessionId);
	}

	#upsertState(sessionId: string, key: RuntimeStateKey, payload: unknown): void {
		const validated = validateStatePayload(key, payload);
		this.#database.prepare(`
			INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(session_id, state_key) DO UPDATE SET
				payload_json = excluded.payload_json,
				updated_at = excluded.updated_at
		`).run(sessionId, key, stableJson(validated), this.#clock());
	}

	#insertSummary(sessionId: string, summary: string): void {
		this.#database.prepare(`
			INSERT INTO session_summaries (session_id, summary_text, created_at)
			VALUES (?, ?, ?)
		`).run(sessionId, summary, this.#clock());
	}

	#appendConversationMessage(
		sessionId: string,
		payload: Readonly<Record<string, unknown>>,
	): void {
		const row = this.#database.prepare(`
			SELECT COALESCE(MAX(message_index), -1) + 1 AS next_index
			FROM conversation_messages WHERE session_id = ?
		`).get(sessionId) as { next_index: number };
		this.#database.prepare(`
			INSERT INTO conversation_messages (session_id, message_index, payload_json)
			VALUES (?, ?, ?)
		`).run(sessionId, row.next_index, stableJson(payload));
	}

	#appendHistoryItem(
		sessionId: string,
		payload: Readonly<Record<string, unknown>>,
	): void {
		this.#database.prepare(`
			INSERT INTO history_items (session_id, item_id, payload_json)
			VALUES (?, ?, ?)
		`).run(sessionId, String(payload.id), stableJson(payload));
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

	#sessionExists(sessionId: string): boolean {
		return this.#database.prepare(
			"SELECT 1 AS present FROM sessions WHERE session_id = ?",
		).get(sessionId) !== undefined;
	}

	#read<Result>(operation: () => Result): Result {
		try {
			return operation();
		} catch (error) {
			if (
				error instanceof StorageFailure
				|| error instanceof SessionStateError
				|| error instanceof QueueConflictError
				|| error instanceof ApprovalConflictError
			) {
				throw error;
			}
			throw new StorageFailure("storage operation failed");
		}
	}
}

function sessionOverviewSelect(): string {
	return `
		SELECT
			sessions.session_id,
			sessions.workspace_root,
			sessions.thread_id,
			sessions.created_at,
			sessions.updated_at,
			sessions.last_active_at,
			sessions.status,
			(SELECT COUNT(*) FROM conversation_messages
			 WHERE conversation_messages.session_id = sessions.session_id) AS message_count,
			(SELECT COUNT(*) FROM session_summaries
			 WHERE session_summaries.session_id = sessions.session_id) AS summary_count,
			conversation_trees.parent_id,
			conversation_trees.fork_point
		FROM sessions
		LEFT JOIN conversation_trees
			ON conversation_trees.session_id = sessions.session_id
	`;
}

function sessionOverviewFromRow(row: SessionOverviewRow): SessionOverview {
	const forkPoint = typeof row.fork_point === "number"
		&& Number.isSafeInteger(row.fork_point)
		&& row.fork_point >= 0
		? row.fork_point
		: undefined;
	return Object.freeze({
		sessionId: String(row.session_id),
		workspaceRoot: String(row.workspace_root),
		threadId: String(row.thread_id),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		lastActiveAt: String(row.last_active_at),
		status: String(row.status),
		messageCount: Number(row.message_count),
		summaryCount: Number(row.summary_count),
		...(typeof row.parent_id === "string" && row.parent_id
			? { parentId: row.parent_id }
			: {}),
		...(forkPoint === undefined ? {} : { forkPoint }),
	});
}

function page(query: SessionListQuery): { readonly limit: number; readonly offset: number } {
	const limit = query.limit ?? 20;
	const offset = query.offset ?? 0;
	if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000) {
		throw new RangeError("session list limit must be between 0 and 1000");
	}
	if (!Number.isSafeInteger(offset) || offset < 0) {
		throw new RangeError("session list offset must be a non-negative safe integer");
	}
	return { limit, offset };
}

function parseStateJson(value: unknown, key: RuntimeStateKey): unknown {
	if (typeof value !== "string") throw new SessionStateError("session_state_invalid", key);
	try {
		return validateStatePayload(key, JSON.parse(value) as unknown);
	} catch (error) {
		if (error instanceof SessionStateError) throw error;
		throw new SessionStateError("session_state_invalid", key);
	}
}

function validateStatePayload(key: RuntimeStateKey, payload: unknown): unknown {
	if (!isRecord(payload)) {
		throw new SessionStateError("session_state_invalid", key);
	}
	const requiredVersion = key === "compact_checkpoint"
		? payload.version
		: payload.state_version;
	if (typeof requiredVersion === "number" && requiredVersion !== 1) {
		throw new SessionStateError("session_state_version_unsupported", key);
	}
	const kind = VALIDATED_STATE_KINDS[key];
	if (kind) {
		try {
			parseRuntimeState({ kind, version: 1, payload });
		} catch (error) {
			if (error instanceof ContractValidationError) {
				throw new SessionStateError("session_state_invalid", key);
			}
			throw error;
		}
	}
	try {
		stableJson(payload);
	} catch {
		throw new SessionStateError("session_state_invalid", key);
	}
	return payload;
}

function queueSnapshotFromPayload(payload: Readonly<Record<string, unknown>>): QueueSnapshot {
	const state = parseRuntimeState({ kind: "input_queue", version: 1, payload });
	if (state.kind !== "input_queue") {
		throw new SessionStateError("session_state_invalid", "input_queue");
	}
	return freezeQueueSnapshot({
		sessionId: state.payload.session_id,
		revision: state.payload.revision,
		pendingSteers: state.payload.pending_steers.map(queueRecordFromPayload),
		rejectedSteers: state.payload.rejected_steers.map(queueRecordFromPayload),
		followUps: state.payload.follow_ups.map(queueRecordFromPayload),
	});
}

function queueRecordFromPayload(payload: {
	readonly queue_id: string;
	readonly session_id: string;
	readonly client_turn_id: string;
	readonly target_turn_id: string | null;
	readonly kind: QueuedInput["kind"];
	readonly state: QueuedInput["state"];
	readonly text: string;
	readonly image_paths: readonly string[];
	readonly source: string;
	readonly created_at: string;
	readonly updated_at: string;
}): QueuedInput {
	return Object.freeze({
		queueId: payload.queue_id,
		sessionId: payload.session_id,
		clientTurnId: payload.client_turn_id,
		targetTurnId: payload.target_turn_id,
		kind: payload.kind,
		state: payload.state,
		text: payload.text,
		imagePaths: Object.freeze([...payload.image_paths]),
		source: payload.source,
		createdAt: payload.created_at,
		updatedAt: payload.updated_at,
	});
}

function queuePayload(
	snapshot: QueueSnapshot,
	previous: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const previousRecords = previousQueueRecords(previous);
	return {
		...previous,
		session_id: snapshot.sessionId,
		revision: snapshot.revision,
		pending_steers: snapshot.pendingSteers.map(
			(record) => queueRecordPayload(record, previousRecords.get(record.queueId)),
		),
		rejected_steers: snapshot.rejectedSteers.map(
			(record) => queueRecordPayload(record, previousRecords.get(record.queueId)),
		),
		follow_ups: snapshot.followUps.map(
			(record) => queueRecordPayload(record, previousRecords.get(record.queueId)),
		),
	};
}

function queueRecordPayload(
	record: QueuedInput,
	previous: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
	return {
		...previous,
		queue_id: record.queueId,
		session_id: record.sessionId,
		client_turn_id: record.clientTurnId,
		target_turn_id: record.targetTurnId,
		kind: record.kind,
		state: record.state,
		text: record.text,
		image_paths: [...record.imagePaths],
		source: record.source,
		created_at: record.createdAt,
		updated_at: record.updatedAt,
	};
}

function previousQueueRecords(
	payload: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, Readonly<Record<string, unknown>>> {
	const records = new Map<string, Readonly<Record<string, unknown>>>();
	for (const key of ["pending_steers", "rejected_steers", "follow_ups"] as const) {
		const values = payload[key];
		if (!Array.isArray(values)) continue;
		for (const value of values) {
			if (isRecord(value) && typeof value.queue_id === "string" && value.queue_id) {
				records.set(value.queue_id, value);
			}
		}
	}
	return records;
}

function freezeQueueSnapshot(snapshot: QueueSnapshot): QueueSnapshot {
	return Object.freeze({
		...snapshot,
		pendingSteers: Object.freeze([...snapshot.pendingSteers]),
		rejectedSteers: Object.freeze([...snapshot.rejectedSteers]),
		followUps: Object.freeze([...snapshot.followUps]),
	});
}

function activeQueueRecords(snapshot: QueueSnapshot): readonly QueuedInput[] {
	return [...snapshot.pendingSteers, ...snapshot.rejectedSteers, ...snapshot.followUps];
}

function validateLegacyConversationMessage(
	value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const role = value.role;
	if (typeof value.content !== "string") {
		throw new StorageFailure("invalid legacy conversation message");
	}
	if (role === "user") return Object.freeze({ ...value, role, content: value.content });
	if (role === "assistant") {
		if (value.tool_calls !== undefined && value.tool_calls !== null) {
			if (!Array.isArray(value.tool_calls) || value.tool_calls.some((raw) => {
				const call = recordValue(raw);
				return typeof call.name !== "string" || !call.name
					|| typeof call.call_id !== "string" || !call.call_id
					|| !isRecord(call.arguments);
			})) {
				throw new StorageFailure("invalid legacy conversation message");
			}
		}
		return Object.freeze({ ...value, role, content: value.content });
	}
	if (role === "tool" && typeof value.tool_call_id === "string" && value.tool_call_id) {
		return Object.freeze({ ...value, role, content: value.content });
	}
	throw new StorageFailure("invalid legacy conversation message");
}

function queueRecordsEqual(left: QueuedInput, right: QueuedInput): boolean {
	return stableJson(queueRecordPayload(left)) === stableJson(queueRecordPayload(right));
}

function queuedUserMessage(
	record: QueuedInput,
	turnId: string,
	images: readonly CanonicalImage[],
): Readonly<Record<string, unknown>> {
	return {
		role: "user",
		content: record.text,
		tool_call_id: null,
		response_id: null,
		metadata: {
			turn_id: turnId,
			client_turn_id: record.clientTurnId,
			queue_id: record.queueId,
			source: record.source,
			image_paths: [...record.imagePaths],
		},
		blocks: imageBlocks(images),
		tool_calls: [],
	};
}

function queuedHistoryItem(
	record: QueuedInput,
	turnId: string,
	threadId: string,
): Readonly<Record<string, unknown>> {
	return {
		id: `${turnId}:queue:${record.queueId}`,
		thread_id: threadId,
		turn_id: turnId,
		type: "user_message",
		text: record.text,
		tool_name: null,
		call_id: null,
		metadata: {
			client_turn_id: record.clientTurnId,
			queue_id: record.queueId,
			source: record.source,
			image_paths: [...record.imagePaths],
		},
	};
}

function approvalCheckpointFromPayload(
	payload: Readonly<Record<string, unknown>>,
): ApprovalCheckpoint {
	const common = {
		sessionId: requiredString(payload.session_id, "session_id"),
		clientTurnId: requiredString(payload.client_turn_id, "client_turn_id"),
		turnId: requiredString(payload.turn_id, "turn_id"),
		decisionId: requiredString(payload.decision_id, "decision_id"),
		callId: requiredString(payload.call_id, "call_id"),
		toolName: requiredString(payload.tool_name, "tool_name"),
		updatedAt: requiredString(payload.updated_at, "updated_at"),
	};
	switch (payload.status) {
		case "waiting":
		case "rejected":
		case "approved":
			return Object.freeze({ ...common, status: payload.status });
		case "executing":
			return Object.freeze({
				...common,
				status: payload.status,
				fingerprint: requiredString(payload.fingerprint, "fingerprint"),
			});
		case "completed":
			return Object.freeze({
				...common,
				status: payload.status,
				fingerprint: requiredString(payload.fingerprint, "fingerprint"),
				resultCallId: requiredString(payload.result_call_id, "result_call_id"),
			});
		default:
			throw new SessionStateError("session_state_invalid", "node_effect_checkpoint");
	}
}

function approvalResolution(checkpoint: ApprovalCheckpoint): ApprovalResolution {
	switch (checkpoint.status) {
		case "waiting":
		case "rejected":
		case "approved":
			return Object.freeze({
				status: checkpoint.status,
				decisionId: checkpoint.decisionId,
			});
		case "executing":
			return Object.freeze({
				status: checkpoint.status,
				decisionId: checkpoint.decisionId,
				fingerprint: checkpoint.fingerprint,
			});
		case "completed":
			return Object.freeze({
				status: checkpoint.status,
				decisionId: checkpoint.decisionId,
				fingerprint: checkpoint.fingerprint,
				resultCallId: checkpoint.resultCallId,
			});
	}
}

function effectPayload(
	previous: Readonly<Record<string, unknown>>,
	resolution: ApprovalResolution,
	updatedAt: string,
): Readonly<Record<string, unknown>> {
	const base = Object.fromEntries(
		Object.entries(previous).filter(([key]) => !["status", "fingerprint", "result_call_id"]
			.includes(key)),
	);
	return {
		...base,
		status: resolution.status,
		updated_at: updatedAt,
		...(resolution.status === "executing" || resolution.status === "completed"
			? { fingerprint: resolution.fingerprint }
			: {}),
		...(resolution.status === "completed"
			? { result_call_id: resolution.resultCallId }
			: {}),
	};
}

function approvalCheckpointPayload(
	checkpoint: ApprovalCheckpoint,
): Readonly<Record<string, unknown>> {
	return {
		session_id: checkpoint.sessionId,
		client_turn_id: checkpoint.clientTurnId,
		turn_id: checkpoint.turnId,
		decision_id: checkpoint.decisionId,
		call_id: checkpoint.callId,
		tool_name: checkpoint.toolName,
		status: checkpoint.status,
		...(checkpoint.status === "executing" || checkpoint.status === "completed"
			? { fingerprint: checkpoint.fingerprint }
			: {}),
		...(checkpoint.status === "completed"
			? { result_call_id: checkpoint.resultCallId }
			: {}),
		updated_at: checkpoint.updatedAt,
	};
}

function validateMessage(
	value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const role = value.role;
	if (!["system", "developer", "user", "assistant", "tool"].includes(String(role))
		|| typeof value.content !== "string") {
		throw new SessionStateError("session_state_invalid", "compact_checkpoint");
	}
	return value;
}

function boundedSummary(value: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new TypeError("summary must be a non-empty string");
	}
	if (value.length > 200_000) throw new RangeError("summary exceeds storage limit");
	return value;
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
	return isRecord(value) ? value : {};
}

function freezeJson<Value>(value: Value): Value {
	if (Array.isArray(value)) {
		for (const item of value) freezeJson(item);
		return Object.freeze(value) as Value;
	}
	if (typeof value === "object" && value !== null) {
		for (const item of Object.values(value)) freezeJson(item);
		return Object.freeze(value);
	}
	return value;
}

function nonEmpty(value: string, name: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new TypeError(`${name} must be a non-empty string`);
	}
	return value.trim();
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value) {
		throw new StorageFailure(`invalid ${name} in approval checkpoint`);
	}
	return value;
}

function increment(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) {
		throw new RangeError(`${name} cannot be incremented safely`);
	}
	return value + 1;
}
