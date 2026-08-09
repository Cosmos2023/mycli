import type { NodeRuntimeConfig } from "@mycli/config";
import OpenAI from "openai";
import { ChatProvider } from "./chat-provider.ts";
import { ProviderFailure } from "./errors.ts";
import type {
	ChatCompletionsClient,
	ModelProvider,
	ResponsesClient,
} from "./model-provider.ts";
import { ResponsesProvider } from "./responses-provider.ts";

export interface OpenAIClientOptions {
	readonly apiKey: string;
	readonly baseURL: string;
	readonly maxRetries: number;
}

export interface OpenAIClientFacade {
	readonly responses: ResponsesClient;
	readonly chat: {
		readonly completions: ChatCompletionsClient;
	};
}

export type OpenAIClientFactory = (options: OpenAIClientOptions) => OpenAIClientFacade;

export interface OpenAIProviderRegistryOptions {
	readonly clientFactory?: OpenAIClientFactory;
}

export class OpenAIProviderRegistry {
	readonly #clientFactory: OpenAIClientFactory;

	constructor(options: OpenAIProviderRegistryOptions = {}) {
		this.#clientFactory = options.clientFactory ?? createOfficialClient;
	}

	create(config: NodeRuntimeConfig): ModelProvider {
		if (!config.apiKey) {
			throw new ProviderFailure({
				code: "auth_error",
				message: "provider API key is not configured",
			});
		}
		const client = this.#clientFactory({
			apiKey: config.apiKey,
			baseURL: config.apiBaseUrl,
			maxRetries: 0,
		});
		switch (config.protocol) {
			case "responses":
				return new ResponsesProvider({ client: client.responses });
			case "chat_completions":
				return new ChatProvider({
					client: client.chat.completions,
					...(config.provider === "deepseek"
						? { providerAdapter: "deepseek" as const }
						: {}),
				});
			default:
				throw new ProviderFailure({
					code: "config_error",
					message: "unsupported provider protocol",
				});
		}
	}
}

function createOfficialClient(options: OpenAIClientOptions): OpenAIClientFacade {
	return new OpenAI(options) as unknown as OpenAIClientFacade;
}
