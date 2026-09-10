import type { NodeRuntimeConfig } from "@mycli/config";
import { parseRuntimeFailure, type ProviderAttemptUpdate, type RuntimeFailure } from "@mycli/contracts";
import { projectProviderRequest, type CanonicalConversationItem, type ProviderUsage, type RuntimeEvent } from "@mycli/core";
import { ProviderFailure, type ModelProvider } from "@mycli/providers";
import { InProcessProviderStepExecutor, type ProviderStepExecutionInput } from "../providers/provider-step-executor.ts";

export type CompactionModelEvent = {
	readonly provider: string;
	readonly model: string;
} & (
	| { readonly type: "attempt"; readonly update: ProviderAttemptUpdate }
	| { readonly type: "usage"; readonly attempt: number; readonly usage: ProviderUsage }
);

interface CompactionModelInput {
	readonly items: readonly CanonicalConversationItem[];
	readonly instruction: string;
	readonly model?: string;
	readonly maxOutputTokens: number;
	readonly signal: AbortSignal;
	readonly operationId?: string;
	readonly recordEvent?: (event: CompactionModelEvent) => Promise<void>;
	readonly reportRetry?: (event: Extract<RuntimeEvent, { readonly type: "stream_retrying" }>) => void;
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
	const request = projectProviderRequest({
		config: { provider: config.provider, protocol: config.protocol,
			model: input.model ?? config.model, reasoningEffort: "none",
			maxOutputTokens: input.maxOutputTokens, sessionId: config.sessionId,
			cacheRetention: config.cacheRetention,
			...(config.nativeTransport ? { nativeTransport: config.nativeTransport } : {}) },
		instructions: input.instruction,
		history: input.items,
		tools: [],
	});
	const result = await new InProcessProviderStepExecutor().execute({
		config, provider, request, purpose: "compaction",
		timelineWindowId: input.operationId ?? "compaction", timelineVersion: 1,
		maxRetries: config.streamMaxRetries, signal: input.signal, toolCallsAllowed: false,
		// Summary deltas and stream resets never enter the ordinary assistant transcript.
		emit: (event) => { if (event.type === "stream_retrying") input.reportRetry?.(event); },
		recordAttempt: async (update) => {
			await input.recordEvent?.({ type: "attempt", provider: request.provider, model: request.model, update });
		},
		recordUsage: async (usage, attempt) => {
			await input.recordEvent?.({ type: "usage", provider: request.provider, model: request.model, usage, attempt });
		},
		...options,
	});
	if ("failure" in result) throw new CompactionProviderError(result.failure);
	if (!result.assistantText.trim()) {
		throw new ProviderFailure({ code: "provider_error", message: "compaction summary provider returned empty text" });
	}
	return result.assistantText.trim();
}
