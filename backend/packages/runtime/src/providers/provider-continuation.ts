import { createHash } from "node:crypto";
import type {
	ProtocolId,
	ProviderRequestConfig,
	ToolDefinition,
} from "@mycli/core";
import { compareUnicodeCodePoints } from "../memory/memory-ordering.ts";

const MAX_CONTINUATION_ITEMS = 4096;

export interface PersistedProviderContinuation {
	readonly response_id: string | null;
	readonly request_signature: string;
	readonly request_input: readonly Readonly<Record<string, unknown>>[];
	readonly response_output: readonly Readonly<Record<string, unknown>>[];
	readonly eligible: boolean;
	readonly failure_reason: string | null;
	readonly session_id?: string;
	readonly protocol?: "responses";
	readonly model?: string;
	readonly history_boundary?: string;
}

export interface ContinuationInput {
	readonly protocol: ProtocolId;
	readonly persisted?: unknown;
	readonly requestSignature: string;
	readonly requestInput: readonly Readonly<Record<string, unknown>>[];
	readonly model: string;
	readonly historyBoundary: string;
}

export type ContinuationDecision =
	| { readonly kind: "responses_continuation"; readonly responseId: string }
	| {
		readonly kind: "canonical_replay";
		readonly reason:
			| "chat_replay"
			| "missing_state"
			| "malformed_state"
			| "ineligible"
			| "state_mismatch";
	};

export interface ProviderRequestSignatureInput extends ProviderRequestConfig {
	readonly instructions: string;
	readonly developerInstructions?: readonly string[];
	readonly tools: readonly ToolDefinition[];
	readonly instructionSnapshotSha256?: string;
	readonly toolSetSnapshotSha256?: string;
	readonly contextPrefixSha256?: string;
	readonly providerSemanticSha256?: string;
}

export interface ProviderContinuationCoordinatorOptions {
	readonly sessionId: string;
	readonly initialState?: unknown;
	readonly persist: (state: PersistedProviderContinuation) => void;
}

export interface SafeProviderCompletionInput {
	readonly protocol: ProtocolId;
	readonly responseId: string;
	readonly requestSignature: string;
	readonly requestInput: readonly Readonly<Record<string, unknown>>[];
	readonly responseOutput: readonly Readonly<Record<string, unknown>>[];
	readonly model: string;
	readonly historyBoundary: string;
}

export function selectProviderContinuation(input: ContinuationInput): ContinuationDecision {
	if (input.protocol !== "responses") {
		return { kind: "canonical_replay", reason: "chat_replay" };
	}
	if (input.persisted === undefined) {
		return { kind: "canonical_replay", reason: "missing_state" };
	}
	const persisted = parsePersistedContinuation(input.persisted);
	if (!persisted) {
		return { kind: "canonical_replay", reason: "malformed_state" };
	}
	if (!persisted.eligible) {
		return { kind: "canonical_replay", reason: "ineligible" };
	}
	if (persisted.request_signature !== input.requestSignature
		|| persisted.model !== input.model
		|| persisted.history_boundary !== input.historyBoundary) {
		return { kind: "canonical_replay", reason: "state_mismatch" };
	}
	if (!strictlyExtends(
		input.requestInput,
		[...persisted.request_input, ...persisted.response_output],
	)) {
		return { kind: "canonical_replay", reason: "state_mismatch" };
	}
	return { kind: "responses_continuation", responseId: persisted.response_id! };
}

export function buildProviderRequestSignature(input: ProviderRequestSignatureInput): string {
	const visible = {
		provider: input.provider,
		protocol: input.protocol,
		model: input.model,
		instructions: input.instructions,
		developer_instructions: input.developerInstructions ?? [],
		reasoning_effort: input.reasoningEffort ?? null,
		max_output_tokens: input.maxOutputTokens ?? null,
		session_id: input.sessionId ?? null,
		cache_retention: input.cacheRetention ?? null,
		web_search_mode: input.webSearchMode ?? "disabled",
		tools: input.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.inputSchema,
		})),
		instruction_snapshot_sha256: input.instructionSnapshotSha256 ?? null,
		tool_set_snapshot_sha256: input.toolSetSnapshotSha256 ?? null,
		provider_semantic_sha256: input.providerSemanticSha256 ?? null,
	};
	return `sha256:${createHash("sha256").update(stableJson(visible)).digest("hex")}`;
}

export class ProviderContinuationCoordinator {
	readonly #sessionId: string;
	readonly #persist: ProviderContinuationCoordinatorOptions["persist"];
	#state: PersistedProviderContinuation | undefined;
	#malformedInitial: boolean;

	constructor(options: ProviderContinuationCoordinatorOptions) {
		this.#sessionId = requiredText(options.sessionId);
		this.#persist = options.persist;
		const parsed = options.initialState === undefined
			? undefined
			: parsePersistedContinuation(options.initialState);
		const owned = parsed?.session_id === undefined || parsed.session_id === this.#sessionId;
		this.#state = owned ? parsed : undefined;
		this.#malformedInitial = options.initialState !== undefined && (!parsed || !owned);
	}

