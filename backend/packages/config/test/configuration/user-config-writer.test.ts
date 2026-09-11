import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { parse } from "smol-toml";
import * as config from "../../src/index.ts";

type WriteUserProviderConfig = (input: {
	readonly homeDir: string;
	readonly provider: string;
	readonly protocol: string;
	readonly model: string;
	readonly apiBaseUrl: string;
	readonly authRef: string;
	readonly cacheRetention: "none" | "short" | "long";
	readonly thinkingEnabled?: boolean;
	readonly reasoningEffort?: string;
	readonly failpoint?: (name: string) => void;
}) => Promise<string>;

test("user config writer preserves unrelated TOML and removes inline API keys", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const directory = join(homeDir, ".mycli");
	const path = join(directory, "config.toml");
	await mkdir(directory, { recursive: true });
	await writeFile(path, [
		'api_key = "legacy-secret"',
		"# keep provider comment",
		'custom_flag = "keep" # keep inline comment',
		"",
		"[model]",
		'provider = "openai"',
		'protocol = "responses"',
		'name = "old-model"',
		'api_base_url = "https://old.example/v1"',
		'api_key = "nested-legacy-secret"',
		'custom_option = "keep" # keep model extension',
		"",
		"[request]",
		'custom_option = "keep" # keep request extension',
		"",
		"[plugins]",
		'enabled = ["demo"]',
		"",
	].join("\r\n"), { encoding: "utf8", mode: 0o644 });
	const writeUserProviderConfig = (
		config as { writeUserProviderConfig?: WriteUserProviderConfig }
	).writeUserProviderConfig;

	assert.equal(typeof writeUserProviderConfig, "function");
	const writtenPath = await writeUserProviderConfig!({
		homeDir,
		provider: "anthropic",
		protocol: "anthropic_messages",
		model: "claude-sonnet-4-6",
		apiBaseUrl: "https://api.anthropic.com/",
		authRef: "anthropic",
		cacheRetention: "short",
		thinkingEnabled: true,
		reasoningEffort: "high",
	});

	assert.equal(writtenPath, path);
	const raw = await readFile(path, "utf8");
	const payload = parse(raw) as Record<string, unknown>;
	assert.equal(raw.includes("legacy-secret"), false);
	assert.match(raw, /# keep provider comment\r\n/u);
	assert.match(raw, /custom_flag = "keep" # keep inline comment\r\n/u);
	assert.equal(raw.includes("\n") && !raw.includes("\r\n"), false);
	assert.equal(payload.custom_flag, "keep");
	assert.deepEqual(payload.plugins, { enabled: ["demo"] });
	assert.deepEqual(payload.model, {
		provider: "anthropic",
		protocol: "anthropic_messages",
		name: "claude-sonnet-4-6",
		api_base_url: "https://api.anthropic.com",
		auth_ref: "anthropic",
		custom_option: "keep",
	});
	assert.deepEqual(payload.request, {
		custom_option: "keep",
		cache_retention: "short",
	});
	assert.deepEqual(payload.reasoning, {
		enabled: true,
		effort: "high",
		reasoning_effort: "high",
	});
	if (process.platform !== "win32") {
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await stat(directory)).mode & 0o777, 0o700);
	}
	assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);

	await writeUserProviderConfig!({
		homeDir,
		provider: "anthropic",
		protocol: "anthropic_messages",
		model: "claude-sonnet-4-6",
		apiBaseUrl: "https://api.anthropic.com/",
		authRef: "anthropic",
		cacheRetention: "short",
		thinkingEnabled: true,
		reasoningEffort: "high",
		failpoint: () => { throw new Error("no-op must not replace"); },
	});
	assert.equal(await readFile(path, "utf8"), raw);
});

