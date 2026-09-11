import {
	canonicalTurnFailureMessage,
	parseErrorContext,
	storageErrorReason,
	sanitizeRuntimeErrorDetail,
} from "@mycli/contracts";
import type { ErrorContext, ErrorReason, RuntimeStateRecord, RuntimeTurnRecord } from "@mycli/contracts";
import type {
	ApprovalResolution,
	ApprovalTransition,
	AgentForkTurns,
	CanonicalConversationItem,
	CanonicalContextMetadata,
	CanonicalImage,
	CanonicalMessage,
	CanonicalToolCall,
	CanonicalToolResult,
	ProviderUsage,
	ProviderReplayState,
	QueueSnapshot,
	QueuedInput,
	RuntimeErrorCode,
} from "@mycli/core";
import type {
	ShellOutputTranscriptReader,
	ShellTranscriptStore,
} from "../transcript/shell-transcript-store.ts";
import type { SubagentTaskStore } from "../agents/subagent-task-store.ts";
import type { AgentThreadStore } from "../agents/agent-thread-store.ts";
import type { AgentLifecycleStore } from "../agents/agent-lifecycle-store.ts";
import type {
	AppendTranscriptDisplayActivityInput,
	TranscriptEventEnvelope,
} from "../transcript/transcript-events.ts";

export interface ReserveTurnInput {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly clientUserMessageId: string;
	readonly turnId: string;
	readonly requestFingerprint: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly userText: string;
	readonly queueId?: string;
	readonly inputSource?: "submit" | "steer" | "queued";
	readonly imagePaths?: readonly string[];
	readonly images?: readonly CanonicalImage[];
	readonly source?: "user" | "agent_mailbox";
	readonly startedAt: string;
}

export interface TurnReservation {
	readonly kind: "reserved" | "existing";
	readonly turn: RuntimeTurnRecord;
}

export interface CompleteStoredTurnInput {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly assistantText: string;
	readonly usage: ProviderUsage;
	readonly lastTokenUsage?: ProviderUsage;
	readonly responseId?: string;
	readonly providerState?: ProviderReplayState;
	readonly completedAt: string;
}

export interface FailStoredTurnInput {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly code: RuntimeErrorCode;
	readonly message: string;
	readonly additionalDetails?: string;
	readonly errorContext?: ErrorContext;
	readonly diagnostics?: Readonly<Record<string, string | number | boolean | null>>;
	readonly completedAt: string;
}

export type TerminalizeStoredTurnInput =
	| (CompleteStoredTurnInput & { readonly kind: "completed" })
	| (FailStoredTurnInput & { readonly kind: "failed" });

export interface StoredTurnTerminalization {
	readonly kind: "completed" | "failed" | "interrupted";
	readonly turn: RuntimeTurnRecord;
	readonly outbox: TranscriptEventEnvelope<"turn_lifecycle">;
}

export interface TurnTerminalizationStore {
	terminalize(input: TerminalizeStoredTurnInput): StoredTurnTerminalization;
	load(sessionId: string, clientTurnId: string): StoredTurnTerminalization | undefined;
}

export function normalizeStoredTurnFailure(input: FailStoredTurnInput): FailStoredTurnInput {
	const additionalDetails = sanitizeRuntimeErrorDetail(input.additionalDetails);
	const errorContext = input.errorContext ? parseErrorContext(input.errorContext) : undefined;
	return Object.freeze({
		sessionId: input.sessionId,
		clientTurnId: input.clientTurnId,
		code: input.code,
		message: canonicalTurnFailureMessage(input.code, input.message, errorContext),
		...(errorContext ? { errorContext } : {}),
		...(additionalDetails ? { additionalDetails } : {}),
		...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
		completedAt: input.completedAt,
	});
}

export interface AppendAssistantToolCallsInput {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly assistantText: string;
	readonly calls: readonly CanonicalToolCall[];
	readonly responseId?: string;
	readonly providerState?: ProviderReplayState;
}

export interface AppendContextItemInput {
	readonly sessionId: string;
	readonly itemId: string;
	readonly text: string;
	readonly metadata: CanonicalContextMetadata;
}

export interface AppendToolResultInput {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly result: CanonicalToolResult;
	readonly summary: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
	readonly errorKind?: string;
	readonly contextItem?: Omit<AppendContextItemInput, "sessionId">;
	readonly planUpdate?: StoredPlanUpdate;
	readonly toolActivation?: StoredToolActivation;
}

