import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	ConfigError,
	parseConfigProfileName,
	resolveConfig,
	resolveConfigWithMetadata,
	resolveProviderRetryPolicy,
	runtimeSettingSnapshots,
} from "../../src/index.ts";

test("Azure derives its native endpoint and defaults only from the injected environment", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	const resolved = await resolveConfig({ homeDir, workspaceRoot, env: {
		MYCLI_PROVIDER: "azure-openai-responses", AZURE_OPENAI_RESOURCE_NAME: "fixture-resource",
	} });
	assert.equal(resolved.protocol, "responses");
	assert.equal(resolved.model, "gpt-5.5");
	assert.equal(resolved.apiBaseUrl, "https://fixture-resource.openai.azure.com/openai/v1");
	assert.equal(resolved.allowAmbientAuth, true);
	const explicit = await resolveConfig({ homeDir, workspaceRoot, env: {
		MYCLI_PROVIDER: "azure-openai-responses", AZURE_OPENAI_BASE_URL: "https://azure.invalid/openai/v1/",
		MYCLI_AUTH_REF: "azure-openai-responses",
	} });
	assert.equal(explicit.apiBaseUrl, "https://azure.invalid/openai/v1");
	assert.equal(explicit.allowAmbientAuth, false);
	await assert.rejects(resolveConfig({ homeDir, workspaceRoot, env: { MYCLI_PROVIDER: "azure-openai-responses" } }), ConfigError);
	await assert.rejects(resolveConfig({ homeDir, workspaceRoot, env: {
		MYCLI_PROVIDER: "azure-openai-responses", AZURE_OPENAI_RESOURCE_NAME: "invalid/private-resource",
	} }), ConfigError);
});

test("provider retry overrides preserve zero, independent fallback, and immutable route snapshots", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"[request]",
		"request_max_retries = 8",
		"stream_max_retries = 9",
		"[request.request_max_retries_by_provider]",
		"openai = 0",
		"private-relay = 2",
		"[request.stream_max_retries_by_provider]",
		"deepseek = 3",
	]);
	const resolved = await resolveConfigWithMetadata({ homeDir, workspaceRoot, env: {}, workspaceTrust: "untrusted" });
	assert.deepEqual(resolved.diagnostics, []);
	assert.deepEqual(resolveProviderRetryPolicy(resolved.config, "openai"), { requestMaxRetries: 0, streamMaxRetries: 9 });
	assert.deepEqual(resolveProviderRetryPolicy(resolved.config, "deepseek"), { requestMaxRetries: 8, streamMaxRetries: 3 });
	assert.equal(resolved.config.requestMaxRetriesByProvider?.["private-relay"], 2);
	assert(Object.isFrozen(resolved.config.requestMaxRetriesByProvider));
	assert(Object.isFrozen(resolved.config.streamMaxRetriesByProvider));
	assert.equal(resolved.layers.origins.request_max_retries_by_provider?.source.id, "user");
	const row = runtimeSettingSnapshots(resolved.config).find((item) => item.key === "request.request_max_retries_by_provider");
	assert.deepEqual(row?.value, { openai: 0, "private-relay": 2 });
	assert.equal(row?.writable, false);
	const changing = { requestMaxRetries: 4, streamMaxRetries: 5, requestMaxRetriesByProvider: { openai: 1 } };
	const frozen = resolveProviderRetryPolicy(changing, "openai");
	changing.requestMaxRetriesByProvider.openai = 100;
	changing.streamMaxRetries = 100;
	assert(Object.isFrozen(frozen));
	assert.deepEqual(frozen, { requestMaxRetries: 1, streamMaxRetries: 5 });
});

