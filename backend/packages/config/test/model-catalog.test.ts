import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	BUILTIN_MODEL_CATALOG,
	builtinModelReasoningDefaults,
	findModelCatalogEntry,
	loadModelCatalog,
	loadModelProviderDeclarations,
	modelCatalogEntryPayload,
	modelInputTokenLimit,
} from "../src/index.ts";

const CURRENT = Object.freeze({
	provider: "openai" as const,
	protocol: "responses" as const,
	model: "private-current",
	apiBaseUrl: "https://models.example/v1/",
	authRef: "private-account",
});

test("model catalog loads the legacy flat models.json and marks the exact current entry", async (t) => {
	const homeDir = await temporaryDirectory(t);
	await writeCatalog(homeDir, [
		{
			model: "other-model",
			provider: "openai",
			protocol: "responses",
			base_url: "https://api.openai.com/v1",
			auth_ref: "openai",
		},
		{
			model: "private-current",
			provider: "openai",
			protocol: "responses",
			base_url: "https://models.example/v1",
			auth_ref: "private-account",
			description: "Configured endpoint",
			capabilities: { images: false },
			reasoning_efforts: ["low", "high", "max"],
			default_reasoning_effort: "high",
		},
	]);

	const entries = await loadModelCatalog({ homeDir, currentConfig: CURRENT });
	const declarations = await loadModelProviderDeclarations(homeDir);
	assert.equal(entries.length, BUILTIN_MODEL_CATALOG.length + 2);
	assert.equal(declarations[0]?.modelPolicy, "subset");
	assert.equal(entries[0]?.model, "private-current");
	assert.equal(entries[0]?.isCurrent, true);
	assert.deepEqual(entries[0]?.supportedReasoningEfforts, ["low", "high", "max"]);
	assert.equal(entries[0]?.defaultReasoningEffort, "high");
	assert.equal(entries[0]?.supportsImages, false);
	assert.equal(entries[1]?.isCurrent, false);
	assert.equal(
		findModelCatalogEntry(entries, {
			provider: "openai",
			protocol: "responses",
			model: "private-current",
			baseUrl: "https://models.example/v1/",
		}),
		entries[0],
	);
	const payload = modelCatalogEntryPayload(entries[0]!);
	assert.equal(payload.current, true);
	assert.equal(payload.default_reasoning_effort, "high");
	assert.equal("auth_ref" in payload, false);
});

test("model catalog v2 inherits provider settings and validates model capabilities", async (t) => {
	const homeDir = await temporaryDirectory(t);
	await writeProviderCatalog(homeDir, {
		openai: {
			protocol: "responses",
			base_url: "https://models.example/v1/",
			auth_ref: "private-account",
			options: { store: false },
			capabilities: { images: true, web_search: true },
			models: {
				"private-current": {
					name: "Private Current",
					description: "Configured endpoint",
					limits: {
						context_window_tokens: 200_000,
						max_output_tokens: 50_000,
					},
					reasoning: {
						efforts: ["low", "high", "max"],
						default: "high",
					},
				},
			},
		},
	});

	const entries = await loadModelCatalog({ homeDir, currentConfig: CURRENT });
	assert.equal(entries.length, BUILTIN_MODEL_CATALOG.length + 1);
	const entry = entries[0]!;
	assert.equal(entry.displayName, "Private Current");
	assert.equal(entry.baseUrl, "https://models.example/v1");
	assert.equal(entry.authRef, "private-account");
	assert.equal(entry.contextWindowTokens, 200_000);
	assert.equal(entry.maxOutputTokens, 50_000);
	assert.equal(entry.supportsImages, true);
	assert.equal(entry.supportsHostedWebSearch, true);
	assert.equal(modelInputTokenLimit(entry), 150_000);
	assert.deepEqual(entry.supportedReasoningEfforts, ["low", "high", "max"]);
	assert.equal(entry.defaultReasoningEffort, "high");
	assert.deepEqual(modelCatalogEntryPayload(entry), {
		provider: "openai",
		protocol: "responses",
		model: "private-current",
		name: "Private Current",
		description: "Configured endpoint",
		base_url: "https://models.example/v1",
		supported_reasoning_efforts: ["low", "high", "max"],
		default_reasoning_effort: "high",
		context_window_tokens: 200_000,
		max_output_tokens: 50_000,
		supports_images: true,
		default: false,
		current: true,
	});
});

