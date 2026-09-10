import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderRequest } from "@mycli/core";
import {
	createPiAiSnapshot,
	piAiRequestModel,
	type PiAiModelConfig,
} from "../../src/pi-ai/pi-ai-model.ts";

test("builds immutable models for every supported protocol", async () => {
	for (const [protocol, api] of [
		["responses", "openai-responses"],
		["chat_completions", "openai-completions"],
		["anthropic_messages", "anthropic-messages"],
	] as const) {
		const snapshot = await createPiAiSnapshot(config({ protocol }));
		assert.equal(snapshot.api, api);
		assert.equal(snapshot.model.baseUrl, "https://custom.example/v1");
		assert.equal(snapshot.model.id, "uncatalogued-model");
		assert.deepEqual(snapshot.model.input, ["text", "image"]);
		assert.equal(snapshot.model.contextWindow, 200_000);
		assert.equal(snapshot.model.maxTokens, 32_000);
		const transportProvider = protocol === "responses" ? "openai" : "compatible";
		assert.equal(snapshot.model.provider, transportProvider);
		assert.equal(snapshot.models.getProvider(transportProvider)?.id, transportProvider);
	}
	const catalogued = await createPiAiSnapshot(config({
		provider: "openai",
		model: "gpt-5.5",
	}));
	assert.equal(catalogued.model.id, "gpt-5.5");
	assert.equal(catalogued.model.baseUrl, "https://custom.example/v1");
});

test("captures immutable catalog-backed model and provider snapshots", async () => {
	for (const [provider, protocol, model] of [
		["openai", "responses", "gpt-5.5"],
		["deepseek", "chat_completions", "deepseek-v4-flash"],
		["anthropic", "anthropic_messages", "claude-opus-4-7"],
	] as const) {
		const snapshot = await createPiAiSnapshot(config({ provider, protocol, model }));
		assert.equal(snapshot.model.provider, provider);
		assert.equal(snapshot.model.id, model);
		assert.equal(snapshot.model.baseUrl, "https://custom.example/v1");
		assert.equal(snapshot.model.contextWindow, 200_000);
		assert.equal(snapshot.model.maxTokens, 32_000);
		assert(Object.isFrozen(snapshot));
		assert(Object.isFrozen(snapshot.model));
		assert(Object.isFrozen(snapshot.model.input));
		assert(Object.isFrozen(snapshot.model.cost));
		assert(Object.isFrozen(snapshot.model.compat));
		const routeProvider = snapshot.models.getProvider(provider);
		assert(routeProvider);
		assert(Object.isFrozen(routeProvider));
		assert(Object.isFrozen(routeProvider.getModels()));
		assert.strictEqual(routeProvider.getModels()[0], snapshot.model);
	}
});

test("uses pi-ai-declared fallbacks when a route API is absent from the catalog", async () => {
	for (const [provider, protocol] of [
		["openai", "chat_completions"],
		["qwen", "chat_completions"],
		["codex", "responses"],
		["compatible", "anthropic_messages"],
	] as const) {
		const snapshot = await createPiAiSnapshot(config({ provider, protocol }));
		const transportProvider = protocol === "responses" ? "openai" : provider;
		assert.equal(snapshot.model.provider, transportProvider);
		assert.equal(snapshot.model.api, protocol === "responses"
			? "openai-responses"
			: protocol === "chat_completions"
				? "openai-completions"
				: "anthropic-messages");
		assert.equal(snapshot.models.getProvider(transportProvider)?.id, transportProvider);
	}
});

test("maps max and ultra to distinct pi-ai wire values", async () => {
	const snapshot = await createPiAiSnapshot(config());
	const maximum = piAiRequestModel(snapshot, request({ reasoningEffort: "max" }));
	const ultra = piAiRequestModel(snapshot, request({ reasoningEffort: "ultra" }));

	assert.equal(maximum.reasoning, "max");
	assert.equal(maximum.model.thinkingLevelMap?.max, "max");
	assert.equal(ultra.reasoning, "max");
	assert.equal(ultra.model.thinkingLevelMap?.max, "ultra");
});

