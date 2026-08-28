import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	BUILTIN_MODEL_CATALOG,
	findModelCatalogEntry,
	loadModelCatalog,
	modelCatalogEntryPayload,
	modelInputTokenLimit,
	resolveModelRuntimeConfig,
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
			reasoning_efforts: ["low", "high", "max"],
			default_reasoning_effort: "high",
		},
	]);

	const entries = await loadModelCatalog({ homeDir, currentConfig: CURRENT });
	assert.equal(entries.length, 2);
	assert.equal(entries[0]?.model, "private-current");
	assert.equal(entries[0]?.isCurrent, true);
	assert.deepEqual(entries[0]?.supportedReasoningEfforts, ["low", "high", "max"]);
	assert.equal(entries[0]?.defaultReasoningEffort, "high");
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
			capabilities: { web_search: true },
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
	assert.equal(entries.length, 1);
	const entry = entries[0]!;
	assert.equal(entry.displayName, "Private Current");
	assert.equal(entry.baseUrl, "https://models.example/v1");
	assert.equal(entry.authRef, "private-account");
	assert.equal(entry.contextWindowTokens, 200_000);
	assert.equal(entry.maxOutputTokens, 50_000);
	assert.equal(entry.store, false);
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
		default: false,
		current: true,
	});
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
	]);
	for (const model of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
		const entry = BUILTIN_MODEL_CATALOG.find((candidate) =>
			candidate.provider === "deepseek" && candidate.model === model);
		assert.ok(entry, `missing DeepSeek model ${model}`);
		assert.deepEqual(entry.supportedReasoningEfforts, ["high", "max"]);
	}
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
		BUILTIN_MODEL_CATALOG.length + 1,
	);
	if (process.platform !== "win32") {
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await stat(join(homeDir, ".mycli"))).mode & 0o777, 0o700);
	}
});

test("model runtime config derives prompt and request limits while preserving explicit caps", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const workspaceRoot = join(homeDir, "workspace");
	await mkdir(workspaceRoot, { recursive: true });
	await writeProviderCatalog(homeDir, {
		openai: {
			protocol: "responses",
			base_url: "https://models.example/v1",
			auth_ref: "private-account",
			options: { store: false },
			capabilities: { web_search: true },
			models: {
				"private-current": {
					capabilities: { web_search: false },
					limits: {
						context_window_tokens: 200_000,
						max_output_tokens: 50_000,
					},
				},
			},
		},
	});
	await writeFile(join(homeDir, ".mycli", "config.toml"), [
		"[model]",
		'provider = "openai"',
		'protocol = "responses"',
		'name = "private-current"',
		'api_base_url = "https://models.example/v1"',
		'auth_ref = "private-account"',
	].join("\n"), "utf8");

	const derived = await resolveModelRuntimeConfig({ homeDir, workspaceRoot, env: {} });
	assert.equal(derived.maxPromptTokens, 150_000);
	assert.equal(derived.modelContextWindowTokens, 200_000);
	assert.equal(derived.maxOutputTokens, 50_000);
	assert.equal(derived.store, false);
	assert.equal(derived.webSearchMode, "disabled");

	const capped = await resolveModelRuntimeConfig({
		homeDir,
		workspaceRoot,
		env: { MYCLI_MAX_PROMPT_TOKENS: "12000" },
	});
	assert.equal(capped.maxPromptTokens, 12_000);
	const clamped = await resolveModelRuntimeConfig({
		homeDir,
		workspaceRoot,
		env: { MYCLI_MAX_PROMPT_TOKENS: "999999" },
	});
	assert.equal(clamped.maxPromptTokens, 150_000);
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
