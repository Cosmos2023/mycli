import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { AuthManagementService, readApiKeyFromStdin } from "../src/management/auth.ts";

test("curated providers share the provider-free login status and logout lifecycle", async (t) => {
	const providers = [
		["openrouter", "OPENROUTER_API_KEY"],
		["groq", "GROQ_API_KEY"],
		["together", "TOGETHER_API_KEY"],
		["moonshotai", "MOONSHOT_API_KEY"],
		["nvidia", "NVIDIA_API_KEY"],
		["cerebras", "CEREBRAS_API_KEY"],
	] as const;
	const signal = new AbortController().signal;

	for (const [provider, ambientVariable] of providers) {
		const root = await temporaryDirectory(t);
		const homeDir = join(root, "home");
		const secret = `${provider}-stored-secret`;
		await mkdir(join(homeDir, ".mycli"), { recursive: true });
		await writeFile(join(homeDir, ".mycli", "config.toml"), [
			"[model]",
			`provider = "${provider}"`,
			"",
		].join("\n"), "utf8");
		const service = new AuthManagementService({
			homeDir,
			workspaceRoot: root,
			env: { [ambientVariable]: `${provider}-ambient-secret` },
			workspaceTrust: "untrusted",
			readApiKeyInput: async () => secret,
		});
		const missing = await service.execute({
			kind: "login",
			action: "status",
			json: true,
		}, signal);
		assert.equal(missing.provider, provider);
		assert.equal(missing.authRef, provider);
		assert.equal(missing.source, "missing");

		const loggedIn = await service.execute({
			kind: "login",
			action: "api_key",
			provider,
			json: true,
		}, signal);
		assert.equal(loggedIn.source, "stored");
		assert.equal(loggedIn.authRef, provider);
		assert.equal(JSON.stringify(loggedIn).includes(secret), false);
		assert.equal(JSON.stringify(loggedIn).includes("ambient-secret"), false);

		const environment = new AuthManagementService({
			homeDir,
			workspaceRoot: root,
			env: { MYCLI_API_KEY: `${provider}-environment-secret` },
			workspaceTrust: "untrusted",
		});
		const environmentStatus = await environment.execute({
			kind: "login",
			action: "status",
			json: true,
		}, signal);
		assert.equal(environmentStatus.source, "environment");
		assert.equal(JSON.stringify(environmentStatus).includes("environment-secret"), false);

		const loggedOut = await service.execute({
			kind: "logout",
			action: "logout",
			provider,
			json: true,
		}, signal);
		assert.equal(loggedOut.removed, true);
		assert.equal(loggedOut.source, "missing");
		assert.equal(JSON.stringify(loggedOut).includes(secret), false);
	}
});

test("auth status is provider-free and reports missing, stored, and environment sources", async (t) => {
	const root = await temporaryDirectory(t);
	const homeDir = join(root, "home");
	const service = new AuthManagementService({
		homeDir,
		workspaceRoot: root,
		env: {},
		workspaceTrust: "untrusted",
	});
	const signal = new AbortController().signal;

	assert.deepEqual(await service.execute({
		kind: "login",
		action: "status",
		json: false,
	}, signal), {
		ok: true,
		action: "status",
		provider: "openai",
		authRef: "openai",
		configured: false,
		source: "missing",
		stored: false,
		message: "No credential is configured.",
	});

	await mkdir(join(homeDir, ".mycli"), { recursive: true });
	await writeFile(join(homeDir, ".mycli", "auth.json"), JSON.stringify({
		openai: { type: "api_key", key: "stored-secret" },
	}), "utf8");
	assert.equal((await service.execute({
		kind: "login",
		action: "status",
		json: false,
	}, signal)).source, "stored");

	const environment = new AuthManagementService({
		homeDir,
		workspaceRoot: root,
		env: { MYCLI_API_KEY: "environment-secret" },
		workspaceTrust: "untrusted",
	});
	const response = await environment.execute({
		kind: "login",
		action: "status",
		json: true,
	}, signal);
	assert.equal(response.source, "environment");
	assert.equal(JSON.stringify(response).includes("environment-secret"), false);
});

