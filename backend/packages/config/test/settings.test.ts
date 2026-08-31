import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	ConfigError,
	resolveConfig,
	resolveConfigWithMetadata,
} from "../src/index.ts";

test("resolves trusted project precedence with source provenance", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".config", "mycli", "config.toml"), [
		"[model]",
		'name = "legacy-model"',
	]);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"[model]",
		'name = "user-model"',
	]);
	await writeToml(join(workspaceRoot, ".mycli", "config.toml"), [
		"[model]",
		'name = "project-model"',
	]);

	const resolved = await resolveConfigWithMetadata({
		homeDir,
		workspaceRoot,
		env: {},
		workspaceTrust: "trusted",
	});

	assert.equal(resolved.config.model, "project-model");
	assert.deepEqual(resolved.layers.layers.map((layer) => layer.metadata.id), [
		"session",
		"environment",
		"project",
		"user",
		"legacy_user",
	]);
	assert.equal(resolved.layers.origins.model?.source.id, "project");
	assert.deepEqual(
		resolved.layers.origins.model?.overridden.map((source) => source.id),
		["user", "legacy_user"],
	);
});

test("keeps untrusted project configuration disabled without reading it", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"[model]",
		'name = "user-model"',
	]);
	await writeToml(join(workspaceRoot, ".mycli", "config.toml"), ["[broken"]);

	for (const workspaceTrust of ["unknown", "untrusted"] as const) {
		const resolved = await resolveConfigWithMetadata({
			homeDir,
			workspaceRoot,
			env: {},
			workspaceTrust,
		});

		assert.equal(resolved.config.model, "user-model");
		const project = resolved.layers.layers.find((layer) => layer.metadata.id === "project");
		assert.equal(project?.metadata.enabled, false);
		assert.equal(project?.metadata.disabledReason, "workspace_not_trusted");
		assert.deepEqual(project?.keys, []);
		assert.equal(resolved.layers.origins.model?.source.id, "user");
		assert.deepEqual(resolved.diagnostics, []);
	}
});

test("attributes session and environment overrides above file layers", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(workspaceRoot, ".mycli", "config.toml"), [
		"[model]",
		'name = "project-model"',
	]);

	const environment = await resolveConfigWithMetadata({
		homeDir,
		workspaceRoot,
		env: { MYCLI_MODEL: "environment-model" },
		workspaceTrust: "trusted",
	});
	const session = await resolveConfigWithMetadata({
		homeDir,
		workspaceRoot,
		env: { MYCLI_MODEL: "environment-model" },
		overrides: { model: "session-model" },
		workspaceTrust: "trusted",
	});

	assert.equal(environment.config.model, "environment-model");
	assert.equal(environment.layers.origins.model?.source.id, "environment");
	assert.equal(session.config.model, "session-model");
	assert.equal(session.layers.origins.model?.source.id, "session");
	assert.deepEqual(
		session.layers.origins.model?.overridden.map((source) => source.id),
		["environment", "project"],
	);
});

test("reports deterministic value-free schema diagnostics", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		'typo_root = "must-not-leak"',
		"[model]",
		'name = "valid-model"',
		'nmae = "must-not-leak"',
		"[plugins]",
		'enabled = ["demo"]',
		'extra = "must-not-leak"',
		"[runtime]",
		'collaboration_mode = "default"',
	]);

	const resolved = await resolveConfigWithMetadata({
		homeDir,
		workspaceRoot,
		env: {},
	});

	assert.equal(resolved.config.model, "valid-model");
	assert.deepEqual(
		resolved.diagnostics.map((diagnostic) => ({
			version: diagnostic.version,
			code: diagnostic.code,
			severity: diagnostic.severity,
			layer: diagnostic.layer,
			keyPath: diagnostic.keyPath,
		})),
		[
			{
				version: 1,
				code: "unknown_key",
				severity: "warning",
				layer: "user",
				keyPath: "model.nmae",
			},
			{
				version: 1,
				code: "unknown_key",
				severity: "warning",
				layer: "user",
				keyPath: "plugins.extra",
			},
			{
				version: 1,
				code: "unknown_table",
				severity: "warning",
				layer: "user",
				keyPath: "runtime",
			},
			{
				version: 1,
				code: "unknown_key",
				severity: "warning",
				layer: "user",
				keyPath: "typo_root",
			},
		],
	);
	assert.equal(JSON.stringify(resolved.diagnostics).includes("must-not-leak"), false);
});

