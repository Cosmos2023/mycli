import { createHash } from "node:crypto";
import {
	decideCompaction,
	type CanonicalConversationItem,
	type CompactionLimitScope,
	type ProviderUsage,
	type RuntimeEvent,
} from "@mycli/core";
import { parseRuntimeFailure, runtimeRetryStatusText, type RuntimeFailure } from "@mycli/contracts";
import { TRANSCRIPT_EVENT_MAX_BATCH_ITEMS } from "@mycli/storage";
import type {
	CommitCompactionInput,
	CompareAndSetStateInput,
	RuntimeStateKey,
} from "@mycli/storage";
import { ProviderFailure, providerFailureToRuntimeFailure } from "@mycli/providers";
import { NO_RUNTIME_FAILPOINT } from "../fault-injection.ts";
import type { RuntimeFailpointHook } from "../fault-injection.ts";
import { TokenCounter } from "./token-counter.ts";
import { countConversationTokens } from "./conversation-token-count.ts";
import {
	assertCompactionSummary, compactionSummaryInstruction, compactionSummaryItem,
	retainCompactionUserMessages,
} from "./compaction-summary.ts";
import { CompactionProviderError, type CompactionModelEvent } from "./compaction-model-executor.ts";
import { normalizeProviderAgentLoopFailure } from "../providers/provider-agent-loop.ts";

export { summarizeCompactionWithProvider } from "./compaction-model-executor.ts";

export interface CompactionCoordinatorStore {
	loadState(sessionId: string, key: RuntimeStateKey): unknown | undefined;
	compareAndSetState(input: CompareAndSetStateInput): boolean;
	loadHistoryItems(sessionId: string): readonly Readonly<Record<string, unknown>>[];
	commitCompaction(input: CommitCompactionInput): boolean;
}

export interface CompactionSummaryInput {
	readonly operationId: string;
	readonly recordEvent: (event: CompactionModelEvent) => Promise<void>;
	readonly reportRetry: (event: Extract<RuntimeEvent, { readonly type: "stream_retrying" }>) => void;
	readonly reportProgress?: (text: string) => void;
	readonly items: readonly CanonicalConversationItem[];
	readonly instruction: string;
	readonly model?: string;
	readonly baseInstructions: string;
	readonly developerInstructions?: readonly string[];
	readonly fingerprint: string;
	readonly signal: AbortSignal;
}

export type CompactionRuntimeEvent = Extract<RuntimeEvent, {
	readonly type: "compaction_started" | "compaction_progress" | "compaction_completed";
}>;

export interface CompactionModelEvidence {
	readonly operationId: string;
	readonly turnId: string;
	readonly fingerprint: string;
	readonly event: CompactionModelEvent | {
		readonly type: "failure";
		readonly failure: RuntimeFailure;
		readonly usage: ProviderUsage;
	};
}

export type CompactionSource = "pre_turn" | "mid_turn" | "context_overflow" | "user_requested";

export interface RehydratedFile {
	readonly path: string;
	readonly content: string;
	readonly tokens: number;
	readonly truncated: boolean;
}

export interface CompactionCoordinatorOptions {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly store: CompactionCoordinatorStore;
	readonly tokenCounter?: TokenCounter;
	readonly baseContext?: string | (() => string);
	readonly tokenLimit: number;
	readonly reservedOutputTokens: number;
	readonly limitScope?: CompactionLimitScope;
	readonly hardLimitTokens?: number;
	readonly triggerRatio?: number;
	readonly retainedUserMaxTokens?: number;
	readonly baseInstructions?: string;
	readonly developerInstructions?: readonly string[];
	readonly summaryModel?: string;
	readonly summarize: (input: CompactionSummaryInput) => Promise<string>;
	readonly recordModelEvent?: (input: CompactionModelEvidence) => boolean;
	readonly createCheckpointId: () => string;
	readonly clock: () => string;
	readonly monotonicClock?: () => number;
	readonly failpoint?: RuntimeFailpointHook;
}

export interface CompactInput {
	readonly operationId?: string;
	readonly clientTurnId: string;
	readonly turnId: string;
	readonly source: CompactionSource;
	readonly conversation: readonly CanonicalConversationItem[];
	readonly freshItemIds: ReadonlySet<string>;
	readonly emit: (event: CompactionRuntimeEvent) => void;
	readonly signal: AbortSignal;
}

export interface CompactionResult {
	readonly failure?: RuntimeFailure;
	readonly usage?: ProviderUsage;
	readonly status: "not_needed" | "compressed" | "skipped" | "failed" | "interrupted";
	readonly providerConversation: readonly CanonicalConversationItem[];
	readonly rehydration: readonly RehydratedFile[];
	readonly beforeTokens: number;
	readonly afterTokens: number;
}

