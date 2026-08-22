import type { NodeRuntimeConfig } from "@mycli/config";
import type { ProviderRequest, RuntimeEvent } from "@mycli/core";
import type { ModelProvider } from "@mycli/providers";
import {
	ProviderAgentLoop,
	normalizeProviderAgentLoopFailure,
} from "./provider-agent-loop.ts";
import type { ProviderAgentLoopResult } from "./provider-agent-loop.ts";

export interface ProviderStepExecutionInput {
	readonly config: NodeRuntimeConfig;
	readonly provider: ModelProvider;
	readonly request: ProviderRequest;
	readonly timelineWindowId: string;
	readonly timelineVersion: number;
	readonly maxRetries: number;
	readonly signal: AbortSignal;
	readonly toolCallsAllowed: boolean;
	readonly emit: (event: RuntimeEvent) => void;
	readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
	readonly random?: () => number;
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
			maxRetries: input.maxRetries,
			signal: input.signal,
			toolCallsAllowed: input.toolCallsAllowed,
			emit: input.emit,
			normalizeFailure: (error) => normalizeProviderAgentLoopFailure(error, input.signal),
			...(input.sleep ? { sleep: input.sleep } : {}),
			...(input.random ? { random: input.random } : {}),
		});
	}
}
