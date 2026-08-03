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

export interface ResponsesClient {
	create(
		request: Readonly<Record<string, unknown>>,
		options: ProviderStreamOptions,
	): Promise<AsyncIterable<unknown>>;
}