	select(input: Omit<ContinuationInput, "persisted">): ContinuationDecision {
		if (this.#malformedInitial) {
			this.#malformedInitial = false;
			this.#persistInvalid("malformed_state");
			return { kind: "canonical_replay", reason: "malformed_state" };
		}
		return selectProviderContinuation({ ...input, persisted: this.#state });
	}

	recordSafeCompletion(input: SafeProviderCompletionInput): void {
		if (input.protocol !== "responses") {
			this.invalidate("chat_replay");
			return;
		}
		if (input.requestInput.length > MAX_CONTINUATION_ITEMS
			|| input.responseOutput.length > MAX_CONTINUATION_ITEMS) {
			this.invalidate("continuation_input_too_large");
			return;
		}
		const state = freezeState({
			response_id: requiredText(input.responseId),
			request_signature: requiredText(input.requestSignature),
			request_input: copyRecords(input.requestInput),
			response_output: copyRecords(input.responseOutput),
			eligible: true,
			failure_reason: null,
			session_id: this.#sessionId,
			protocol: "responses",
			model: requiredText(input.model),
			history_boundary: requiredText(input.historyBoundary),
		});
		this.#persist(state);
		this.#state = state;
	}

	invalidate(reason: string): void {
		if (this.#state?.eligible === false) return;
		this.#persistInvalid(reason);
	}

	#persistInvalid(reason: string): void {
		this.#malformedInitial = false;
		const state = freezeState({
			response_id: null,
			request_signature: this.#state?.request_signature ?? "",
			request_input: Object.freeze([]),
			response_output: Object.freeze([]),
			eligible: false,
			failure_reason: requiredText(reason),
			session_id: this.#sessionId,
			protocol: "responses",
			...(this.#state?.model ? { model: this.#state.model } : {}),
			...(this.#state?.history_boundary
				? { history_boundary: this.#state.history_boundary }
				: {}),
		});
		this.#persist(state);
		this.#state = state;
	}

	snapshot(): PersistedProviderContinuation | undefined {
		return this.#state;
	}
}

function parsePersistedContinuation(value: unknown): PersistedProviderContinuation | undefined {
	if (!isRecord(value)
		|| !(value.response_id === null || isNonEmptyString(value.response_id))
		|| typeof value.request_signature !== "string"
		|| !isRecordArray(value.request_input)
		|| !isRecordArray(value.response_output)
		|| value.request_input.length > MAX_CONTINUATION_ITEMS
		|| value.response_output.length > MAX_CONTINUATION_ITEMS
		|| typeof value.eligible !== "boolean"
		|| !(value.failure_reason === null || typeof value.failure_reason === "string")) {
		return undefined;
	}
	if (value.eligible && (!isNonEmptyString(value.response_id)
		|| !isNonEmptyString(value.request_signature)
		|| value.protocol !== "responses"
		|| !isNonEmptyString(value.model)
		|| !isNonEmptyString(value.history_boundary))) {
		return undefined;
	}
	if (value.session_id !== undefined && !isNonEmptyString(value.session_id)) return undefined;
	if (value.protocol !== undefined && value.protocol !== "responses") return undefined;
	if (value.model !== undefined && !isNonEmptyString(value.model)) return undefined;
	if (value.history_boundary !== undefined && !isNonEmptyString(value.history_boundary)) {
		return undefined;
	}
	return freezeState({
		response_id: value.response_id,
		request_signature: value.request_signature,
		request_input: copyRecords(value.request_input),
		response_output: copyRecords(value.response_output),
		eligible: value.eligible,
		failure_reason: value.failure_reason,
		...(isNonEmptyString(value.session_id) ? { session_id: value.session_id } : {}),
		...(value.protocol === "responses" ? { protocol: value.protocol } : {}),
		...(isNonEmptyString(value.model) ? { model: value.model } : {}),
		...(isNonEmptyString(value.history_boundary)
			? { history_boundary: value.history_boundary }
			: {}),
	});
}

function strictlyExtends(
	value: readonly Readonly<Record<string, unknown>>[],
	prefix: readonly Readonly<Record<string, unknown>>[],
): boolean {
	if (value.length <= prefix.length) return false;
	return prefix.every((item, index) => stableJson(value[index]) === stableJson(item));
}

function freezeState(state: PersistedProviderContinuation): PersistedProviderContinuation {
	return Object.freeze({
		...state,
		request_input: copyRecords(state.request_input),
		response_output: copyRecords(state.response_output),
	});
}

function copyRecords(
	items: readonly Readonly<Record<string, unknown>>[],
): readonly Readonly<Record<string, unknown>>[] {
	return Object.freeze(items.map((item) => Object.freeze({ ...item })));
}

function stableJson(value: unknown): string {
	return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => compareUnicodeCodePoints(left, right))
			.map(([key, item]) => [key, sortJson(item)]),
	);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordArray(value: unknown): value is readonly Readonly<Record<string, unknown>>[] {
	return Array.isArray(value) && value.every(isRecord);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function requiredText(value: string): string {
	if (!value.trim()) throw new TypeError("continuation text fields must not be blank");
	return value;
}
