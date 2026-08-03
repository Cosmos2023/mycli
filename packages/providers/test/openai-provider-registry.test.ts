import assert from "node:assert/strict";
import test from "node:test";
import type { NodeRuntimeConfig } from "@mycli/config";
import type { ProviderEvent } from "@mycli/core";
import type { ModelProvider } from "../src/model-provider.ts";
import * as providers from "../src/index.ts";

interface ClientOptions {
	readonly apiKey: string;
	readonly baseURL: string;
	readonly maxRetries: number;
}

interface FakeOpenAIClient {
	readonly responses: {
		readonly create: () => Promise<AsyncIterable<unknown>>;
	};
	readonly chat: {
		readonly completions: {
			readonly create: () => Promise<AsyncIterable<unknown>>;
		};
	};
}

type RegistryConstructor = new (options?: {
	clientFactory?: (options: ClientOptions) => FakeOpenAIClient;
}) => {
	create(config: NodeRuntimeConfig): ModelProvider;
};

test("registry configures the official client boundary and selects Chat", async () => {
	const OpenAIProviderRegistry = Reflect.get(
		providers,
		"OpenAIProviderRegistry",
	) as RegistryConstructor | undefined;
	assert.equal(typeof OpenAIProviderRegistry, "function");
	let capturedOptions: ClientOptions | undefined;
	let chatCalls = 0;
	let responsesCalls = 0;
	const client: FakeOpenAIClient = {
		responses: {
			create: async () => {
				responsesCalls += 1;
				return events([]);
			},
		},
		chat: {
			completions: {
				create: async () => {
					chatCalls += 1;
					return events([{
						id: "chatcmpl-registry",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					}]);
				},
			},
		},
	};
	const registry = new OpenAIProviderRegistry!({
		clientFactory: (options) => {
			capturedOptions = options;
			return client;
		},
	});
	const provider = registry.create(config("chat_completions"));

	const result = await collect(provider.stream(request("chat_completions"), {
		signal: new AbortController().signal,
	}));

	assert.deepEqual(capturedOptions, {
		apiKey: "test-key",
		baseURL: "https://provider.example/v1",
		maxRetries: 0,
	});
	assert.deepEqual(result.at(-1), { type: "completed", responseId: "chatcmpl-registry" });
	assert.equal(chatCalls, 1);
	assert.equal(responsesCalls, 0);
});

test("registry selects Responses and rejects missing credentials", async () => {
	const OpenAIProviderRegistry = Reflect.get(
		providers,
		"OpenAIProviderRegistry",
	) as RegistryConstructor | undefined;
	assert.equal(typeof OpenAIProviderRegistry, "function");
	let responsesCalls = 0;
	const registry = new OpenAIProviderRegistry!({
		clientFactory: () => ({
			responses: {
				create: async () => {
					responsesCalls += 1;
					return events([{
						type: "response.completed",
						response: { id: "resp-registry", usage: {} },
					}]);
				},
			},
			chat: { completions: { create: async () => events([]) } },
		}),
	});
	const provider = registry.create(config("responses"));

	const result = await collect(provider.stream(request("responses"), {
		signal: new AbortController().signal,
	}));

	assert.deepEqual(result.at(-1), { type: "completed", responseId: "resp-registry" });
	assert.equal(responsesCalls, 1);
	assert.throws(
		() => registry.create({ ...config("responses"), apiKey: undefined }),
		/auth_error: provider API key is not configured/,
	);
});

test("registry rejects an unsupported protocol at the runtime boundary", () => {
	const OpenAIProviderRegistry = Reflect.get(
		providers,
		"OpenAIProviderRegistry",
	) as RegistryConstructor | undefined;
	assert.equal(typeof OpenAIProviderRegistry, "function");
	const registry = new OpenAIProviderRegistry!({
		clientFactory: () => ({
			responses: { create: async () => events([]) },
			chat: { completions: { create: async () => events([]) } },
		}),
	});
	const invalidConfig = {
		...config("responses"),
		protocol: "unknown_protocol",
	} as unknown as NodeRuntimeConfig;

	assert.throws(
		() => registry.create(invalidConfig),
		/config_error: unsupported provider protocol/,
	);
});

function config(protocol: "responses" | "chat_completions"): NodeRuntimeConfig {
	return {
		workspaceRoot: "/workspace",
		homeDir: "/home/test",
		provider: "compatible",
		protocol,
		model: "gpt-test",
		apiBaseUrl: "https://provider.example/v1",
		apiKey: "test-key",
		authRef: "compatible",
		sessionId: "session-1",
		sessionsDbPath: "/home/test/.mycli/sessions.db",
		maxPromptTokens: 12000,
		requestMaxRetries: 4,
		streamMaxRetries: 5,
		reasoningEffort: "medium",
		thinkingEnabled: true,
		promptCacheKeyEnabled: true,
	};
}

function request(protocol: "responses" | "chat_completions") {
	return {
		provider: "compatible" as const,
		protocol,
		model: "gpt-test",
		instructions: "system",
		messages: [{ role: "user" as const, content: "hello" }],
		tools: [] as const,
	};
}

async function* events(items: readonly unknown[]): AsyncIterable<unknown> {
	for (const item of items) {
		yield item;
	}
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
	const collected: ProviderEvent[] = [];
	for await (const event of stream) {
		collected.push(event);
	}
	return collected;
}
