import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const probe = fileURLToPath(new URL("./fixtures/provider-startup-probe.mjs", import.meta.url));

test("compiled bootstrap loads only selected auth adapters and defers the complete pi-ai directory", { timeout: 60_000 }, async (t) => {
	for (const scenario of [
		{ name: "empty home", env: {}, ready: false },
		{ name: "explicit empty auth reference", env: { MYCLI_AUTH_REF: "" }, ready: false },
		{ name: "configured key", env: { MYCLI_API_KEY: "test-key" }, ready: true },
		{ name: "ambient OpenAI key", env: { OPENAI_API_KEY: "test-key" }, ready: true },
		{ name: "ambient Groq key", env: { MYCLI_PROVIDER: "groq", GROQ_API_KEY: "test-key" }, ready: true, selected: "groq" },
		{ name: "scoped reference ignores ambient key", env: { MYCLI_PROVIDER: "groq", MYCLI_AUTH_REF: "scoped", GROQ_API_KEY: "test-key" }, ready: false },
		{ name: "stored scoped reference", env: { MYCLI_PROVIDER: "groq", MYCLI_AUTH_REF: "scoped" }, ready: true, stored: true },
		{ name: "native Azure auth", env: { MYCLI_PROVIDER: "azure-openai-responses", AZURE_OPENAI_BASE_URL: "https://offline.invalid/openai/v1", AZURE_OPENAI_API_KEY: "test-key" }, ready: true, selected: "azure-openai-responses" },
		{ name: "stored OAuth without refresh", env: { MYCLI_PROVIDER: "anthropic", MYCLI_AUTH_REF: "scoped" }, ready: true, oauth: true },
	]) {
		await t.test(scenario.name, async (t) => {
			const root = await mkdtemp(join(tmpdir(), "mycli-provider-startup-"));
			t.after(() => rm(root, { recursive: true, force: true }));
			const homeDir = join(root, "home");
			const workspace = join(root, "workspace");
			await mkdir(join(homeDir, ".mycli"), { recursive: true });
			await mkdir(workspace);
			if (scenario.stored) await writeFile(join(homeDir, ".mycli", "auth.json"), JSON.stringify({ scoped: { type: "api_key", key: "test-key" } }));
			if (scenario.oauth) await writeFile(join(homeDir, ".mycli", "auth.json"), JSON.stringify({ scoped: { type: "oauth", access: "test-access", refresh: "test-refresh", expires: 1 } }));
			const result = spawnSync(process.execPath, [probe], {
				cwd: workspace, env: { PATH: process.env.PATH, HOME: homeDir, MYCLI_UPDATES_CHECK_ON_STARTUP: "false", ...scenario.env },
				timeout: 15_000, encoding: "utf8", maxBuffer: 4 * 1_024 * 1_024,
			});
			assert.equal(result.error, undefined);
			assert.equal(result.status, 0, result.stderr);
			const output = JSON.parse(result.stdout) as {
				startupModules: string[]; catalogModules: string[];
				auth: { ready: boolean }; providers: unknown;
			};
			assert.equal(output.auth.ready, scenario.ready);
			assert(!output.startupModules.some((url) => url.endsWith("/providers/all.js")));
			for (const provider of ["groq", "openrouter", "together", "moonshotai", "nvidia", "cerebras", "google", "azure-openai-responses"]) {
				if (provider !== scenario.selected) assert(!output.startupModules.some((url) => url.endsWith(`/providers/${provider}.js`)), provider);
			}
			assert(output.catalogModules.some((url) => url.endsWith("/providers/all.js")));
			assert(output.catalogModules.some((url) => url.endsWith("/providers/openrouter.js")));
			assert.match(JSON.stringify(output.providers), /qwen-token-plan-cn/u);
		});
	}
});