test("stdin login stores a custom auth reference without returning the secret", async (t) => {
	const root = await temporaryDirectory(t);
	const homeDir = join(root, "home");
	const service = new AuthManagementService({
		homeDir,
		workspaceRoot: root,
		env: {},
		workspaceTrust: "untrusted",
		readApiKeyInput: async () => "private-login-sentinel",
	});
	const response = await service.execute({
		kind: "login",
		action: "api_key",
		provider: "openai",
		authRef: "openai-work",
		json: true,
	}, new AbortController().signal);

	assert.equal(response.ok, true);
	assert.equal(response.source, "stored");
	assert.equal(response.authRef, "openai-work");
	assert.equal(JSON.stringify(response).includes("private-login-sentinel"), false);
	assert.match(await readFile(join(homeDir, ".mycli", "auth.json"), "utf8"), /private-login-sentinel/u);
});

test("logout preserves unrelated credentials and reports an effective environment credential", async (t) => {
	const root = await temporaryDirectory(t);
	const homeDir = join(root, "home");
	await mkdir(join(homeDir, ".mycli"), { recursive: true });
	await writeFile(join(homeDir, ".mycli", "auth.json"), JSON.stringify({
		openai: { type: "api_key", key: "remove-secret" },
		anthropic: { type: "api_key", key: "keep-secret" },
	}), "utf8");
	const service = new AuthManagementService({
		homeDir,
		workspaceRoot: root,
		env: { MYCLI_API_KEY: "environment-secret" },
		workspaceTrust: "untrusted",
	});
	const response = await service.execute({
		kind: "logout",
		action: "logout",
		json: false,
	}, new AbortController().signal);

	assert.equal(response.ok, true);
	assert.equal(response.removed, true);
	assert.equal(response.configured, true);
	assert.equal(response.source, "environment");
	assert.deepEqual(JSON.parse(await readFile(join(homeDir, ".mycli", "auth.json"), "utf8")), {
		anthropic: { type: "api_key", key: "keep-secret" },
	});
});

test("auth management preserves malformed credential bytes", async (t) => {
	const root = await temporaryDirectory(t);
	const homeDir = join(root, "home");
	const path = join(homeDir, ".mycli", "auth.json");
	const malformed = "{private-auth-malformed";
	await mkdir(join(homeDir, ".mycli"), { recursive: true });
	await writeFile(path, malformed, "utf8");
	const service = new AuthManagementService({
		homeDir,
		workspaceRoot: root,
		env: {},
		workspaceTrust: "untrusted",
		readApiKeyInput: async () => "replacement-secret",
	});

	for (const command of [
		{ kind: "login", action: "status", json: true },
		{ kind: "login", action: "api_key", json: true },
		{ kind: "logout", action: "logout", json: true },
	] as const) {
		const response = await service.execute(command, new AbortController().signal);
		assert.equal(response.ok, false);
		assert.deepEqual(response.issues, ["auth_store_malformed"]);
		assert.equal(JSON.stringify(response).includes("private-auth-malformed"), false);
	}
	assert.equal(await readFile(path, "utf8"), malformed);
});

test("API key stdin reader rejects TTY, empty, and oversized input without echoing content", async () => {
	const tty = new PassThrough() as PassThrough & { isTTY?: boolean };
	tty.isTTY = true;
	await assert.rejects(() => readApiKeyFromStdin(tty), { code: "auth_stdin_required" });

	const empty = new PassThrough() as PassThrough & { isTTY?: boolean };
	empty.isTTY = false;
	empty.end("  \n");
	await assert.rejects(() => readApiKeyFromStdin(empty), { code: "auth_input_empty" });

	const oversized = new PassThrough() as PassThrough & { isTTY?: boolean };
	oversized.isTTY = false;
	oversized.end("x".repeat(64 * 1024 + 1));
	await assert.rejects(() => readApiKeyFromStdin(oversized), { code: "auth_input_too_large" });

	const valid = new PassThrough() as PassThrough & { isTTY?: boolean };
	valid.isTTY = false;
	valid.end("  stdin-secret  \n");
	assert.equal(await readApiKeyFromStdin(valid), "stdin-secret");
});

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "mycli-auth-management-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}
