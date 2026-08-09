import type { NodeRuntimeConfig } from "@mycli/config";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageStreamParams } from "@anthropic-ai/sdk/resources/messages/messages";
import { AnthropicProvider } from "./anthropic-provider.ts";
import { ProviderFailure } from "./errors.ts";
import type { AnthropicMessagesClient, ModelProvider } from "./model-provider.ts";
import {
	OpenAIProviderRegistry,
	type OpenAIClientFactory,
} from "./openai-provider-registry.ts";

export interface AnthropicClientOptions {
	readonly apiKey: string;
	readonly baseURL: string;
	readonly maxRetries: number;
}

export type AnthropicClientFactory = (
	options: AnthropicClientOptions,
) => AnthropicMessagesClient;

export interface ProviderRegistryOptions {
	readonly openAIClientFactory?: OpenAIClientFactory;
	readonly anthropicClientFactory?: AnthropicClientFactory;
}

export class ProviderRegistry {
	readonly #openAI: OpenAIProviderRegistry;
	readonly #anthropicClientFactory: AnthropicClientFactory;

	constructor(options: ProviderRegistryOptions = {}) {
		this.#openAI = new OpenAIProviderRegistry({
			...(options.openAIClientFactory ? { clientFactory: options.openAIClientFactory } : {}),
		});
		this.#anthropicClientFactory = options.anthropicClientFactory ?? createOfficialClient;
	}

	create(config: NodeRuntimeConfig): ModelProvider {
		if (!config.apiKey) {
			throw new ProviderFailure({
				code: "auth_error",
				message: "provider API key is not configured",
			});
		}
		switch (config.protocol) {
			case "responses":
			case "chat_completions":
				return this.#openAI.create(config);
			case "anthropic_messages":
				return new AnthropicProvider({
					client: this.#anthropicClientFactory({
						apiKey: config.apiKey,
						baseURL: config.apiBaseUrl,
						maxRetries: 0,
					}),
				});
		}
	}
}

function createOfficialClient(options: AnthropicClientOptions): AnthropicMessagesClient {
	const client = new Anthropic(options);
	return {
		stream: async (body, streamOptions) => client.messages.stream(
			body as unknown as MessageStreamParams,
			{ signal: streamOptions.signal },
		),
	};
}