test("model provider declarations allow catalog-backed routes to omit endpoint and models", async (t) => {
	const homeDir = await temporaryDirectory(t);
	await writeProviderCatalog(homeDir, {
		fireworks: {
			source: "pi_ai_builtin",
			protocol: "chat_completions",
			auth_ref: "fireworks-primary",
		},
		"openrouter-responses": {
			catalog_provider: "openrouter",
			protocol: "responses",
			auth_ref: "openrouter-responses",
		},
	});

	const declarations = await loadModelProviderDeclarations(homeDir);
	assert.deepEqual(declarations, [
		{
			provider: "fireworks",
			protocol: "chat_completions",
			authRef: "fireworks-primary",
			source: "pi_ai_builtin",
		},
		{
			provider: "openrouter-responses",
			protocol: "responses",
			authRef: "openrouter-responses",
			catalogProvider: "openrouter",
		},
	]);
	assert.ok(Object.isFrozen(declarations));
	assert.ok(declarations.every(Object.isFrozen));
});

test("model provider declarations parse explicit catalog model policies", async (t) => {
	const homeDir = await temporaryDirectory(t);
	await writeProviderCatalog(homeDir, {
		deepseek: {
			protocol: "chat_completions",
			model_policy: "subset",
			models: {
				"deepseek-v4-flash": {},
				"deepseek-v4-pro": {},
			},
		},
		fireworks: {
			source: "pi_ai_builtin",
			protocol: "chat_completions",
			model_policy: "catalog",
		},
	});

	const declarations = await loadModelProviderDeclarations(homeDir);
	assert.equal(declarations[0]?.modelPolicy, "subset");
	assert.deepEqual(declarations[0]?.models?.map((model) => model.model), [
		"deepseek-v4-flash",
		"deepseek-v4-pro",
	]);
	assert.equal(declarations[1]?.modelPolicy, "catalog");

	await writeProviderCatalog(homeDir, {
		deepseek: {
			protocol: "chat_completions",
			model_policy: "subset",
		},
	});
	await assert.rejects(
		() => loadModelProviderDeclarations(homeDir),
		/requires 'models' when model_policy is 'subset'/i,
	);

	await writeProviderCatalog(homeDir, {
		deepseek: {
			protocol: "chat_completions",
			model_policy: "automatic",
		},
	});
	await assert.rejects(
		() => loadModelProviderDeclarations(homeDir),
		/unsupported model_policy/i,
	);
});

