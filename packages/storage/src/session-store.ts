import type { RuntimeStateRecord, RuntimeTurnRecord } from "@mycli/contracts";
import type {
	ApprovalResolution,
	ApprovalTransition,
	CanonicalConversationItem,
	CanonicalContextMetadata,
	CanonicalMessage,
	CanonicalToolCall,
	CanonicalToolResult,
	ProviderUsage,
	ProviderReplayState,
	QueueSnapshot,
	QueuedInput,
	RuntimeErrorCode,
} from "@mycli/core";
import type { ShellTranscriptStore } from "./shell-transcript-store.ts";

export interface ReserveTurnInput {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly turnId: string;
	readonly requestFingerprint: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly userText: string;
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
	readonly responseId?: string;
	readonly providerState?: ProviderReplayState;
	readonly completedAt: string;
}

export interface FailStoredTurnInput {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly code: RuntimeErrorCode;
	readonly message: string;
	readonly completedAt: string;
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
}

export interface ProjectedFileChange {
	readonly version: 1;
	readonly kind: "add" | "update";
	readonly path: string;
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
	readonly limit?: number;
	readonly offset?: number;
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
	readonly parentId?: string;
	readonly forkPoint?: number;
}

export interface SessionLineageNode {
	readonly sessionId: string;
	readonly parentId?: string;
	readonly forkPoint?: number;
}

export interface SaveStateInput {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly key: RuntimeStateKey;
	readonly payload: unknown;
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
	readonly sessionId: string;
	readonly replacementMessages: readonly Readonly<Record<string, unknown>>[];
	readonly summary: string;
	readonly checkpoint: Readonly<Record<string, unknown>>;
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
	saveState(input: SaveStateInput): void;
	saveQueueSnapshot(input: SaveQueueSnapshotInput): QueueSnapshot;
	deleteState(sessionId: string, key: RuntimeStateKey): void;
	appendSessionSummary(input: AppendSessionSummaryInput): void;
	loadSessionSummaries(sessionId: string): readonly string[];
	loadHistoryItems(sessionId: string): readonly Readonly<Record<string, unknown>>[];
	loadTurnRollouts(sessionId: string): readonly Readonly<Record<string, unknown>>[];
	importLegacyConversation(input: ImportLegacyConversationInput): boolean;
	loadCommittedQueueIds(sessionId: string): ReadonlySet<string>;
	commitQueuedInputs(input: CommitQueuedInputsInput): QueueSnapshot;
	compareAndSetApproval(input: ApprovalTransitionInput): ApprovalCheckpoint;
	saveApprovalSuspension(input: SaveApprovalSuspensionInput): ApprovalCheckpoint;
	finalizeApprovalContinuation(input: FinalizeApprovalContinuationInput): void;
	commitCompaction(input: CommitCompactionInput): void;
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
	completeTurn(input: CompleteStoredTurnInput): RuntimeTurnRecord;
	failTurn(input: FailStoredTurnInput): RuntimeTurnRecord;
	recoverInterruptedTurns(): number;
	close(): void;
}

export interface SessionStore extends TurnStore, SessionStateStore, ShellTranscriptStore {
	commitApprovalResult(input: CommitApprovalResultInput): ApprovalCheckpoint;
	interruptAmbiguousApproval(input: InterruptAmbiguousApprovalInput): RuntimeTurnRecord;
}

type DiagnosticValue = string | number | boolean | null;

export class StorageFailure extends Error {
	readonly code = "persistence_error" as const;
	readonly diagnostics: Readonly<Record<string, DiagnosticValue>>;

	constructor(message: string, diagnostics: Readonly<Record<string, DiagnosticValue>> = {}) {
		super(`persistence_error: ${message}`);
		this.name = "StorageFailure";
		this.diagnostics = diagnostics;
	}
}

export class MessageIdConflictError extends Error {
	readonly code = "message_id_conflict" as const;

	constructor() {
		super("message_id_conflict: client_turn_id already has a different payload");
		this.name = "MessageIdConflictError";
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