test("accepts existing legacy runtime shell and plugin config vocabulary", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		'model = "legacy-model"',
		"request_max_retries = 2",
		'tui_theme = "dark"',
		'view_mode = "default"',
		"[plugins]",
		'enabled = ["demo"]',
		'disabled = ["old"]',
	]);

	const resolved = await resolveConfigWithMetadata({ homeDir, workspaceRoot, env: {} });

	assert.equal(resolved.config.model, "legacy-model");
	assert.deepEqual(resolved.diagnostics, []);
});

test("warns for user and legacy-user root API keys without exposing them", async (t) => {
	for (const [relativePath, layer] of [
		[[".mycli", "config.toml"], "user"],
		[[".config", "mycli", "config.toml"], "legacy_user"],
	] as const) {
		const { homeDir, workspaceRoot } = await configTree(t);
		await writeToml(join(homeDir, ...relativePath), [
			'api_key = "must-not-leak"',
		]);

		const resolved = await resolveConfigWithMetadata({ homeDir, workspaceRoot, env: {} });

		assert.equal(resolved.config.apiKey, "must-not-leak");
		assert.deepEqual(
			resolved.diagnostics.map((diagnostic) => [
				diagnostic.code,
				diagnostic.severity,
				diagnostic.layer,
				diagnostic.keyPath,
			]),
			[["deprecated_inline_secret", "warning", layer, "api_key"]],
		);
		assert.equal(JSON.stringify(resolved.diagnostics).includes("must-not-leak"), false);
	}
});

test("rejects project inline credentials with a value-free typed error", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(workspaceRoot, ".mycli", "config.toml"), [
		"[model]",
		'api_key = "must-not-leak"',
	]);

	await assert.rejects(
		() => resolveConfig({ homeDir, workspaceRoot, env: {}, workspaceTrust: "trusted" }),
		(error: unknown) => error instanceof ConfigError
			&& error.diagnostic.code === "forbidden_inline_secret"
			&& error.diagnostic.layer === "project"
			&& error.diagnostic.keyPath === "model.api_key"
			&& !JSON.stringify(error.diagnostic).includes("must-not-leak"),
	);
});

test("rejects table credentials in user config instead of treating them as legacy", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"[model]",
		'api_key = "must-not-leak"',
	]);

	await assert.rejects(
		() => resolveConfig({ homeDir, workspaceRoot, env: {} }),
		(error: unknown) => error instanceof ConfigError
			&& error.diagnostic.code === "forbidden_inline_secret"
			&& error.diagnostic.layer === "user"
			&& error.diagnostic.keyPath === "model.api_key"
			&& !JSON.stringify(error.diagnostic).includes("must-not-leak"),
	);
});

test("reports invalid known values without echoing the configured value", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"[reasoning]",
		'effort = "must-not-leak"',
	]);

	await assert.rejects(
		() => resolveConfig({ homeDir, workspaceRoot, env: {} }),
		(error: unknown) => error instanceof ConfigError
			&& error.diagnostic.code === "invalid_value"
			&& error.diagnostic.keyPath === "thinking_effort"
			&& !JSON.stringify(error.diagnostic).includes("must-not-leak")
			&& !error.message.includes("must-not-leak"),
	);
});