test("model provider declaration discovery does not bootstrap a global catalog", async (t) => {
	const homeDir = await temporaryDirectory(t);
	assert.deepEqual(await loadModelProviderDeclarations(homeDir), []);
	await assert.rejects(
		() => stat(join(homeDir, ".mycli", "models.json")),
		(error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
	);
});

test("model provider declarations accept complete custom routes", async (t) => {
	const homeDir = await temporaryDirectory(t);
	await writeProviderCatalog(homeDir, {
		"private-gateway": {
			source: "pi_ai_declared",
			protocol: "chat_completions",
			base_url: "https://gateway.example/v1/",
			auth_ref: "private-gateway-key",
			capabilities: { images: false },
			models: {
				"private-model": {
					limits: {
						context_window_tokens: 64_000,
						max_output_tokens: 8_000,
					},
				},
			},
		},
	});

	const [declaration] = await loadModelProviderDeclarations(homeDir);
	assert.deepEqual(declaration, {
		provider: "private-gateway",
		protocol: "chat_completions",
		baseUrl: "https://gateway.example/v1",
		authRef: "private-gateway-key",
		source: "pi_ai_declared",
		models: [{
			model: "private-model",
			contextWindowTokens: 64_000,
			maxOutputTokens: 8_000,
			supportsImages: false,
		}],
	});
});

test("model provider declarations reject incomplete custom routes", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const base = {
		source: "pi_ai_declared",
		protocol: "chat_completions",
		base_url: "https://gateway.example/v1",
		auth_ref: "private-gateway-key",
		capabilities: { images: false },
		models: {
			"private-model": {
				limits: {
					context_window_tokens: 64_000,
					max_output_tokens: 8_000,
				},
			},
		},
	};

	for (const incomplete of [
		{ ...base, base_url: undefined },
		{ ...base, auth_ref: undefined },
		{ ...base, models: undefined },
		{ ...base, capabilities: undefined },
		{
			...base,
			models: {
				"private-model": { capabilities: { images: false } },
			},
		},
	]) {
		await writeProviderCatalog(homeDir, { "private-gateway": incomplete });
		await assert.rejects(
			() => loadModelProviderDeclarations(homeDir),
			/incomplete declared route/i,
		);
	}
});

