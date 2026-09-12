import { parseSkillReferences, type SkillReference } from "@mycli/contracts";
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
	SessionMetadataConflictError,
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
	CompareAndSetStateInput,
	CommitQueuedInputsInput,
	FinalizeApprovalContinuationInput,
	HistoryItemWindow,
	ImportLegacyConversationInput,
	InterruptAmbiguousApprovalInput,
	RuntimeStateKey,
	SaveQueueSnapshotInput,
	SaveApprovalSuspensionInput,
	SaveParallelApprovalBatchInput,
	SaveClarificationSuspensionInput,
	SaveStateInput,
	SessionLineageNode,
	SessionLeaseState,
	SessionListQuery,
	SessionMetadata,
	SessionOverview,
	SessionPendingState,
	SessionStateBatchEntry,
	SessionStateStore,
	UpdateSessionMetadataInput,
} from "./session-store.ts";
import { stableJson } from "../stable-json.ts";
import {
	assertImagePathCount,
	canonicalImages,
	imageBlocks,
} from "../artifacts/canonical-images.ts";

export interface SQLiteSessionStateRepositoryOptions {
	readonly database: Database.Database;
	readonly clock: () => string;
	readonly write: <Result>(operation: () => Result) => Result;
	readonly ownerId?: string;
	readonly isProcessAlive?: (processId: number) => boolean;
	readonly failpoint?: (name: string) => void;
	readonly transcriptAdapter?: SQLiteSessionStateTranscriptAdapter;
}

export interface SQLiteSessionStateTranscriptAdapter {
	loadCommittedQueueIds(sessionId: string): ReadonlySet<string>;
	appendQueuedInput(input: Readonly<{
		readonly sessionId: string;
		readonly turnId: string;
		readonly record: QueuedInput;
		readonly images: readonly CanonicalImage[];
	}>): void;
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

interface SessionOperationalStateRow {
	readonly session_id: unknown;
	readonly metadata_payload_json: unknown;
	readonly lease_owner_id: unknown;
	readonly lease_owner_pid: unknown;
	readonly agent_owner_pid: unknown;
	readonly has_pending_decision: unknown;
	readonly has_suspended_turn: unknown;
	readonly latest_turn_status: unknown;
}

export interface SessionOperationalStateProjection {
	readonly metadata: SessionMetadata;
	readonly leaseState: SessionLeaseState;
	readonly pendingState: SessionPendingState;
	readonly latestTurnStatus?: string;
	readonly metadataIssue?: SessionStateError["code"];
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

const MAX_RECENT_STATE_ROWS = 10_000;

export class SQLiteSessionStateRepository implements SessionStateStore {
	readonly #database: Database.Database;
	readonly #clock: () => string;
	readonly #writeTransaction: <Result>(operation: () => Result) => Result;
	readonly #ownerId?: string;
	readonly #isProcessAlive: (processId: number) => boolean;
	readonly #failpoint: (name: string) => void;
	readonly #transcriptAdapter?: SQLiteSessionStateTranscriptAdapter;

	constructor(options: SQLiteSessionStateRepositoryOptions) {
		this.#database = options.database;
		this.#clock = options.clock;
		this.#writeTransaction = options.write;
		this.#ownerId = options.ownerId;
		this.#isProcessAlive = options.isProcessAlive ?? processIsAlive;
		this.#failpoint = options.failpoint ?? (() => undefined);
		this.#transcriptAdapter = options.transcriptAdapter;
	}

