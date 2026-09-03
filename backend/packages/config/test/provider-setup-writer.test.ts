import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { resolveConfig, writeUserProviderSetup } from "../src/index.ts";

test("provider setup round trips every curated provider through private files", async (t) => {
	const providers = [
		["openrouter", "openrouter/auto", "https://openrouter.ai/api/v1"],
		["groq", "openai/gpt-oss-120b", "https://api.groq.com/openai/v1"],
		["together", "moonshotai/Kimi-K2.7-Code", "https://api.together.ai/v1"],
		["moonshotai", "kimi-k2.7-code", "https://api.moonshot.ai/v1"],
		["nvidia", "openai/gpt-oss-120b", "https://integrate.api.nvidia.com/v1"],
		["cerebras", "gpt-oss-120b", "https://api.cerebras.ai/v1"],
	] as const;

	for (const [provider, model, baseUrl] of providers) {
		const homeDir = await temporaryDirectory(t);
		const secret = `${provider}-private-sentinel`;
		const result = await writeUserProviderSetup({
			homeDir,
			provider,
			protocol: "chat_completions",
			model,
			apiBaseUrl: `${baseUrl}/`,
			authRef: provider,
			apiKey: secret,
			cacheRetention: "short",
		});
		const resolved = await resolveConfig({
			homeDir,
			workspaceRoot: homeDir,
			env: {},
		});
		assert.equal(resolved.provider, provider);
		assert.equal(resolved.protocol, "chat_completions");
		assert.equal(resolved.model, model);
		assert.equal(resolved.apiBaseUrl, baseUrl);
		assert.equal(resolved.authRef, provider);
		assert.equal(resolved.apiKey, secret);
		assert.equal((await readFile(result.configPath, "utf8")).includes(secret), false);
		assert.equal(JSON.stringify(result).includes(secret), false);
		if (process.platform !== "win32") {
			assert.equal((await stat(result.configPath)).mode & 0o777, 0o600);
			assert.equal((await stat(result.authPath)).mode & 0o777, 0o600);
		}
	}
});

test("provider setup writes config and credentials without returning the secret", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const result = await writeUserProviderSetup({
		homeDir,
		provider: "openai",
		protocol: "responses",
		model: "gpt-5",
		apiBaseUrl: "https://api.openai.com/v1",
		authRef: "openai",
		apiKey: "private-setup-sentinel",
		cacheRetention: "short",
	});

	assert.equal(result.configPath, join(homeDir, ".mycli", "config.toml"));
	assert.equal(result.authPath, join(homeDir, ".mycli", "auth.json"));
	assert.equal(JSON.stringify(result).includes("private-setup-sentinel"), false);
	assert.match(await readFile(result.configPath, "utf8"), /name = "gpt-5"/u);
	assert.match(await readFile(result.authPath, "utf8"), /private-setup-sentinel/u);
});

test("provider setup restores exact credential bytes when config persistence fails", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const directory = join(homeDir, ".mycli");
	const configPath = join(directory, "config.toml");
	const authPath = join(directory, "auth.json");
	const configBefore = "# existing config\n[model]\nname = \"old-model\"\n";
	const authBefore = '{"openai":{"type":"api_key","key":"old-key"},"anthropic":{"type":"api_key","key":"keep-key"}}\n';
	await mkdir(directory, { recursive: true });
	await Promise.all([
		writeFile(configPath, configBefore, "utf8"),
		writeFile(authPath, authBefore, "utf8"),
	]);

	await assert.rejects(
		() => writeUserProviderSetup({
			homeDir,
			provider: "openai",
			protocol: "responses",
			model: "gpt-5",
			apiBaseUrl: "https://api.openai.com/v1",
			authRef: "openai",
			apiKey: "private-replacement-sentinel",
			cacheRetention: "short",
			configFailpoint: () => { throw new Error("private-config-failure"); },
		}),
		(error: unknown) => error instanceof Error
			&& error.message === "provider_setup_write_failed: unable to update provider credentials"
			&& !error.message.includes("private-replacement-sentinel"),
	);
	assert.equal(await readFile(configPath, "utf8"), configBefore);
	assert.equal(await readFile(authPath, "utf8"), authBefore);
});

test("provider setup reports a bounded failure when credential rollback cannot prove ownership", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const directory = join(homeDir, ".mycli");
	const authPath = join(directory, "auth.json");
	await mkdir(directory, { recursive: true });
	await writeFile(authPath, '{"openai":{"type":"api_key","key":"old-key"}}\n', "utf8");

	await assert.rejects(
		() => writeUserProviderSetup({
			homeDir,
			provider: "openai",
			protocol: "responses",
			model: "gpt-5",
			apiBaseUrl: "https://api.openai.com/v1",
			authRef: "openai",
			apiKey: "replacement-key",
			cacheRetention: "short",
			configFailpoint: () => { throw new Error("config failure"); },
			authRollbackFailpoint: () => { throw new Error("rollback failure"); },
		}),
		/provider_setup_write_failed/u,
	);
	assert.match(await readFile(authPath, "utf8"), /replacement-key/u);
});

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "mycli-provider-setup-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}