test("builtin catalog includes current GPT and DeepSeek V4 model choices", () => {
	for (const model of ["gpt-5.5", "gpt-5.4-mini"]) {
		const entry = BUILTIN_MODEL_CATALOG.find((candidate) =>
			candidate.provider === "openai" && candidate.model === model);
		assert.ok(entry, `missing OpenAI model ${model}`);
		assert.deepEqual(entry.supportedReasoningEfforts, ["low", "medium", "high", "xhigh"]);
	}
	const luna = BUILTIN_MODEL_CATALOG.find((candidate) =>
		candidate.provider === "openai" && candidate.model === "gpt-5.6-luna");
	assert.ok(luna);
	assert.deepEqual(luna.supportedReasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
	assert.equal(luna.defaultReasoningEffort, "medium");
	for (const model of ["gpt-5.6-terra", "gpt-5.6-sol"]) {
		const entry = BUILTIN_MODEL_CATALOG.find((candidate) =>
			candidate.provider === "openai" && candidate.model === model);
		assert.ok(entry, `missing OpenAI model ${model}`);
		assert.deepEqual(entry.supportedReasoningEfforts,
			["low", "medium", "high", "xhigh", "max", "ultra"]);
	}
	assert.equal(BUILTIN_MODEL_CATALOG.find((entry) =>
		entry.provider === "openai" && entry.model === "gpt-5.6-sol")?.defaultReasoningEffort, "low");
	assert.deepEqual([...new Set(BUILTIN_MODEL_CATALOG.map((entry) => entry.provider))], [
		"openai",
		"deepseek",
		"qwen",
		"anthropic",
		"openrouter",
		"groq",
		"together",
		"moonshotai",
		"nvidia",
		"cerebras",
	]);
	for (const model of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
		const entry = BUILTIN_MODEL_CATALOG.find((candidate) =>
			candidate.provider === "deepseek" && candidate.model === model);
		assert.ok(entry, `missing DeepSeek model ${model}`);
		assert.deepEqual(entry.supportedReasoningEfforts, ["high", "max"]);
	}
});

test("builtin catalog pins each curated provider default", () => {
	const expected = [
		["openrouter", "openrouter/auto", "Auto Router", ["none", "minimal", "low", "medium", "high"], "medium", 2_000_000, 4_096],
		["groq", "openai/gpt-oss-120b", "GPT OSS 120B", ["low", "medium", "high"], "medium", 131_072, 65_536],
		["together", "moonshotai/Kimi-K2.7-Code", "Kimi K2.7 Code", ["none", "high"], "high", 262_144, 131_072],
		["moonshotai", "kimi-k2.7-code", "Kimi K2.7 Code", ["high"], "high", 262_144, 131_072],
		["nvidia", "openai/gpt-oss-120b", "GPT-OSS-120B", [], undefined, 128_000, 8_192],
		["cerebras", "gpt-oss-120b", "GPT OSS 120B", ["low", "medium", "high"], "medium", 131_072, 40_960],
	] as const;

	for (const [provider, model, name, efforts, defaultEffort, context, output] of expected) {
		const entry = BUILTIN_MODEL_CATALOG.find((candidate) => (
			candidate.provider === provider && candidate.model === model
		));
		assert.ok(entry, `missing curated model ${provider}/${model}`);
		assert.equal(entry.protocol, "chat_completions");
		assert.equal(entry.displayName, name);
		assert.deepEqual(entry.supportedReasoningEfforts, efforts);
		assert.equal(entry.defaultReasoningEffort, defaultEffort);
		assert.equal(entry.contextWindowTokens, context);
		assert.equal(entry.maxOutputTokens, output);
		assert.equal(entry.authRef, provider);
		assert.equal(entry.isDefault, true);
	}
});

test("builtin model reasoning defaults fail closed for uncatalogued models", () => {
	assert.deepEqual(builtinModelReasoningDefaults({
		provider: "together",
		protocol: "chat_completions",
		model: "moonshotai/Kimi-K2.7-Code",
	}), { reasoningEffort: "high", thinkingEnabled: true });
	assert.deepEqual(builtinModelReasoningDefaults({
		provider: "nvidia",
		protocol: "chat_completions",
		model: "openai/gpt-oss-120b",
	}), { reasoningEffort: "none", thinkingEnabled: false });
	assert.deepEqual(builtinModelReasoningDefaults({
		provider: "openrouter",
		protocol: "chat_completions",
		model: "custom-model",
	}), { reasoningEffort: "none", thinkingEnabled: false });
});

test("existing catalogs merge compiled defaults in memory without rewriting user bytes", async (t) => {
	const homeDir = await temporaryDirectory(t);
	await writeProviderCatalog(homeDir, {
		openrouter: {
			protocol: "chat_completions",
			base_url: "https://openrouter.ai/api/v1/",
			auth_ref: "user-openrouter-auth",
			models: {
				"openrouter/auto": {
					name: "User Auto Override",
					description: "User-owned catalog entry",
					limits: { context_window_tokens: 100_000, max_output_tokens: 10_000 },
					reasoning: { efforts: ["low"], default: "low" },
				},
			},
		},
	});
	const path = join(homeDir, ".mycli", "models.json");
	const before = await readFile(path, "utf8");
	const entries = await loadModelCatalog({ homeDir, currentConfig: CURRENT });
	const after = await readFile(path, "utf8");
	const openrouter = entries.filter((entry) => (
		entry.provider === "openrouter"
		&& entry.model === "openrouter/auto"
		&& entry.baseUrl === "https://openrouter.ai/api/v1"
	));

	assert.equal(after, before);
	assert.equal(openrouter.length, 1);
	assert.equal(openrouter[0]?.displayName, "User Auto Override");
	assert.equal(openrouter[0]?.authRef, "user-openrouter-auth");
	assert.equal(openrouter[0]?.contextWindowTokens, 100_000);
	assert.ok(entries.some((entry) => entry.provider === "cerebras" && entry.model === "gpt-oss-120b"));
	assert.equal(entries[0]?.model, CURRENT.model);
	assert.equal(entries[0]?.isCurrent, true);
	const identities = entries.map((entry) => [
		entry.provider,
		entry.protocol,
		entry.model,
		entry.baseUrl.replace(/\/+$/u, ""),
	].join("\0"));
	assert.equal(new Set(identities).size, entries.length);
	assert.ok(entries.length <= 32, `catalog unexpectedly grew to ${entries.length} entries`);
});

test("model catalog bootstraps the provider-grouped registry with private permissions", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const entries = await loadModelCatalog({ homeDir, currentConfig: CURRENT });
	const path = join(homeDir, ".mycli", "models.json");
	const raw = JSON.parse(await readFile(path, "utf8")) as {
		version: number;
		providers: Record<string, { models: Record<string, unknown> }>;
	};

	assert.equal(entries.length, BUILTIN_MODEL_CATALOG.length + 1);
	assert.equal(entries[0]?.model, CURRENT.model);
	assert.equal(entries[0]?.authRef, CURRENT.authRef);
	assert.equal(raw.version, 2);
	assert.equal(
		Object.values(raw.providers).reduce(
			(count, provider) => count + Object.keys(provider.models).length,
			0,
		),
		BUILTIN_MODEL_CATALOG.length,
	);
	if (process.platform !== "win32") {
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await stat(join(homeDir, ".mycli"))).mode & 0o777, 0o700);
	}
});

