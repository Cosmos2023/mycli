import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	decideCompaction,
	projectProviderRequest,
	type CanonicalConversationItem,
	type ProviderReplayState,
	type ProviderRequestConfig,
} from "@mycli/core";
import type { ModelProvider } from "@mycli/providers";
import type {
	CommitCompactionInput,
	RuntimeStateKey,
	SaveStateInput,
} from "@mycli/storage";
import { resolveReadableWorkspaceFile } from "@mycli/tools";
import { NO_RUNTIME_FAILPOINT } from "./fault-injection.ts";
import type { RuntimeFailpointHook } from "./fault-injection.ts";
import { TokenCounter } from "./token-counter.ts";

const SUMMARY_PROMPT = [
	"CRITICAL: Respond with TEXT ONLY.",
	"Do not call tools, continue the task, or ask for confirmation.",
	"Summarize the supplied conversation for a coding agent that must continue the work.",
	"Preserve the primary request, decisions, files examined or edited, errors and fixes,",
	"all user instructions, pending tasks, and the exact current work state.",
].join(" ");

const MAX_REHYDRATION_FILE_BYTES = 1_000_000;
const EXCLUDED_REHYDRATION_PREFIXES = Object.freeze([
	".mycli/",
	".omx/",
	".trellis/",
	"docs/superpowers/plans/",
]);

export interface CompactionCoordinatorStore {
	loadState(sessionId: string, key: RuntimeStateKey): unknown | undefined;
	saveState(input: SaveStateInput): void;
	deleteState(sessionId: string, key: RuntimeStateKey): void;
	loadHistoryItems(sessionId: string): readonly Readonly<Record<string, unknown>>[];
	commitCompaction(input: CommitCompactionInput): void;
}

export interface CompactionSummaryInput {
	readonly items: readonly CanonicalConversationItem[];
	readonly instruction: string;
	readonly model?: string;
	readonly maxOutputTokens: number;
	readonly fingerprint: string;
	readonly signal: AbortSignal;
}

export async function summarizeCompactionWithProvider(
	provider: ModelProvider,
	config: ProviderRequestConfig,
	input: Pick<
		CompactionSummaryInput,
		"items" | "instruction" | "model" | "maxOutputTokens" | "signal"
	>,
): Promise<string> {
	assertNotAborted(input.signal);
	const request = projectProviderRequest({
		config: {
			provider: config.provider,
			protocol: config.protocol,
			model: input.model ?? config.model,
			reasoningEffort: "none",
			maxOutputTokens: input.maxOutputTokens,
			...(config.sessionId === undefined ? {} : { sessionId: config.sessionId }),
			...(config.cacheRetention === undefined ? {} : { cacheRetention: config.cacheRetention }),
		},
		instructions: input.instruction,
		history: input.items,
		tools: [],
	});
	let text = "";
	let completed = false;
	for await (const event of provider.stream(request, { signal: input.signal })) {
		assertNotAborted(input.signal);
		if (completed) throw new Error("compaction summary provider emitted after completion");
		switch (event.type) {
			case "text_delta":
				text += event.text;
				break;
			case "tool_call":
				throw new Error("compaction summary provider returned a tool call");
			case "completed":
				completed = true;
				break;
			case "reasoning_delta":
			case "usage":
				break;
		}
	}
	if (!completed) throw new Error("compaction summary provider ended without completion");
	if (!text.trim()) throw new Error("compaction summary provider returned empty text");
	return text.trim();
}

export type CompactionRuntimeEvent =
	| {
		readonly type: "compaction_started";
		readonly clientTurnId: string;
		readonly source: CompactionSource;
		readonly beforeTokens: number;
		readonly maxTokens: number;
	}
	| {
		readonly type: "compaction_completed";
		readonly clientTurnId: string;
		readonly source: CompactionSource;
		readonly status: "compressed" | "skipped" | "failed";
		readonly beforeTokens: number;
		readonly afterTokens: number;
		readonly maxTokens: number;
		readonly durationSeconds: number;
	};

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
	readonly baseContext?: string;
	readonly tokenLimit: number;
	readonly reservedOutputTokens: number;
	readonly triggerRatio?: number;
	readonly tailTurns: number;
	readonly tailMaxTokens: number;
	readonly minSavingsRatio?: number;
	readonly summaryMaxTokens: number;
	readonly summaryModel?: string;
	readonly rehydrationMaxFiles: number;
	readonly rehydrationMaxItemTokens: number;
	readonly rehydrationMaxTotalTokens: number;
	readonly summarize: (input: CompactionSummaryInput) => Promise<string>;
	readonly createCheckpointId: () => string;
	readonly clock: () => string;
	readonly monotonicClock?: () => number;
	readonly failpoint?: RuntimeFailpointHook;
}