interface CompactionSelection {
	readonly summaryItems: readonly CanonicalConversationItem[];
	readonly retainedUsers: readonly CanonicalConversationItem[];
	readonly freshSuffix: readonly CanonicalConversationItem[];
}

export class CompactionCoordinator {
	readonly #options: CompactionCoordinatorOptions;
	readonly #tokenCounter: TokenCounter;
	readonly #failpoint: RuntimeFailpointHook;

	constructor(options: CompactionCoordinatorOptions) {
		this.#options = validateOptions(options);
		this.#tokenCounter = options.tokenCounter ?? new TokenCounter();
		this.#failpoint = options.failpoint ?? NO_RUNTIME_FAILPOINT;
	}

	async compact(input: CompactInput): Promise<CompactionResult> {
		assertNotAborted(input.signal);
		const baseContext = typeof this.#options.baseContext === "function"
			? this.#options.baseContext()
			: this.#options.baseContext ?? "";
		if (typeof baseContext !== "string") {
			throw new TypeError("baseContext resolver must return a string");
		}
		const baseTokens = this.#tokenCounter.count(baseContext);
		const beforeTokens = baseTokens + countConversationTokens(this.#tokenCounter, input.conversation);
		const checkpointState = this.#checkpointState(input.turnId);
		if (checkpointState.interrupted) {
			return result("interrupted", input.conversation, beforeTokens);
		}
		const selection = this.#select(input.conversation, input.freshItemIds, input.source);
		const freshSuffixTokens = countConversationTokens(this.#tokenCounter, selection.freshSuffix);
		const decision = decideCompaction({
			usedTokens: beforeTokens,
			tokenLimit: this.#options.tokenLimit,
			reservedOutputTokens: this.#options.reservedOutputTokens,
			scope: this.#options.limitScope ?? "total",
			baseContextTokens: baseTokens,
			...(this.#options.hardLimitTokens === undefined
				? {}
				: { hardLimitTokens: this.#options.hardLimitTokens }),
			freshSuffixTokens,
			triggerRatio: this.#options.triggerRatio ?? 1,
		});
		const shouldCompact = input.source === "context_overflow" || input.source === "user_requested"
			? beforeTokens > freshSuffixTokens
			: decision.shouldCompact;
		if (!shouldCompact || selection.summaryItems.length === 0) {
			return result("not_needed", input.conversation, beforeTokens);
		}
		const rawHistory = this.#options.store.loadHistoryItems(this.#options.sessionId);

		const checkpointId = input.operationId ?? this.#options.createCheckpointId();
		const startedAt = this.#options.monotonicClock?.() ?? performance.now();
		const interruptedResult = (): CompactionResult => {
			input.emit(this.#completedEvent(input, checkpointId, "interrupted", beforeTokens, beforeTokens, startedAt));
			return result("interrupted", input.conversation, beforeTokens);
		};
		input.emit({
			type: "compaction_started",
			operationId: checkpointId,
			clientTurnId: input.clientTurnId,
			source: input.source,
			beforeTokens,
			maxTokens: this.#options.tokenLimit,
		});
		const inputHash = hashItems(input.conversation);
		const instruction = compactionSummaryInstruction();
		const summaryFingerprint = hashValue({
			session_id: this.#options.sessionId,
			turn_id: input.turnId,
			source: input.source,
			items: selection.summaryItems,
			instruction,
			model: this.#options.summaryModel ?? null,
			base_instructions: this.#options.baseInstructions ?? "",
			developer_instructions: this.#options.developerInstructions ?? [],
		});
		const pendingCheckpoint = checkpointPayload({
				turnId: input.turnId,
				source: input.source,
				checkpointId,
				windowNumber: checkpointState.windowNumber,
				historyItemCount: rawHistory.length,
				inputHash,
				replacementHash: inputHash,
				replacementMessages: Object.freeze([]),
				status: "in_progress",
				summaryFingerprint,
				updatedAt: this.#options.clock(),
		});
		if (!this.#replaceCheckpoint(checkpointState.payload, pendingCheckpoint)) {
			return interruptedResult();
		}
		const clearCheckpoint = (): boolean => this.#replaceCheckpoint(pendingCheckpoint,
			isRecord(checkpointState.payload) && checkpointState.payload.status === "completed"
				? checkpointState.payload : undefined);

		let summary: string;
		const attemptUsage = new Map<number, ProviderUsage>();
		const usage = (): ProviderUsage => {
			const totals: Record<string, number> = {};
			for (const value of attemptUsage.values()) {
				for (const [key, count] of Object.entries(value)) {
					if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
						totals[key] = (totals[key] ?? 0) + count;
					}
				}
			}
			return Object.freeze(totals);
		};
		const recordModelEvent = (event: CompactionModelEvidence["event"]): boolean => {
			return this.#options.recordModelEvent?.({ operationId: checkpointId, turnId: input.turnId,
				fingerprint: summaryFingerprint, event }) ?? true;
		};
		try {
			summary = (await this.#options.summarize({
				operationId: checkpointId,
				recordEvent: async (event) => {
					if (!recordModelEvent(event)) throw new DOMException("Compaction ownership changed", "AbortError");
					if (event.type === "usage") attemptUsage.set(event.attempt, event.usage);
				},
				reportRetry: (event) => {
					input.emit({ type: "compaction_progress", clientTurnId: input.clientTurnId,
						operationId: checkpointId,
						text: runtimeRetryStatusText(event.failureKind, event.attempt, event.maxRetries) });
				},
				reportProgress: (text) => input.emit({ type: "compaction_progress", clientTurnId: input.clientTurnId,
					operationId: checkpointId, text }),
				items: selection.summaryItems,
				instruction,
				...(this.#options.summaryModel ? { model: this.#options.summaryModel } : {}),
				baseInstructions: this.#options.baseInstructions ?? "",
				developerInstructions: this.#options.developerInstructions,
				fingerprint: summaryFingerprint,
				signal: input.signal,
			})).trim();
			assertNotAborted(input.signal);
			assertCompactionSummary(summary);
		} catch (error) {
			const failure = parseRuntimeFailure(input.signal.aborted
				? normalizeProviderAgentLoopFailure(error, input.signal)
				: error instanceof CompactionProviderError ? error.failure
					: error instanceof ProviderFailure ? providerFailureToRuntimeFailure(error, {
						errorContextVersion: 1, scope: { kind: "request", id: checkpointId },
					}) : normalizeProviderAgentLoopFailure(error, input.signal));
			const owned = recordModelEvent({ type: "failure", failure, usage: usage() });
			clearCheckpoint();
			input.emit({ ...this.#completedEvent(
				input, checkpointId,
				!owned || failure.code === "interrupted" ? "interrupted" : "failed",
				beforeTokens,
				beforeTokens,
				startedAt,
			), failure, usage: usage() });
			return { ...result(
				!owned || failure.code === "interrupted" ? "interrupted" : "failed",
				input.conversation,
				beforeTokens,
			), failure, usage: usage() };
		}
		this.#failpoint("compaction_after_summary_request");
		if (input.signal.aborted) {
			clearCheckpoint();
			return interruptedResult();
		}

