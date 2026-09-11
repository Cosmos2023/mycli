import { resolveProviderRetryPolicy, type NodeRuntimeConfig, type ProviderRetryPolicy } from "@mycli/config";
import type { ProviderRequest, ProviderUsage, RuntimeEvent } from "@mycli/core";
import type { ProviderAttemptUpdate } from "@mycli/contracts";
import type {
	ModelProvider,
	ProviderRouteDescriptor,
} from "@mycli/providers";
import {
	ProviderAgentLoop,
	normalizeProviderAgentLoopFailure,
} from "./provider-agent-loop.ts";
import type { ProviderAgentLoopResult } from "./provider-agent-loop.ts";
import type { ProviderStreamDiagnostics } from "../runtime-observability.ts";

export interface ProviderStepExecutionInput {
	readonly errorContextVersion?: 1;
	readonly purpose?: "turn" | "compaction";
	readonly config: NodeRuntimeConfig;
	readonly provider: ModelProvider;
	readonly providerRoute?: ProviderRouteDescriptor;
	readonly request: ProviderRequest;
	readonly timelineWindowId: string;
	readonly timelineVersion: number;
	readonly maxRetries: number;
	readonly retryPolicy?: ProviderRetryPolicy;
	readonly requestId?: string;
	readonly attemptState?: ProviderAttemptUpdate;
	readonly recordAttempt?: (update: ProviderAttemptUpdate) => Promise<void>;
	readonly recordUsage?: (usage: ProviderUsage, attempt: number) => Promise<void>;
	readonly clock?: () => string;
	readonly signal: AbortSignal;
	readonly toolCallsAllowed: boolean;
	readonly emit: (event: RuntimeEvent) => void;
	readonly recordDiagnostic?: (diagnostic: ProviderStreamDiagnostics) => void;
	readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
	readonly random?: () => number;
	readonly monotonicClock?: () => number;
}

export interface ProviderStepExecutor {
	readonly attemptSource?: "in_process" | "worker";
	execute(input: ProviderStepExecutionInput): Promise<ProviderAgentLoopResult>;
}

export class InProcessProviderStepExecutor implements ProviderStepExecutor {
	readonly attemptSource = "in_process" as const;
	readonly #loop = new ProviderAgentLoop();

	async execute(input: ProviderStepExecutionInput): Promise<ProviderAgentLoopResult> {
		const retryPolicy = resolveProviderStepRetryPolicy(input);
		return await this.#loop.runStep({
			...(input.requestId ? { requestId: input.requestId } : {}),
			errorContextVersion: input.errorContextVersion,
			provider: input.provider,
			request: input.request,
			requestMaxRetries: retryPolicy.requestMaxRetries,
			maxRetries: retryPolicy.streamMaxRetries,
			signal: input.signal,
			toolCallsAllowed: input.toolCallsAllowed,
			emit: input.emit,
			...(input.attemptState ? { attemptState: input.attemptState } : {}),
			...(input.recordAttempt ? { recordAttempt: input.recordAttempt } : {}),
			...(input.recordUsage ? { recordUsage: input.recordUsage } : {}),
			...(input.clock ? { clock: input.clock } : {}),
			...(input.recordDiagnostic ? { recordDiagnostic: input.recordDiagnostic } : {}),
			normalizeFailure: (error) => normalizeProviderAgentLoopFailure(error, input.signal),
			...(input.sleep ? { sleep: input.sleep } : {}),
			...(input.random ? { random: input.random } : {}),
			...(input.monotonicClock ? { monotonicClock: input.monotonicClock } : {}),
		});
	}
}

export function resolveProviderStepRetryPolicy(input: ProviderStepExecutionInput): ProviderRetryPolicy {
	return resolveProviderRetryPolicy(input.attemptState?.policy ?? input.retryPolicy ?? {
		requestMaxRetries: input.config.requestMaxRetries,
		streamMaxRetries: input.maxRetries,
		...(input.config.requestMaxRetriesByProvider === undefined ? {} : {
			requestMaxRetriesByProvider: input.config.requestMaxRetriesByProvider,
		}),
		...(input.config.streamMaxRetriesByProvider === undefined ? {} : {
			streamMaxRetriesByProvider: input.config.streamMaxRetriesByProvider,
		}),
	}, input.request.provider);
}
