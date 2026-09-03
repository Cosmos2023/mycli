import assert from "node:assert/strict";
import test from "node:test";
import {
	BUILTIN_MODEL_CATALOG,
	listProviderProfiles,
	type ModelProviderDeclaration,
} from "@mycli/config";
import { parseProviderRouteId } from "@mycli/core";
import type {
	ProviderDirectoryEntry,
	ProviderDirectorySnapshot,
	ProviderInputModality,
	ProviderModelDirectoryEntry,
} from "@mycli/providers";
import {
	assembleProviderModelDirectory,
	ProviderModelDirectory,
	type ProviderModelCurrentConfig,
} from "../src/node-runtime/provider-model-directory.ts";

const CURRENT: ProviderModelCurrentConfig = Object.freeze({
	provider: "openai",
	protocol: "responses",
	model: "gpt-custom",
	apiBaseUrl: "https://api.openai.com/v1",
	authRef: "openai-session",
	reasoningEffort: "high",
	thinkingEnabled: true,
	supportsImages: true,
	webSearchMode: "live",
});

const CLOUDFLARE = parseProviderRouteId("cloudflare-ai-gateway");
const CLOUDFLARE_CHAT = parseProviderRouteId("cloudflare-chat");
const PRIVATE_GATEWAY = parseProviderRouteId("private-gateway");
const MISSING_UPSTREAM = parseProviderRouteId("missing-upstream");

test("assembles catalog-backed stable routes with sparse provider-local overrides", () => {
	const snapshot = assemble([{
		provider: "openai",
		protocol: "responses",
		baseUrl: "https://api.openai.com/v1",
		authRef: "openai-user",
		models: [{ model: "gpt-5", displayName: "User GPT" }],
	}], catalog([
		provider("openai", "OpenAI", "https://api.openai.com/v1", [
			model("openai", "gpt-5", "responses", {
				input: ["text", "image"],
				reasoningEfforts: ["low", "medium", "high"],
				contextWindowTokens: 400_000,
				maxOutputTokens: 128_000,
			}),
			model("openai", "gpt-extra", "responses"),
		]),
	]));

	const route = snapshot.route("openai");
	assert.equal(route?.source, "pi_ai_builtin");
	assert.equal(route?.supportTier, "stable");
	assert.equal(route?.catalogProviderId, "openai");
	assert.deepEqual(route?.modelPolicy, { kind: "catalog" });
	assert.equal(route?.authRef, CURRENT.authRef);
	const models = snapshot.models("openai");
	assert.deepEqual(models.map((entry) => entry.model), ["gpt-custom", "gpt-5", "gpt-extra"]);
	assert.equal(models[0]?.origin, "current_custom");
	assert.equal(models[0]?.isCurrent, true);
	assert.equal(models[0]?.authRef, CURRENT.authRef);
	assert.equal(models[1]?.displayName, "User GPT");
	assert.equal(models[1]?.authRef, "openai-user");
	assert.equal(models[1]?.contextWindowTokens, 400_000);
	assert.equal(models[1]?.supportsImages, true);
	assert.deepEqual(models[1]?.supportedReasoningEfforts, ["low", "medium", "high"]);
	assert.equal(models[2]?.origin, "pi_ai_catalog");
	assert.ok(Object.isFrozen(snapshot));
	assert.ok(Object.isFrozen(snapshot.routes));
	assert.ok(models.every(Object.isFrozen));
});