		const storedConversation = Object.freeze([
			...selection.retainedUsers,
			compactionSummaryItem(summary),
			...selection.freshSuffix,
		]);
		const rehydration: readonly RehydratedFile[] = Object.freeze([]);
		const providerConversation = storedConversation;
		const afterTokens = baseTokens + countConversationTokens(this.#tokenCounter, providerConversation);
		assertNotAborted(input.signal);

		const replacementMessages = storedConversation.map(toStoredMessage);
		const replacementHash = hashItems(storedConversation);
		const checkpoint = checkpointPayload({
			turnId: input.turnId,
			source: input.source,
			checkpointId,
			windowNumber: checkpointState.windowNumber,
			historyItemCount: rawHistory.length,
			inputHash,
			replacementHash,
			replacementMessages,
			retainedTailMessages: selection.retainedUsers.map(toStoredMessage),
			freshSuffixCount: selection.freshSuffix.length,
			rehydration,
			status: "completed",
			summaryFingerprint,
			updatedAt: this.#options.clock(),
		});
		const committed = this.#options.store.commitCompaction({
			sessionId: this.#options.sessionId,
			expectedCheckpoint: pendingCheckpoint,
			replacementMessages,
			replacementItems: storedConversation,
			summary,
			checkpoint,
		});
		if (!committed) return interruptedResult();

		input.emit({ ...this.#completedEvent(
			input, checkpointId,
			"compressed",
			beforeTokens,
			afterTokens,
			startedAt,
		), usage: usage() });
		return Object.freeze({
			status: "compressed",
			providerConversation,
			rehydration,
			beforeTokens,
			afterTokens,
			usage: usage(),
		});
	}

	#replaceCheckpoint(expectedPayload: unknown, payload: unknown): boolean {
		return this.#options.store.compareAndSetState({
			sessionId: this.#options.sessionId,
			workspaceRoot: this.#options.workspaceRoot,
			threadId: this.#options.threadId,
			key: "compact_checkpoint",
			expectedPayload,
			payload,
		});
	}

	#checkpointState(turnId: string): {
		readonly interrupted: boolean;
		readonly windowNumber: number;
		readonly payload: unknown;
	} {
		const state = this.#options.store.loadState(
			this.#options.sessionId,
			"compact_checkpoint",
		);
		const previousWindow = isRecord(state)
			&& typeof state.window_number === "number"
			&& Number.isSafeInteger(state.window_number)
			&& state.window_number >= 0
			&& state.window_number < Number.MAX_SAFE_INTEGER
			? state.window_number
			: 0;
		return {
			interrupted: isRecord(state) && state.status === "in_progress" && state.turn_id === turnId,
			windowNumber: previousWindow + 1,
			payload: state,
		};
	}

	#select(
		conversation: readonly CanonicalConversationItem[],
		freshItemIds: ReadonlySet<string>,
		source: CompactionSource,
	): CompactionSelection {
		// A new turn has not executed yet: compact prior history, then append its fresh input.
		// Manual and in-turn compaction summarize the complete active window.
		const freshCount = source === "pre_turn" ? this.#freshSuffixCount(freshItemIds) : 0;
		if (freshCount > conversation.length) throw new RangeError("fresh suffix exceeds provider conversation");
		const priorLength = conversation.length - freshCount;
		const summaryItems = conversation.slice(0, priorLength);
		return {
			summaryItems,
			retainedUsers: retainCompactionUserMessages(summaryItems, this.#tokenCounter, this.#options.retainedUserMaxTokens)
				.slice(-Math.max(1, TRANSCRIPT_EVENT_MAX_BATCH_ITEMS - freshCount - 1)),
			freshSuffix: conversation.slice(priorLength),
		};
	}

	#freshSuffixCount(freshItemIds: ReadonlySet<string>): number {
		if (freshItemIds.size === 0) return 0;
		const history = this.#options.store.loadHistoryItems(this.#options.sessionId);
		const present = new Set<string>();
		let firstFreshIndex = -1;
		for (const [index, item] of history.entries()) {
			const id = stringValue(item.id);
			if (!id || !freshItemIds.has(id)) continue;
			present.add(id);
			if (firstFreshIndex < 0) firstFreshIndex = index;
		}
		if (present.size !== freshItemIds.size) {
			throw new RangeError("fresh history item IDs are not present");
		}
		return projectedHistoryItemCount(history.slice(firstFreshIndex));
	}

	#completedEvent(
		input: CompactInput,
		operationId: string,
		status: "compressed" | "skipped" | "failed" | "interrupted",
		beforeTokens: number,
		afterTokens: number,
		startedAt: number,
	): Extract<CompactionRuntimeEvent, { readonly type: "compaction_completed" }> {
		const finishedAt = this.#options.monotonicClock?.() ?? performance.now();
		return {
			type: "compaction_completed",
			operationId,
			clientTurnId: input.clientTurnId,
			source: input.source,
			status,
			beforeTokens,
			afterTokens,
			maxTokens: this.#options.tokenLimit,
			durationSeconds: Math.max(0, finishedAt - startedAt) / 1_000,
		};
	}
}