export interface CompactInput {
	readonly clientTurnId: string;
	readonly turnId: string;
	readonly source: CompactionSource;
	readonly conversation: readonly CanonicalConversationItem[];
	readonly freshItemIds: ReadonlySet<string>;
	readonly emit: (event: CompactionRuntimeEvent) => void;
	readonly signal: AbortSignal;
}

export interface CompactionResult {
	readonly status: "not_needed" | "compressed" | "skipped" | "failed" | "interrupted";
	readonly providerConversation: readonly CanonicalConversationItem[];
	readonly rehydration: readonly RehydratedFile[];
	readonly beforeTokens: number;
	readonly afterTokens: number;
}

interface CompletedTurn {
	readonly startIndex: number;
	readonly user: Extract<CanonicalConversationItem, { readonly type: "user" }>;
	readonly assistant: Extract<CanonicalConversationItem, { readonly type: "assistant" }>;
}

interface CompactionSelection {
	readonly summaryItems: readonly CanonicalConversationItem[];
	readonly exactTail: readonly CanonicalConversationItem[];
	readonly freshSuffix: readonly CanonicalConversationItem[];
	readonly summaryPlacement: "before_retained" | "after_retained";
}

interface FileCandidate {
	readonly path: string;
	readonly kind: "edit" | "read";
	readonly sequence: number;
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
		const baseTokens = this.#tokenCounter.count(this.#options.baseContext ?? "");
		const beforeTokens = baseTokens + countItems(this.#tokenCounter, input.conversation);
		const checkpointState = this.#checkpointState();
		if (checkpointState.interrupted) {
			return result("interrupted", input.conversation, beforeTokens);
		}
		const selection = this.#select(input.conversation, input.freshItemIds, input.source);
		const freshSuffixTokens = countItems(this.#tokenCounter, selection.freshSuffix);
		const decision = decideCompaction({
			usedTokens: beforeTokens,
			tokenLimit: this.#options.tokenLimit,
			reservedOutputTokens: this.#options.reservedOutputTokens,
			freshSuffixTokens,
			triggerRatio: this.#options.triggerRatio ?? 1,
		});
		const shouldCompact = input.source === "context_overflow" || input.source === "user_requested"
			? beforeTokens > freshSuffixTokens
			: decision.shouldCompact;
		if (!shouldCompact || selection.summaryItems.length === 0) {
			return result("not_needed", input.conversation, beforeTokens);
		}
		if (selection.exactTail.length === 0 && !isActiveTurnCompaction(input.source)) {
			return result("skipped", input.conversation, beforeTokens);
		}
		const rawHistory = this.#options.store.loadHistoryItems(this.#options.sessionId);

		const startedAt = this.#options.monotonicClock?.() ?? performance.now();
		input.emit({
			type: "compaction_started",
			clientTurnId: input.clientTurnId,
			source: input.source,
			beforeTokens,
			maxTokens: this.#options.tokenLimit,
		});
		const checkpointId = this.#options.createCheckpointId();
		const inputHash = hashItems(input.conversation);
		const summaryFingerprint = hashValue({
			session_id: this.#options.sessionId,
			turn_id: input.turnId,
			source: input.source,
			items: selection.summaryItems,
			instruction: SUMMARY_PROMPT,
			model: this.#options.summaryModel ?? null,
			max_output_tokens: this.#options.summaryMaxTokens,
		});
		this.#options.store.saveState({
			sessionId: this.#options.sessionId,
			workspaceRoot: this.#options.workspaceRoot,
			threadId: this.#options.threadId,
			key: "compact_checkpoint",
			payload: checkpointPayload({
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
			}),
		});