test("provider retry tables follow complete-table precedence and the project trust gate", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"[request.request_max_retries_by_provider]", "openai = 7", "deepseek = 2",
		"[request.stream_max_retries_by_provider]", "openai = 1",
	]);
	await writeToml(join(workspaceRoot, ".mycli", "config.toml"), [
		"[request.request_max_retries_by_provider]", "openai = 0",
		"[request.stream_max_retries_by_provider]",
	]);
	const options = { homeDir, workspaceRoot, env: { MYCLI_REQUEST_MAX_RETRIES: "6" } };
	const trusted = await resolveConfigWithMetadata({ ...options, workspaceTrust: "trusted" });
	assert.deepEqual(trusted.config.requestMaxRetriesByProvider, { openai: 0 });
	assert.deepEqual(trusted.config.streamMaxRetriesByProvider, {});
	assert.deepEqual(resolveProviderRetryPolicy(trusted.config, "deepseek"), { requestMaxRetries: 6, streamMaxRetries: 5 });
	assert.equal(trusted.layers.origins.request_max_retries_by_provider?.source.id, "project");
	assert.deepEqual(trusted.layers.origins.request_max_retries_by_provider?.overridden.map((layer) => layer.id), ["user"]);
	const untrusted = await resolveConfigWithMetadata({ ...options, workspaceTrust: "untrusted" });
	assert.deepEqual(resolveProviderRetryPolicy(untrusted.config, "openai"), { requestMaxRetries: 7, streamMaxRetries: 1 });
});

test("provider retry override validation rejects malformed and unbounded values without copying them", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	for (const setting of [
		'request_max_retries_by_provider = "private-invalid-value"',
		"request_max_retries_by_provider = { openai = -1 }",
		"request_max_retries_by_provider = { openai = 101 }",
		"request_max_retries_by_provider = { openai = 1.5 }",
		"request_max_retries_by_provider = { openai = true }",
		'request_max_retries_by_provider = { "private/invalid/route" = 2 }',
		`request_max_retries_by_provider = { ${Array.from({ length: 129 }, (_, index) => `route-${index} = 1`).join(", ")} }`,
	]) {
		await writeToml(join(homeDir, ".mycli", "config.toml"), ["[request]", setting]);
		await assert.rejects(resolveConfigWithMetadata({ homeDir, workspaceRoot, env: {} }), (error: unknown) => {
			assert(error instanceof ConfigError);
			assert.equal(error.diagnostic.code, "invalid_value");
			assert.equal(error.diagnostic.layer, "user");
			assert.equal(error.diagnostic.keyPath, "request.request_max_retries_by_provider");
			assert.doesNotMatch(JSON.stringify(error.diagnostic), /private-invalid-value|private\/invalid\/route/u);
			return true;
		});
	}
});

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
		"system",
		"legacy_user",
	]);
	assert.equal(resolved.layers.origins.model?.source.id, "project");
	assert.deepEqual(
		resolved.layers.origins.model?.overridden.map((source) => source.id),
		["user", "legacy_user"],
	);
});

test("resolves the complete Codex-style profile and system layer precedence", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	const systemConfigPath = join(homeDir, "machine", "config.toml");
	await writeToml(join(homeDir, ".config", "mycli", "config.toml"), [
		'tui_theme = "dark"',
		"[model]",
		'name = "legacy-model"',
	]);
	await writeToml(systemConfigPath, [
		'tui_theme = "dark"',
		"[model]",
		'name = "system-model"',
	]);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		'tui_theme = "dark"',
		"[model]",
		'name = "user-model"',
	]);
	await writeToml(join(homeDir, ".mycli", "work.config.toml"), [
		'tui_theme = "dark"',
		"[model]",
		'name = "profile-model"',
	]);
	await writeToml(join(workspaceRoot, ".mycli", "config.toml"), [
		'tui_theme = "light"',
		"[model]",
		'name = "project-model"',
	]);

	const resolved = await resolveConfigWithMetadata({
		homeDir,
		workspaceRoot,
		env: { MYCLI_MODEL: "environment-model" },
		overrides: { model: "session-model" },
		configProfile: parseConfigProfileName("work"),
		systemConfigPath,
		workspaceTrust: "trusted",
	});

	assert.equal(resolved.config.model, "session-model");
	assert.deepEqual(resolved.layers.layers.map((layer) => layer.metadata.id), [
		"session",
		"environment",
		"project",
		"profile",
		"user",
		"system",
		"legacy_user",
	]);
	assert.equal(resolved.layers.origins.model?.source.id, "session");
	assert.deepEqual(
		resolved.layers.origins.model?.overridden.map((source) => source.id),
		["environment", "project", "profile", "user", "system", "legacy_user"],
	);
	assert.equal(resolved.shellSettings.settings.theme, "light");
	assert.equal(resolved.shellSettings.sources.theme, "project");
	assert.deepEqual(
		resolved.shellSettings.overridden.theme,
		["profile", "user", "system", "legacy_user"],
	);
});