export interface StoredPlanUpdate {
	readonly explanation?: string;
	readonly items: readonly {
		readonly id: string;
		readonly text: string;
		readonly status: "pending" | "in_progress" | "completed";
	}[];
}

export interface StoredToolActivation {
	readonly names: readonly string[];
}

export interface ProjectedFileChange {
	readonly version: 1;
	readonly kind: "add" | "update" | "delete" | "move";
	readonly path: string;
	readonly previous_path?: string;
	readonly diff: string;
	readonly added_lines: number;
	readonly removed_lines: number;
	readonly truncated?: true;
	readonly omitted_chars?: number;
}

export interface ProjectedMutationMetadata {
	readonly path?: string;
	readonly status?: "created" | "overwritten" | "edited" | "patched" | "unchanged";
	readonly matches?: number;
	readonly file_changes?: readonly ProjectedFileChange[];
}

export type RuntimeStateKey =
	| "input_queue"
	| "session_metadata"
	| "session_preferences"
	| "pending_decision"
	| "suspended_turn"
	| "turn_record"
	| "compact_checkpoint"
	| "context_baseline"
	| "responses_continuation_state"
	| "provider_timeline"
	| "node_effect_checkpoint";

export type SessionStateSource = RuntimeStateKey | "session_lineage";

export interface SessionListQuery {
	readonly workspaceRoot?: string;
	readonly search?: string;
	readonly includeArchived?: boolean;
	readonly includeDeleted?: boolean;
	readonly limit?: number;
	readonly offset?: number;
}

export type SessionLeaseState = "unlocked" | "owned" | "active" | "stale";

export type SessionPendingState = "none" | "approval" | "clarification" | "interrupted";

export interface SessionMetadata {
	readonly revision: number;
	readonly archived: boolean;
	readonly deleted: boolean;
	readonly title?: string;
}

export interface UpdateSessionMetadataInput {
	readonly sessionId: string;
	readonly expectedRevision: number;
	readonly title?: string | null;
	readonly archived?: boolean;
	readonly deleted?: boolean;
}

export interface SessionStateBatchEntry {
	readonly sessionId: string;
	readonly key: RuntimeStateKey;
	readonly payload: unknown;
}

export interface SessionOverview {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly lastActiveAt: string;
	readonly status: string;
	readonly messageCount: number;
	readonly summaryCount: number;
	readonly metadataRevision?: number;
	readonly archived?: boolean;
	readonly deleted?: boolean;
	readonly leaseState?: SessionLeaseState;
	readonly pendingState?: SessionPendingState;
	readonly latestTurnStatus?: string;
	readonly title?: string;
	readonly metadataIssue?: SessionStateErrorCode;
	readonly parentId?: string;
	readonly forkPoint?: number;
}

export interface SessionLineageNode {
	readonly sessionId: string;
	readonly parentId?: string;
	readonly forkPoint?: number;
	readonly forkEventSessionId?: string;
	readonly forkEventId?: string;
}

export interface ForkSessionInput {
	readonly sourceSessionId: string;
	readonly targetSessionId: string;
	readonly targetWorkspaceRoot?: string;
	readonly forkPoint?: number;
	readonly forkEventId?: string;
}

export interface ForkSessionResult {
	readonly sourceSessionId: string;
	readonly targetSessionId: string;
	readonly forkPoint: number;
	readonly forkEventSessionId?: string;
	readonly forkEventId?: string;
	readonly messageCount: number;
}

export interface ForkAgentConversationInput {
	readonly sourceSessionId: string;
	readonly targetSessionId: string;
	readonly workspaceRoot: string;
	readonly targetThreadId: string;
	readonly forkTurns: AgentForkTurns;
}

export interface ForkAgentConversationResult {
	readonly sourceSessionId: string;
	readonly targetSessionId: string;
	readonly messageCount: number;
}

export interface SessionSearchQuery {
	readonly workspaceRoot?: string;
	readonly limit?: number;
}

export interface SessionSearchResult {
	readonly sessionId: string;
	readonly messageIndex: number;
	readonly role: string;
	readonly snippet: string;
}

export interface SessionMaintenanceOptions {
	readonly workspaceRoot?: string;
	readonly candidateLimit?: number;
	readonly payloadLimit?: number;
}

export interface SessionMaintenanceCandidate {
	readonly sessionId: string;
	readonly lastActiveAt: string;
	readonly status: string;
}