test("rejects unsupported providers without echoing configured values", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"[model]",
		'provider = "must-not-leak"',
	]);

	await assert.rejects(
		() => resolveConfig({ homeDir, workspaceRoot, env: {} }),
		(error: unknown) => error instanceof ConfigError
			&& error.diagnostic.code === "invalid_value"
			&& error.diagnostic.keyPath === "provider"
			&& error.diagnostic.message === "unsupported provider configuration"
			&& !JSON.stringify(error.diagnostic).includes("must-not-leak")
			&& !error.message.includes("must-not-leak"),
	);
});

test("rejects unsupported protocols without echoing configured values", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"[model]",
		'provider = "openai"',
		'protocol = "must-not-leak"',
	]);

	await assert.rejects(
		() => resolveConfig({ homeDir, workspaceRoot, env: {} }),
		(error: unknown) => error instanceof ConfigError
			&& error.diagnostic.code === "invalid_value"
			&& error.diagnostic.keyPath === "protocol"
			&& error.diagnostic.message === "unsupported protocol configuration"
			&& !JSON.stringify(error.diagnostic).includes("must-not-leak")
			&& !error.message.includes("must-not-leak"),
	);
});

test("resolves CLI, environment, user, project, and legacy precedence", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".config", "mycli", "config.toml"), [
		'model = "legacy-model"',
		'request_max_retries = 1',
	]);
	await writeToml(join(workspaceRoot, ".mycli", "config.toml"), [
		'model = "project-model"',
		'request_max_retries = 2',
	]);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"[model]",
		'provider = "openai"',
		'name = "user-model"',
		"[request]",
		"request_max_retries = 3",
		"stream_max_retries = 120",
		"[reasoning]",
		'effort = "high"',
	]);

	const resolved = await resolveConfig({
		homeDir,
		workspaceRoot,
		env: { MYCLI_MODEL: "env-model", MYCLI_REQUEST_MAX_RETRIES: "-1" },
		overrides: { model: "cli-model", session: "session-1" },
	});

	assert.equal(resolved.model, "cli-model");
	assert.equal(resolved.provider, "openai");
	assert.equal(resolved.protocol, "responses");
	assert.equal(resolved.webSearchMode, "live");
	assert.equal(resolved.requestMaxRetries, 0);
	assert.equal(resolved.streamMaxRetries, 100);
	assert.equal(resolved.reasoningEffort, "high");
	assert.equal(resolved.sessionId, "session-1");
	assert.equal(resolved.sessionsDbPath, join(homeDir, ".mycli", "sessions.db"));
});

test("auth store outranks legacy inline config keys", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		'provider = "compatible"',
		'protocol = "chat_completions"',
		'model = "chat-model"',
		'auth_ref = "private-endpoint"',
		'api_key = "inline-secret"',
	]);
	await mkdir(join(homeDir, ".mycli"), { recursive: true });
	await writeFile(join(homeDir, ".mycli", "auth.json"), JSON.stringify({
		"private-endpoint": { type: "api_key", key: "stored-secret" },
	}), "utf8");

	const resolved = await resolveConfig({
		homeDir,
		workspaceRoot,
		env: {},
		createSessionId: () => "generated-session",
	});

	assert.equal(resolved.apiKey, "stored-secret");
	assert.equal(resolved.authRef, "private-endpoint");
	assert.equal(resolved.sessionId, "generated-session");
});

test("session overrides restore a complete provider identity above user and environment config", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	const resolved = await resolveConfig({
		homeDir,
		workspaceRoot,
		env: {
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_MODEL: "global-model",
			MYCLI_BASE_URL: "https://global.invalid/v1",
			MYCLI_AUTH_REF: "global-account",
			MYCLI_THINKING_EFFORT: "low",
		},
		overrides: {
			session: "restored-session",
			provider: "anthropic",
			protocol: "anthropic_messages",
			model: "claude-restored",
			apiBaseUrl: "https://session.invalid",
			authRef: "session-account",
			reasoningEffort: "high",
			thinkingEnabled: true,
		},
	});

	assert.equal(resolved.sessionId, "restored-session");
	assert.equal(resolved.provider, "anthropic");
	assert.equal(resolved.protocol, "anthropic_messages");
	assert.equal(resolved.model, "claude-restored");
	assert.equal(resolved.apiBaseUrl, "https://session.invalid");
	assert.equal(resolved.authRef, "session-account");
	assert.equal(resolved.reasoningEffort, "high");
	assert.equal(resolved.thinkingEnabled, true);
});

