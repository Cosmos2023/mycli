import { parseRuntimeState } from "@mycli/contracts";
import type { RuntimeStateRecord, RuntimeTurnRecord } from "@mycli/contracts";
import type {
	CanonicalMessage,
	CanonicalToolCall,
	ProtocolId,
	ProviderUsage,
	ReasoningEffort,
} from "@mycli/core";
import type { AppendToolResultInput, RuntimeStateKey } from "@mycli/storage";

export interface ClarificationOption {
	readonly label: string;
	readonly description?: string;
}

export interface ClarificationSuspensionInput {
	readonly clientTurnId: string;
	readonly clientUserMessageId: string;
	readonly turnId: string;
	readonly userMessage: string;
	readonly providerProtocol: ProtocolId;
	readonly call: CanonicalToolCall;
	readonly remainingCalls: readonly CanonicalToolCall[];
	readonly conversation: readonly CanonicalMessage[];
	readonly assistantText: string;
	readonly responseId?: string;
	readonly usage: ProviderUsage;
	readonly modelOverride?: string;
	readonly reasoningEffort?: ReasoningEffort;
	readonly question: string;
	readonly options: readonly ClarificationOption[];
	readonly header: string;
	readonly multiSelect: boolean;
}

export interface PendingClarificationContinuation extends ClarificationSuspensionInput {
	readonly sessionId: string;
	readonly requestId: string;
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

export interface ClarificationContinuationStore {
	loadState(sessionId: string, key: RuntimeStateKey): unknown | undefined;
	loadTurn(sessionId: string, clientTurnId: string): RuntimeTurnRecord | undefined;
	loadConversation?(sessionId: string): readonly CanonicalMessage[];
	deleteState(sessionId: string, key: RuntimeStateKey): void;
	saveClarificationSuspension(input: SaveClarificationSuspensionInput): void;
	commitClarificationResponse(input: CommitClarificationResponseInput): void;
}

export interface ClarificationContinuationCoordinatorOptions {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly store: ClarificationContinuationStore;
	readonly clock: () => string;
}

export class ClarificationNotPendingError extends Error {
	readonly code = "clarification_not_pending" as const;

	constructor() {
		super("clarification_not_pending: no matching clarification is pending");
		this.name = "ClarificationNotPendingError";
	}
}

export class ClarificationContinuationCoordinator {
	readonly #sessionId: string;
	readonly #workspaceRoot: string;
	readonly #threadId: string;
	readonly #store: ClarificationContinuationStore;
	readonly #clock: () => string;

	constructor(options: ClarificationContinuationCoordinatorOptions) {
		this.#sessionId = nonEmpty(options.sessionId, "sessionId");
		this.#workspaceRoot = nonEmpty(options.workspaceRoot, "workspaceRoot");
		this.#threadId = nonEmpty(options.threadId, "threadId");
		this.#store = options.store;
		this.#clock = options.clock;
	}

