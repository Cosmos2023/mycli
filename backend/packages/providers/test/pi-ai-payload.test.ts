import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderRequest, ReasoningEffort } from "@mycli/core";
import { ProviderFailure } from "../src/errors.ts";
import type { PiAiModelConfig } from "../src/pi-ai-model.ts";
import { PiAiProvider } from "../src/pi-ai-provider.ts";
import {
	PARITY_REASONING_EFFORTS,
	PARITY_READ_TOOL,
	contextItem,
	parityRequest,
} from "./provider-parity-fixtures.ts";
import { startProviderMockServer } from "./provider-mock-server.ts";

test("lets pi-ai serialize Responses authority, cache, reasoning, images, and tools", async () => {
	const body = await capturePayload({
		...parityRequest("openai", "responses"),
		reasoningEffort: "ultra",
		maxOutputTokens: 7,
	});

	assert.equal(body.instructions, undefined);
	assert.equal(body.store, false);
	assert.equal(body.prompt_cache_key, "parity-session");
	assert.equal(body.prompt_cache_retention, "24h");
	assert.equal(body.max_output_tokens, 16);
	assert.equal(body.parallel_tool_calls, undefined);
	assert.deepEqual(body.reasoning, { effort: "ultra", summary: "auto" });
	assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
	const input = records(body.input);
	assert.deepEqual(input.slice(0, 2), [
		{
			role: "developer",
			content: "stable system policy\n\nstable developer policy\n\ndynamic developer policy",
		},
		{
			role: "user",
			content: [{ type: "input_text", text: "ordinary context" }],
		},
	]);
	assert.deepEqual(input[2], {
		role: "user",
		content: [
			{ type: "input_text", text: "inspect" },
			{
				type: "input_image",
				detail: "auto",
				image_url: "data:image/png;base64,aW1hZ2U=",
			},
		],
	});
	assert.deepEqual(body.tools, [{
		type: "function",
		name: "Read",
		description: "Read a file.",
		parameters: {
			type: "object",
			properties: { file_path: { type: "string" } },
			required: ["file_path"],
		},
	}]);
});

test("injects hosted web search into the pi-ai Responses tool array", async () => {
	const body = await capturePayload({
		...parityRequest("openai", "responses"),
		webSearchMode: "live",
	});

	assert.deepEqual(body.tools, [
		{
			type: "function",
			name: "Read",
			description: "Read a file.",
			parameters: {
				type: "object",
				properties: { file_path: { type: "string" } },
				required: ["file_path"],
			},
		},
		{ type: "web_search", external_web_access: true },
	]);
});

test("rejects hosted web search outside the Responses protocol before provider traffic", async () => {
	for (const request of [
		{ ...minimalRequest("compatible", "chat_completions"), webSearchMode: "live" as const },
		{ ...minimalRequest("anthropic", "anthropic_messages"), webSearchMode: "live" as const },
	]) {
		await assertUnsupportedBeforeRequest(request);
	}
});

test("lets pi-ai serialize compatible and Qwen Chat payloads", async () => {
	for (const provider of ["compatible", "qwen"] as const) {
		const body = await capturePayload(parityRequest(provider, "chat_completions"));
		assert.equal(body.store, false, provider);
		assert.equal(body.prompt_cache_key, "parity-session", provider);
		assert.equal(body.prompt_cache_retention, "24h", provider);
		assert.equal(body.max_completion_tokens, 12_000, provider);
		assert.deepEqual(records(body.messages).slice(0, 2), [
			{
				role: "developer",
				content: "stable system policy\n\nstable developer policy\n\ndynamic developer policy",
			},
			{ role: "user", content: "ordinary context" },
		], provider);
		assert.deepEqual(records(body.messages)[2], {
			role: "user",
			content: [
				{ type: "text", text: "inspect" },
				{
					type: "image_url",
					image_url: { url: "data:image/png;base64,aW1hZ2U=" },
				},
			],
		}, provider);
		assert.deepEqual(body.tools, [{
			type: "function",
			function: {
				name: "Read",
				description: "Read a file.",
				parameters: {
					type: "object",
					properties: { file_path: { type: "string" } },
					required: ["file_path"],
				},
				strict: false,
			},
		}], provider);
	}
});