		let summary: string;
		try {
			summary = (await this.#options.summarize({
				items: selection.summaryItems,
				instruction: SUMMARY_PROMPT,
				...(this.#options.summaryModel ? { model: this.#options.summaryModel } : {}),
				maxOutputTokens: this.#options.summaryMaxTokens,
				fingerprint: summaryFingerprint,
				signal: input.signal,
			})).trim();
			assertNotAborted(input.signal);
			if (!summary || this.#tokenCounter.count(summary) > this.#options.summaryMaxTokens) {
				throw new CompactionSummaryError();
			}
		} catch (error) {
			this.#options.store.deleteState(this.#options.sessionId, "compact_checkpoint");
			input.emit(this.#completedEvent(
				input,
				"failed",
				beforeTokens,
				beforeTokens,
				startedAt,
			));
			return result(
				input.signal.aborted || isAbortError(error) ? "interrupted" : "failed",
				input.conversation,
				beforeTokens,
			);
		}
		this.#failpoint("compaction_after_summary_request");

		const summaryItem = { type: "user", text: `[compact-summary]\n${summary}` } as const;
		const retainedConversation = Object.freeze([
			...selection.exactTail,
			...selection.freshSuffix,
		]);
		const storedConversation = Object.freeze(selection.summaryPlacement === "after_retained"
			? [...retainedConversation, summaryItem]
			: [summaryItem, ...retainedConversation]);
		const rehydration = isActiveTurnCompaction(input.source)
			? Object.freeze([])
			: await this.#rehydrate(rawHistory, selection.exactTail, input.signal);
		const rehydrationInsertionIndex = selection.summaryPlacement === "after_retained"
			? 0
			: storedConversation.length - selection.freshSuffix.length;
		const providerConversation = injectRehydration(
			storedConversation,
			rehydration,
			rehydrationInsertionIndex,
		);
		const afterTokens = baseTokens + countItems(this.#tokenCounter, providerConversation);
		const savingsRatio = beforeTokens === 0 ? 0 : (beforeTokens - afterTokens) / beforeTokens;
		if (savingsRatio < (this.#options.minSavingsRatio ?? 0)) {
			this.#options.store.deleteState(this.#options.sessionId, "compact_checkpoint");
			input.emit(this.#completedEvent(
				input,
				"skipped",
				beforeTokens,
				beforeTokens,
				startedAt,
			));
			return result("skipped", input.conversation, beforeTokens);
		}

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
			retainedTailMessages: selection.exactTail.map(toStoredMessage),
			freshSuffixCount: selection.freshSuffix.length,
			rehydration,
			status: "completed",
			summaryFingerprint,
			updatedAt: this.#options.clock(),
		});
		this.#options.store.commitCompaction({
			sessionId: this.#options.sessionId,
			replacementMessages,
			replacementItems: storedConversation,
			summary,
			checkpoint,
		});

		input.emit(this.#completedEvent(
			input,
			"compressed",
			beforeTokens,
			afterTokens,
			startedAt,
		));
		return Object.freeze({
			status: "compressed",
			providerConversation,
			rehydration,
			beforeTokens,
			afterTokens,
		});
	}

	#checkpointState(): { readonly interrupted: boolean; readonly windowNumber: number } {
		const state = this.#options.store.loadState(
			this.#options.sessionId,
			"compact_checkpoint",
		);
		if (isRecord(state) && state.status === "in_progress") {
			this.#options.store.deleteState(this.#options.sessionId, "compact_checkpoint");
			return { interrupted: true, windowNumber: 1 };
		}
		const previousWindow = isRecord(state)
			&& typeof state.window_number === "number"
			&& Number.isSafeInteger(state.window_number)
			&& state.window_number >= 0
			&& state.window_number < Number.MAX_SAFE_INTEGER
			? state.window_number
			: 0;
		return { interrupted: false, windowNumber: previousWindow + 1 };
	}

	#select(
		conversation: readonly CanonicalConversationItem[],
		freshItemIds: ReadonlySet<string>,
		source: CompactionSource,
	): CompactionSelection {
		if (isActiveTurnCompaction(source)) {
			// Completed tool phases can be summarized; keep real user intent exact for continuation.
			return Object.freeze({
				summaryItems: conversation,
				exactTail: Object.freeze([]),
				freshSuffix: retainRecentUserMessages(
					conversation,
					this.#tokenCounter,
					this.#options.tailMaxTokens,
				),
				summaryPlacement: "after_retained",
			});
		}
		const freshCount = this.#freshSuffixCount(freshItemIds);
		if (freshCount > conversation.length) {
			throw new RangeError("fresh suffix exceeds provider conversation");
		}
		const priorLength = conversation.length - freshCount;
		const prior = conversation.slice(0, priorLength);
		const freshSuffix = conversation.slice(priorLength);
		const completed = completedTurns(prior);
		let retained = this.#options.tailTurns === 0
			? []
			: completed.slice(-this.#options.tailTurns);
		while (retained.length > 1 && countTurns(this.#tokenCounter, retained)
			> this.#options.tailMaxTokens) {
			retained = retained.slice(1);
		}
		if (retained.length === 0) {
			return Object.freeze({
				summaryItems: prior,
				exactTail: Object.freeze([]),
				freshSuffix,
				summaryPlacement: "before_retained",
			});
		}
		const firstTailIndex = retained[0]!.startIndex;
		if (firstTailIndex === 0) {
			return Object.freeze({
				summaryItems: Object.freeze([]),
				exactTail: retained.flatMap((turn) => [turn.user, turn.assistant]),
				freshSuffix,
				summaryPlacement: "before_retained",
			});
		}
		return Object.freeze({
			summaryItems: prior.slice(0, firstTailIndex),
			exactTail: Object.freeze(retained.flatMap((turn) => [turn.user, turn.assistant])),
			freshSuffix,
			summaryPlacement: "before_retained",
		});
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

	async #rehydrate(
		history: readonly Readonly<Record<string, unknown>>[],
		tail: readonly CanonicalConversationItem[],
		signal: AbortSignal,
	): Promise<readonly RehydratedFile[]> {
		const candidates = fileCandidates(history);
		const tailText = renderItems(tail);
		let remaining = this.#options.rehydrationMaxTotalTokens;
		const files: RehydratedFile[] = [];
		for (const candidate of candidates) {
			if (files.length >= this.#options.rehydrationMaxFiles || remaining <= 0) break;
			assertNotAborted(signal);
			const normalizedPath = candidate.path.replaceAll("\\", "/").replace(/^\.\//, "");
			if (isExcludedRehydrationPath(normalizedPath)) continue;
			let content: string;
			try {
				const target = await resolveReadableWorkspaceFile(
					this.#options.workspaceRoot,
					normalizedPath,
				);
				const bytes = await readFile(target);
				if (bytes.length > MAX_REHYDRATION_FILE_BYTES || bytes.includes(0)) continue;
				content = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
			} catch {
				continue;
			}
			if (!content || tailText.includes(content)) continue;
			const budget = Math.min(this.#options.rehydrationMaxItemTokens, remaining);
			const bounded = truncateToTokens(content, budget, this.#tokenCounter);
			if (!bounded.content || bounded.tokens === 0) continue;
			files.push(Object.freeze({
				path: normalizedPath,
				content: bounded.content,
				tokens: bounded.tokens,
				truncated: bounded.truncated,
			}));
			remaining -= bounded.tokens;
		}
		return Object.freeze(files);
	}

	#completedEvent(
		input: CompactInput,
		status: "compressed" | "skipped" | "failed",
		beforeTokens: number,
		afterTokens: number,
		startedAt: number,
	): Extract<CompactionRuntimeEvent, { readonly type: "compaction_completed" }> {
		const finishedAt = this.#options.monotonicClock?.() ?? performance.now();
		return {
			type: "compaction_completed",
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

class CompactionSummaryError extends Error {}

function validateOptions(options: CompactionCoordinatorOptions): CompactionCoordinatorOptions {
	positiveSafeInteger(options.tokenLimit, "tokenLimit");
	nonNegativeSafeInteger(options.reservedOutputTokens, "reservedOutputTokens");
	if (options.reservedOutputTokens >= options.tokenLimit) {
		throw new RangeError("reservedOutputTokens must be below tokenLimit");
	}
	nonNegativeSafeInteger(options.tailTurns, "tailTurns");
	nonNegativeSafeInteger(options.tailMaxTokens, "tailMaxTokens");
	positiveSafeInteger(options.summaryMaxTokens, "summaryMaxTokens");
	nonNegativeSafeInteger(options.rehydrationMaxFiles, "rehydrationMaxFiles");
	nonNegativeSafeInteger(options.rehydrationMaxItemTokens, "rehydrationMaxItemTokens");
	nonNegativeSafeInteger(options.rehydrationMaxTotalTokens, "rehydrationMaxTotalTokens");
	if (options.rehydrationMaxItemTokens > options.rehydrationMaxTotalTokens) {
		throw new RangeError("rehydrationMaxItemTokens cannot exceed total tokens");
	}
	for (const [name, value] of [
		["triggerRatio", options.triggerRatio ?? 1],
		["minSavingsRatio", options.minSavingsRatio ?? 0],
	] as const) {
		if (!Number.isFinite(value) || value < 0 || value > 1) {
			throw new RangeError(`${name} must be between 0 and 1`);
		}
	}
	return options;
}

function completedTurns(items: readonly CanonicalConversationItem[]): readonly CompletedTurn[] {
	const userIndexes = items.flatMap((item, index) => item.type === "user" ? [index] : []);
	const completed: CompletedTurn[] = [];
	for (const [offset, startIndex] of userIndexes.entries()) {
		const endIndex = userIndexes[offset + 1] ?? items.length;
		const assistant = items.slice(startIndex + 1, endIndex).findLast(
			(item): item is Extract<CanonicalConversationItem, { readonly type: "assistant" }> =>
				item.type === "assistant" && Boolean(item.text.trim()),
		);
		const user = items[startIndex];
		if (user?.type === "user" && assistant) {
			completed.push(Object.freeze({ startIndex, user, assistant }));
		}
	}
	return Object.freeze(completed);
}

function countTurns(counter: TokenCounter, turns: readonly CompletedTurn[]): number {
	return turns.reduce(
		(total, turn) => total + countItems(counter, [turn.user, turn.assistant]),
		0,
	);
}

function countItems(counter: TokenCounter, items: readonly CanonicalConversationItem[]): number {
	return items.reduce((total, item) => {
		const providerState = item.type === "assistant" || item.type === "assistant_tool_calls"
			? item.providerState
			: undefined;
		return total + counter.count(renderItem(item))
			+ (providerState ? countProviderReplayState(counter, providerState) : 0);
	}, 0);
}

const OPAQUE_PROVIDER_STATE_KEYS = new Set([
	"encrypted_content",
	"encryptedContent",
	"signature",
]);

function countProviderReplayState(counter: TokenCounter, state: ProviderReplayState): number {
	if (state.tokenEstimate !== undefined
		&& Number.isSafeInteger(state.tokenEstimate)
		&& state.tokenEstimate >= 0) {
		return state.tokenEstimate;
	}
	return counter.count(JSON.stringify(withoutOpaqueProviderState(state.value)));
}

function withoutOpaqueProviderState(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutOpaqueProviderState);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => (
		OPAQUE_PROVIDER_STATE_KEYS.has(key)
			? []
			: [[key, withoutOpaqueProviderState(entry)]]
	)));
}

function isActiveTurnCompaction(source: CompactionSource): boolean {
	return source === "mid_turn" || source === "context_overflow";
}

function retainRecentUserMessages(
	items: readonly CanonicalConversationItem[],
	counter: TokenCounter,
	maxTokens: number,
): readonly CanonicalConversationItem[] {
	const userMessages = items.filter(
		(item): item is Extract<CanonicalConversationItem, { readonly type: "user" }> =>
			item.type === "user" && !item.text.startsWith("[compact-summary]\n"),
	);
	if (userMessages.length === 0) return Object.freeze([]);

	let remaining = maxTokens;
	const retained: CanonicalConversationItem[] = [];
	for (const message of userMessages.toReversed()) {
		const tokens = countItems(counter, [message]);
		if (retained.length === 0 || tokens <= remaining) {
			retained.push(message);
			remaining = Math.max(0, remaining - tokens);
		}
		if (remaining === 0) break;
	}
	return Object.freeze(retained.reverse());
}

function renderItems(items: readonly CanonicalConversationItem[]): string {
	return items.map(renderItem).join("\n");
}

function renderItem(item: CanonicalConversationItem): string {
	switch (item.type) {
		case "user":
		case "assistant":
			return `${item.type}: ${item.text}`;
		case "context":
			return `context ${item.metadata.kind}: ${item.text}`;
		case "assistant_tool_calls":
			return `assistant: ${item.text}\n${item.calls.map((call) =>
				`tool_call ${call.name} ${call.callId} ${call.argumentsJson}`).join("\n")}`;
		case "tool_result":
			return `tool ${item.toolName} ${item.callId}: ${item.output}`;
	}
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

function fileCandidates(
	history: readonly Readonly<Record<string, unknown>>[],
): readonly FileCandidate[] {
	const successfulCalls = new Set<string>();
	for (const item of history) {
		if (item.type !== "tool_result") continue;
		const metadata = recordValue(item.metadata);
		if (metadata.success !== false) {
			const callId = stringValue(item.call_id);
			if (callId) successfulCalls.add(callId);
		}
	}
	const edits: FileCandidate[] = [];
	const reads: FileCandidate[] = [];
	for (const [sequence, item] of history.entries()) {
		const toolName = stringValue(item.tool_name);
		const metadata = recordValue(item.metadata);
		if (item.type === "tool_result" && ["Edit", "Write", "Patch"].includes(toolName ?? "")) {
			const changes = Array.isArray(metadata.file_changes) ? metadata.file_changes : [];
			for (const change of changes) {
				const path = stringValue(recordValue(change).path);
				if (path) edits.push({ path, kind: "edit", sequence });
			}
		}
		if (item.type === "tool_call" && toolName === "Read") {
			const callId = stringValue(item.call_id);
			if (!callId || !successfulCalls.has(callId)) continue;
			const path = stringValue(recordValue(metadata.arguments).file_path);
			if (path) reads.push({ path, kind: "read", sequence });
		}
	}
	const ordered = [
		...edits.sort((left, right) => right.sequence - left.sequence),
		...reads.sort((left, right) => right.sequence - left.sequence),
	];
	const seen = new Set<string>();
	return Object.freeze(ordered.filter((candidate) => {
		const normalized = candidate.path.replaceAll("\\", "/");
		if (seen.has(normalized)) return false;
		seen.add(normalized);
		return true;
	}));
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

function injectRehydration(
	conversation: readonly CanonicalConversationItem[],
	files: readonly RehydratedFile[],
	insertionIndex: number,
): readonly CanonicalConversationItem[] {
	if (files.length === 0) return conversation;
	if (!Number.isSafeInteger(insertionIndex)
		|| insertionIndex < 0
		|| insertionIndex > conversation.length) {
		throw new RangeError("rehydration insertion index is invalid");
	}
	const text = [
		"[Compaction file rehydration]",
		...files.flatMap((file) => [
			`### ${file.path}`,
			"```text",
			file.content,
			"```",
		]),
	].join("\n");
	return Object.freeze([
		...conversation.slice(0, insertionIndex),
		{ type: "user", text },
		...conversation.slice(insertionIndex),
	]);
}

function truncateToTokens(
	content: string,
	maxTokens: number,
	counter: TokenCounter,
): { readonly content: string; readonly tokens: number; readonly truncated: boolean } {
	if (maxTokens <= 0) return { content: "", tokens: 0, truncated: false };
	let bounded = content;
	let tokens = counter.count(bounded);
	let truncated = false;
	while (tokens > maxTokens && bounded) {
		truncated = true;
		bounded = bounded.slice(0, Math.max(1, Math.trunc(bounded.length * 0.8)));
		tokens = counter.count(bounded);
	}
	return { content: bounded.trimEnd(), tokens, truncated };
}

function isExcludedRehydrationPath(path: string): boolean {
	return EXCLUDED_REHYDRATION_PREFIXES.some((prefix) => path.startsWith(prefix));
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

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
	return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(value: unknown): boolean {
	return value instanceof Error && value.name === "AbortError";
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