	listSessions(query: SessionListQuery = {}): readonly SessionOverview[] {
		return this.#read(() => {
			const { limit, offset } = sessionListPage(query);
			const filters = sessionListSqlFilter(query);
			const rows = this.#database.prepare(`
				${sessionOverviewSelect()}
				${filters.where}
				ORDER BY sessions.last_active_at DESC, sessions.session_id DESC
				LIMIT ? OFFSET ?
			`).all(...filters.parameters, limit, offset) as readonly SessionOverviewRow[];
			const operational = this.loadSessionOperationalStates(
				rows.map((row) => nonEmpty(row.session_id, "sessionId")),
			);
			return Object.freeze(rows.map((row) => sessionOverviewFromRow(
				row,
				requiredOperationalState(operational, nonEmpty(row.session_id, "sessionId")),
			)));
		});
	}

	loadSession(sessionId: string): SessionOverview | undefined {
		return this.#read(() => {
			const normalizedSessionId = nonEmpty(sessionId, "sessionId");
			const row = this.#database.prepare(`
				${sessionOverviewSelect()}
				WHERE sessions.session_id = ?
			`).get(normalizedSessionId) as SessionOverviewRow | undefined;
			if (!row) return undefined;
			const operational = this.loadSessionOperationalStates([normalizedSessionId]);
			return sessionOverviewFromRow(
				row,
				requiredOperationalState(operational, normalizedSessionId),
			);
		});
	}

	loadSessionOperationalStates(
		sessionIds: readonly string[],
	): ReadonlyMap<string, SessionOperationalStateProjection> {
		const normalizedSessionIds = boundedIdentities(sessionIds, "sessionIds");
		if (normalizedSessionIds.length === 0) return new Map();
		return this.#read(() => {
			const rows = this.#database.prepare(`
				SELECT requested.value AS session_id,
					metadata.payload_json AS metadata_payload_json,
					root_lease.owner_id AS lease_owner_id,
					root_lease.owner_pid AS lease_owner_pid,
					agent_lease.owner_pid AS agent_owner_pid,
					CASE WHEN pending.rowid IS NULL THEN 0 ELSE 1 END AS has_pending_decision,
					CASE WHEN suspended.rowid IS NULL THEN 0 ELSE 1 END AS has_suspended_turn,
					(
						SELECT status FROM runtime_turns
						WHERE runtime_turns.session_id = requested.value
						ORDER BY started_at DESC, rowid DESC LIMIT 1
					) AS latest_turn_status
				FROM json_each(?) AS requested
				LEFT JOIN session_state AS metadata
					ON metadata.session_id = requested.value
					AND metadata.state_key = 'session_metadata'
				LEFT JOIN session_runtime_leases AS root_lease
					ON root_lease.session_id = requested.value
				LEFT JOIN agent_runtime_leases AS agent_lease
					ON agent_lease.thread_id = requested.value
				LEFT JOIN session_state AS pending
					ON pending.session_id = requested.value
					AND pending.state_key = 'pending_decision'
				LEFT JOIN session_state AS suspended
					ON suspended.session_id = requested.value
					AND suspended.state_key = 'suspended_turn'
			`).all(JSON.stringify(normalizedSessionIds)) as readonly SessionOperationalStateRow[];
			return new Map(rows.map((row) => {
				const sessionId = nonEmpty(row.session_id, "sessionId");
				return [sessionId, operationalStateFromRow(
					row,
					this.#ownerId,
					this.#isProcessAlive,
				)] as const;
			}));
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

	loadStates(
		sessionIds: readonly string[],
		keys: readonly RuntimeStateKey[],
	): readonly SessionStateBatchEntry[] {
		const normalizedSessionIds = boundedIdentities(sessionIds, "sessionIds");
		const normalizedKeys = boundedStateKeys(keys);
		if (normalizedSessionIds.length === 0 || normalizedKeys.length === 0) {
			return Object.freeze([]);
		}
		return this.#read(() => Object.freeze((this.#database.prepare(`
			SELECT session_id, state_key, payload_json
			FROM session_state
			WHERE session_id IN (SELECT value FROM json_each(?))
				AND state_key IN (SELECT value FROM json_each(?))
			ORDER BY session_id, state_key
		`).all(
			JSON.stringify(normalizedSessionIds),
			JSON.stringify(normalizedKeys),
		) as readonly {
			readonly session_id: unknown;
			readonly state_key: unknown;
			readonly payload_json: unknown;
		}[]).map((row): SessionStateBatchEntry => {
			const key = runtimeStateKey(row.state_key);
			return Object.freeze({
				sessionId: nonEmpty(row.session_id, "sessionId"),
				key,
				payload: freezeJson(parseStateJson(row.payload_json, key)),
			});
		})));
	}

	loadSessionMetadata(sessionId: string): SessionMetadata {
		const payload = this.loadState(sessionId, "session_metadata");
		return payload === undefined ? EMPTY_SESSION_METADATA : sessionMetadataFromPayload(payload);
	}

	updateSessionMetadata(input: UpdateSessionMetadataInput): SessionMetadata {
		const sessionId = nonEmpty(input.sessionId, "sessionId");
		const expectedRevision = metadataRevision(input.expectedRevision);
		return this.#writeTransaction(() => {
			if (!this.#sessionExists(sessionId)) throw new StorageFailure("session does not exist");
			const row = this.#database.prepare(`
				SELECT payload_json FROM session_state
				WHERE session_id = ? AND state_key = 'session_metadata'
			`).get(sessionId) as { readonly payload_json: unknown } | undefined;
			const current = row
				? sessionMetadataFromPayload(parseStateJson(row.payload_json, "session_metadata"))
				: EMPTY_SESSION_METADATA;
			if (current.revision !== expectedRevision) throw new SessionMetadataConflictError();
			const title = input.title === undefined
				? current.title
				: input.title === null ? undefined : sessionTitle(input.title);
			const archived = input.archived ?? current.archived;
			const deleted = input.deleted ?? current.deleted;
			if (title === current.title && archived === current.archived && deleted === current.deleted) {
				return current;
			}
			const next = Object.freeze({
				revision: increment(current.revision, "session metadata revision"),
				archived,
				deleted,
				...(title ? { title } : {}),
			});
			this.#upsertState(sessionId, "session_metadata", sessionMetadataPayload(next));
			this.#touchExistingSession(sessionId);
			return next;
		});
	}

	saveState(input: SaveStateInput): void {
		const payload = validateStatePayload(input.key, input.payload);
		this.#writeTransaction(() => {
			this.#touchSession(input.sessionId, input.workspaceRoot, input.threadId);
			this.#upsertState(input.sessionId, input.key, payload);
		});
	}

	compareAndSetState(input: CompareAndSetStateInput): boolean {
		return this.#writeTransaction(() => {
			const current = this.loadState(input.sessionId, input.key);
			if (stableJson(current) !== stableJson(input.expectedPayload)) return false;
			if (input.payload === undefined) this.deleteState(input.sessionId, input.key);
			else this.saveState(input);
			return true;
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

	loadRecentSessionSummaries(sessionId: string, limit: number): readonly string[] {
		const boundedLimit = boundedRecentStateRowLimit(limit);
		return this.#read(() => Object.freeze(
			[...(this.#database.prepare(`
				SELECT summary_text
				FROM session_summaries
				WHERE session_id = ?
				ORDER BY summary_index DESC
				LIMIT ?
			`).all(
				nonEmpty(sessionId, "sessionId"),
				boundedLimit,
			) as readonly { summary_text: unknown }[])]
				.reverse()
				.map((row) => String(row.summary_text)),
		));
	}

	loadHistoryItems(sessionId: string): readonly Readonly<Record<string, unknown>>[] {
		return this.#loadObjectRows("history_items", "sequence_no", sessionId);
	}

	loadRecentHistoryItems(
		sessionId: string,
		limit: number,
	): readonly Readonly<Record<string, unknown>>[] {
		return this.#loadRecentObjectRows("history_items", sessionId, limit);
	}

	loadTurnRollouts(sessionId: string): readonly Readonly<Record<string, unknown>>[] {
		return this.#loadObjectRows("turn_rollouts", "sequence_no", sessionId);
	}

	loadRecentTurnRollouts(
		sessionId: string,
		limit: number,
	): readonly Readonly<Record<string, unknown>>[] {
		return this.#loadRecentObjectRows("turn_rollouts", sessionId, limit);
	}

	loadHistoryItemWindow(
		sessionId: string,
		beforeSequence: number | undefined,
		limit: number,
	): HistoryItemWindow {
		const boundedLimit = boundedRecentStateRowLimit(limit);
		const before = beforeSequence === undefined
			? undefined
			: positiveSequence(beforeSequence, "beforeSequence");
		return this.#read(() => {
			const rows = this.#database.prepare(`
				SELECT sequence_no, payload_json
				FROM history_items
				WHERE session_id = ?
					${before === undefined ? "" : "AND sequence_no < ?"}
				ORDER BY sequence_no DESC
				LIMIT ?
			`).all(
				nonEmpty(sessionId, "sessionId"),
				...(before === undefined ? [] : [before]),
				boundedLimit + 1,
			) as readonly { readonly sequence_no: unknown; readonly payload_json: unknown }[];
			const hasMore = rows.length > boundedLimit;
			return Object.freeze({
				items: Object.freeze(rows.slice(0, boundedLimit).map((row) => Object.freeze({
					sequenceNo: positiveSequence(row.sequence_no, "sequence_no"),
					payload: freezeJson(parseObjectJson(row.payload_json, "history_items")),
				}))),
				hasMore,
			});
		});
	}

	loadTurnRolloutsForTurns(
		sessionId: string,
		turnIds: readonly string[],
	): readonly Readonly<Record<string, unknown>>[] {
		const ids = [...new Set(turnIds.map((turnId) => nonEmpty(turnId, "turnId")))];
		if (ids.length === 0) return Object.freeze([]);
		if (ids.length > MAX_RECENT_STATE_ROWS) {
			throw new RangeError(`turnIds must contain at most ${MAX_RECENT_STATE_ROWS} entries`);
		}
		return this.#read(() => Object.freeze(
			(this.#database.prepare(`
				SELECT payload_json
				FROM turn_rollouts
				WHERE session_id = ? AND turn_id IN (${ids.map(() => "?").join(", ")})
				ORDER BY sequence_no
			`).all(
				nonEmpty(sessionId, "sessionId"),
				...ids,
			) as readonly { readonly payload_json: unknown }[])
				.map((row) => freezeJson(parseObjectJson(row.payload_json, "turn_rollouts"))),
		));
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
		if (this.#transcriptAdapter) {
			return this.#transcriptAdapter.loadCommittedQueueIds(nonEmpty(sessionId, "sessionId"));
		}
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
				if (this.#transcriptAdapter) {
					this.#transcriptAdapter.appendQueuedInput({ sessionId, turnId, record, images });
				} else {
					this.#appendConversationMessage(
						sessionId,
						queuedUserMessage(record, turnId, images),
					);
					this.#appendHistoryItem(
						sessionId,
						queuedHistoryItem(record, turnId, this.#threadId(sessionId)),
					);
				}
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

	saveParallelApprovalBatch(input: SaveParallelApprovalBatchInput): void {
		const parsed = parseRuntimeState(input.suspendedTurn);
		if (parsed.kind !== "suspended_turn" || !parsed.payload.parallel_batch
			|| parsed.payload.session_id !== input.sessionId) {
			throw new SessionStateError("session_state_invalid", "suspended_turn");
		}
		const batch = parsed.payload.parallel_batch;
		if (!parsed.payload.turn_id || !parsed.payload.client_turn_id
			|| parsed.payload.pending_clarification
			|| batch.batch_id !== batch.calls[0]!.call.callId
			|| !batch.calls.some((entry) => entry.approval)) {
			throw new SessionStateError("session_state_invalid", "suspended_turn");
		}
		const ids = new Set<string>();
		for (const entry of batch.calls) {
			if (ids.has(entry.call.callId) || entry.call.callId !== entry.execution_call.callId
				|| entry.choice !== undefined && (!entry.approval || !entry.approval.options.includes(entry.choice))
				|| entry.approval && (entry.approval.tool_call.call_id !== entry.call.callId
					|| entry.approval.tool_call.name !== entry.call.name
					|| stableJson(entry.approval.tool_call.arguments) !== stableJson(JSON.parse(entry.call.argumentsJson))
					|| stableJson(entry.call) !== stableJson(entry.execution_call))) {
				throw new SessionStateError("session_state_invalid", "suspended_turn");
			}
			ids.add(entry.call.callId);
		}
		const pending = batch.calls.find((entry) => entry.approval && entry.choice === undefined)?.approval;
		const payload = { ...parsed.payload, pending_approval: pending ?? null };
		this.#writeTransaction(() => {
			const previous = this.loadState(input.sessionId, "suspended_turn");
			if (input.expectedRevision === undefined) {
				if (previous !== undefined || batch.revision !== 0
					|| this.loadState(input.sessionId, "pending_decision") !== undefined
					|| this.loadState(input.sessionId, "node_effect_checkpoint") !== undefined
					|| batch.calls.some((entry) => entry.choice !== undefined)) {
					throw new StorageFailure("parallel approval batch already exists");
				}
			} else {
				const old = parseRuntimeState({ kind: "suspended_turn", version: 1, payload: previous });
				if (old.kind !== "suspended_turn" || !old.payload.parallel_batch
					|| old.payload.parallel_batch.revision !== input.expectedRevision
					|| batch.revision !== input.expectedRevision + 1
					|| old.payload.parallel_batch.batch_id !== batch.batch_id
					|| stableJson({ ...old.payload, parallel_batch: null, pending_approval: null })
						!== stableJson({ ...payload, parallel_batch: null, pending_approval: null })) {
					throw new StorageFailure("parallel approval batch revision conflict");
				}
				const prior = old.payload.parallel_batch.calls;
				let decisions = 0;
				if (prior.length !== batch.calls.length) {
					throw new StorageFailure("parallel approval calls changed");
				}
				for (const [index, entry] of batch.calls.entries()) {
					const before = prior[index]!;
					if (stableJson({ ...before, choice: null }) !== stableJson({ ...entry, choice: null })
						|| before.choice !== undefined && before.choice !== entry.choice) {
						throw new StorageFailure("parallel approval call changed");
					}
					if (before.choice !== entry.choice) decisions += 1;
				}
				if (decisions !== 1) throw new StorageFailure("parallel approval decision conflict");
			}
			this.#touchSession(input.sessionId, input.workspaceRoot, input.threadId);
			this.#upsertState(input.sessionId, "suspended_turn", payload);
			if (pending) this.#upsertState(input.sessionId, "pending_decision", pending);
			else this.#database.prepare(
				"DELETE FROM session_state WHERE session_id = ? AND state_key = 'pending_decision'",
			).run(input.sessionId);
			this.#upsertState(input.sessionId, "turn_record", {
				turn_id: payload.turn_id,
				client_turn_id: payload.client_turn_id,
				user_message: payload.user_message,
				status: pending ? "waiting_approval" : "running",
				updated_at: this.#clock(),
			});
			this.#failpoint("parallel_approval_after_states");
		});
	}

	clearParallelApprovalBatch(sessionId: string, turnId: string, batchId: string): void {
		this.#writeTransaction(() => {
			const raw = this.loadState(sessionId, "suspended_turn");
			if (raw === undefined) return;
			const state = parseRuntimeState({ kind: "suspended_turn", version: 1, payload: raw });
			if (state.kind !== "suspended_turn" || state.payload.turn_id !== turnId
				|| state.payload.parallel_batch?.batch_id !== batchId) return;
			this.#deleteApprovalContinuation(sessionId);
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
		if (suspended.parallel_batch !== undefined) {
			const parsed = parseRuntimeState({ kind: "suspended_turn", version: 1, payload: suspended });
			if (parsed.kind !== "suspended_turn" || !parsed.payload.parallel_batch || effect !== undefined) {
				throw new SessionStateError("session_state_invalid", "suspended_turn");
			}
			const head = parsed.payload.parallel_batch.calls.find(
				(entry) => entry.approval && entry.choice === undefined,
			);
			return head !== undefined
				&& parsed.payload.session_id === sessionId
				&& parsed.payload.client_turn_id === clientTurnId
				&& parsed.payload.turn_id === turnId
				&& recordValue(pending.tool_call).call_id === head.call.callId;
		}
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

	commitCompaction(input: CommitCompactionInput): boolean {
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
		return this.#writeTransaction(() => {
			if (input.expectedCheckpoint && stableJson(this.loadState(sessionId, "compact_checkpoint"))
				!== stableJson(input.expectedCheckpoint)) return false;
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
			return true;
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

	#loadRecentObjectRows(
		table: "history_items" | "turn_rollouts",
		sessionId: string,
		limit: number,
	): readonly Readonly<Record<string, unknown>>[] {
		const boundedLimit = boundedRecentStateRowLimit(limit);
		return this.#read(() => {
			const rows = this.#database.prepare(`
				SELECT payload_json FROM ${table}
				WHERE session_id = ? ORDER BY sequence_no DESC LIMIT ?
			`).all(
				nonEmpty(sessionId, "sessionId"),
				boundedLimit,
			) as readonly { payload_json: unknown }[];
			return Object.freeze([...rows]
				.reverse()
				.map((row) => freezeJson(parseObjectJson(row.payload_json, table))));
		});
	}

	#committedQueueIdsInTransaction(sessionId: string): readonly string[] {
		if (this.#transcriptAdapter) {
			return [...this.#transcriptAdapter.loadCommittedQueueIds(sessionId)];
		}
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
				|| error instanceof SessionMetadataConflictError
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

function sessionOverviewFromRow(
	row: SessionOverviewRow,
	operational: SessionOperationalStateProjection,
): SessionOverview {
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
		metadataRevision: operational.metadata.revision,
		archived: operational.metadata.archived,
		deleted: operational.metadata.deleted,
		leaseState: operational.leaseState,
		pendingState: operational.pendingState,
		...(operational.latestTurnStatus
			? { latestTurnStatus: operational.latestTurnStatus }
			: {}),
		...(operational.metadata.title ? { title: operational.metadata.title } : {}),
		...(operational.metadataIssue ? { metadataIssue: operational.metadataIssue } : {}),
		...(typeof row.parent_id === "string" && row.parent_id
			? { parentId: row.parent_id }
			: {}),
		...(forkPoint === undefined ? {} : { forkPoint }),
	});
}

function requiredOperationalState(
	states: ReadonlyMap<string, SessionOperationalStateProjection>,
	sessionId: string,
): SessionOperationalStateProjection {
	return states.get(sessionId) ?? Object.freeze({
		metadata: EMPTY_SESSION_METADATA,
		leaseState: "unlocked",
		pendingState: "none",
	});
}

function operationalStateFromRow(
	row: SessionOperationalStateRow,
	ownerId: string | undefined,
	isProcessAlive: (processId: number) => boolean,
): SessionOperationalStateProjection {
	let metadata = EMPTY_SESSION_METADATA;
	let metadataIssue: SessionStateError["code"] | undefined;
	if (typeof row.metadata_payload_json === "string") {
		try {
			metadata = sessionMetadataFromPayload(
				parseStateJson(row.metadata_payload_json, "session_metadata"),
			);
		} catch (error) {
			if (!(error instanceof SessionStateError)) throw error;
			metadataIssue = error.code;
		}
	}
	const latestTurnStatus = typeof row.latest_turn_status === "string"
		&& row.latest_turn_status.length <= 64
		? row.latest_turn_status
		: undefined;
	const pendingState: SessionPendingState = Number(row.has_pending_decision) === 1
		? "approval"
		: Number(row.has_suspended_turn) === 1
			? "clarification"
			: latestTurnStatus === "interrupted" ? "interrupted" : "none";
	return Object.freeze({
		metadata,
		leaseState: sessionLeaseState(row, ownerId, isProcessAlive),
		pendingState,
		...(latestTurnStatus ? { latestTurnStatus } : {}),
		...(metadataIssue ? { metadataIssue } : {}),
	});
}

function sessionLeaseState(
	row: SessionOperationalStateRow,
	ownerId: string | undefined,
	isProcessAlive: (processId: number) => boolean,
): SessionLeaseState {
	if (typeof row.lease_owner_id === "string" && row.lease_owner_id) {
		if (ownerId && row.lease_owner_id === ownerId) return "owned";
		return liveProcess(row.lease_owner_pid, isProcessAlive) ? "active" : "stale";
	}
	if (row.agent_owner_pid !== null && row.agent_owner_pid !== undefined) {
		return liveProcess(row.agent_owner_pid, isProcessAlive) ? "active" : "stale";
	}
	return "unlocked";
}

function liveProcess(
	value: unknown,
	isProcessAlive: (processId: number) => boolean,
): boolean {
	return typeof value === "number"
		&& Number.isSafeInteger(value)
		&& value > 0
		&& isProcessAlive(value);
}

export function sessionListSqlFilter(query: SessionListQuery): Readonly<{
	readonly where: string;
	readonly parameters: readonly string[];
}> {
	const predicates: string[] = [];
	const parameters: string[] = [];
	const workspaceRoot = query.workspaceRoot?.trim();
	if (workspaceRoot) {
		predicates.push("sessions.workspace_root = ?");
		parameters.push(workspaceRoot);
	}
	if (query.includeArchived !== true) {
		predicates.push(`NOT EXISTS (
			SELECT 1 FROM session_state AS archived_metadata
			WHERE archived_metadata.session_id = sessions.session_id
				AND archived_metadata.state_key = 'session_metadata'
				AND json_valid(archived_metadata.payload_json)
				AND json_extract(archived_metadata.payload_json, '$.archived') = 1
		)`);
	}
	if (query.includeDeleted !== true) {
		predicates.push(`NOT EXISTS (
			SELECT 1 FROM session_state AS deleted_metadata
			WHERE deleted_metadata.session_id = sessions.session_id
				AND deleted_metadata.state_key = 'session_metadata'
				AND json_valid(deleted_metadata.payload_json)
				AND json_extract(deleted_metadata.payload_json, '$.deleted') = 1
		)`);
	}
	const search = query.search?.trim();
	if (search) {
		if (search.length > 256 || /[\r\n\0]/u.test(search)) {
			throw new RangeError("session search must be at most 256 characters on one line");
		}
		const pattern = `%${search.toLocaleLowerCase().replace(/[\\%_]/gu, "\\$&")}%`;
		predicates.push(`(
			LOWER(sessions.session_id) LIKE ? ESCAPE '\\'
			OR LOWER(sessions.workspace_root) LIKE ? ESCAPE '\\'
			OR EXISTS (
				SELECT 1 FROM session_state AS title_metadata
				WHERE title_metadata.session_id = sessions.session_id
					AND title_metadata.state_key = 'session_metadata'
					AND json_valid(title_metadata.payload_json)
					AND LOWER(COALESCE(json_extract(title_metadata.payload_json, '$.title'), ''))
						LIKE ? ESCAPE '\\'
			)
		)`);
		parameters.push(pattern, pattern, pattern);
	}
	return Object.freeze({
		where: predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "",
		parameters: Object.freeze(parameters),
	});
}

export function sessionListPage(query: SessionListQuery): { readonly limit: number; readonly offset: number } {
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

const EMPTY_SESSION_METADATA: SessionMetadata = Object.freeze({
	revision: 0,
	archived: false,
	deleted: false,
});

function sessionMetadataFromPayload(payload: unknown): SessionMetadata {
	if (!isRecord(payload) || payload.state_version !== 1) {
		throw new SessionStateError("session_state_invalid", "session_metadata");
	}
	const revision = metadataRevision(payload.revision);
	if (typeof payload.archived !== "boolean" || typeof payload.deleted !== "boolean") {
		throw new SessionStateError("session_state_invalid", "session_metadata");
	}
	let title: string | undefined;
	try {
		title = payload.title === undefined ? undefined : sessionTitle(payload.title);
	} catch {
		throw new SessionStateError("session_state_invalid", "session_metadata");
	}
	return Object.freeze({
		revision,
		archived: payload.archived,
		deleted: payload.deleted,
		...(title ? { title } : {}),
	});
}

function sessionMetadataPayload(metadata: SessionMetadata): Readonly<Record<string, unknown>> {
	return Object.freeze({
		state_version: 1,
		revision: metadata.revision,
		archived: metadata.archived,
		deleted: metadata.deleted,
		...(metadata.title ? { title: metadata.title } : {}),
	});
}

function metadataRevision(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new SessionStateError("session_state_invalid", "session_metadata");
	}
	return value;
}

function sessionTitle(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("session title must be a string");
	const title = value.trim();
	if (!title || title.length > 256 || hasAsciiControlCharacter(title)) {
		throw new RangeError("session title must be between 1 and 256 printable characters");
	}
	return title;
}

function hasAsciiControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
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
	readonly claim_turn_id?: string | null;
	readonly text: string;
	readonly image_paths: readonly string[];
	readonly skill_references?: readonly SkillReference[];
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
		...(payload.claim_turn_id ? { claimTurnId: payload.claim_turn_id } : {}),
		text: payload.text,
		imagePaths: Object.freeze([...payload.image_paths]),
		...(payload.skill_references?.length ? { skillReferences: parseSkillReferences(payload.skill_references) } : {}),
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
		claim_turn_id: record.claimTurnId ?? null,
		text: record.text,
		image_paths: [...record.imagePaths],
		...(record.skillReferences?.length ? { skill_references: record.skillReferences } : {}),
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
		...(record.skillReferences?.length ? { skill_references: record.skillReferences } : {}),
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
		...(record.skillReferences?.length ? { skill_references: record.skillReferences } : {}),
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

const RUNTIME_STATE_KEYS = new Set<RuntimeStateKey>([
	"input_queue",
	"session_metadata",
	"session_preferences",
	"pending_decision",
	"suspended_turn",
	"turn_record",
	"compact_checkpoint",
	"context_baseline",
	"responses_continuation_state",
	"provider_timeline",
	"node_effect_checkpoint",
]);

function boundedIdentities(values: readonly string[], name: string): readonly string[] {
	if (!Array.isArray(values) || values.length > 1_000) {
		throw new RangeError(`${name} must contain at most 1000 values`);
	}
	return Object.freeze([...new Set(values.map((value) => nonEmpty(value, name)))]);
}

function boundedStateKeys(values: readonly RuntimeStateKey[]): readonly RuntimeStateKey[] {
	if (!Array.isArray(values) || values.length > RUNTIME_STATE_KEYS.size) {
		throw new RangeError("state keys exceed the supported limit");
	}
	return Object.freeze([...new Set(values.map(runtimeStateKey))]);
}

function runtimeStateKey(value: unknown): RuntimeStateKey {
	if (typeof value !== "string" || !RUNTIME_STATE_KEYS.has(value as RuntimeStateKey)) {
		throw new TypeError("invalid runtime state key");
	}
	return value as RuntimeStateKey;
}

function nonEmpty(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new TypeError(`${name} must be a non-empty string`);
	}
	return value.trim();
}

function processIsAlive(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error
			&& error.code === "EPERM";
	}
}

function boundedRecentStateRowLimit(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RECENT_STATE_ROWS) {
		throw new RangeError(`limit must be an integer between 1 and ${MAX_RECENT_STATE_ROWS}`);
	}
	return value;
}

function positiveSequence(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}
	return value;
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
