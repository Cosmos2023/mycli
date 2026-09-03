import assert from "node:assert/strict";
import test from "node:test";
import { NODE_RUNTIME_CONTEXT_DEFAULTS, type NodeRuntimeConfig } from "@mycli/config";
import type { ProviderEvent, ProviderRequest } from "@mycli/core";
import { ProviderRegistry } from "../src/provider-registry.ts";
import { startProviderMockServer } from "./provider-mock-server.ts";

test("registry sends ordinary Responses traffic through pi-ai", async (context) => {
	const server = await startProviderMockServer({ protocol: "responses" });
	context.after(() => server.close());
	const provider = new ProviderRegistry().create(config("responses", {
		apiBaseUrl: `${server.baseUrl}/v1`,
	}));
	const result = await collect(provider.stream({
		...request("responses"),
		developerInstructions: ["durable policy"],
		items: [
			contextItem("trusted hook policy", "developer"),
			{ type: "user", text: "hello" },
		],
		sessionId: "session-cache",
		cacheRetention: "short",
		maxOutputTokens: 8,
	}, { signal: new AbortController().signal }));

	assert.equal(server.requests.length, 1);
	assert.equal(server.requests[0]?.path, "/v1/responses");
	assert.equal(server.requests[0]?.body.instructions, undefined);
	assert.equal(server.requests[0]?.body.store, false);
	assert.equal(server.requests[0]?.body.prompt_cache_key, "session-cache");
	assert.equal(server.requests[0]?.body.max_output_tokens, 16);
	const input = server.requests[0]?.body.input as readonly Record<string, unknown>[];
	assert.deepEqual(input.slice(0, 2), [
		{ role: "system", content: "system\n\ndurable policy\n\ntrusted hook policy" },
		{ role: "user", content: [{ type: "input_text", text: "hello" }] },
	]);
	assert.deepEqual(result.at(-1), { type: "completed", responseId: "resp_mock" });
});

test("registry lets pi-ai preserve DeepSeek instruction authority", async (context) => {
	const server = await startProviderMockServer({ protocol: "chat_completions" });
	context.after(() => server.close());
	const provider = new ProviderRegistry().create(config("chat_completions", {
		provider: "deepseek",
		model: "deepseek-reasoner",
		apiBaseUrl: `${server.baseUrl}/v1`,
	}));

	await collect(provider.stream({
		...request("chat_completions"),
		provider: "deepseek",
		model: "deepseek-reasoner",
		reasoningEffort: "high",
		developerInstructions: ["durable policy"],
		items: [
			{ type: "user", text: "U1" },
			{ type: "assistant", text: "A1" },
			contextItem("updated permission", "developer"),
			{ type: "user", text: "U2" },
		],
	}, { signal: new AbortController().signal }));

	assert.equal(server.requests.length, 1);
	assert.deepEqual(server.requests[0]?.body.messages, [
		{ role: "system", content: "system\n\ndurable policy\n\nupdated permission" },
		{ role: "user", content: "U1" },
		{ role: "assistant", content: "A1", reasoning_content: "" },
		{ role: "user", content: "U2" },
	]);
	assert.deepEqual(server.requests[0]?.body.thinking, { type: "enabled" });
	assert.equal(server.requests[0]?.body.reasoning_effort, "high");
});

test("one pi-ai invocation performs one HTTP attempt", async (context) => {
	const server = await startProviderMockServer({
		protocol: "chat_completions",
		mode: "failed",
		status: 429,
	});
	context.after(() => server.close());
	const provider = new ProviderRegistry().create(config("chat_completions", {
		apiBaseUrl: `${server.baseUrl}/v1`,
	}));

	await assert.rejects(
		() => collect(provider.stream(request("chat_completions"), {
			signal: new AbortController().signal,
		})),
		(error: unknown) => error instanceof Error && /rate_limited/u.test(error.message),
	);
	assert.equal(server.requests.length, 1);
});

