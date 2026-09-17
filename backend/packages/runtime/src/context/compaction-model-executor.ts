import { createHash } from "node:crypto";
import type { NodeRuntimeConfig } from "@mycli/config";
import { parseRuntimeFailure, type ProviderAttemptUpdate, type RuntimeFailure } from "@mycli/contracts";
import { projectProviderRequest, stableModelInputJson, type CanonicalConversationItem, type ProviderUsage, type RuntimeEvent, type ReasoningEffort } from "@mycli/core";
import { ProviderFailure, type ModelProvider } from "@mycli/providers";
import { InProcessProviderStepExecutor, type ProviderStepExecutionInput } from "../providers/provider-step-executor.ts";
import { TokenCounter } from "./token-counter.ts";
import { countConversationTokens } from "./conversation-token-count.ts";
import { assertCompactionSummary, compactionSummaryHistory, removeOldestCompactionItem } from "./compaction-summary.ts";

const MIN_GENERATION_TOKENS = 16;

export interface CompactionRequestEvidence {
	readonly generation: number;
	readonly fingerprint: string;
	readonly maxOutputTokens?: number;
	readonly reasoningEffort: ReasoningEffort;
}

export type CompactionModelEvent = {
	readonly provider: string;
	readonly model: string;
	readonly request?: CompactionRequestEvidence;
} & (
	| { readonly type: "attempt"; readonly update: ProviderAttemptUpdate; readonly operationAttempt?: number }
	| { readonly type: "usage"; readonly attempt: number; readonly usage: ProviderUsage }
	| { readonly type: "recovery"; readonly message: string }
);

interface CompactionModelInput {
	readonly items: readonly CanonicalConversationItem[];
	readonly instruction: string;
	readonly model?: string;
	readonly baseInstructions: string;
	readonly developerInstructions?: readonly string[];
	readonly signal: AbortSignal;
	readonly operationId?: string;
	readonly recordEvent?: (event: CompactionModelEvent) => Promise<void>;
	readonly reportRetry?: (event: Extract<RuntimeEvent, { readonly type: "stream_retrying" }>) => void;
	readonly reportProgress?: (text: string) => void;
	readonly remainingTokenBudget?: () => number | undefined;
}

export class CompactionProviderError extends Error {
	readonly failure: RuntimeFailure;
	constructor(failure: RuntimeFailure) {
		const safe = parseRuntimeFailure(failure);
		super(safe.message);
		this.failure = safe;
		this.name = "CompactionProviderError";
	}
}