test("lets pi-ai serialize Anthropic authority, cache, reasoning, images, tools, and replay", async () => {
	const base = parityRequest("anthropic", "anthropic_messages");
	const body = await capturePayload({
		...base,
		items: [
			...(base.items ?? []),
			{
				type: "assistant_tool_calls",
				text: "checking",
				calls: [{ callId: "toolu_1", name: "Read", argumentsJson: "{}" }],
				providerState: {
					provider: "anthropic",
					value: { thinkingBlocks: [{ thinking: "private", signature: "sig_1" }] },
				},
			},
			{
				type: "tool_result",
				callId: "toolu_1",
				toolName: "Read",
				output: "contents",
				success: true,
			},
		],
	});

	assert.deepEqual(body.system, [
		{
			type: "text",
			text: "stable system policy\n\nstable developer policy\n\ndynamic developer policy",
			cache_control: { type: "ephemeral", ttl: "1h" },
		},
	]);
	const messages = records(body.messages);
	assert.deepEqual(messages[1], {
		role: "user",
		content: [
			{ type: "text", text: "inspect" },
			{
				type: "image",
				source: {
					type: "base64",
					media_type: "image/png",
					data: "aW1hZ2U=",
				},
			},
		],
	});
	assert.deepEqual(records(messages[2]?.content).slice(0, 2), [
		{ type: "thinking", thinking: "private", signature: "sig_1" },
		{ type: "text", text: "checking" },
	]);
	assert.deepEqual(records(messages[2]?.content)[2], {
		type: "tool_use",
		id: "toolu_1",
		name: "Read",
		input: {},
	});
	assert.deepEqual(records(messages[3]?.content)[0], {
		type: "tool_result",
		tool_use_id: "toolu_1",
		content: "contents",
		is_error: false,
		cache_control: { type: "ephemeral", ttl: "1h" },
	});
	assert.equal(body.max_tokens, 15_072);
	assert.deepEqual(body.thinking, {
		type: "enabled",
		budget_tokens: 3_072,
		display: "summarized",
	});
	assert.deepEqual(body.tools, [{
		name: "Read",
		description: "Read a file.",
		eager_input_streaming: true,
		input_schema: {
			type: "object",
			properties: { file_path: { type: "string" } },
			required: ["file_path"],
		},
		cache_control: { type: "ephemeral", ttl: "1h" },
	}]);
});

test("lets pi-ai map cache retention for Responses and Anthropic", async () => {
	const responses = await capturePayloads((["none", "short", "long"] as const).map((cacheRetention) => ({
		...minimalRequest("openai", "responses"),
		sessionId: "cache-session",
		cacheRetention,
	})));
	assert.deepEqual(responses.map((body) => ({
		key: body.prompt_cache_key,
		retention: body.prompt_cache_retention,
	})), [
		{ key: undefined, retention: undefined },
		{ key: "cache-session", retention: undefined },
		{ key: "cache-session", retention: "24h" },
	]);

	const anthropic = await capturePayloads((["none", "short", "long"] as const).map((cacheRetention) => ({
		...minimalRequest("anthropic", "anthropic_messages"),
		sessionId: "cache-session",
		cacheRetention,
	})));
	assert.deepEqual(anthropic.map((body) => records(body.system)[0]?.cache_control), [
		undefined,
		{ type: "ephemeral" },
		{ type: "ephemeral", ttl: "1h" },
	]);
});

test("maps every reasoning effort to its protocol-specific wire value", async () => {
	const responses = await capturePayloads(PARITY_REASONING_EFFORTS.map((reasoningEffort) => ({
		...minimalRequest("openai", "responses"),
		reasoningEffort,
	})));
	const chat = await capturePayloads(PARITY_REASONING_EFFORTS.map((reasoningEffort) => ({
		...minimalRequest("compatible", "chat_completions"),
		reasoningEffort,
	})));
	const deepSeek = await capturePayloads(PARITY_REASONING_EFFORTS.map((reasoningEffort) => ({
		...minimalRequest("deepseek", "chat_completions"),
		model: "deepseek-reasoner",
		reasoningEffort,
	})));
	const anthropic = await capturePayloads(PARITY_REASONING_EFFORTS.map((reasoningEffort) => ({
		...minimalRequest("anthropic", "anthropic_messages"),
		reasoningEffort,
		maxOutputTokens: 12_000,
	})));

	for (const [index, effort] of PARITY_REASONING_EFFORTS.entries()) {
		assert.equal(reasoningEffort(responses[index]), effort === "none" ? undefined : effort);
		assert.equal(chat[index]?.reasoning_effort, effort === "none" ? undefined : effort);
		assert.deepEqual(deepSeek[index]?.thinking, effort === "none"
			? undefined
			: { type: "enabled" });
		assert.equal(
			deepSeek[index]?.reasoning_effort,
			effort === "none" ? undefined : effort,
		);
		assert.equal(
			thinkingBudget(anthropic[index]),
			anthropicBudget(effort),
		);
	}
});