export interface SessionStorageMetrics {
	readonly dbSizeBytes: number;
	readonly pageCount: number;
	readonly freelistCount: number;
	readonly pageSize: number;
}

export interface SessionContentBlobMaintenanceMetrics {
	readonly blobCount: number;
	readonly referenceCount: number;
	readonly transcriptReferenceCount: number;
	readonly modelInputReferenceCount: number;
	readonly reachableBlobCount: number;
	readonly reachableRawBytes: number;
	readonly reachableStoredBytes: number;
	readonly logicalReferenceBytes: number;
	readonly deduplicatedReferenceBytes: number;
	readonly orphanBlobCount: number;
	readonly orphanRawBytes: number;
	readonly orphanStoredBytes: number;
}

export interface SessionMaintenanceReport extends SessionStorageMetrics {
	readonly workspaceSessionCount: number;
	readonly emptySessionCount: number;
	readonly emptySessionCandidates: readonly SessionMaintenanceCandidate[];
	readonly emptySessionCandidatesOmitted: number;
	readonly compactableRolloutCount: number;
	readonly compactableRolloutBytes: number;
	readonly removableStateCount: number;
	readonly removableStateBytes: number;
	readonly estimatedPayloadBytesReclaimable: number;
	readonly freelistBytes: number;
	readonly contentBlobs?: SessionContentBlobMaintenanceMetrics;
	readonly dryRun: true;
}

export interface SessionContentBlobOrphanCleanupResult extends SessionStorageMetrics {
	readonly deletedBlobCount: number;
	readonly deletedRawBytes: number;
	readonly deletedStoredBytes: number;
	readonly freelistBytes: number;
	readonly dryRun: false;
}

export interface SessionPayloadCleanupResult extends SessionStorageMetrics {
	readonly compactedRolloutCount: number;
	readonly deletedStateCount: number;
	readonly removedPayloadBytes: number;
	readonly remainingCompactableRolloutCount: number;
	readonly remainingRemovableStateCount: number;
	readonly dryRun: false;
}

export interface SessionEmptyCleanupResult extends SessionStorageMetrics {
	readonly deletedSessionIds: readonly string[];
	readonly workspaceSessionCount: number;
	readonly emptySessionCount: number;
	readonly emptySessionCandidatesOmitted: number;
	readonly dryRun: false;
}

export interface SessionOrphanCleanupResult {
	readonly deletedRowsByTable: readonly Readonly<{
		readonly table: string;
		readonly count: number;
	}>[];
	readonly totalDeletedRows: number;
	readonly dryRun: false;
}

export interface SessionVacuumResult {
	readonly beforeDbSizeBytes: number;
	readonly afterDbSizeBytes: number;
	readonly beforePageCount: number;
	readonly afterPageCount: number;
	readonly beforeFreelistCount: number;
	readonly afterFreelistCount: number;
	readonly pageSize: number;
	readonly dryRun: false;
}

export interface SaveStateInput {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly key: RuntimeStateKey;
	readonly payload: unknown;
}

export interface CompareAndSetStateInput extends SaveStateInput {
	readonly expectedPayload: unknown | undefined;
}

export interface SaveQueueSnapshotInput {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly snapshot: QueueSnapshot;
}

export interface AppendSessionSummaryInput {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly summary: string;
}

export interface CommitQueuedInputsInput {
	readonly sessionId: string;
	readonly turnId: string;
	readonly records: readonly QueuedInput[];
	readonly imagesByQueueId?: ReadonlyMap<string, readonly CanonicalImage[]>;
}

export type ApprovalCheckpoint = ApprovalResolution & {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly turnId: string;
	readonly callId: string;
	readonly toolName: string;
	readonly updatedAt: string;
};

export interface ApprovalTransitionInput {
	readonly sessionId: string;
	readonly expectedStatus: ApprovalResolution["status"];
	readonly transition: ApprovalTransition;
}

export interface SaveApprovalSuspensionInput {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly pendingDecision: Extract<RuntimeStateRecord, { kind: "pending_decision" }>;
	readonly suspendedTurn: Extract<RuntimeStateRecord, { kind: "suspended_turn" }>;
	readonly turnRecord: Readonly<Record<string, unknown>>;
	readonly checkpoint: ApprovalCheckpoint;
}