test("inherits new DeepSeek catalog models unless an explicit subset is configured", () => {
	const declaration: ModelProviderDeclaration = {
		provider: "deepseek",
		protocol: "chat_completions",
		baseUrl: "https://api.deepseek.com",
		authRef: "deepseek",
		models: [
			{ model: "deepseek-v4-flash" },
			{ model: "deepseek-v4-pro" },
		],
	};
	const deepseekCatalog = catalog([
		provider("deepseek", "DeepSeek", "https://api.deepseek.com", [
			model("deepseek", "deepseek-v4-flash", "chat_completions"),
			model("deepseek", "deepseek-v4-flash-vision-exp", "chat_completions", {
				input: ["text", "image"],
			}),
			model("deepseek", "deepseek-v4-pro", "chat_completions"),
		]),
	]);

	const inherited = assemble([declaration], deepseekCatalog);
	assert.deepEqual(inherited.route("deepseek")?.modelPolicy, { kind: "catalog" });
	assert.deepEqual(inherited.models("deepseek").map((entry) => entry.model), [
		"deepseek-v4-flash",
		"deepseek-v4-flash-vision-exp",
		"deepseek-v4-pro",
	]);
	assert.equal(inherited.models("deepseek")[1]?.supportsImages, true);

	const restricted = assemble([{ ...declaration, modelPolicy: "subset" }], deepseekCatalog);
	assert.deepEqual(restricted.route("deepseek")?.modelPolicy, {
		kind: "subset",
		modelIds: ["deepseek-v4-flash", "deepseek-v4-pro"],
	});
	assert.deepEqual(restricted.models("deepseek").map((entry) => entry.model), [
		"deepseek-v4-flash",
		"deepseek-v4-pro",
	]);
});

test("assembles an explicit mixed-protocol catalog alias", () => {
	const snapshot = assemble([{
		provider: CLOUDFLARE_CHAT,
		protocol: "chat_completions",
		baseUrl: "https://gateway.example/v1",
		authRef: "cloudflare-chat-key",
		catalogProvider: CLOUDFLARE,
	}], catalog([
		provider(CLOUDFLARE, "Cloudflare AI Gateway", undefined, [
			model(CLOUDFLARE, "responses-model", "responses"),
			model(CLOUDFLARE, "chat-model", "chat_completions"),
		]),
	]));

	const route = snapshot.route(CLOUDFLARE_CHAT);
	assert.equal(route?.supportTier, "experimental");
	assert.equal(route?.source, "pi_ai_builtin");
	assert.equal(route?.catalogProviderId, CLOUDFLARE);
	assert.equal(route?.apiBaseUrl, "https://gateway.example/v1");
	assert.deepEqual(snapshot.models(CLOUDFLARE_CHAT).map((entry) => entry.model), ["chat-model"]);
});

test("keeps stable fallback models and the exact uncatalogued DeepSeek current model", () => {
	const current = Object.freeze({
		...CURRENT,
		provider: "deepseek" as const,
		protocol: "chat_completions" as const,
		model: "deepseek-reasoner",
		apiBaseUrl: "https://api.deepseek.com",
		authRef: "deepseek",
		supportsImages: false,
		webSearchMode: "disabled" as const,
	});
	const snapshot = assemble([], catalog([
		provider("deepseek", "DeepSeek", "https://api.deepseek.com", [
			model("deepseek", "deepseek-v4-flash", "chat_completions"),
		]),
	]), current);

	assert.deepEqual(snapshot.models("deepseek").map((entry) => entry.model), [
		"deepseek-reasoner",
		"deepseek-v4-flash",
	]);
	assert.equal(snapshot.models("deepseek")[0]?.isCurrent, true);
	assert.equal(snapshot.route("qwen")?.source, "pi_ai_declared");
	assert.deepEqual(snapshot.models("qwen").map((entry) => entry.model), [
		"qwen3.6-plus",
		"qwen3-coder-plus",
	]);
});

