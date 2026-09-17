import { turnInterruptionNotice, type TurnInterruptionReason } from "@mycli/contracts";
import {
	parseRuntimeTurnRecord,
	turnCompletedDurationId,
	turnFailedNoticeId,
	turnFailureNotice,
	turnInterruptedNoticeId,
} from "@mycli/contracts";
import type { ErrorContext, RuntimeTurnRecord } from "@mycli/contracts";
import { turnAbortedContextItem } from "@mycli/core";
import type { CanonicalToolCall, RuntimeErrorCode } from "@mycli/core";
import type { AgentEffectAttempt, AgentEffectLedgerStore } from "../agents/agent-effect-ledger.ts";
import { interruptedToolResult } from "../agents/interrupted-tool-result.ts";
import type Database from "better-sqlite3";
import type { ProviderAttemptLedgerStore } from "../projections/provider-attempt-ledger.ts";
import {
	normalizeStoredTurnFailure,
	StorageFailure,
} from "./session-store.ts";
import type {
	StoredTurnTerminalization,
	TerminalizeStoredTurnInput,
	TurnTerminalizationStore,
	InterruptAmbiguousApprovalInput,
} from "./session-store.ts";
import { stableJson } from "../stable-json.ts";
import { semanticTranscriptEventId } from "../transcript/transcript-event-id.ts";
import {
	parseTranscriptEventAppendInput,
} from "../transcript/transcript-events.ts";
import type {
	TranscriptEventAppendInput,
	TranscriptEventEnvelope,
} from "../transcript/transcript-events.ts";

export type TurnTerminalizationFailpoint =
	| "complete_after_assistant"
	| "complete_after_display"
	| "complete_after_outbox"
	| "complete_after_turn"
	| "failure_after_tools"
	| "failure_after_display"
	| "failure_after_outbox"
	| "failure_after_turn";

