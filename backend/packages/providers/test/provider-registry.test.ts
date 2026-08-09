import assert from "node:assert/strict";
import test from "node:test";
import { NODE_RUNTIME_CONTEXT_DEFAULTS, type NodeRuntimeConfig } from "@mycli/config";
import type { ProviderEvent } from "@mycli/core";
import {
	ProviderRegistry,
	type AnthropicClientOptions,
} from "../src/provider-registry.ts";

test("provider registry constructs Anthropic with zero SDK retries", async () => {
	let captured: AnthropicClientOptions | undefined;
	const registry = new ProviderRegistry({
		anthropicClientFactory: (options) => {
			captured = options;
			return {
				stream: async () => events([
					{ type: "message_start", message: { id: "msg-registry", usage: {} } },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
					{ type: "message_stop" },
				]),
			};
		},
	});
	const provider = registry.create(config());
	const result = await collect(provider.stream({
		provider: "anthropic",
		protocol: "anthropic_messages",
		model: "claude-test",
		instructions: "system",
		messages: [{ role: "user", content: "hello" }],
		tools: [],
	}, { signal: new AbortController().signal }));

	assert.deepEqual(captured, {
		apiKey: "test-key",
		baseURL: "https://api.anthropic.com",
		maxRetries: 0,
	});
	assert.deepEqual(result.at(-1), { type: "completed", responseId: "msg-registry" });
});

function config(): NodeRuntimeConfig {
	return {
		...NODE_RUNTIME_CONTEXT_DEFAULTS,
		workspaceRoot: "/workspace",
		homeDir: "/home/test",
		provider: "anthropic",
		protocol: "anthropic_messages",
		model: "claude-test",
		apiBaseUrl: "https://api.anthropic.com",
		apiKey: "test-key",
		authRef: "anthropic",
		sessionId: "session-1",
		sessionsDbPath: "/home/test/.mycli/sessions.db",
		maxPromptTokens: 12000,
		requestMaxRetries: 4,
		streamMaxRetries: 5,
		reasoningEffort: "medium",
		thinkingEnabled: true,
		supportsImages: true,
		promptCacheKeyEnabled: false,
		cacheControlEnabled: true,
	};
}

async function* events(values: readonly unknown[]): AsyncIterable<unknown> {
	for (const value of values) yield value;
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
	const result: ProviderEvent[] = [];
	for await (const event of stream) result.push(event);
	return result;
}