test("model catalog rejects duplicate identities and invalid reasoning defaults", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const duplicate = {
		model: "gpt-test",
		provider: "openai",
		protocol: "responses",
		base_url: "https://models.example/v1",
	};
	await writeCatalog(homeDir, [duplicate, { ...duplicate, auth_ref: "another" }]);
	await assert.rejects(
		() => loadModelCatalog({ homeDir, currentConfig: CURRENT }),
		/duplicate model entry/i,
	);

	await writeCatalog(homeDir, [{
		...duplicate,
		reasoning_efforts: ["low"],
		default_reasoning_effort: "high",
	}]);
	await assert.rejects(
		() => loadModelCatalog({ homeDir, currentConfig: CURRENT }),
		/unlisted default reasoning effort/i,
	);
});

test("model catalog rejects invalid v2 limits and provider request options", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const provider = {
		protocol: "responses",
		base_url: "https://models.example/v1",
		models: {
			"gpt-test": {
				limits: {
					context_window_tokens: 100,
					max_output_tokens: 100,
				},
			},
		},
	};
	await writeProviderCatalog(homeDir, { openai: provider });
	await assert.rejects(
		() => loadModelCatalog({ homeDir, currentConfig: CURRENT }),
		/max_output_tokens must be smaller/i,
	);

	await writeProviderCatalog(homeDir, {
		openai: { ...provider, options: { apiKey: "not-allowed" } },
	});
	await assert.rejects(
		() => loadModelCatalog({ homeDir, currentConfig: CURRENT }),
		/invalid provider request options/i,
	);

	await writeProviderCatalog(homeDir, {
		openai: { ...provider, capabilities: { web_search: "yes" } },
	});
	await assert.rejects(
		() => loadModelCatalog({ homeDir, currentConfig: CURRENT }),
		/invalid model capabilities/i,
	);

	await writeProviderCatalog(homeDir, {
		deepseek: {
			protocol: "chat_completions",
			models: { "deepseek-chat": { capabilities: { web_search: true } } },
		},
	});
	await assert.rejects(
		() => loadModelCatalog({ homeDir, currentConfig: CURRENT }),
		/requires protocol 'responses' for web_search/i,
	);

	await writeProviderCatalog(homeDir, {
		openai: { ...provider, base_url: "https://models.example/v1?key=must-not-leak" },
	});
	await assert.rejects(
		() => loadModelCatalog({ homeDir, currentConfig: CURRENT }),
		(error: unknown) => error instanceof Error
			&& /invalid base_url/i.test(error.message)
			&& !error.message.includes("must-not-leak"),
	);
});

async function writeCatalog(homeDir: string, models: readonly unknown[]): Promise<void> {
	const directory = join(homeDir, ".mycli");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "models.json"), `${JSON.stringify({ models }, null, 2)}\n`, "utf8");
}

async function writeProviderCatalog(
	homeDir: string,
	providers: Readonly<Record<string, unknown>>,
): Promise<void> {
	const directory = join(homeDir, ".mycli");
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "models.json"),
		`${JSON.stringify({ version: 2, providers }, null, 2)}\n`,
		"utf8",
	);
}

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "mycli-model-catalog-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}