test("session overrides restore disabled reasoning without conflicting with configured effort", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	const resolved = await resolveConfig({
		homeDir,
		workspaceRoot,
		env: {
			MYCLI_THINKING_ENABLED: "true",
			MYCLI_THINKING_EFFORT: "high",
		},
		overrides: {
			reasoningEffort: "none",
			thinkingEnabled: false,
		},
	});

	assert.equal(resolved.reasoningEffort, "none");
	assert.equal(resolved.thinkingEnabled, false);
});

test("legacy transport retry limit feeds the stream retry setting", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), ["transport_retry_limit = 7"]);

	const resolved = await resolveConfig({ homeDir, workspaceRoot, env: {} });
	assert.equal(resolved.streamMaxRetries, 7);
});

test("resolves Anthropic defaults and cache-control policy", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);

	const resolved = await resolveConfig({
		homeDir,
		workspaceRoot,
		env: { MYCLI_PROVIDER: "anthropic", MYCLI_API_KEY: "test-key" },
	});

	assert.equal(resolved.provider, "anthropic");
	assert.equal(resolved.protocol, "anthropic_messages");
	assert.equal(resolved.model, "claude-sonnet-4-6");
	assert.equal(resolved.apiBaseUrl, "https://api.anthropic.com");
	assert.equal(resolved.promptCacheKeyEnabled, false);
	assert.equal(resolved.cacheControlEnabled, true);
	assert.equal(resolved.supportsImages, true);
	assert.equal(resolved.webSearchMode, "disabled");
});

test("resolves provider image capability with an explicit override", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	const deepSeek = await resolveConfig({
		homeDir,
		workspaceRoot,
		env: { MYCLI_PROVIDER: "deepseek" },
	});
	const overridden = await resolveConfig({
		homeDir,
		workspaceRoot,
		env: { MYCLI_PROVIDER: "deepseek", MYCLI_SUPPORTS_IMAGES: "true" },
	});

	assert.equal(deepSeek.supportsImages, false);
	assert.equal(overridden.supportsImages, true);
});

test("enables hosted web search only for built-in Responses providers", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	const openai = await resolveConfig({
		homeDir,
		workspaceRoot,
		env: { MYCLI_PROVIDER: "openai" },
	});
	const compatible = await resolveConfig({
		homeDir,
		workspaceRoot,
		env: {
			MYCLI_PROVIDER: "compatible",
			MYCLI_PROTOCOL: "responses",
			MYCLI_MODEL: "gpt-proxy",
		},
	});
	const qwen = await resolveConfig({
		homeDir,
		workspaceRoot,
		env: { MYCLI_PROVIDER: "qwen" },
	});
	const deepseek = await resolveConfig({
		homeDir,
		workspaceRoot,
		env: { MYCLI_PROVIDER: "deepseek" },
	});
	const anthropic = await resolveConfig({
		homeDir,
		workspaceRoot,
		env: { MYCLI_PROVIDER: "anthropic" },
	});

	assert.equal(openai.webSearchMode, "live");
	assert.equal(compatible.webSearchMode, "disabled");
	assert.equal(qwen.webSearchMode, "disabled");
	assert.equal(deepseek.webSearchMode, "disabled");
	assert.equal(anthropic.webSearchMode, "disabled");
});