test("fills a sparse uncatalogued current model from its exact runtime config", () => {
	const snapshot = assemble([{
		provider: "openai",
		protocol: "responses",
		authRef: CURRENT.authRef,
		models: [{ model: CURRENT.model, displayName: "Current custom GPT" }],
	}], catalog([
		provider("openai", "OpenAI", CURRENT.apiBaseUrl, [
			model("openai", "gpt-catalogued", "responses"),
		]),
	]));

	assert.deepEqual(snapshot.models("openai").map((entry) => entry.model), [
		CURRENT.model,
		"gpt-catalogued",
	]);
	assert.deepEqual(snapshot.models("openai")[0], {
		provider: "openai",
		protocol: "responses",
		model: CURRENT.model,
		displayName: "Current custom GPT",
		description: "Current configured model",
		baseUrl: CURRENT.apiBaseUrl,
		authRef: CURRENT.authRef,
		supportedReasoningEfforts: [CURRENT.reasoningEffort],
		defaultReasoningEffort: CURRENT.reasoningEffort,
		supportsImages: true,
		supportsHostedWebSearch: true,
		isDefault: false,
		isCurrent: true,
		origin: "current_custom",
	});
});

test("fills a sparse stable model absent from pi-ai from product fallback metadata", () => {
	const stableModel = BUILTIN_MODEL_CATALOG.find((entry) =>
		entry.provider === "openai"
		&& entry.protocol === "responses"
		&& entry.model === "gpt-5.6");
	assert(stableModel);
	const snapshot = assemble([{
		provider: "openai",
		protocol: "responses",
		authRef: CURRENT.authRef,
		models: [{ model: stableModel.model }],
	}], catalog([
		provider("openai", "OpenAI", CURRENT.apiBaseUrl, [
			model("openai", "gpt-catalogued", "responses"),
		]),
	]));

	const resolved = snapshot.models("openai").find((entry) => entry.model === stableModel.model);
	assert(resolved);
	assert.equal(resolved.contextWindowTokens, stableModel.contextWindowTokens);
	assert.equal(resolved.maxOutputTokens, stableModel.maxOutputTokens);
	assert.equal(resolved.supportsImages, stableModel.supportsImages);
});

test("assembles complete compatible routes without catalog metadata", () => {
	const snapshot = assemble([{
		provider: PRIVATE_GATEWAY,
		protocol: "chat_completions",
		baseUrl: "https://private.example/v1",
		authRef: "private-key",
		source: "pi_ai_declared",
		compat: { supportsStore: false, maxTokensField: "max_tokens" },
		models: [{
			model: "private-model",
			contextWindowTokens: 64_000,
			maxOutputTokens: 8_000,
			supportsImages: false,
			compat: { supportsStore: true },
		}],
	}], catalog([]));

	const route = snapshot.route(PRIVATE_GATEWAY);
	assert.equal(route?.supportTier, "compatible");
	assert.equal(route?.source, "pi_ai_declared");
	assert.equal(route?.catalogProviderId, undefined);
	assert.deepEqual(route?.compat, { supportsStore: false, maxTokensField: "max_tokens" });
	assert.deepEqual(route?.modelCompat, { "private-model": { supportsStore: true } });
	assert(Object.isFrozen(route?.compat));
	assert(Object.isFrozen(route?.modelCompat?.["private-model"]));
	assert.deepEqual(snapshot.models(PRIVATE_GATEWAY).map((entry) => entry.model), ["private-model"]);
});

test("rejects an empty catalog subset even when config parsing is bypassed", () => {
	assert.throws(() => assemble([{
		provider: "deepseek",
		protocol: "chat_completions",
		authRef: "deepseek",
		modelPolicy: "subset",
	}], catalog([
		provider("deepseek", "DeepSeek", "https://api.deepseek.com", [
			model("deepseek", "deepseek-v4-pro", "chat_completions"),
		]),
	])), /subset requires at least one declared model/i);
});

test("rejects compat fields from another pi-ai API", () => {
	assert.throws(() => assemble([{
		provider: PRIVATE_GATEWAY,
		protocol: "responses",
		baseUrl: "https://private.example/v1",
		authRef: "private-key",
		source: "pi_ai_declared",
		compat: { thinkingFormat: "deepseek" },
		models: [{
			model: "private-model",
			contextWindowTokens: 64_000,
			maxOutputTokens: 8_000,
			supportsImages: false,
		}],
	}], catalog([])), /compat field/u);
});

