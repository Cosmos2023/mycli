import type { ProviderEvent, ProviderRequest } from "@mycli/core";

export type ProviderStreamPhase = "response_terminal" | "sdk_terminal";

export interface ProviderStreamOptions {
	readonly signal: AbortSignal;
	readonly onPhase?: (phase: ProviderStreamPhase) => void;
}

export interface ModelProvider {
	resolveCapabilities?(): Promise<Readonly<{ supportsImages: boolean }>>;
	stream(
		request: ProviderRequest,
		options: ProviderStreamOptions,
	): AsyncIterable<ProviderEvent>;
}