	suspend(input: ClarificationSuspensionInput): PendingClarificationContinuation {
		const pending = freezePending({
			...input,
			sessionId: this.#sessionId,
			requestId: input.call.callId,
		});
		this.#store.saveClarificationSuspension({
			sessionId: this.#sessionId,
			workspaceRoot: this.#workspaceRoot,
			threadId: this.#threadId,
			suspendedTurn: suspendedTurnState(pending),
			turnRecord: {
				turn_id: pending.turnId,
				client_turn_id: pending.clientTurnId,
				client_user_message_id: pending.clientUserMessageId,
				user_message: pending.userMessage,
				status: "waiting_clarification",
				stop_reason: "clarification_required",
				updated_at: this.#clock(),
			},
		});
		return pending;
	}

	pending(): PendingClarificationContinuation | undefined {
		const raw = this.#store.loadState(this.#sessionId, "suspended_turn");
		if (raw === undefined) return undefined;
		const state = parseRuntimeState({ kind: "suspended_turn", version: 1, payload: raw });
		if (state.kind !== "suspended_turn" || state.payload.pending_clarification === undefined
			|| state.payload.pending_clarification === null) return undefined;
		const referencedConversation = state.payload.conversation.length === 0
			&& typeof state.payload.transcript_event_id === "string"
			? this.#store.loadConversation?.(this.#sessionId)
			: undefined;
		return pendingFromState(this.#sessionId, state, referencedConversation);
	}

	resolve(input: { readonly requestId: string; readonly response: string }): {
		readonly continuation: PendingClarificationContinuation;
		readonly response: string;
	} {
		const requestId = nonEmpty(input.requestId, "requestId");
		const response = boundedResponse(input.response);
		const pending = this.pending();
		if (!pending || pending.requestId !== requestId) throw new ClarificationNotPendingError();
		const turn = this.#store.loadTurn(this.#sessionId, pending.clientTurnId);
		if (!turn || turn.status !== "in_progress") throw new ClarificationNotPendingError();
		this.#store.commitClarificationResponse({
			sessionId: this.#sessionId,
			requestId,
			display: {
				...(pending.header ? { header: pending.header } : {}),
				question: pending.question,
				response,
				multiSelect: pending.multiSelect,
			},
			toolResult: {
				sessionId: this.#sessionId,
				clientTurnId: pending.clientTurnId,
				result: {
					callId: pending.call.callId,
					toolName: pending.call.name,
					output: `User response: ${response}`,
					success: true,
				},
				summary: "User answered clarification",
				metadata: { request_id: requestId, source: "user" },
			},
		});
		return Object.freeze({ continuation: pending, response });
	}

	cancel(input: { readonly requestId: string }): PendingClarificationContinuation {
		const requestId = nonEmpty(input.requestId, "requestId");
		const pending = this.pending();
		if (!pending || pending.requestId !== requestId) throw new ClarificationNotPendingError();
		this.#store.deleteState(this.#sessionId, "suspended_turn");
		this.#store.deleteState(this.#sessionId, "turn_record");
		return pending;
	}
}

function suspendedTurnState(
	pending: PendingClarificationContinuation,
): Extract<RuntimeStateRecord, { kind: "suspended_turn" }> {
	return {
		kind: "suspended_turn",
		version: 1,
		payload: {
			user_message: pending.userMessage,
			conversation: pending.conversation.map((message) => ({ ...message })),
			suspend_reason: "clarification_required",
			pending_clarification: {
				request_id: pending.requestId,
				tool_call: storedToolCall(pending.call),
				question: pending.question,
				options: pending.options.map((option) => ({ ...option })),
				header: pending.header,
				multi_select: pending.multiSelect,
			},
			session_id: pending.sessionId,
			client_turn_id: pending.clientTurnId,
			client_user_message_id: pending.clientUserMessageId,
			turn_id: pending.turnId,
			provider_protocol: pending.providerProtocol,
			remaining_tool_calls: pending.remainingCalls.map(storedCanonicalCall),
			continuation: {
				assistant_text: pending.assistantText,
				response_id: pending.responseId ?? null,
				usage: pending.usage,
				model_override: pending.modelOverride ?? null,
				reasoning_effort: pending.reasoningEffort ?? null,
			},
		},
	};
}