test("rejects unserviceable catalog routes and retains the last valid directory snapshot", async () => {
	let declarations: readonly ModelProviderDeclaration[] = [];
	const directory = new ProviderModelDirectory({
		homeDir: "/unused",
		loadDeclarations: async () => declarations,
		loadCatalog: async () => catalog([]),
	});
	const first = await directory.load(CURRENT);
	declarations = [{
		provider: MISSING_UPSTREAM,
		protocol: "chat_completions",
		authRef: "missing-upstream",
		source: "pi_ai_builtin",
	}];

	await assert.rejects(
		() => directory.load(CURRENT),
		/not serviceable/i,
	);
	assert.strictEqual(directory.current(), first);
});

test("publishes concurrent directory loads in invocation order with monotonic versions", async () => {
	let releaseFirst: (() => void) | undefined;
	let declarationLoads = 0;
	const firstLoadHeld = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const directory = new ProviderModelDirectory({
		homeDir: "/unused",
		loadDeclarations: async () => {
			declarationLoads += 1;
			if (declarationLoads === 1) await firstLoadHeld;
			return [];
		},
		loadCatalog: async () => catalog([]),
	});
	const firstConfig = CURRENT;
	const secondConfig = Object.freeze({ ...CURRENT, model: "gpt-second" });

	const firstPromise = directory.load(firstConfig);
	const secondPromise = directory.load(secondConfig);
	await Promise.resolve();
	assert.equal(declarationLoads, 1);
	releaseFirst?.();

	const [first, second] = await Promise.all([firstPromise, secondPromise]);
	assert.equal(first.version, 1);
	assert.equal(second.version, 2);
	assert.equal(second.models("openai").some((entry) => entry.model === "gpt-second"), true);
	assert.strictEqual(directory.current(), second);
});

function assemble(
	declarations: readonly ModelProviderDeclaration[],
	providerCatalog: ProviderDirectorySnapshot,
	currentConfig: ProviderModelCurrentConfig = CURRENT,
) {
	return assembleProviderModelDirectory({
		version: 1,
		currentConfig,
		profiles: listProviderProfiles(),
		declarations,
		catalog: providerCatalog,
		stableFallbackModels: BUILTIN_MODEL_CATALOG,
	});
}

function catalog(providers: readonly ProviderDirectoryEntry[]): ProviderDirectorySnapshot {
	return Object.freeze({
		generatedAt: 1,
		providers: Object.freeze([...providers]),
	});
}

function provider(
	catalogProviderId: ProviderDirectoryEntry["catalogProviderId"],
	name: string,
	baseUrl: string | undefined,
	models: readonly ProviderModelDirectoryEntry[],
): ProviderDirectoryEntry {
	const protocols = Object.freeze([...new Set(models.map((entry) => entry.protocol))]);
	return Object.freeze({
		catalogProviderId,
		name,
		...(baseUrl === undefined ? {} : { baseUrl }),
		protocols,
		apiKeyServiceable: true,
		endpointRequired: baseUrl === undefined,
		status: baseUrl === undefined || protocols.length !== 1
			? "configuration_required"
			: "serviceable",
		models: Object.freeze([...models]),
	});
}

function model(
	catalogProviderId: ProviderModelDirectoryEntry["catalogProviderId"],
	id: string,
	protocol: ProviderModelDirectoryEntry["protocol"],
	overrides: Partial<ProviderModelDirectoryEntry> = {},
): ProviderModelDirectoryEntry {
	return Object.freeze({
		catalogProviderId,
		id,
		name: id,
		protocol,
		input: Object.freeze<readonly ProviderInputModality[]>(["text"]),
		reasoningEfforts: Object.freeze([]),
		contextWindowTokens: 128_000,
		maxOutputTokens: 16_384,
		...overrides,
	});
}