export async function summarizeCompactionWithProvider(
	provider: ModelProvider,
	config: NodeRuntimeConfig,
	input: CompactionModelInput,
	options: Pick<ProviderStepExecutionInput, "sleep" | "random" | "clock" | "recordDiagnostic"> = {},
): Promise<string> {
	input.signal.throwIfAborted();
	const capabilities = await provider.resolveCapabilities?.();
	const reasoningEffort = config.reasoningEffort;
	const counter = new TokenCounter({ maxCache: 0 });
	const contextLimit = capabilities?.contextWindowTokens ?? config.modelContextWindowTokens;
	const instructionTokens = counter.count(input.baseInstructions)
		+ (input.developerInstructions ?? []).reduce((total, text) => total + counter.count(text), 0);
	let items = input.items;
	let trimmed = false;
	let generation = 1;
	let lastAttempt = 0;
	let lastSequence = 0;
	while (true) {
		input.signal.throwIfAborted();
		const history = compactionSummaryHistory(items, input.instruction);
		const inputTokens = instructionTokens + countConversationTokens(counter, history) + 8 * history.length;
		const contextRoom = contextLimit === undefined ? Infinity : Math.max(0, contextLimit - inputTokens);
		if (contextRoom < MIN_GENERATION_TOKENS) {
			if (items.length === 0) {
				throw new ProviderFailure({ code: "context_window_exceeded",
					message: "compaction instructions exceed the model context window" });
			}
			items = removeOldestCompactionItem(items);
			trimmed = true;
			continue;
		}
		const ceiling = Math.min(config.maxOutputTokens ?? Infinity, capabilities?.maxOutputTokens ?? Infinity, contextRoom);
		const outputRoom = (): number => {
			const remaining = input.remainingTokenBudget?.();
			return Math.max(0, Math.min(ceiling, remaining === undefined ? Infinity : remaining - inputTokens));
		};
		const outputTokens = outputRoom();
		if (outputTokens < MIN_GENERATION_TOKENS) throw compactionBudgetFailure();
		const maxOutputTokens = Number.isFinite(outputTokens) ? Math.floor(outputTokens) : undefined;
		// Attempt persistence can change ownership or consume Goal budget. Check again at dispatch.
		const budgetedProvider: ModelProvider = { stream: (request, options) => {
			options.signal.throwIfAborted();
			if ((request.maxOutputTokens ?? MIN_GENERATION_TOKENS) > outputRoom()) throw compactionBudgetFailure();
			return provider.stream(request, options);
		} };
		const request = projectProviderRequest({
			config: { provider: config.provider, protocol: config.protocol,
				model: input.model ?? config.model, reasoningEffort,
				...(maxOutputTokens === undefined ? {} : { maxOutputTokens }), sessionId: config.sessionId,
				cacheRetention: config.cacheRetention,
				...(config.nativeTransport ? { nativeTransport: config.nativeTransport } : {}) },
			instructions: input.baseInstructions,
			developerInstructions: input.developerInstructions,
			history,
			tools: [],
		});
		const requestEvidence: CompactionRequestEvidence = { generation, reasoningEffort,
			...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
			fingerprint: createHash("sha256").update(stableModelInputJson(request)).digest("hex") };
		const identity = { provider: request.provider, model: request.model, request: requestEvidence };
		const attemptOffset = lastAttempt;
		const sequenceOffset = lastSequence;
		if (trimmed) {
			const message = "Compaction input exceeded the context window; older history was removed from the summary request.";
			await input.recordEvent?.({ type: "recovery", ...identity, message });
			input.reportProgress?.(message);
			trimmed = false;
		}
		const result = await new InProcessProviderStepExecutor().execute({
			...options,
			config, provider: budgetedProvider, request, purpose: "compaction", errorContextVersion: 1,
			requestId: `${input.operationId ?? "compaction"}:generation:${generation}`,
			timelineWindowId: input.operationId ?? "compaction", timelineVersion: generation,
			maxRetries: config.streamMaxRetries, signal: input.signal, toolCallsAllowed: false,
			// Each reduced input starts a new request with the normal transport retry budgets.
			emit: (event) => { if (event.type === "stream_retrying") input.reportRetry?.(event); },
			recordAttempt: async (update) => {
				lastAttempt = attemptOffset + update.attempt;
				lastSequence = sequenceOffset + update.sequence;
				await input.recordEvent?.({ type: "attempt", ...identity,
					operationAttempt: lastAttempt, update: { ...update, sequence: lastSequence } });
			},
			recordUsage: async (usage, attempt) => {
				await input.recordEvent?.({ type: "usage", ...identity, usage, attempt: attemptOffset + attempt });
			},
			recordDiagnostic: (diagnostic) => options.recordDiagnostic?.({ ...diagnostic, attempt: attemptOffset + diagnostic.attempt }),
		});
		input.signal.throwIfAborted();
		if ("failure" in result) {
			if (result.failure.code === "context_window_exceeded" && items.length > 0) {
				items = removeOldestCompactionItem(items);
				trimmed = true;
				generation += 1;
				continue;
			}
			throw new CompactionProviderError(result.failure);
		}
		const summary = result.assistantText.trim();
		assertCompactionSummary(summary);
		return summary;
	}
}

function compactionBudgetFailure(): ProviderFailure {
	return new ProviderFailure({ code: "tool_budget_exceeded", message: "insufficient compaction generation budget",
		publicDetail: "The remaining token budget cannot cover this compaction request." });
}