function pendingFromState(
	sessionId: string,
	state: Extract<RuntimeStateRecord, { kind: "suspended_turn" }>,
	referencedConversation?: readonly CanonicalMessage[],
): PendingClarificationContinuation {
	const payload = state.payload;
	const clarification = payload.pending_clarification;
	if (!clarification || payload.session_id !== sessionId) throw new ClarificationNotPendingError();
	const continuation = record(payload.continuation);
	return freezePending({
		sessionId,
		requestId: clarification.request_id,
		clientTurnId: nonEmpty(String(payload.client_turn_id ?? ""), "clientTurnId"),
		clientUserMessageId: nonEmpty(
			String(payload.client_user_message_id ?? payload.client_turn_id ?? ""),
			"clientUserMessageId",
		),
		turnId: nonEmpty(String(payload.turn_id ?? ""), "turnId"),
		userMessage: payload.user_message,
		providerProtocol: protocol(payload.provider_protocol),
		call: canonicalCall(clarification.tool_call),
		remainingCalls: (payload.remaining_tool_calls ?? []).map((call) => canonicalStoredCall(record(call))),
		conversation: referencedConversation ?? payload.conversation.flatMap(
			(message): CanonicalMessage[] => message.role === "user" || message.role === "assistant"
				? [{ role: message.role, content: message.content }]
				: [],
		),
		assistantText: stringValue(continuation.assistant_text),
		...(optionalString(continuation.response_id) ? { responseId: optionalString(continuation.response_id) } : {}),
		usage: numericRecord(continuation.usage),
		...(optionalString(continuation.model_override) ? { modelOverride: optionalString(continuation.model_override) } : {}),
		...(reasoningEffort(continuation.reasoning_effort)
			? { reasoningEffort: reasoningEffort(continuation.reasoning_effort) }
			: {}),
		question: clarification.question,
		options: clarification.options.map((option) => clarificationOption(record(option))),
		header: clarification.header ?? "",
		multiSelect: clarification.multi_select,
	});
}

function freezePending(input: PendingClarificationContinuation): PendingClarificationContinuation {
	return Object.freeze({
		...input,
		call: Object.freeze({ ...input.call }),
		remainingCalls: Object.freeze(input.remainingCalls.map((call) => Object.freeze({ ...call }))),
		conversation: Object.freeze(input.conversation.map((message) => Object.freeze({ ...message }))),
		usage: Object.freeze({ ...input.usage }),
		options: Object.freeze(input.options.map((option) => Object.freeze({ ...option }))),
	});
}

function storedToolCall(call: CanonicalToolCall) {
	return {
		name: call.name,
		arguments: parseArguments(call.argumentsJson),
		reason: "",
		call_id: call.callId,
	};
}

function storedCanonicalCall(call: CanonicalToolCall) {
	return { call_id: call.callId, name: call.name, arguments_json: call.argumentsJson };
}

function canonicalCall(call: {
	readonly name: string;
	readonly arguments: Readonly<Record<string, unknown>>;
	readonly call_id: string;
}): CanonicalToolCall {
	return Object.freeze({
		callId: call.call_id,
		name: call.name,
		argumentsJson: JSON.stringify(call.arguments),
	});
}

function canonicalStoredCall(value: Readonly<Record<string, unknown>>): CanonicalToolCall {
	return Object.freeze({
		callId: nonEmpty(String(value.call_id ?? ""), "callId"),
		name: nonEmpty(String(value.name ?? ""), "toolName"),
		argumentsJson: nonEmpty(String(value.arguments_json ?? ""), "argumentsJson"),
	});
}

function clarificationOption(value: Readonly<Record<string, unknown>>): ClarificationOption {
	const label = nonEmpty(String(value.label ?? ""), "option label");
	const description = optionalString(value.description);
	return Object.freeze({ label, ...(description ? { description } : {}) });
}

function protocol(value: unknown): ProtocolId {
	if (value === "responses" || value === "chat_completions" || value === "anthropic_messages") return value;
	throw new ClarificationNotPendingError();
}

function reasoningEffort(value: unknown): ReasoningEffort | undefined {
	return value === "none" || value === "minimal" || value === "low" || value === "medium"
		|| value === "high" || value === "xhigh" || value === "max" || value === "ultra" ? value : undefined;
}

function boundedResponse(value: string): string {
	const response = nonEmpty(value, "response");
	if (response.length > 4_096) throw new TypeError("response exceeds 4096 characters");
	return response;
}

function parseArguments(value: string): Readonly<Record<string, unknown>> {
	try {
		return record(JSON.parse(value) as unknown);
	} catch {
		return {};
	}
}

function numericRecord(value: unknown): ProviderUsage {
	return Object.freeze(Object.fromEntries(Object.entries(record(value)).flatMap(([key, item]) =>
		typeof item === "number" && Number.isFinite(item) && item >= 0 ? [[key, item]] : [])));
}

function record(value: unknown): Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Readonly<Record<string, unknown>>
		: {};
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function nonEmpty(value: string, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be non-empty`);
	return value.trim();
}