function validateOptions(options: CompactionCoordinatorOptions): CompactionCoordinatorOptions {
	positiveSafeInteger(options.tokenLimit, "tokenLimit");
	nonNegativeSafeInteger(options.reservedOutputTokens, "reservedOutputTokens");
	if (options.reservedOutputTokens >= options.tokenLimit) {
		throw new RangeError("reservedOutputTokens must be below tokenLimit");
	}
	if (options.limitScope !== undefined
		&& options.limitScope !== "total"
		&& options.limitScope !== "body_after_prefix") {
		throw new RangeError("limitScope must be 'total' or 'body_after_prefix'");
	}
	if (options.hardLimitTokens !== undefined) positiveSafeInteger(options.hardLimitTokens, "hardLimitTokens");
	if (options.retainedUserMaxTokens !== undefined) nonNegativeSafeInteger(options.retainedUserMaxTokens, "retainedUserMaxTokens");
	const ratio = options.triggerRatio ?? 1;
	if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new RangeError("triggerRatio must be between 0 and 1");
	return options;
}

function toStoredMessage(item: CanonicalConversationItem): Readonly<Record<string, unknown>> {
	switch (item.type) {
		case "user":
		case "assistant":
			return {
				role: item.type,
				content: item.text,
				tool_call_id: null,
				response_id: null,
				metadata: item.type === "user" && item.text.startsWith("[compact-summary]\n")
					? { compaction: true, source: "node_runtime" }
					: { source: "node_runtime" },
				blocks: [],
				tool_calls: [],
			};
		case "assistant_tool_calls":
			return {
				role: "assistant",
				content: item.text,
				tool_call_id: null,
				response_id: item.responseId ?? null,
				metadata: { source: "node_runtime" },
				blocks: item.calls.map((call) => ({
					type: "tool_call",
					text: null,
					tool_name: call.name,
					tool_arguments: parseArguments(call.argumentsJson),
					call_id: call.callId,
					provider_id: null,
					metadata: {},
				})),
				tool_calls: item.calls.map((call) => ({
					name: call.name,
					arguments: parseArguments(call.argumentsJson),
					reason: "model requested tool",
					call_id: call.callId,
				})),
			};
		case "tool_result":
			return {
				role: "tool",
				content: item.output,
				tool_call_id: item.callId,
				response_id: null,
				metadata: {
					source: "node_runtime",
					tool_name: item.toolName,
					success: item.success,
				},
				blocks: [],
				tool_calls: [],
			};
		case "context":
			return {
				role: "context",
				content: item.text,
				tool_call_id: null,
				response_id: null,
				metadata: {
					context: {
						kind: item.metadata.kind,
						...(item.metadata.role ? { role: item.metadata.role } : {}),
						cache_class: item.metadata.cacheClass,
						durability: item.metadata.durability,
						scope: item.metadata.scope,
						source_id: item.metadata.sourceId,
						content_sha256: item.metadata.contentSha256,
						content_length: item.metadata.contentLength,
					},
				},
				blocks: [],
				tool_calls: [],
			};
	}
}