test("selected profiles stay above untrusted project config and may be empty", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		'tui_theme = "light"',
		"[model]",
		'name = "user-model"',
	]);
	await writeToml(join(workspaceRoot, ".mycli", "config.toml"), ["[broken"]);

	const resolved = await resolveConfigWithMetadata({
		homeDir,
		workspaceRoot,
		env: {},
		configProfile: parseConfigProfileName("missing"),
		systemConfigPath: join(homeDir, "missing-system.toml"),
		workspaceTrust: "untrusted",
	});

	assert.equal(resolved.config.model, "user-model");
	const profile = resolved.layers.layers.find((layer) => layer.metadata.id === "profile");
	assert.equal(profile?.metadata.enabled, true);
	assert.deepEqual(profile?.keys, []);
	assert.equal(resolved.layers.origins.model?.source.id, "user");
	assert.equal(resolved.shellSettings.sources.theme, "user");
	assert.equal(resolved.shellSettings.settings.theme, "light");
	assert.deepEqual(resolved.diagnostics, []);
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
	assert.deepEqual(
		resolved.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.keyPath]),
		[
			["deprecated_key", "model"],
			["deprecated_key", "request_max_retries"],
		],
	);
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
		const expected = layer === "legacy_user"
			? [
				["deprecated_config_file", "warning", "legacy_user", undefined],
				["deprecated_inline_secret", "warning", "legacy_user", "api_key"],
			]
			: [["deprecated_inline_secret", "warning", "user", "api_key"]];
		assert.deepEqual(
			resolved.diagnostics.map((diagnostic) => [
				diagnostic.code,
				diagnostic.severity,
				diagnostic.layer,
				diagnostic.keyPath,
			]),
			expected,
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

test("rejects root inline credentials in profile and system layers", async (t) => {
	for (const layer of ["profile", "system"] as const) {
		const { homeDir, workspaceRoot } = await configTree(t);
		const systemConfigPath = join(homeDir, "machine", "config.toml");
		const options = {
			homeDir,
			workspaceRoot,
			env: {},
			systemConfigPath,
			...(layer === "profile" ? { configProfile: parseConfigProfileName("work") } : {}),
		};
		const path = layer === "profile"
			? join(homeDir, ".mycli", "work.config.toml")
			: systemConfigPath;
		await writeToml(path, ['api_key = "must-not-leak"']);

		await assert.rejects(
			() => resolveConfig(options),
			(error: unknown) => error instanceof ConfigError
				&& error.diagnostic.code === "forbidden_inline_secret"
				&& error.diagnostic.layer === layer
				&& error.diagnostic.keyPath === "api_key"
				&& !JSON.stringify(error.diagnostic).includes("must-not-leak")
				&& !error.message.includes("must-not-leak"),
		);
	}
});

test("rejects invalid profile visual settings with value-free diagnostics", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "work.config.toml"), [
		'tui_theme = "private-purple-sentinel"',
	]);

	await assert.rejects(
		() => resolveConfigWithMetadata({
			homeDir,
			workspaceRoot,
			env: {},
			configProfile: parseConfigProfileName("work"),
			systemConfigPath: join(homeDir, "missing-system.toml"),
			workspaceTrust: "untrusted",
		}),
		(error: unknown) => error instanceof ConfigError
			&& error.diagnostic.code === "invalid_value"
			&& error.diagnostic.layer === "profile"
			&& error.diagnostic.keyPath === "tui.theme"
			&& !JSON.stringify(error.diagnostic).includes("private-purple-sentinel"),
	);
});