test("Responses routes preserve native tool ids across pi-ai continuation", async (context) => {
	for (const route of ["codex", "compatible"] as const) {
		const server = await startProviderMockServer({ protocol: "responses" });
		context.after(() => server.close());
		const provider = new ProviderRegistry().create(config("responses", {
			provider: route,
			model: "gpt-test",
			apiBaseUrl: `${server.baseUrl}/v1`,
		}));

		await collect(provider.stream({
			...request("responses"),
			provider: route,
			items: [
				{ type: "user", text: "read" },
				{
					type: "assistant_tool_calls",
					text: "",
					calls: [{ callId: "call-1", name: "Read", argumentsJson: "{}" }],
					providerState: {
						provider: route,
						value: {
							kind: "pi_ai_assistant",
							version: 1,
							api: "openai-responses",
							provider: route,
							model: "gpt-test",
							textBlocks: [],
							thinkingBlocks: [],
							toolCalls: [{
								callId: "call-1",
								nativeId: "call-1|fc_1",
								name: "Read",
								argumentsJson: "{}",
							}],
						},
					},
				},
				{
					type: "tool_result",
					callId: "call-1",
					toolName: "Read",
					output: "contents",
					success: true,
				},
			],
			tools: [{
				id: "builtin:Read",
				name: "Read",
				description: "Read a file.",
				inputSchema: { type: "object", properties: {} },
			}],
		}, { signal: new AbortController().signal }));

		const input = server.requests[0]?.body.input as readonly Record<string, unknown>[];
		assert.deepEqual(input.find((item) => item.type === "function_call"), {
			type: "function_call",
			id: "fc_1",
			call_id: "call-1",
			name: "Read",
			arguments: "{}",
		});
		assert.deepEqual(input.find((item) => item.type === "function_call_output"), {
			type: "function_call_output",
			call_id: "call-1",
			output: "contents",
		});
	}
});

test("live Responses web search stays on pi-ai and tolerates provider heartbeats", async (context) => {
	const server = await startProviderMockServer({
		protocol: "responses",
		responsesScenario: "web_search",
	});
	context.after(() => server.close());
	const provider = new ProviderRegistry().create(config("responses", {
		apiBaseUrl: `${server.baseUrl}/v1`,
	}));
	const result = await collect(provider.stream({
		...request("responses"),
		webSearchMode: "live",
	}, { signal: new AbortController().signal }));

	assert.equal(server.requests.length, 1);
	assert.deepEqual(server.requests[0]?.body.tools, [{
		type: "web_search",
		external_web_access: true,
	}]);
	assert.equal(result.some((event) => event.type === "text_delta"), true);
	assert.equal(result.some((event) => event.type === "web_search_started"), false);
	assert.deepEqual(result.at(-1), { type: "completed", responseId: "resp_mock" });
});

function config(
	protocol: "responses" | "chat_completions",
	overrides: Partial<NodeRuntimeConfig> = {},
): NodeRuntimeConfig {
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
		maxPromptTokens: 12_000,
		modelContextWindowTokens: 20_000,
		maxOutputTokens: 4_096,
		requestMaxRetries: 4,
		streamMaxRetries: 5,
		reasoningEffort: "medium",
		thinkingEnabled: true,
		supportsImages: true,
		webSearchMode: "disabled",
		cacheRetention: "short",
		requestPermissionsToolEnabled: false,
		updatesCheckOnStartup: true,
		...overrides,
	};
}

function request(protocol: "responses" | "chat_completions"): ProviderRequest {
	return {
		provider: "compatible",
		protocol,
		model: "gpt-test",
		instructions: "system",
		messages: [{ role: "user", content: "hello" }],
		tools: [],
	};
}

function contextItem(text: string, role?: "developer" | "user") {
	return {
		type: "context" as const,
		text,
		metadata: {
			kind: "hook_context" as const,
			...(role ? { role } : {}),
			cacheClass: "ephemeral" as const,
			durability: "persistent" as const,
			scope: "turn" as const,
			sourceId: `hook-${role ?? "user"}`,
			contentSha256: "a".repeat(64),
			contentLength: text.length,
		},
	};
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
	const result: ProviderEvent[] = [];
	for await (const event of stream) result.push(event);
	return result;
}
