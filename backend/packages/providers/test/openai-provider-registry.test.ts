import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
	NODE_RUNTIME_CONTEXT_DEFAULTS,
	type NodeRuntimeConfig,
} from "@mycli/config";
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
		readonly create: (request: Record<string, unknown>) => Promise<AsyncIterable<unknown>>;
	};
	readonly chat: {
		readonly completions: {
			readonly create: (request: Record<string, unknown>) => Promise<AsyncIterable<unknown>>;
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

test("registry applies the DeepSeek Chat developer-role downgrade", async () => {
	const OpenAIProviderRegistry = Reflect.get(
		providers,
		"OpenAIProviderRegistry",
	) as RegistryConstructor | undefined;
	assert.equal(typeof OpenAIProviderRegistry, "function");
	let capturedRequest: Record<string, unknown> | undefined;
	const registry = new OpenAIProviderRegistry!({
		clientFactory: () => ({
			responses: { create: async () => events([]) },
			chat: { completions: {
				create: async (body) => {
					capturedRequest = body;
					return events([{
						id: "chatcmpl-deepseek",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					}]);
				},
			} },
		}),
	});
	const provider = registry.create({
		...config("chat_completions"),
		provider: "deepseek",
		authRef: "deepseek",
		promptCacheKeyEnabled: false,
	});

	await collect(provider.stream({
		...request("chat_completions"),
		provider: "deepseek",
		reasoningEffort: "high",
		developerInstructions: ["Use the child role."],
	}, { signal: new AbortController().signal }));

	assert.deepEqual(capturedRequest?.messages, [
		{ role: "system", content: "system\n\nUse the child role." },
		{ role: "user", content: "hello" },
	]);
	assert.deepEqual(capturedRequest?.thinking, { type: "enabled" });
	assert.equal("extra_body" in (capturedRequest ?? {}), false);
	assert.equal(capturedRequest?.reasoning_effort, "high");
});

test("official client sends DeepSeek thinking at the HTTP body top level", async (context) => {
	const OpenAIProviderRegistry = Reflect.get(
		providers,
		"OpenAIProviderRegistry",
	) as RegistryConstructor | undefined;
	assert.equal(typeof OpenAIProviderRegistry, "function");
	let capturedBody: Record<string, unknown> | undefined;
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end([
				'data: {"id":"chatcmpl-wire","choices":[{"delta":{},"finish_reason":"stop"}]}',
				"",
				"data: [DONE]",
				"",
			].join("\n"));
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	context.after(() => new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	}));
	const address = server.address();
	assert(address && typeof address !== "string");
	const provider = new OpenAIProviderRegistry!().create({
		...config("chat_completions"),
		provider: "deepseek",
		authRef: "deepseek",
		apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
	});

	await collect(provider.stream({
		...request("chat_completions"),
		provider: "deepseek",
		reasoningEffort: "high",
	}, { signal: new AbortController().signal }));

	assert.deepEqual(capturedBody?.thinking, { type: "enabled" });
	assert.equal("extra_body" in (capturedBody ?? {}), false);
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
		...NODE_RUNTIME_CONTEXT_DEFAULTS,
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
		supportsImages: true,
		webSearchMode: "disabled",
		promptCacheKeyEnabled: true,
		requestPermissionsToolEnabled: false,
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