test("loads compaction defaults with memory disabled", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);

	const resolved = await resolveConfig({ homeDir, workspaceRoot, env: {} });

	assert.equal(resolved.memoryEnabled, false);
	assert.equal(resolved.requestPermissionsToolEnabled, false);
	assert.equal(resolved.updatesCheckOnStartup, true);
	assert.equal(resolved.compressionThresholdTokens, 8_000);
	assert.equal(resolved.compactionTokenLimit, 9_600);
	assert.equal(resolved.compactionReservedOutputTokens, 13_000);
	assert.equal(resolved.compactionTailTurns, 2);
	assert.equal(resolved.compactionTailMaxTokens, 8_000);
	assert.equal(resolved.compactionTriggerRatio, 0.9);
	assert.equal(resolved.compactionBufferTokens, 13_000);
	assert.equal(resolved.compactionMinSavingsRatio, undefined);
	assert.equal(resolved.compactionExpectedSummaryTokens, 500);
	assert.equal(resolved.compactionCarryTurns, 1);
	assert.equal(resolved.compactionSummarizerModel, undefined);
	assert.deepEqual(resolved.compactionTriggerRatiosByModel, {});
	assert.equal(resolved.compactionRehydrationFileMaxTotalTokens, 50_000);
	assert.equal(resolved.compactionRehydrationFileMaxItemTokens, 5_000);
	assert.equal(resolved.compactionRehydrationMaxFiles, 5);
});

test("loads the canonical startup update opt-out", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"[updates]",
		"check_on_startup = false",
	]);

	const resolved = await resolveConfig({ homeDir, workspaceRoot, env: {} });

	assert.equal(resolved.updatesCheckOnStartup, false);
});

test("loads the experimental request_permissions feature only when explicitly enabled", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(workspaceRoot, ".mycli", "config.toml"), [
		"[features]",
		"request_permissions_tool = true",
	]);

	const enabled = await resolveConfig({ homeDir, workspaceRoot, env: {} });
	const disabledByEnvironment = await resolveConfig({
		homeDir,
		workspaceRoot,
		env: { MYCLI_REQUEST_PERMISSIONS_TOOL: "false" },
	});

	assert.equal(enabled.requestPermissionsToolEnabled, true);
	assert.equal(disabledByEnvironment.requestPermissionsToolEnabled, false);
});

test("loads the sectioned memory opt-in", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(workspaceRoot, ".mycli", "config.toml"), [
		"[memory]",
		"enabled = true",
	]);

	const resolved = await resolveConfig({ homeDir, workspaceRoot, env: {} });

	assert.equal(resolved.memoryEnabled, true);
});

test("loads sectioned compaction settings and model ratios", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(workspaceRoot, ".mycli", "config.toml"), [
		"[request]",
		"max_prompt_tokens = 100000",
		"[context]",
		"compaction_token_limit = 87000",
		"compaction_reserved_output_tokens = 13000",
		"compaction_tail_turns = 3",
		"compaction_tail_max_tokens = 7000",
		"compaction_l4_trigger_ratio = 0.82",
		"compaction_l4_buffer_tokens = 9000",
		"compaction_l4_min_savings_ratio = 0.2",
		"compaction_l4_expected_summary_tokens = 300",
		"compaction_l4_carry_turns = 4",
		'compaction_l4_summarizer_model = "summary-model"',
		"compaction_rehydration_file_max_total_tokens = 12000",
		"compaction_rehydration_file_max_item_tokens = 2000",
		"compaction_rehydration_max_files = 3",
		"[compaction_l4_trigger_ratios_by_model]",
		'"gpt-5" = 0.75',
		'"chat-model" = 0.8',
	]);

	const resolved = await resolveConfig({
		homeDir,
		workspaceRoot,
		env: { MYCLI_MEMORY_ENABLED: "false" },
	});

	assert.equal(resolved.memoryEnabled, false);
	assert.equal(resolved.compactionTokenLimit, 87_000);
	assert.equal(resolved.compactionReservedOutputTokens, 13_000);
	assert.equal(resolved.compactionTailTurns, 3);
	assert.equal(resolved.compactionTailMaxTokens, 7_000);
	assert.equal(resolved.compactionTriggerRatio, 0.82);
	assert.equal(resolved.compactionBufferTokens, 9_000);
	assert.equal(resolved.compactionMinSavingsRatio, 0.2);
	assert.equal(resolved.compactionExpectedSummaryTokens, 300);
	assert.equal(resolved.compactionCarryTurns, 4);
	assert.equal(resolved.compactionSummarizerModel, "summary-model");
	assert.deepEqual(resolved.compactionTriggerRatiosByModel, {
		"chat-model": 0.8,
		"gpt-5": 0.75,
	});
	assert.equal(resolved.compactionRehydrationFileMaxTotalTokens, 12_000);
	assert.equal(resolved.compactionRehydrationFileMaxItemTokens, 2_000);
	assert.equal(resolved.compactionRehydrationMaxFiles, 3);
});

