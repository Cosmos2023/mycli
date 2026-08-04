import type { RuntimeTurnRecord } from "@mycli/contracts";
import type {
	CanonicalConversationItem,
	CanonicalMessage,
	CanonicalToolCall,
	CanonicalToolResult,
	ProviderUsage,
	RuntimeErrorCode,
} from "@mycli/core";

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
}

export interface AppendToolResultInput {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly result: CanonicalToolResult;
	readonly summary: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
	readonly errorKind?: string;
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

export interface SessionStore {
	reserveTurn(input: ReserveTurnInput): TurnReservation;
	loadTurn(sessionId: string, clientTurnId: string): RuntimeTurnRecord | undefined;
	loadConversation(sessionId: string): readonly CanonicalMessage[];
	loadConversationItems(sessionId: string): readonly CanonicalConversationItem[];
	appendAssistantToolCalls(input: AppendAssistantToolCallsInput): void;
	appendToolResult(input: AppendToolResultInput): void;
	completeTurn(input: CompleteStoredTurnInput): RuntimeTurnRecord;
	failTurn(input: FailStoredTurnInput): RuntimeTurnRecord;
	recoverInterruptedTurns(): number;
	close(): void;
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