test("disables Anthropic thinking when the output cap cannot contain its budget", async () => {
	const body = await capturePayload({
		...minimalRequest("anthropic", "anthropic_messages"),
		reasoningEffort: "high",
		maxOutputTokens: 3_072,
	});
	assert.equal(body.max_tokens, 3_072);
	assert.equal(body.thinking, undefined);
});

const CURATED_PAYLOAD_CASES = [
	["openrouter", "openrouter/auto", "medium", "system", "max_completion_tokens", true],
	["groq", "openai/gpt-oss-120b", "medium", "developer", "max_completion_tokens", true],
	["together", "moonshotai/Kimi-K2.7-Code", "high", "system", "max_tokens", false],
	["moonshotai", "kimi-k2.7-code", "high", "system", "max_tokens", false],
	["nvidia", "openai/gpt-oss-120b", "none", "system", "max_tokens", false],
	["cerebras", "gpt-oss-120b", "medium", "system", "max_completion_tokens", true],
] as const satisfies readonly [
	ProviderRequest["provider"],
	string,
	ReasoningEffort,
	"developer" | "system",
	"max_completion_tokens" | "max_tokens",
	boolean,
][];

test("uses pi-ai catalog compatibility for every curated default", async () => {
	for (const [provider, model, effort, developerRole, tokenField, strictTools] of CURATED_PAYLOAD_CASES) {
		const body = await capturePayload(curatedRequest(provider, model, effort));
		assert.equal(body[tokenField], 321, provider);
		assert.equal(
			body[tokenField === "max_tokens" ? "max_completion_tokens" : "max_tokens"],
			undefined,
			provider,
		);
		assert.equal(body.prompt_cache_key, undefined, provider);
		assert.deepEqual(records(body.messages).slice(0, 2), [
			{
				role: developerRole,
				content: "stable system policy\n\nstable developer policy\n\ndynamic developer policy",
			},
			{ role: "user", content: "inspect" },
		], provider);
		const tool = records(body.tools)[0];
		assert.equal(
			(tool?.function as Readonly<Record<string, unknown>> | undefined)?.strict,
			strictTools ? false : undefined,
			provider,
		);

		switch (provider) {
			case "openrouter":
				assert.deepEqual(body.reasoning, { effort: "medium" });
				break;
			case "groq":
			case "cerebras":
				assert.equal(body.reasoning_effort, "medium");
				break;
			case "together":
				assert.deepEqual(body.reasoning, { enabled: true });
				assert.equal(body.reasoning_effort, undefined);
				break;
			case "moonshotai":
				assert.deepEqual(body.thinking, { type: "enabled" });
				assert.equal(body.reasoning_effort, undefined);
				break;
			case "nvidia":
				assert.equal(body.reasoning, undefined);
				assert.equal(body.reasoning_effort, undefined);
				break;
		}
	}
});

test("uses pi-ai detection for an uncatalogued curated model", async () => {
	const body = await capturePayload(curatedRequest("openrouter", "future-model", "none"));
	assert.equal(body.max_tokens, undefined);
	assert.equal(body.max_completion_tokens, 321);
	assert.equal(body.store, false);
	assert.equal(body.prompt_cache_key, undefined);
	assert.equal(body.reasoning, undefined);
	assert.deepEqual(records(body.messages).slice(0, 2), [
		{
			role: "system",
			content: "stable system policy\n\nstable developer policy\n\ndynamic developer policy",
		},
		{ role: "user", content: "inspect" },
	]);
	assert.equal(
		(records(body.tools)[0]?.function as Readonly<Record<string, unknown>> | undefined)?.strict,
		false,
	);
});

