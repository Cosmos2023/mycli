import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { resolveConfig } from "../src/index.ts";

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

test("legacy transport retry limit feeds the stream retry setting", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), ["transport_retry_limit = 7"]);

	const resolved = await resolveConfig({ homeDir, workspaceRoot, env: {} });
	assert.equal(resolved.streamMaxRetries, 7);
});

test("malformed TOML raises a bounded config error", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), ["[broken"]);

	await assert.rejects(
		() => resolveConfig({ homeDir, workspaceRoot, env: {} }),
		(error: unknown) => error instanceof Error
			&& /^config_error: invalid TOML in user config$/.test(error.message),
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