test("attributes effective profile and system value failures without exposing values or paths", async (t) => {
	for (const layer of ["profile", "system"] as const) {
		const { homeDir, workspaceRoot } = await configTree(t);
		const systemConfigPath = join(homeDir, "machine", "config.toml");
		const profilePath = join(homeDir, ".mycli", "work.config.toml");
		const path = layer === "profile" ? profilePath : systemConfigPath;
		await writeToml(path, [
			"[request]",
			'max_prompt_tokens = "private-invalid-sentinel"',
		]);

		await assert.rejects(
			() => resolveConfigWithMetadata({
				homeDir,
				workspaceRoot,
				env: {},
				...(layer === "profile" ? { configProfile: parseConfigProfileName("work") } : {}),
				systemConfigPath,
				workspaceTrust: "untrusted",
			}),
			(error: unknown) => error instanceof ConfigError
				&& error.diagnostic.code === "invalid_value"
				&& error.diagnostic.layer === layer
				&& error.diagnostic.keyPath === "max_prompt_tokens"
				&& !JSON.stringify(error.diagnostic).includes("private-invalid-sentinel")
				&& !JSON.stringify(error.diagnostic).includes(homeDir),
		);
	}
});

test("reports profile and system unknown keys using stable layer ids only", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	const systemConfigPath = join(homeDir, "machine", "config.toml");
	await writeToml(join(homeDir, ".mycli", "work.config.toml"), [
		'private_profile_marker = "profile-value-sentinel"',
	]);
	await writeToml(systemConfigPath, [
		'private_system_marker = "system-value-sentinel"',
	]);

	const resolved = await resolveConfigWithMetadata({
		homeDir,
		workspaceRoot,
		env: {},
		configProfile: parseConfigProfileName("work"),
		systemConfigPath,
		workspaceTrust: "untrusted",
	});
	assert.deepEqual(
		resolved.diagnostics.map((diagnostic) => [diagnostic.layer, diagnostic.keyPath]),
		[
			["profile", "private_profile_marker"],
			["system", "private_system_marker"],
		],
	);
	const serialized = JSON.stringify(resolved.diagnostics);
	assert.equal(serialized.includes("profile-value-sentinel"), false);
	assert.equal(serialized.includes("system-value-sentinel"), false);
	assert.equal(serialized.includes(homeDir), false);
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
		'provider = "MUST-NOT-LEAK"',
	]);

	await assert.rejects(
		() => resolveConfig({ homeDir, workspaceRoot, env: {} }),
		(error: unknown) => error instanceof ConfigError
			&& error.diagnostic.code === "invalid_value"
			&& error.diagnostic.keyPath === "provider"
			&& error.diagnostic.message === "invalid provider route configuration"
			&& !JSON.stringify(error.diagnostic).includes("MUST-NOT-LEAK")
			&& !error.message.includes("MUST-NOT-LEAK"),
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

test("resolves Anthropic defaults with provider-neutral cache retention", async (t) => {
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
	assert.equal(resolved.cacheRetention, "short");
	assert.equal(resolved.supportsImages, false);
	assert.equal(resolved.webSearchMode, "disabled");
});

test("resolves curated provider defaults and explicit layered overrides", async (t) => {
	const providers = [
		["openrouter", "openrouter/auto", "https://openrouter.ai/api/v1"],
		["groq", "openai/gpt-oss-120b", "https://api.groq.com/openai/v1"],
		["together", "moonshotai/Kimi-K2.7-Code", "https://api.together.ai/v1"],
		["moonshotai", "kimi-k2.7-code", "https://api.moonshot.ai/v1"],
		["nvidia", "openai/gpt-oss-120b", "https://integrate.api.nvidia.com/v1"],
		["cerebras", "gpt-oss-120b", "https://api.cerebras.ai/v1"],
	] as const;

	for (const [provider, defaultModel, defaultBaseUrl] of providers) {
		const { homeDir, workspaceRoot } = await configTree(t);
		const defaults = await resolveConfig({
			homeDir,
			workspaceRoot,
			env: { MYCLI_PROVIDER: provider },
		});
		assert.equal(defaults.provider, provider);
		assert.equal(defaults.protocol, "chat_completions");
		assert.equal(defaults.model, defaultModel);
		assert.equal(defaults.apiBaseUrl, defaultBaseUrl);
		assert.equal(defaults.authRef, provider);
		assert.equal(defaults.supportsImages, false);
		assert.equal(defaults.cacheRetention, "short");
		assert.equal(defaults.webSearchMode, "disabled");

		const explicit = await resolveConfig({
			homeDir,
			workspaceRoot,
			env: {
				MYCLI_PROVIDER: provider,
				MYCLI_PROTOCOL: "chat_completions",
				MYCLI_MODEL: `${provider}-custom-model`,
				MYCLI_BASE_URL: `https://${provider}.example.test/v1/`,
				MYCLI_AUTH_REF: `${provider}-custom-auth`,
				MYCLI_SUPPORTS_IMAGES: "true",
			},
		});
		assert.equal(explicit.provider, provider);
		assert.equal(explicit.protocol, "chat_completions");
		assert.equal(explicit.model, `${provider}-custom-model`);
		assert.equal(explicit.apiBaseUrl, `https://${provider}.example.test/v1`);
		assert.equal(explicit.authRef, `${provider}-custom-auth`);
		assert.equal(explicit.supportsImages, true);
	}
});

test("resolves structurally complete dynamic provider routes conservatively", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	const resolved = await resolveConfig({
		homeDir,
		workspaceRoot,
		env: {
			MYCLI_PROVIDER: "fireworks",
			MYCLI_PROTOCOL: "chat_completions",
			MYCLI_MODEL: "accounts/example/models/custom",
			MYCLI_BASE_URL: "https://api.fireworks.ai/inference/v1/",
			MYCLI_AUTH_REF: "fireworks-primary",
		},
	});

	assert.equal(resolved.provider, "fireworks");
	assert.equal(resolved.protocol, "chat_completions");
	assert.equal(resolved.model, "accounts/example/models/custom");
	assert.equal(resolved.apiBaseUrl, "https://api.fireworks.ai/inference/v1");
	assert.equal(resolved.authRef, "fireworks-primary");
	assert.equal(resolved.supportsImages, false);
	assert.equal(resolved.cacheRetention, "short");
	assert.equal(resolved.webSearchMode, "disabled");
});

