import type { ProviderEvent, ProviderRequest, ReasoningEffort } from "@mycli/core";

export interface ProviderCapabilities {
	readonly supportsImages: boolean;
	readonly reasoningEfforts?: readonly ReasoningEffort[];
	readonly maxOutputTokens?: number;
	readonly contextWindowTokens?: number;
}

export type ProviderStreamPhase = "response_terminal" | "sdk_terminal";

export interface ProviderStreamOptions {
	readonly signal: AbortSignal;
	readonly onPhase?: (phase: ProviderStreamPhase) => void;
}

export interface ModelProvider {
	resolveCapabilities?(): Promise<ProviderCapabilities>;
	stream(
		request: ProviderRequest,
		options: ProviderStreamOptions,
	): AsyncIterable<ProviderEvent>;
}
