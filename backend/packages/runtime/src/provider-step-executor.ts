import type { NodeRuntimeConfig } from "@mycli/config";
import type { ProviderRequest, RuntimeEvent } from "@mycli/core";
import type {
	ModelProvider,
	ProviderRouteDescriptor,
} from "@mycli/providers";
import {
	ProviderAgentLoop,
	normalizeProviderAgentLoopFailure,
} from "./provider-agent-loop.ts";
import type { ProviderAgentLoopResult } from "./provider-agent-loop.ts";
import type { ProviderStreamDiagnostics } from "./runtime-observability.ts";

export interface ProviderStepExecutionInput {
	readonly config: NodeRuntimeConfig;
	readonly provider: ModelProvider;
	readonly providerRoute?: ProviderRouteDescriptor;
	readonly request: ProviderRequest;
	readonly timelineWindowId: string;
	readonly timelineVersion: number;
	readonly maxRetries: number;
	readonly signal: AbortSignal;
	readonly toolCallsAllowed: boolean;
	readonly emit: (event: RuntimeEvent) => void;
	readonly recordDiagnostic?: (diagnostic: ProviderStreamDiagnostics) => void;
	readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
	readonly random?: () => number;
	readonly monotonicClock?: () => number;
}

export interface ProviderStepExecutor {
	execute(input: ProviderStepExecutionInput): Promise<ProviderAgentLoopResult>;
}

export class InProcessProviderStepExecutor implements ProviderStepExecutor {
	readonly #loop = new ProviderAgentLoop();

	async execute(input: ProviderStepExecutionInput): Promise<ProviderAgentLoopResult> {
		return await this.#loop.runStep({
			provider: input.provider,
			request: input.request,
			requestMaxRetries: input.config.requestMaxRetries,
			maxRetries: input.maxRetries,
			signal: input.signal,
			toolCallsAllowed: input.toolCallsAllowed,
			emit: input.emit,
			...(input.recordDiagnostic ? { recordDiagnostic: input.recordDiagnostic } : {}),
			normalizeFailure: (error) => normalizeProviderAgentLoopFailure(error, input.signal),
			...(input.sleep ? { sleep: input.sleep } : {}),
			...(input.random ? { random: input.random } : {}),
			...(input.monotonicClock ? { monotonicClock: input.monotonicClock } : {}),
		});
	}
}
