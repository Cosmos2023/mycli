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
	readonly errorKind?: string;
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