test("rejects incomplete dynamic provider runtime configuration", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	const complete = {
		MYCLI_PROVIDER: "fireworks",
		MYCLI_PROTOCOL: "chat_completions",
		MYCLI_MODEL: "accounts/example/models/custom",
		MYCLI_BASE_URL: "https://api.fireworks.ai/inference/v1",
	};
	for (const missing of ["MYCLI_PROTOCOL", "MYCLI_MODEL", "MYCLI_BASE_URL"] as const) {
		const env = { ...complete, [missing]: undefined };
		await assert.rejects(
			() => resolveConfig({ homeDir, workspaceRoot, env }),
			(error: unknown) => error instanceof ConfigError
				&& error.diagnostic.code === "invalid_value",
		);
	}
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

	assert.equal(resolved.model, "gpt-5.5");
	assert.equal(resolved.memoryEnabled, false);
	assert.equal(resolved.requestPermissionsToolEnabled, false);
	assert.equal(resolved.updatesCheckOnStartup, true);
	assert.equal(resolved.compressionThresholdTokens, 8_000);
	assert.equal(resolved.compactionTokenLimit, 9_600);
	assert.equal(resolved.compactionReservedOutputTokens, 13_000);
	assert.equal(resolved.compactionTailTurns, 2);
	assert.equal(resolved.compactionTailMaxTokens, 20_000);
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