test("falls through an empty user model-ratio table to project settings", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"[compaction_l4_trigger_ratios_by_model]",
	]);
	await writeToml(join(workspaceRoot, ".mycli", "config.toml"), [
		"[compaction_l4_trigger_ratios_by_model]",
		'"project-model" = 0.72',
	]);

	const resolved = await resolveConfig({ homeDir, workspaceRoot, env: {} });

	assert.deepEqual(resolved.compactionTriggerRatiosByModel, {
		"project-model": 0.72,
	});
});

test("rejects invalid compaction ranges before a turn starts", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"compaction_l4_trigger_ratio = 1.1",
	]);

	await assert.rejects(
		() => resolveConfig({ homeDir, workspaceRoot, env: {} }),
		/error: compaction_l4_trigger_ratio must be between 0 and 1/,
	);
});

test("accepts zero as an explicit minimum compaction savings ratio", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"compaction_l4_min_savings_ratio = 0",
	]);

	const resolved = await resolveConfig({ homeDir, workspaceRoot, env: {} });
	assert.equal(resolved.compactionMinSavingsRatio, 0);
});

test("rejects an impossible rehydration item budget", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"compaction_rehydration_file_max_total_tokens = 100",
		"compaction_rehydration_file_max_item_tokens = 101",
	]);

	await assert.rejects(
		() => resolveConfig({ homeDir, workspaceRoot, env: {} }),
		/error: compaction_rehydration_file_max_item_tokens cannot exceed total tokens/,
	);
});

test("rejects a compaction threshold above the prompt window", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"max_prompt_tokens = 12000",
		"compaction_token_limit = 12001",
	]);

	await assert.rejects(
		() => resolveConfig({ homeDir, workspaceRoot, env: {} }),
		/error: compaction_token_limit cannot exceed max_prompt_tokens/,
	);
});

test("malformed TOML raises a bounded config error", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), ["[broken"]);

	await assert.rejects(
		() => resolveConfig({ homeDir, workspaceRoot, env: {} }),
		(error: unknown) => error instanceof ConfigError
			&& error.diagnostic.code === "invalid_toml"
			&& error.diagnostic.layer === "user"
			&& error.diagnostic.line === 1
			&& error.diagnostic.column === 2
			&& error.message === "config_error: user config contains invalid TOML"
			&& !("codeblock" in error.diagnostic),
	);
});

async function configTree(t: TestContext): Promise<{ homeDir: string; workspaceRoot: string }> {
	const root = await mkdtemp(join(tmpdir(), "mycli-settings-"));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	await mkdir(homeDir, { recursive: true });
	await mkdir(workspaceRoot, { recursive: true });
	t.after(() => rm(root, { recursive: true, force: true }));
	return { homeDir, workspaceRoot };
}

async function writeToml(path: string, lines: readonly string[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}
