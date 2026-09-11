import assert from "node:assert/strict";
import test from "node:test";
import {
	NODE_RUNTIME_CONTEXT_DEFAULTS,
	type NodeRuntimeConfig,
} from "@mycli/config";
import type {
	ProviderEvent,
	ProviderId,
	ProviderReplayState,
	ProviderRequest,
	ReasoningEffort,
} from "@mycli/core";
import { ProviderRegistry } from "../../src/registry/provider-registry.ts";
import { PARITY_READ_TOOL } from "../support/provider-parity-fixtures.ts";
import { startProviderMockServer } from "../support/provider-mock-server.ts";

const CURATED_RUNTIME_CASES = [
	["openrouter", "openrouter/auto", "medium", true],
	["groq", "openai/gpt-oss-120b", "medium", true],
	["together", "moonshotai/Kimi-K2.7-Code", "high", true],
	["moonshotai", "kimi-k2.7-code", "high", true],
	["nvidia", "openai/gpt-oss-120b", "none", false],
	["cerebras", "gpt-oss-120b", "medium", true],
] as const satisfies readonly [ProviderId, string, ReasoningEffort, boolean][];

test("streams canonical reasoning, tools, usage, state, and completion for curated providers", async () => {
	for (const [providerId, model, reasoningEffort, includeReasoning] of CURATED_RUNTIME_CASES) {
		const server = await startProviderMockServer({
			protocol: "chat_completions",
			chatScenario: "reasoning_tool",
			includeReasoning,
		});
		try {
			const provider = new ProviderRegistry().create(runtimeConfig(
				providerId,
				model,
				`${server.baseUrl}/v1`,
			));
			const events = await collect(provider.stream(runtimeRequest(
				providerId,
				model,
				reasoningEffort,
			), { signal: new AbortController().signal }));

			assert.deepEqual(events.map((event) => event.type), [
				...(includeReasoning ? ["reasoning_delta"] : []),
				"provider_state",
				"tool_call",
				"usage",
				"completed",
			], providerId);
			assert.deepEqual(events.find((event) => event.type === "tool_call"), {
				type: "tool_call",
				callId: "call_mock",
				name: "Read",
				argumentsJson: "{\"file_path\":\"README.md\"}",
			}, providerId);
			assert.deepEqual(events.find((event) => event.type === "usage"), {
				type: "usage",
				usage: {
					input_tokens: 9,
					output_tokens: 4,
					total_tokens: 13,
					reasoning_tokens: 2,
				},
			}, providerId);
			const state = events.find((event) => event.type === "provider_state");
			assert.equal(state?.type === "provider_state" && state.state.provider, providerId);
			assert.deepEqual(events.at(-1), { type: "completed", responseId: "chatcmpl_mock" });

			const messages = server.requests[0]?.body.messages;
			assert(Array.isArray(messages), providerId);
			assert(messages.some((message) => isRole(message, "assistant")), providerId);
			assert(messages.some((message) => isRole(message, "tool")), providerId);
		} finally {
			await server.close();
		}
	}
});

test("resumes curated replay only for matching provider and model identities", async () => {
	for (const [index, source] of CURATED_RUNTIME_CASES.entries()) {
		const [providerId, model, reasoningEffort, includeReasoning] = source;
		const target = CURATED_RUNTIME_CASES[(index + 1) % CURATED_RUNTIME_CASES.length];
		assert(target);
		const server = await startProviderMockServer({
			protocol: "chat_completions",
			chatScenario: "reasoning_tool",
			includeReasoning,
		});
		try {
			const sourceProvider = new ProviderRegistry().create(runtimeConfig(
				providerId,
				model,
				`${server.baseUrl}/v1`,
			));
			const first = await collect(sourceProvider.stream(runtimeRequest(
				providerId,
				model,
				reasoningEffort,
			), { signal: new AbortController().signal }));
			const state = providerState(first);

			await collect(sourceProvider.stream(continuationRequest(
				providerId,
				model,
				reasoningEffort,
				state,
			), { signal: new AbortController().signal }));
			assert.equal(historicalToolCallId(server.requests[1]?.body), "call_mock|native_item");

			const [targetProviderId, targetModel, targetEffort] = target;
			const targetProvider = new ProviderRegistry().create(runtimeConfig(
				targetProviderId,
				targetModel,
				`${server.baseUrl}/v1`,
			));
			await collect(targetProvider.stream(continuationRequest(
				targetProviderId,
				targetModel,
				targetEffort,
				state,
			), { signal: new AbortController().signal }));
			assert.equal(historicalToolCallId(server.requests[2]?.body), "call_mock");
		} finally {
			await server.close();
		}
	}
});

