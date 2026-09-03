import type { ProviderEvent, ProviderRequest } from "@mycli/core";

export interface ProviderStreamOptions {
	readonly signal: AbortSignal;
}

export interface ModelProvider {
	stream(
		request: ProviderRequest,
		options: ProviderStreamOptions,
	): AsyncIterable<ProviderEvent>;
}