export interface SaveParallelApprovalBatchInput {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly suspendedTurn: Extract<RuntimeStateRecord, { kind: "suspended_turn" }>;
	readonly expectedRevision?: number;
}

export interface SaveClarificationSuspensionInput {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly suspendedTurn: Extract<RuntimeStateRecord, { kind: "suspended_turn" }>;
	readonly turnRecord: Readonly<Record<string, unknown>>;
}

export interface CommitClarificationResponseInput {
	readonly sessionId: string;
	readonly requestId: string;
	readonly toolResult: AppendToolResultInput;
	readonly display: Readonly<{
		readonly header?: string;
		readonly question: string;
		readonly response: string;
		readonly multiSelect: boolean;
	}>;
}

export interface CommitApprovalResultInput {
	readonly sessionId: string;
	readonly expectedStatus: ApprovalResolution["status"];
	readonly transition: ApprovalTransition;
	readonly toolResult: AppendToolResultInput;
}

export interface FinalizeApprovalContinuationInput {
	readonly sessionId: string;
	readonly decisionId: string;
}

export interface InterruptAmbiguousApprovalInput {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly callId: string;
	readonly toolName: string;
	readonly errorKind: "effect_outcome_unknown";
	readonly completedAt: string;
}

export interface CommitCompactionInput {
	readonly expectedCheckpoint?: Readonly<Record<string, unknown>>;
	readonly sessionId: string;
	readonly replacementMessages: readonly Readonly<Record<string, unknown>>[];
	readonly replacementItems?: readonly CanonicalConversationItem[];
	readonly summary: string;
	readonly checkpoint: Readonly<Record<string, unknown>>;
}

export interface SequencedHistoryItem {
	readonly sequenceNo: number;
	readonly payload: Readonly<Record<string, unknown>>;
}

export interface HistoryItemWindow {
	readonly items: readonly SequencedHistoryItem[];
	readonly hasMore: boolean;
}

export interface ImportLegacyConversationInput {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly messages: readonly Readonly<Record<string, unknown>>[];
}

export interface SessionStateStore {
	listSessions(query?: SessionListQuery): readonly SessionOverview[];
	loadSession(sessionId: string): SessionOverview | undefined;
	loadSessionLineage(sessionId: string): readonly SessionLineageNode[];
	loadState(sessionId: string, key: RuntimeStateKey): unknown | undefined;
	loadStates(
		sessionIds: readonly string[],
		keys: readonly RuntimeStateKey[],
	): readonly SessionStateBatchEntry[];
	loadSessionMetadata(sessionId: string): SessionMetadata;
	updateSessionMetadata(input: UpdateSessionMetadataInput): SessionMetadata;
	saveState(input: SaveStateInput): void;
	compareAndSetState(input: CompareAndSetStateInput): boolean;
	saveQueueSnapshot(input: SaveQueueSnapshotInput): QueueSnapshot;
	deleteState(sessionId: string, key: RuntimeStateKey): void;
	appendSessionSummary(input: AppendSessionSummaryInput): void;
	loadSessionSummaries(sessionId: string): readonly string[];
	loadHistoryItems(sessionId: string): readonly Readonly<Record<string, unknown>>[];
	loadRecentHistoryItems(
		sessionId: string,
		limit: number,
	): readonly Readonly<Record<string, unknown>>[];
	loadTurnRollouts(sessionId: string): readonly Readonly<Record<string, unknown>>[];
	loadRecentTurnRollouts(
		sessionId: string,
		limit: number,
	): readonly Readonly<Record<string, unknown>>[];
	importLegacyConversation(input: ImportLegacyConversationInput): boolean;
	loadCommittedQueueIds(sessionId: string): ReadonlySet<string>;
	commitQueuedInputs(input: CommitQueuedInputsInput): QueueSnapshot;
	compareAndSetApproval(input: ApprovalTransitionInput): ApprovalCheckpoint;
	saveApprovalSuspension(input: SaveApprovalSuspensionInput): ApprovalCheckpoint;
	saveParallelApprovalBatch(input: SaveParallelApprovalBatchInput): void;
	clearParallelApprovalBatch(sessionId: string, turnId: string, batchId: string): void;
	finalizeApprovalContinuation(input: FinalizeApprovalContinuationInput): void;
	commitCompaction(input: CommitCompactionInput): boolean;
}

