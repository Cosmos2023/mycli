import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent, ProviderRequest } from "@mycli/core";
import { ProviderFailure, providerFailureToRuntimeFailure } from "../../src/errors.ts";
import type { PiAiModelConfig } from "../../src/pi-ai/pi-ai-model.ts";
import { PiAiProvider } from "../../src/pi-ai/pi-ai-provider.ts";
import { providerStreamFixture } from "../support/provider-stream-fixtures.ts";

test("explicit reasoning off reaches the real SDK wire without erasing model capability", async (t) => {
	const cases: readonly { provider: ProviderRequest["provider"]; protocol: ProviderRequest["protocol"];
		model: string; expected: Readonly<Record<string, unknown>>; compat?: PiAiModelConfig["compat"] }[] = [
		{ provider: "deepseek", protocol: "chat_completions", model: "deepseek-v4-flash", expected: { thinking: { type: "disabled" } } },
		{ provider: "deepseek", protocol: "chat_completions", model: "deepseek-v4-flash-vision-exp", expected: { thinking: { type: "disabled" } } },
		{ provider: "qwen", protocol: "chat_completions", model: "private-qwen", compat: { thinkingFormat: "qwen" }, expected: { enable_thinking: false } },
		{ provider: "openai", protocol: "responses", model: "gpt-5.5", expected: { reasoning: { effort: "none" } } },
		{ provider: "anthropic", protocol: "anthropic_messages", model: "claude-sonnet-4-5", expected: { thinking: { type: "disabled" } } },
	];
	for (const entry of cases) await t.test(entry.model, async () => {
		let body: Record<string, unknown> = {};
		const provider = new PiAiProvider({ config: { ...entry, apiKey: "fixture", apiBaseUrl: "https://offline.invalid/v1",
			supportsImages: false, maxOutputTokens: 8000 }, fetch: async (_url, init) => {
			body = JSON.parse(init!.body as string) as Record<string, unknown>;
			return providerStreamFixture(entry.protocol, "healthy");
		} });
		const request: ProviderRequest = { provider: entry.provider, protocol: entry.protocol, model: entry.model,
			instructions: "Summarize.", messages: [{ role: "user", content: "Context" }], tools: [], reasoningEffort: "none", maxOutputTokens: 4096 };
		assert.equal((await collect(provider, request)).at(-1)?.type, "completed");
		for (const [key, value] of Object.entries(entry.expected)) assert.deepEqual(body[key], value);
		assert.equal(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens, 4096);
		if (entry.provider === "deepseek") assert.equal(body.reasoning_effort, undefined);
	});
});

test("fixed-thinking catalog models reject off before any HTTP request", async () => {
	let calls = 0;
	const provider = new PiAiProvider({ config: { provider: "openai", model: "gpt-5", protocol: "responses",
		apiKey: "fixture", apiBaseUrl: "https://offline.invalid/v1", supportsImages: false },
		fetch: async () => { calls += 1; throw new Error("must not send"); } });
	const capabilities = await provider.resolveCapabilities();
	assert.equal(capabilities.reasoningEfforts?.includes("none"), false);
	assert.equal(capabilities.reasoningEfforts?.[0], "minimal");
	await assert.rejects(collect(provider, { provider: "openai", protocol: "responses", model: "gpt-5",
		instructions: "summary", messages: [], tools: [], reasoningEffort: "none" }),
		(error: unknown) => error instanceof ProviderFailure && error.errorReason?.reason === "capability.reasoning_unsupported");
	assert.equal(calls, 0);
});

test("generation output caps honor both configured and catalog model limits on the wire", async () => {
	let body: Record<string, unknown> = {};
	const provider = new PiAiProvider({ config: { provider: "openai", model: "gpt-5.5", protocol: "responses",
		apiKey: "fixture", apiBaseUrl: "https://offline.invalid/v1", supportsImages: false, maxOutputTokens: 1024 },
		fetch: async (_url, init) => { body = JSON.parse(init!.body as string) as Record<string, unknown>;
			return providerStreamFixture("responses", "healthy"); } });
	await collect(provider, { provider: "openai", protocol: "responses", model: "gpt-5.5",
		instructions: "summary", messages: [], tools: [], maxOutputTokens: 999_999, reasoningEffort: "none" });
	assert.equal(body.max_output_tokens, 1024);
	assert.equal((await provider.resolveCapabilities()).maxOutputTokens, 1024);
});

