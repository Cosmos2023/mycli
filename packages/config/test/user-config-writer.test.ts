import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { parse } from "smol-toml";
import * as config from "../src/index.ts";

type WriteUserProviderConfig = (input: {
	readonly homeDir: string;
	readonly provider: string;
	readonly protocol: string;
	readonly model: string;
	readonly apiBaseUrl: string;
	readonly authRef: string;
	readonly promptCacheKeyEnabled: boolean;
	readonly cacheControlEnabled: boolean;
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
		'custom_flag = "keep"',
		"",
		"[model]",
		'provider = "openai"',
		'protocol = "responses"',
		'name = "old-model"',
		'api_base_url = "https://old.example/v1"',
		'api_key = "nested-legacy-secret"',
		"",
		"[plugins]",
		'enabled = ["demo"]',
		"",
	].join("\n"), { encoding: "utf8", mode: 0o644 });
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
		promptCacheKeyEnabled: false,
		cacheControlEnabled: true,
		reasoningEffort: "high",
	});

	assert.equal(writtenPath, path);
	const raw = await readFile(path, "utf8");
	const payload = parse(raw) as Record<string, unknown>;
	assert.equal(raw.includes("legacy-secret"), false);
	assert.equal(payload.custom_flag, "keep");
	assert.deepEqual(payload.plugins, { enabled: ["demo"] });
	assert.deepEqual(payload.model, {
		provider: "anthropic",
		protocol: "anthropic_messages",
		name: "claude-sonnet-4-6",
		api_base_url: "https://api.anthropic.com",
		auth_ref: "anthropic",
	});
	assert.deepEqual(payload.request, {
		prompt_cache_key_enabled: false,
		cache_control_enabled: true,
	});
	assert.deepEqual(payload.reasoning, { effort: "high" });
	if (process.platform !== "win32") {
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await stat(directory)).mode & 0o777, 0o700);
	}
	assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
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
			promptCacheKeyEnabled: true,
			cacheControlEnabled: false,
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
			promptCacheKeyEnabled: true,
			cacheControlEnabled: false,
		}),
		/config_write_failed: provider settings must be non-empty/,
	);
});

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "mycli-user-config-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}