const MAX_MUTATION_PATH_CHARS = 240;
const MAX_MUTATION_DIFF_CHARS = 200_000;
const MAX_MUTATION_DIFF_LINES = 5_000;
const MAX_MUTATION_COUNT = 10_000_000;
const MUTATION_STATUSES = new Set<ProjectedMutationMetadata["status"]>([
	"created",
	"overwritten",
	"edited",
	"patched",
	"unchanged",
]);

export function projectMutationMetadata(
	value: Readonly<Record<string, unknown>> | undefined,
	success: boolean,
): ProjectedMutationMetadata {
	if (!isRecord(value)) return {};
	const path = workspacePath(value.path);
	const status = mutationStatus(value.status);
	const matches = boundedCount(value.matches);
	const projected: ProjectedMutationMetadata = {
		...(path ? { path } : {}),
		...(status ? { status } : {}),
		...(matches === undefined ? {} : { matches }),
	};
	if (success && value.fileChanges !== undefined) {
		const fileChanges = projectedFileChanges(value.fileChanges);
		return fileChanges.length > 0 ? { ...projected, file_changes: fileChanges } : projected;
	}
	if (!success || !path || !status || status === "unchanged") return projected;
	const diff = boundedDiff(value.diff);
	const addedLines = boundedCount(value.addedLines);
	const removedLines = boundedCount(value.removedLines);
	if (diff === undefined || addedLines === undefined || removedLines === undefined) {
		return projected;
	}
	const truncated = value.diffTruncated === true;
	const omittedChars = truncated ? boundedCount(value.omittedChars) : undefined;
	if (truncated && omittedChars === undefined) return projected;
	return {
		...projected,
		file_changes: [{
			version: 1,
			kind: status === "created" ? "add" : "update",
			path,
			diff,
			added_lines: addedLines,
			removed_lines: removedLines,
			...(truncated ? { truncated: true, omitted_chars: omittedChars } : {}),
		}],
	};
}

function projectedFileChanges(value: unknown): readonly ProjectedFileChange[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 64) return Object.freeze([]);
	const projected: ProjectedFileChange[] = [];
	let totalDiffChars = 0;
	let totalDiffLines = 0;
	for (const raw of value) {
		if (!isRecord(raw) || raw.version !== 1) return Object.freeze([]);
		const kind = mutationChangeKind(raw.kind);
		const path = workspacePath(raw.path);
		const previousPath = kind === "move" ? workspacePath(raw.previousPath) : undefined;
		const diff = boundedDiff(raw.diff);
		const addedLines = boundedCount(raw.addedLines);
		const removedLines = boundedCount(raw.removedLines);
		const truncated = raw.truncated === true;
		const omittedChars = truncated ? boundedCount(raw.omittedChars) : undefined;
		if (!kind || !path || kind === "move" && !previousPath
			|| diff === undefined || addedLines === undefined || removedLines === undefined
			|| truncated && omittedChars === undefined) return Object.freeze([]);
		totalDiffChars += diff.length;
		totalDiffLines += diff.split("\n").length;
		if (totalDiffChars > MAX_MUTATION_DIFF_CHARS || totalDiffLines > MAX_MUTATION_DIFF_LINES) {
			return Object.freeze([]);
		}
		projected.push(Object.freeze({
			version: 1,
			kind,
			path,
			...(previousPath ? { previous_path: previousPath } : {}),
			diff,
			added_lines: addedLines,
			removed_lines: removedLines,
			...(truncated ? { truncated: true, omitted_chars: omittedChars } : {}),
		}));
	}
	return Object.freeze(projected);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workspacePath(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const path = value.trim().replaceAll("\\", "/");
	if (
		!path
		|| path.length > MAX_MUTATION_PATH_CHARS
		|| path.includes("\0")
		|| path.startsWith("/")
		|| /^[A-Za-z]:\//u.test(path)
		|| path.split("/").includes("..")
	) {
		return undefined;
	}
	return path;
}

function mutationStatus(value: unknown): ProjectedMutationMetadata["status"] | undefined {
	return typeof value === "string" && MUTATION_STATUSES.has(
		value as ProjectedMutationMetadata["status"],
	) ? value as ProjectedMutationMetadata["status"] : undefined;
}

function mutationChangeKind(value: unknown): ProjectedFileChange["kind"] | undefined {
	return value === "add" || value === "update" || value === "delete" || value === "move"
		? value
		: undefined;
}

function boundedCount(value: unknown): number | undefined {
	return typeof value === "number"
		&& Number.isSafeInteger(value)
		&& value >= 0
		&& value <= MAX_MUTATION_COUNT
		? value
		: undefined;
}