export interface SQLiteTurnTerminalizationRepositoryOptions {
	readonly database: Database.Database;
	readonly write: <Result>(operation: () => Result) => Result;
	readonly appendEvent: (input: TranscriptEventAppendInput) => TranscriptEventEnvelope;
	readonly loadEvent: (sessionId: string, eventId: string) => TranscriptEventEnvelope | undefined;
	readonly loadPendingToolCalls: (
		sessionId: string,
		turnId: string,
	) => readonly CanonicalToolCall[];
	readonly failpoint?: (name: TurnTerminalizationFailpoint) => void;
	readonly effectLedger?: Pick<AgentEffectLedgerStore, "recoverInterruptedTools">;
	readonly providerAttemptLedger?: Pick<ProviderAttemptLedgerStore, "closeInterruptedTurn">;
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
completed_at
`;

export class SQLiteTurnTerminalizationRepository implements TurnTerminalizationStore {
	readonly #database: Database.Database;
	readonly #writeTransaction: <Result>(operation: () => Result) => Result;
	readonly #appendEvent: (input: TranscriptEventAppendInput) => TranscriptEventEnvelope;
	readonly #loadEvent: SQLiteTurnTerminalizationRepositoryOptions["loadEvent"];
	readonly #loadPendingToolCalls: SQLiteTurnTerminalizationRepositoryOptions["loadPendingToolCalls"];
	readonly #failpoint: (name: TurnTerminalizationFailpoint) => void;
	readonly #effectLedger: SQLiteTurnTerminalizationRepositoryOptions["effectLedger"];
	readonly #providerAttemptLedger: SQLiteTurnTerminalizationRepositoryOptions["providerAttemptLedger"];

	constructor(options: SQLiteTurnTerminalizationRepositoryOptions) {
		this.#database = options.database;
		this.#writeTransaction = options.write;
		this.#appendEvent = options.appendEvent;
		this.#loadEvent = options.loadEvent;
		this.#loadPendingToolCalls = options.loadPendingToolCalls;
		this.#failpoint = options.failpoint ?? (() => undefined);
		this.#effectLedger = options.effectLedger;
		this.#providerAttemptLedger = options.providerAttemptLedger;
	}

	terminalize(input: TerminalizeStoredTurnInput): StoredTurnTerminalization {
		return this.#writeTransaction(() => input.kind === "completed"
			? this.#complete(input)
			: this.#fail(input));
	}

	load(sessionId: string, clientTurnId: string): StoredTurnTerminalization | undefined {
		const turn = this.#requiredTurn(sessionId, clientTurnId);
		if (turn.status === "in_progress") return undefined;
		const kind = turn.status;
		const event = this.#loadEvent(
			turn.session_id,
			semanticTranscriptEventId(turn.turn_id, "lifecycle", kind),
		);
		if (event?.eventType !== "turn_lifecycle" || event.payload.phase !== kind) {
			throw new StorageFailure("terminal turn lifecycle outbox is missing");
		}
		return terminalization(turn, event);
	}

	terminalizeUnknownToolOutcome(
		input: InterruptAmbiguousApprovalInput,
	): StoredTurnTerminalization {
		return this.#writeTransaction(() => {
			const turn = this.#requireRunningTurn(input.sessionId, input.clientTurnId);
			this.#providerAttemptLedger?.closeInterruptedTurn({
				sessionId: input.sessionId, turnId: turn.turn_id, observedAt: input.completedAt,
			});
			this.#appendEvent(parseTranscriptEventAppendInput({
				schemaVersion: 1,
				sessionId: input.sessionId,
				eventId: semanticTranscriptEventId(turn.turn_id, "tool-result", input.callId),
				turnId: turn.turn_id,
				eventType: "tool_result",
				modelVisible: true,
				createdAt: input.completedAt,
				payload: {
					result: {
						callId: input.callId,
						toolName: input.toolName,
						output: "Tool effect outcome is unknown after interruption.",
						success: false,
					},
					summary: `${input.toolName.slice(0, 128) || "Tool"} outcome unknown`,
					errorKind: input.errorKind,
					metadata: { synthetic: true, append_only: true },
				},
			}));
			const attempts = new Map(this.#effectLedger?.recoverInterruptedTools({
				sessionId: input.sessionId, turnId: turn.turn_id, completedAt: input.completedAt,
			}).map((attempt) => [attempt.externalId, attempt]));
			for (const call of this.#loadPendingToolCalls(input.sessionId, turn.turn_id)) {
				this.#appendSyntheticToolResult(turn, call, "interrupted", input.completedAt, attempts.get(call.callId));
			}
			this.#failpoint("failure_after_tools");
			this.#appendTurnAborted(turn, input.completedAt);
			this.#appendInterruptedDisplay(turn, input.completedAt);
			this.#failpoint("failure_after_display");
			const outbox = this.#appendLifecycle(turn, "interrupted", input.completedAt, {
				errorCode: "interrupted",
				message: "tool effect outcome is unknown",
				diagnostics: { error_kind: input.errorKind },
			});
			this.#failpoint("failure_after_outbox");
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
			this.#failpoint("failure_after_turn");
			this.#touchSession(input.sessionId, input.completedAt);
			return terminalization(
				this.#requiredTurn(input.sessionId, input.clientTurnId),
				outbox,
			);
		});
	}

	terminalizeRecoveredInterruption(input: Readonly<{
		readonly sessionId: string;
		readonly clientTurnId: string;
		readonly message:
			| "turn interrupted during process restart"
			| "turn interrupted by runtime owner";
		readonly completedAt: string;
		readonly appendAbortMarker: boolean;
	}>): StoredTurnTerminalization {
		return this.#writeTransaction(() => this.#fail({
			kind: "failed",
			sessionId: input.sessionId,
			clientTurnId: input.clientTurnId,
			code: "interrupted",
			message: input.message,
			completedAt: input.completedAt,
		}, {
			appendAbortMarker: input.appendAbortMarker,
			trustedMessage: input.message,
		}));
	}

	#complete(
		input: Extract<TerminalizeStoredTurnInput, { readonly kind: "completed" }>,
	): StoredTurnTerminalization {
		const turn = this.#requireRunningTurn(input.sessionId, input.clientTurnId);
		const durationMs = completedTurnDurationMs(turn, input.completedAt);
		this.#appendEvent(parseTranscriptEventAppendInput({
			schemaVersion: 1,
			sessionId: input.sessionId,
			eventId: semanticTranscriptEventId(turn.turn_id, "assistant"),
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
		this.#failpoint("complete_after_assistant");
		if (durationMs !== undefined) {
			this.#appendDisplay({
				schemaVersion: 1,
				sessionId: input.sessionId,
				eventId: turnCompletedDurationId(turn.turn_id),
				turnId: turn.turn_id,
				eventType: "display_activity",
				modelVisible: false,
				createdAt: input.completedAt,
				payload: {
					activityType: "turn_completed",
					status: "completed",
					metadata: { duration_ms: durationMs },
				},
			});
		}
		this.#failpoint("complete_after_display");
		const outbox = this.#appendLifecycle(turn, "completed", input.completedAt, {
			usage: input.usage,
			...(input.lastTokenUsage ? {
				diagnostics: { last_token_usage: input.lastTokenUsage },
			} : {}),
		});
		this.#failpoint("complete_after_outbox");
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
		this.#failpoint("complete_after_turn");
		this.#touchSession(input.sessionId, input.completedAt);
		return terminalization(this.#requiredTurn(input.sessionId, input.clientTurnId), outbox);
	}

	#fail(
		input: Extract<TerminalizeStoredTurnInput, { readonly kind: "failed" }>,
		options: Readonly<{
			readonly appendAbortMarker: boolean;
			readonly trustedMessage?: string;
		}> = {
			appendAbortMarker: true,
		},
	): StoredTurnTerminalization {
		const turn = this.#requireRunningTurn(input.sessionId, input.clientTurnId);
		const status = input.code === "interrupted" ? "interrupted" : "failed";
		const failure = normalizeStoredTurnFailure(input);
		const terminalMessage = options.trustedMessage ?? failure.message;
		this.#providerAttemptLedger?.closeInterruptedTurn({
			sessionId: input.sessionId, turnId: turn.turn_id, observedAt: input.completedAt,
		});
		const attempts = new Map(this.#effectLedger?.recoverInterruptedTools({
			sessionId: input.sessionId, turnId: turn.turn_id, completedAt: input.completedAt,
		}).map((attempt) => [attempt.externalId, attempt]));
		for (const call of this.#loadPendingToolCalls(input.sessionId, turn.turn_id)) {
			this.#appendSyntheticToolResult(turn, call, status, input.completedAt, attempts.get(call.callId));
		}
		this.#failpoint("failure_after_tools");
		if (status === "interrupted") {
			if (options.appendAbortMarker) this.#appendTurnAborted(turn, input.completedAt);
			this.#appendInterruptedDisplay(turn, input.completedAt, failure.errorContext, input.interruptionReason);
		} else {
			this.#appendFailedDisplay(
				turn,
				input.code,
				input.completedAt,
				failure.message,
				failure.additionalDetails,
				failure.errorContext,
			);
		}
		this.#failpoint("failure_after_display");
		const outbox = this.#appendLifecycle(turn, status, input.completedAt, {
			errorCode: input.code,
			...(input.interruptionReason ? { interruptionReason: input.interruptionReason } : {}),
			message: terminalMessage,
			...(failure.errorContext ? { errorContext: failure.errorContext } : {}),
			...(failure.additionalDetails ? { additionalDetails: failure.additionalDetails } : {}),
			...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
		});
		this.#failpoint("failure_after_outbox");
		this.#database.prepare(`
			UPDATE runtime_turns
			SET status = ?, error_code = ?, result_json = ?, completed_at = ?,
				owner_id = NULL, owner_pid = NULL
			WHERE session_id = ? AND client_turn_id = ? AND status = 'in_progress'
		`).run(
			status,
			input.code,
			stableJson({
				message: terminalMessage,
				...(input.interruptionReason ? { interruption_reason: input.interruptionReason } : {}),
				...(failure.errorContext ? { error_context: failure.errorContext } : {}),
				...(failure.additionalDetails
					? { additional_details: failure.additionalDetails }
					: {}),
				...(input.diagnostics && Object.keys(input.diagnostics).length > 0
					? { diagnostics: input.diagnostics }
					: {}),
			}),
			input.completedAt,
			input.sessionId,
			input.clientTurnId,
		);
		this.#failpoint("failure_after_turn");
		this.#touchSession(input.sessionId, input.completedAt);
		return terminalization(this.#requiredTurn(input.sessionId, input.clientTurnId), outbox);
	}

	#appendSyntheticToolResult(
		turn: RuntimeTurnRecord,
		call: CanonicalToolCall,
		status: "failed" | "interrupted",
		createdAt: string,
		attempt?: AgentEffectAttempt,
	): void {
		const interrupted = status === "interrupted";
		this.#appendEvent(parseTranscriptEventAppendInput({
			schemaVersion: 1,
			sessionId: turn.session_id,
			eventId: semanticTranscriptEventId(turn.turn_id, "tool-result", call.callId),
			turnId: turn.turn_id,
			eventType: "tool_result",
			modelVisible: true,
			createdAt,
			payload: attempt ? interruptedToolResult(call, attempt, "Tool execution was interrupted.") : {
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
			},
		}));
	}

	#appendTurnAborted(turn: RuntimeTurnRecord, createdAt: string): void {
		const marker = turnAbortedContextItem(turn.turn_id);
		this.#appendEvent(parseTranscriptEventAppendInput({
			schemaVersion: 1,
			sessionId: turn.session_id,
			eventId: semanticTranscriptEventId(turn.session_id, "context", marker.itemId),
			eventType: "context",
			modelVisible: true,
			createdAt,
			payload: {
				itemId: marker.itemId,
				text: marker.item.text,
				metadata: marker.item.metadata,
			},
		}));
	}

	#appendInterruptedDisplay(turn: RuntimeTurnRecord, createdAt: string, errorContext?: ErrorContext, interruptionReason?: TurnInterruptionReason): void {
		const eventId = turnInterruptedNoticeId(turn.turn_id);
		if (this.#eventExists(turn.session_id, eventId)) return;
		this.#appendDisplay({
			schemaVersion: 1,
			sessionId: turn.session_id,
			eventId,
			turnId: turn.turn_id,
			eventType: "display_activity",
			modelVisible: false,
			createdAt,
			payload: {
				activityType: "warning",
				text: turnInterruptionNotice(interruptionReason),
				status: "interrupted",
				metadata: {
					event_kind: "turn_interrupted",
					interrupted_turn_id: turn.turn_id,
					...(interruptionReason ? { interruption_reason: interruptionReason } : {}),
					status: "interrupted",
					...(errorContext ? { error_context: errorContext } : {}),
				},
			},
		});
	}

	#appendFailedDisplay(
		turn: RuntimeTurnRecord,
		code: RuntimeErrorCode,
		createdAt: string,
		message: string,
		additionalDetails?: string,
		errorContext?: ErrorContext,
	): void {
		const eventId = turnFailedNoticeId(turn.turn_id);
		if (this.#eventExists(turn.session_id, eventId)) return;
		this.#appendDisplay({
			schemaVersion: 1,
			sessionId: turn.session_id,
			eventId,
			turnId: turn.turn_id,
			eventType: "display_activity",
			modelVisible: false,
			createdAt,
			payload: {
				activityType: "error",
				text: turnFailureNotice(code, message, errorContext),
				status: "failed",
				metadata: {
					event_kind: "turn_failed",
					failed_turn_id: turn.turn_id,
					status: "failed",
					code,
					source: "runtime",
					...(errorContext ? { error_context: errorContext } : {}),
					...(additionalDetails ? { additional_details: additionalDetails } : {}),
				},
			},
		});
	}

	#appendDisplay(
		input: TranscriptEventAppendInput<"display_activity">,
	): TranscriptEventEnvelope<"display_activity"> {
		const event = this.#appendEvent(parseTranscriptEventAppendInput(input));
		if (event.eventType !== "display_activity") {
			throw new StorageFailure("display transcript event has an invalid type");
		}
		return event;
	}

	#appendLifecycle(
		turn: RuntimeTurnRecord,
		phase: "completed" | "failed" | "interrupted",
		createdAt: string,
		details: Readonly<Record<string, unknown>>,
	): TranscriptEventEnvelope<"turn_lifecycle"> {
		const event = this.#appendEvent(parseTranscriptEventAppendInput({
			schemaVersion: 1,
			sessionId: turn.session_id,
			eventId: semanticTranscriptEventId(turn.turn_id, "lifecycle", phase),
			turnId: turn.turn_id,
			eventType: "turn_lifecycle",
			modelVisible: false,
			createdAt,
			payload: { phase, ...details },
		}));
		if (event.eventType !== "turn_lifecycle") {
			throw new StorageFailure("turn lifecycle outbox event has an invalid type");
		}
		return event;
	}

	#eventExists(sessionId: string, eventId: string): boolean {
		return this.#database.prepare(`
			SELECT 1 FROM transcript_events
			WHERE session_id = ? AND event_id = ? LIMIT 1
		`).get(sessionId, eventId) !== undefined;
	}

	#touchSession(sessionId: string, timestamp: string): void {
		this.#database.prepare(`
			UPDATE sessions
			SET updated_at = ?, last_active_at = ?
			WHERE session_id = ?
		`).run(timestamp, timestamp, sessionId);
	}

	#requiredTurn(sessionId: string, clientTurnId: string): RuntimeTurnRecord {
		const row = this.#database.prepare(`
			SELECT ${RUNTIME_TURN_COLUMNS}
			FROM runtime_turns
			WHERE session_id = ? AND client_turn_id = ?
		`).get(sessionId, clientTurnId) as RuntimeTurnRow | undefined;
		if (!row) throw new StorageFailure("runtime turn does not exist");
		return runtimeTurn(row);
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
}

function terminalization(
	turn: RuntimeTurnRecord,
	outbox: TranscriptEventEnvelope<"turn_lifecycle">,
): StoredTurnTerminalization {
	if (outbox.payload.phase === "started") {
		throw new StorageFailure("terminal outbox event has a non-terminal phase");
	}
	return Object.freeze({ kind: outbox.payload.phase, turn, outbox });
}

function runtimeTurn(row: RuntimeTurnRow): RuntimeTurnRecord {
	return parseRuntimeTurnRecord({
		schema_version: 1,
		session_id: row.session_id,
		client_turn_id: row.client_turn_id,
		turn_id: row.turn_id,
		request_fingerprint: row.request_fingerprint,
		status: row.status,
		error_code: row.error_code,
		result: row.result_json === null ? null : parseResult(row.result_json),
		started_at: row.started_at,
		completed_at: row.completed_at,
	});
}

function parseResult(value: unknown): Readonly<Record<string, unknown>> {
	if (typeof value !== "string") throw new StorageFailure("invalid JSON in runtime_turns");
	try {
		const result = JSON.parse(value) as unknown;
		if (typeof result !== "object" || result === null || Array.isArray(result)) {
			throw new Error("invalid result");
		}
		return result as Readonly<Record<string, unknown>>;
	} catch {
		throw new StorageFailure("invalid JSON in runtime_turns");
	}
}

function completedTurnDurationMs(
	turn: RuntimeTurnRecord,
	completedAt: string,
): number | undefined {
	const startedAtMs = Date.parse(turn.started_at);
	const completedAtMs = Date.parse(completedAt);
	if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)
		|| completedAtMs < startedAtMs) return undefined;
	return Math.min(86_400_000, completedAtMs - startedAtMs);
}
