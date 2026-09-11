import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseArguments, runNativeProviderSmoke } from "../smoke_native_providers.mjs";

test("native live probes require an explicit opt-in and skip missing or unsupported credentials", async (t) => {
	const homeDir = await mkdtemp(join(tmpdir(), "mycli-native-smoke-"));
	t.after(() => rm(homeDir, { recursive: true, force: true }));
	const dependencies = { homeDir, cwd: homeDir, env: {}, fetch: async () => assert.fail("must not send a request") };
	assert.throws(() => parseArguments([]));
	assert.equal(parseArguments(["--provider", "deepseek"]).live, false);
	for (const provider of ["deepseek", "google", "amazon-bedrock", "openai-codex"]) {
		const result = await runNativeProviderSmoke({ provider, live: true }, dependencies);
		assert.equal(result.exitCode, 77);
		assert.equal(result.evidence.live_validated, false);
		assert.equal(result.evidence.status, "skipped");
	}
	const ready = await runNativeProviderSmoke({ provider: "deepseek" }, { ...dependencies,
		env: { DEEPSEEK_API_KEY: "private-smoke-key" } });
	assert.equal(ready.evidence.status, "ready");
	assert.equal(ready.evidence.live_validated, false);
	assert.doesNotMatch(JSON.stringify(ready), /private-smoke-key/u);
});

test("native live probe uses SDK ambient auth and canonical errors with one attempt", async (t) => {
	const homeDir = await mkdtemp(join(tmpdir(), "mycli-native-smoke-"));
	t.after(() => rm(homeDir, { recursive: true, force: true }));
	let calls = 0;
	const result = await runNativeProviderSmoke({ provider: "azure-openai-responses", live: true }, { homeDir, cwd: homeDir,
		env: { AZURE_OPENAI_API_KEY: "private-smoke-key", AZURE_OPENAI_BASE_URL: "https://offline.invalid/openai/v1" },
		fetch: async (_url, init) => {
			calls += 1;
			assert.equal(new Headers(init.headers).get("api-key"), "private-smoke-key");
			return Response.json({ error: { code: "insufficient_quota", message: "token=private-response" } }, { status: 429 });
		},
	});
	assert.equal(calls, 1);
	assert.equal(result.exitCode, 1);
	assert.equal(result.evidence.error_code, "quota_exceeded");
	assert.doesNotMatch(JSON.stringify(result), /private-smoke-key|private-response|offline\.invalid/u);
});