function boundedDiff(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > MAX_MUTATION_DIFF_CHARS) return undefined;
	return value.split("\n").length <= MAX_MUTATION_DIFF_LINES ? value : undefined;
}

export interface TurnStore {
	reserveTurn(input: ReserveTurnInput): TurnReservation;
	loadTurn(sessionId: string, clientTurnId: string): RuntimeTurnRecord | undefined;
	loadConversation(sessionId: string): readonly CanonicalMessage[];
	loadConversationItems(sessionId: string): readonly CanonicalConversationItem[];
	appendAssistantToolCalls(input: AppendAssistantToolCallsInput): void;
	appendContextItem(input: AppendContextItemInput): void;
	appendToolResult(input: AppendToolResultInput): void;
	appendDisplayActivity?(
		input: AppendTranscriptDisplayActivityInput,
	): TranscriptEventEnvelope<"display_activity">;
	completeTurn(input: CompleteStoredTurnInput): RuntimeTurnRecord;
	failTurn(input: FailStoredTurnInput): RuntimeTurnRecord;
	recoverInterruptedTurns(): number;
	close(): void;
}

export interface RuntimeTurnStore extends TurnStore {
	readonly errorContextVersion?: 1;
	readonly turnTerminalizations: TurnTerminalizationStore;
}

export interface SessionLeaseStore {
	acquireSessionLease(sessionId: string): boolean;
	releaseSessionLease(sessionId: string): void;
}

export interface SessionStore extends TurnStore, SessionStateStore, ShellTranscriptStore, ShellOutputTranscriptReader {
	readonly errorContextVersion?: 1;
	readonly agentLifecycle: AgentLifecycleStore;
	readonly agentThreads: AgentThreadStore;
	readonly subagentTasks: SubagentTaskStore;
	forkAgentConversation(input: ForkAgentConversationInput): ForkAgentConversationResult;
	commitApprovalResult(input: CommitApprovalResultInput): ApprovalCheckpoint;
	interruptAmbiguousApproval(input: InterruptAmbiguousApprovalInput): RuntimeTurnRecord;
	saveClarificationSuspension(input: SaveClarificationSuspensionInput): void;
	commitClarificationResponse(input: CommitClarificationResponseInput): void;
	loadToolActivations(sessionId: string, turnId: string): readonly string[];
}

type DiagnosticValue = string | number | boolean | null;

export class StorageFailure extends Error {
	readonly code = "persistence_error" as const;
	readonly reason: Extract<ErrorReason, `storage.${string}`>;
	readonly diagnostics: Readonly<Record<string, DiagnosticValue>>;

	constructor(message: string, diagnostics: Readonly<Record<string, DiagnosticValue>> = {}, reason?: Extract<ErrorReason, `storage.${string}`>) {
		super(`persistence_error: ${message}`);
		this.name = "StorageFailure";
		this.diagnostics = diagnostics;
		this.reason = reason ?? (typeof diagnostics.expected_version === "number" && typeof diagnostics.actual_version === "number"
			? "storage.version_unsupported" : storageErrorReason(typeof diagnostics.sqlite_code === "string" ? diagnostics.sqlite_code : undefined));
	}
}

export class MessageIdConflictError extends Error {
	readonly code = "message_id_conflict" as const;

	constructor() {
		super("message_id_conflict: client_turn_id already has a different payload");
		this.name = "MessageIdConflictError";
	}
}

export class SessionInUseError extends Error {
	readonly code = "session_in_use" as const;

	constructor() {
		super("session_in_use: session is already owned by another process");
		this.name = "SessionInUseError";
	}
}

export class SessionMetadataConflictError extends Error {
	readonly code = "session_metadata_conflict" as const;

	constructor() {
		super("session_metadata_conflict: session metadata revision is stale");
		this.name = "SessionMetadataConflictError";
	}
}

export type SessionStateErrorCode =
	| "session_state_invalid"
	| "session_state_version_unsupported";

export class SessionStateError extends Error {
	readonly code: SessionStateErrorCode;
	readonly stateKey: SessionStateSource;

	constructor(code: SessionStateErrorCode, stateKey: SessionStateSource) {
		super(`${code}: persisted ${stateKey} state is not usable`);
		this.name = "SessionStateError";
		this.code = code;
		this.stateKey = stateKey;
	}
}