test("user config writer preserves the old file and redacts atomic replacement failures", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const directory = join(homeDir, ".mycli");
	const path = join(directory, "config.toml");
	const oldContent = '[model]\nname = "old-model"\n';
	await mkdir(directory, { recursive: true });
	await writeFile(path, oldContent, "utf8");
	const writeUserProviderConfig = (
		config as { writeUserProviderConfig?: WriteUserProviderConfig }
	).writeUserProviderConfig;

	assert.equal(typeof writeUserProviderConfig, "function");
	await assert.rejects(
		() => writeUserProviderConfig!({
			homeDir,
			provider: "compatible",
			protocol: "responses",
			model: "private-model",
			apiBaseUrl: "https://private.example/v1",
			authRef: "private-auth",
			cacheRetention: "short",
			failpoint: () => { throw new Error("sk-private-secret-value"); },
		}),
		(error: unknown) => error instanceof Error
			&& error.message === "config_write_failed: unable to update user config"
			&& !error.message.includes("private-secret-value"),
	);
	assert.equal(await readFile(path, "utf8"), oldContent);
	assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
});

test("user config writer rejects incomplete provider settings", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const writeUserProviderConfig = (
		config as { writeUserProviderConfig?: WriteUserProviderConfig }
	).writeUserProviderConfig;

	assert.equal(typeof writeUserProviderConfig, "function");
	await assert.rejects(
		() => writeUserProviderConfig!({
			homeDir,
			provider: "openai",
			protocol: "responses",
			model: " ",
			apiBaseUrl: "https://api.openai.com/v1",
			authRef: "openai",
			cacheRetention: "short",
		}),
		/config_write_failed: provider settings must be non-empty/,
	);
});

test("user config writer persists a validated dynamic provider route", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const writeUserProviderConfig = (
		config as { writeUserProviderConfig?: WriteUserProviderConfig }
	).writeUserProviderConfig;
	assert.equal(typeof writeUserProviderConfig, "function");

	await writeUserProviderConfig!({
		homeDir,
		provider: "fireworks",
		protocol: "chat_completions",
		model: "accounts/example/models/custom",
		apiBaseUrl: "https://api.fireworks.ai/inference/v1",
		authRef: "fireworks-primary",
		cacheRetention: "short",
	});
	const resolved = await config.resolveConfig({
		homeDir,
		workspaceRoot: homeDir,
		env: {},
	});
	assert.equal(resolved.provider, "fireworks");
	assert.equal(resolved.model, "accounts/example/models/custom");
	assert.equal(resolved.authRef, "fireworks-primary");
});

test("user config writer clears active thinking effort when model reasoning is disabled", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const directory = join(homeDir, ".mycli");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "config.toml"), [
		"[reasoning]",
		"enabled = true",
		'effort = "high"',
		'reasoning_effort = "high"',
		"",
	].join("\n"), "utf8");

	await config.writeUserProviderConfig({
		homeDir,
		provider: "deepseek",
		protocol: "chat_completions",
		model: "deepseek-chat",
		apiBaseUrl: "https://api.deepseek.com",
		authRef: "deepseek",
		cacheRetention: "short",
		thinkingEnabled: false,
		reasoningEffort: "high",
	});

	const payload = parse(await readFile(join(directory, "config.toml"), "utf8")) as Record<string, unknown>;
	assert.deepEqual(payload.reasoning, { enabled: false, reasoning_effort: "high" });
	const resolved = await config.resolveConfig({
		homeDir,
		workspaceRoot: homeDir,
		env: { HOME: homeDir },
		overrides: { session: "reasoning-disabled" },
	});
	assert.equal(resolved.thinkingEnabled, false);
	assert.equal(resolved.reasoningEffort, "high");
});

test("user config writer validates the complete candidate before replacement", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const directory = join(homeDir, ".mycli");
	const path = join(directory, "config.toml");
	const invalid = [
		"[context]",
		"compaction_token_limit = 11000",
		"",
		"[request]",
		"max_prompt_tokens = 10000",
		"",
	].join("\n");
	await mkdir(directory, { recursive: true });
	await writeFile(path, invalid, "utf8");

	await assert.rejects(
		() => config.writeUserProviderConfig({
			homeDir,
			provider: "openai",
			protocol: "responses",
			model: "private-model-sentinel",
			apiBaseUrl: "https://private.example/v1",
			authRef: "openai",
			cacheRetention: "short",
		}),
		(error: unknown) => error instanceof Error
			&& error.message === "config_write_failed: unable to update user config"
			&& !error.message.includes("private-model-sentinel"),
	);
	assert.equal(await readFile(path, "utf8"), invalid);
});

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "mycli-user-config-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}
