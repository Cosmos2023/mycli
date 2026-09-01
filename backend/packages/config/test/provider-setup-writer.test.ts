import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { writeUserProviderSetup } from "../src/index.ts";

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
		promptCacheKeyEnabled: true,
		cacheControlEnabled: false,
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
			promptCacheKeyEnabled: true,
			cacheControlEnabled: false,
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
			promptCacheKeyEnabled: true,
			cacheControlEnabled: false,
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