test("degrades inconsistent curated replay metadata to canonical history", async () => {
	const [providerId, model, reasoningEffort] = CURATED_RUNTIME_CASES[0];
	const server = await startProviderMockServer({
		protocol: "chat_completions",
		chatScenario: "reasoning_tool",
	});
	try {
		const provider = new ProviderRegistry().create(runtimeConfig(
			providerId,
			model,
			`${server.baseUrl}/v1`,
		));
		const first = await collect(provider.stream(runtimeRequest(
			providerId,
			model,
			reasoningEffort,
		), { signal: new AbortController().signal }));
		const state = providerState(first);
		const transport = state.value.transport;
		assert.equal(typeof transport, "object");
		const inconsistent = Object.freeze({
			provider: state.provider,
			value: Object.freeze({
				...state.value,
				transport: Object.freeze({
					...(transport as Readonly<Record<string, unknown>>),
					model: "different-model",
				}),
			}),
		});

		await collect(provider.stream(continuationRequest(
			providerId,
			model,
			reasoningEffort,
			inconsistent,
		), { signal: new AbortController().signal }));
		assert.equal(historicalToolCallId(server.requests[1]?.body), "call_mock");
	} finally {
		await server.close();
	}
});

function runtimeRequest(
	provider: ProviderId,
	model: string,
	reasoningEffort: ReasoningEffort,
): ProviderRequest {
	return {
		provider,
		protocol: "chat_completions",
		model,
		reasoningEffort,
		instructions: "system",
		messages: [],
		items: [
			{ type: "user", text: "read" },
			{
				type: "assistant_tool_calls",
				text: "",
				calls: [{
					callId: "prior_call",
					name: "Read",
					argumentsJson: "{\"file_path\":\"package.json\"}",
				}],
			},
			{
				type: "tool_result",
				callId: "prior_call",
				toolName: "Read",
				output: "{}",
				success: true,
			},
			{ type: "user", text: "continue" },
		],
		tools: [PARITY_READ_TOOL],
		maxOutputTokens: 256,
	};
}

function runtimeConfig(
	provider: ProviderId,
	model: string,
	apiBaseUrl: string,
): NodeRuntimeConfig {
	return {
		...NODE_RUNTIME_CONTEXT_DEFAULTS,
		workspaceRoot: "/workspace",
		homeDir: "/home/test",
		provider,
		protocol: "chat_completions",
		model,
		apiBaseUrl,
		apiKey: "test-key",
		authRef: provider,
		sessionId: "session-1",
		sessionsDbPath: "/home/test/.mycli/sessions.db",
		maxPromptTokens: 12_000,
		modelContextWindowTokens: 20_000,
		maxOutputTokens: 4_096,
		requestMaxRetries: 4,
		streamMaxRetries: 5,
		reasoningEffort: "medium",
		thinkingEnabled: true,
		supportsImages: false,
		webSearchMode: "disabled",
		cacheRetention: "short",
		requestPermissionsToolEnabled: false,
		updatesCheckOnStartup: true,
	};
}

function continuationRequest(
	provider: ProviderId,
	model: string,
	reasoningEffort: ReasoningEffort,
	state: ProviderReplayState,
): ProviderRequest {
	return {
		provider,
		protocol: "chat_completions",
		model,
		reasoningEffort,
		instructions: "system",
		messages: [],
		items: [
			{ type: "user", text: "read" },
			{
				type: "assistant_tool_calls",
				text: "",
				calls: [{
					callId: "call_mock",
					name: "Read",
					argumentsJson: "{\"file_path\":\"README.md\"}",
				}],
				providerState: state,
			},
			{
				type: "tool_result",
				callId: "call_mock",
				toolName: "Read",
				output: "contents",
				success: true,
			},
			{ type: "user", text: "continue" },
		],
		tools: [PARITY_READ_TOOL],
		maxOutputTokens: 256,
	};
}

function providerState(events: readonly ProviderEvent[]): ProviderReplayState {
	const event = events.find((candidate) => candidate.type === "provider_state");
	assert(event?.type === "provider_state");
	return event.state;
}

function historicalToolCallId(body: Readonly<Record<string, unknown>> | undefined): string | undefined {
	if (!body || !Array.isArray(body.messages)) return undefined;
	for (const message of body.messages) {
		if (!isRole(message, "assistant")) continue;
		const toolCalls = (message as Readonly<Record<string, unknown>>).tool_calls;
		if (!Array.isArray(toolCalls)) continue;
		const call = toolCalls[0];
		if (typeof call === "object" && call !== null && !Array.isArray(call)) {
			const id = (call as Readonly<Record<string, unknown>>).id;
			if (typeof id === "string") return id;
		}
	}
	return undefined;
}

function isRole(value: unknown, role: string): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		&& (value as Readonly<Record<string, unknown>>).role === role;
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
	const events: ProviderEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}