test("Anthropic thinking is included within the total request output ceiling", async () => {
	let body: Record<string, unknown> = {};
	const provider = new PiAiProvider({ config: { provider: "anthropic", protocol: "anthropic_messages", model: "claude-sonnet-4-5",
		apiKey: "fixture", apiBaseUrl: "https://offline.invalid/v1", supportsImages: false }, fetch: async (_url, init) => {
		body = JSON.parse(init!.body as string) as Record<string, unknown>;
		return providerStreamFixture("anthropic_messages", "healthy");
	} });
	await collect(provider, { provider: "anthropic", protocol: "anthropic_messages", model: "claude-sonnet-4-5",
		instructions: "summary", messages: [], tools: [], reasoningEffort: "low", maxOutputTokens: 6000 });
	assert.equal(body.max_tokens, 6000);
	assert.equal((body.thinking as { type: string }).type, "enabled");
	const capped = new PiAiProvider({ config: { provider: "anthropic", protocol: "anthropic_messages", model: "claude-sonnet-4-5",
		apiKey: "fixture", apiBaseUrl: "https://offline.invalid/v1", supportsImages: false, maxOutputTokens: 512 }, fetch: async (_url, init) => {
		body = JSON.parse(init!.body as string) as Record<string, unknown>;
		return providerStreamFixture("anthropic_messages", "healthy");
	} });
	await collect(capped, { provider: "anthropic", protocol: "anthropic_messages", model: "claude-sonnet-4-5",
		instructions: "summary", messages: [], tools: [], reasoningEffort: "high", maxOutputTokens: 6000 });
	assert.equal(body.max_tokens, 512);
	assert.deepEqual(body.thinking, { type: "disabled" });
});

test("reasoning-only length and empty terminal responses retain typed failures and reported usage", async () => {
	for (const finishReason of ["length", "stop"] as const) {
		const provider = new PiAiProvider({ config: { provider: "deepseek", protocol: "chat_completions", model: "deepseek-v4-flash-vision-exp",
			apiKey: "fixture", apiBaseUrl: "https://offline.invalid/v1", supportsImages: false }, fetch: async () => {
			const frames = [
				{ id: "summary", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Internal reasoning" }, finish_reason: null }] },
				{ id: "summary", choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
				{ id: "summary", choices: [], usage: { prompt_tokens: 128, completion_tokens: 4096, total_tokens: 4224,
					completion_tokens_details: { reasoning_tokens: 4096 } } },
			];
			return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
				{ headers: { "content-type": "text/event-stream" } });
		} });
		const events: ProviderEvent[] = [];
		await assert.rejects(async () => {
			for await (const event of provider.stream({ provider: "deepseek", protocol: "chat_completions", model: "deepseek-v4-flash-vision-exp",
				instructions: "summary", messages: [], tools: [], reasoningEffort: "none", maxOutputTokens: 4096 },
			{ signal: new AbortController().signal })) events.push(event);
		}, (error: unknown) => {
			assert(error instanceof ProviderFailure);
			const failure = providerFailureToRuntimeFailure(error, { errorContextVersion: 1, scope: { kind: "provider_attempt", id: "summary" } });
			assert.equal(failure.errorContext?.reason, finishReason === "length" ? "provider.output_limit" : "provider.empty_response");
			assert.equal(failure.errorContext?.details?.finish_reason, finishReason);
			return true;
		});
		const usage = events.filter((event) => event.type === "usage");
		assert.equal(usage.length, 1);
		assert.equal(usage[0]?.usage.output_tokens, 4096);
		assert.equal(usage[0]?.usage.reasoning_tokens, 4096);
		assert.equal(events.some((event) => event.type === "completed" || event.type === "text_delta"), false);
	}
});

test("a terminal output-limit response without usage is unknown rather than free", async () => {
	const provider = new PiAiProvider({ config: { provider: "deepseek", protocol: "chat_completions", model: "deepseek-v4-flash",
		apiKey: "fixture", apiBaseUrl: "https://offline.invalid/v1", supportsImages: false }, fetch: async () => new Response(
		'data: {"id":"limit","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
		{ headers: { "content-type": "text/event-stream" } }) });
	const events: ProviderEvent[] = [];
	await assert.rejects(async () => {
		for await (const event of provider.stream({ provider: "deepseek", protocol: "chat_completions", model: "deepseek-v4-flash",
			instructions: "summary", messages: [], tools: [], reasoningEffort: "none" }, { signal: new AbortController().signal })) events.push(event);
	}, (error: unknown) => error instanceof ProviderFailure && error.errorReason?.reason === "provider.output_limit");
	assert.deepEqual(events, [{ type: "usage", usage: {} }]);
});

async function collect(provider: PiAiProvider, request: ProviderRequest): Promise<readonly ProviderEvent[]> {
	const events: ProviderEvent[] = [];
	for await (const event of provider.stream(request, { signal: new AbortController().signal })) events.push(event);
	return events;
}