test("rejects reasoning for a catalog model that does not support it", async () => {
	await assertUnsupportedBeforeRequest(
		curatedRequest("nvidia", "openai/gpt-oss-120b", "xhigh"),
	);
});

async function capturePayload(request: ProviderRequest): Promise<Readonly<Record<string, unknown>>> {
	return (await capturePayloads([request]))[0] ?? {};
}

async function capturePayloads(
	requests: readonly ProviderRequest[],
): Promise<readonly Readonly<Record<string, unknown>>[]> {
	const first = requests[0];
	assert(first);
	const server = await startProviderMockServer({ protocol: first.protocol });
	try {
		const provider = new PiAiProvider({
			config: configFor(first, server.baseUrl),
		});
		for (const request of requests) {
			for await (const event of provider.stream(request, {
				signal: new AbortController().signal,
			})) {
				// Consume the canonical stream so the complete request lifecycle is verified.
				void event;
			}
		}
		return server.requests.map((request) => request.body);
	} finally {
		await server.close();
	}
}

function configFor(request: ProviderRequest, baseUrl: string): PiAiModelConfig {
	return {
		provider: request.provider,
		protocol: request.protocol,
		model: request.model,
		apiBaseUrl: request.protocol === "anthropic_messages" ? baseUrl : `${baseUrl}/v1`,
		apiKey: "test-key",
		supportsImages: request.provider !== "deepseek",
		maxPromptTokens: 100_000,
		modelContextWindowTokens: 128_000,
		maxOutputTokens: 32_000,
	};
}

function minimalRequest(
	provider: ProviderRequest["provider"],
	protocol: ProviderRequest["protocol"],
): ProviderRequest {
	return {
		provider,
		protocol,
		model: `${provider}-test`,
		instructions: "system",
		messages: [{ role: "user", content: "hello" }],
		tools: [],
	};
}

function curatedRequest(
	provider: ProviderRequest["provider"],
	model: string,
	reasoningEffort: ReasoningEffort,
): ProviderRequest {
	return {
		provider,
		protocol: "chat_completions",
		model,
		reasoningEffort,
		instructions: "stable system policy",
		developerInstructions: ["stable developer policy"],
		messages: [],
		items: [
			contextItem("dynamic developer policy", "developer"),
			{ type: "user", text: "inspect" },
		],
		tools: [PARITY_READ_TOOL],
		maxOutputTokens: 321,
	};
}

async function assertUnsupportedBeforeRequest(request: ProviderRequest): Promise<void> {
	const server = await startProviderMockServer({ protocol: request.protocol });
	try {
		const provider = new PiAiProvider({ config: configFor(request, server.baseUrl) });
		await assert.rejects(
			async () => {
				for await (const event of provider.stream(request, {
					signal: new AbortController().signal,
				})) void event;
			},
			(error: unknown) => error instanceof ProviderFailure
				&& error.code === "unsupported_capability",
		);
		assert.equal(server.requests.length, 0);
	} finally {
		await server.close();
	}
}

function records(value: unknown): readonly Readonly<Record<string, unknown>>[] {
	assert(Array.isArray(value));
	return value as readonly Readonly<Record<string, unknown>>[];
}

function reasoningEffort(body: Readonly<Record<string, unknown>> | undefined): unknown {
	const reasoning = body?.reasoning;
	return reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)
		? (reasoning as Readonly<Record<string, unknown>>).effort
		: undefined;
}

function thinkingBudget(body: Readonly<Record<string, unknown>> | undefined): unknown {
	const thinking = body?.thinking;
	return thinking && typeof thinking === "object" && !Array.isArray(thinking)
		? (thinking as Readonly<Record<string, unknown>>).budget_tokens
		: undefined;
}

function anthropicBudget(effort: ReasoningEffort): number | undefined {
	switch (effort) {
		case "none": return undefined;
		case "minimal":
		case "low": return 1_024;
		case "medium": return 1_536;
		case "high": return 3_072;
		case "xhigh":
		case "max":
		case "ultra": return 6_144;
	}
}