test("uses pi-ai detection unless an explicit compat override is supplied", async () => {
	const detected = await createPiAiSnapshot(config({ protocol: "chat_completions" }));
	assert.equal(detected.model.compat, undefined);

	const declared = await createPiAiSnapshot(config({
		protocol: "chat_completions",
		compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
	}));
	assert.deepEqual(compat(declared), {
		supportsDeveloperRole: false,
		maxTokensField: "max_tokens",
	});

	const catalogBaseline = await createPiAiSnapshot(config({
		provider: "openai",
		model: "gpt-5.5",
	}));
	const catalogued = await createPiAiSnapshot(config({
		provider: "openai",
		model: "gpt-5.5",
		compat: { supportsDeveloperRole: false },
	}));
	assert.deepEqual(compat(catalogued), {
		...compat(catalogBaseline),
		supportsDeveloperRole: false,
	});
});

const CURATED_DEFAULTS = [
	["openrouter", "openrouter/auto", "openrouter"],
	["groq", "openai/gpt-oss-120b", "openai"],
	["together", "moonshotai/Kimi-K2.7-Code", "together"],
	["moonshotai", "kimi-k2.7-code", "deepseek"],
	["nvidia", "openai/gpt-oss-120b", "openai"],
	["cerebras", "gpt-oss-120b", "openai"],
] as const satisfies readonly [PiAiModelConfig["provider"], string, string][];

test("clones curated pi-ai defaults and applies explicit mycli overrides", async () => {
	for (const [provider, model, thinkingFormat] of CURATED_DEFAULTS) {
		const snapshot = await createPiAiSnapshot(config({
			provider,
			protocol: "chat_completions",
			model,
			supportsImages: false,
		}));

		assert.equal(snapshot.api, "openai-completions");
		assert.equal(snapshot.model.api, "openai-completions");
		assert.equal(snapshot.model.provider, provider);
		assert.equal(snapshot.model.id, model);
		assert.equal(snapshot.model.baseUrl, "https://custom.example/v1");
		assert.equal(snapshot.model.contextWindow, 200_000);
		assert.equal(snapshot.model.maxTokens, 32_000);
		assert.deepEqual(snapshot.model.input, ["text"]);
		assert.equal(compat(snapshot).thinkingFormat ?? "openai", thinkingFormat);
		assert.equal(snapshot.models.getProvider(provider)?.id, provider);
	}

	const nvidia = await createPiAiSnapshot(config({
		provider: "nvidia",
		protocol: "chat_completions",
		model: "openai/gpt-oss-120b",
	}));
	assert.deepEqual(nvidia.model.headers, { "NVCF-POLL-SECONDS": "3600" });
});

test("leaves uncatalogued curated model compatibility to pi-ai detection", async () => {
	for (const [provider] of CURATED_DEFAULTS) {
		const snapshot = await createPiAiSnapshot(config({
			provider,
			protocol: "chat_completions",
			model: "future-model",
			supportsImages: false,
		}));

		assert.equal(snapshot.model.provider, provider);
		assert.equal(snapshot.model.id, "future-model");
		assert.deepEqual(snapshot.model.input, ["text"]);
		assert.equal(snapshot.model.reasoning, false);
		assert.equal(snapshot.model.thinkingLevelMap, undefined);
		assert.equal(snapshot.model.compat, undefined);
	}
});

function config(overrides: Partial<PiAiModelConfig> = {}): PiAiModelConfig {
	return {
		provider: "compatible",
		protocol: "responses",
		model: "uncatalogued-model",
		apiBaseUrl: "https://custom.example/v1",
		apiKey: "test-key",
		supportsImages: true,
		modelContextWindowTokens: 200_000,
		maxOutputTokens: 32_000,
		maxPromptTokens: 180_000,
		...overrides,
	};
}

function compat(snapshot: Awaited<ReturnType<typeof createPiAiSnapshot>>): Readonly<Record<string, unknown>> {
	return snapshot.model.compat as Readonly<Record<string, unknown>> | undefined ?? {};
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
	return {
		provider: "compatible",
		protocol: "responses",
		model: "uncatalogued-model",
		instructions: "system",
		messages: [{ role: "user", content: "hello" }],
		tools: [],
		...overrides,
	};
}