function checkpointPayload(input: {
	readonly turnId: string;
	readonly source: CompactionSource;
	readonly checkpointId: string;
	readonly windowNumber: number;
	readonly historyItemCount: number;
	readonly inputHash: string;
	readonly replacementHash: string;
	readonly replacementMessages: readonly Readonly<Record<string, unknown>>[];
	readonly retainedTailMessages?: readonly Readonly<Record<string, unknown>>[];
	readonly freshSuffixCount?: number;
	readonly rehydration?: readonly RehydratedFile[];
	readonly status: "in_progress" | "completed";
	readonly summaryFingerprint: string;
	readonly updatedAt: string;
}): Readonly<Record<string, unknown>> {
	return {
		version: 1,
		turn_id: input.turnId,
		reason: "context_limit",
		phase: input.source,
		window_number: input.windowNumber,
		window_id: input.checkpointId,
		history_item_count: input.historyItemCount,
		input_history_hash: input.inputHash,
		replacement_history_hash: input.replacementHash,
		replacement_messages: input.replacementMessages,
		...(input.retainedTailMessages ? {
			retained_tail_messages: input.retainedTailMessages,
		} : {}),
		...(input.freshSuffixCount === undefined ? {} : {
			fresh_suffix_count: input.freshSuffixCount,
		}),
		...(input.rehydration ? {
			rehydration_items: input.rehydration.map((item) => ({ ...item })),
		} : {}),
		status: input.status,
		summary_request_fingerprint: input.summaryFingerprint,
		updated_at: input.updatedAt,
	};
}

function projectedHistoryItemCount(
	items: readonly Readonly<Record<string, unknown>>[],
): number {
	let count = 0;
	let inToolCallBatch = false;
	for (const item of items) {
		switch (item.type) {
			case "tool_call":
				if (!inToolCallBatch) count += 1;
				inToolCallBatch = true;
				break;
			case "user_message":
			case "assistant_message":
			case "tool_result":
				count += 1;
				inToolCallBatch = false;
				break;
			default:
				inToolCallBatch = false;
		}
	}
	return count;
}

function result(
	status: CompactionResult["status"],
	conversation: readonly CanonicalConversationItem[],
	tokens: number,
): CompactionResult {
	return Object.freeze({
		status,
		providerConversation: conversation,
		rehydration: Object.freeze([]),
		beforeTokens: tokens,
		afterTokens: tokens,
	});
}

function hashItems(items: readonly CanonicalConversationItem[]): string {
	return hashValue(items);
}

function hashValue(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function parseArguments(value: string): Readonly<Record<string, unknown>> {
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}
}

function nonNegativeSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${name} must be a non-negative safe integer`);
	}
}

function assertNotAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		const error = new Error("compaction interrupted");
		error.name = "AbortError";
		throw error;
	}
}
