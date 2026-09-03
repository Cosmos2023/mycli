import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { parse } from "smol-toml";
import { PROVIDER_IDS } from "@mycli/core";
import type { PrepareUserRipgrepOptions, RipgrepPrepareResult } from "@mycli/tools";
import { runSetupCommand } from "../src/management/setup.ts";

test("setup cancellation does not write config or credentials", async (t) => {
	const homeDir = await temporaryDirectory(t);
	let plainCalls = 0;
	const response = await runSetupCommand({
		homeDir,
		isTty: true,
		runTui: async () => undefined,
		runPlain: async () => { plainCalls += 1; return undefined; },
	});

	assert.equal(response.ok, false);
	assert.equal(response.cancelled, true);
	assert.equal(response.exitCode, 130);
	assert.equal(plainCalls, 0);
	await assert.rejects(() => access(join(homeDir, ".mycli", "config.toml")));
	await assert.rejects(() => access(join(homeDir, ".mycli", "auth.json")));
});

test("setup builds all provider rows, persists a successful result, and never returns the key", async (t) => {
	const homeDir = await temporaryDirectory(t);
	await mkdir(join(homeDir, ".mycli"), { recursive: true });
	await writeFile(join(homeDir, ".mycli", "auth.json"), JSON.stringify({
		anthropic: { type: "api_key", key: "existing-key" },
	}), "utf8");
	let capturedState: {
		readonly providers: readonly {
			readonly id: string;
			readonly name: string;
			readonly configured?: boolean;
			readonly protocol?: string;
			readonly default_model?: string;
			readonly default_base_url?: string;
		}[];
	} | undefined;
	const response = await runSetupCommand({
		homeDir,
		isTty: true,
		resolveRipgrep: () => undefined,
		prepareRipgrep: preparedRipgrep,
		runTui: async (state) => {
			capturedState = state;
			return {
				provider: "compatible",
				api_base_url: "https://cosmos.example/v1/",
				model: "gpt-test",
				api_key: "sk-private-secret-value",
			};
		},
		runPlain: async () => { throw new Error("must not use plain setup"); },
	});

	assert.equal(response.ok, true);
	assert.deepEqual(capturedState?.providers.map((provider) => provider.id), PROVIDER_IDS);
	assert.deepEqual(
		capturedState?.providers.filter((provider) => [
			"openrouter", "groq", "together", "moonshotai", "nvidia", "cerebras",
		].includes(provider.id)).map((provider) => [
			provider.id,
			provider.name,
			provider.protocol,
			provider.default_model,
			provider.default_base_url,
		]),
		[
			["openrouter", "OpenRouter", "chat_completions", "openrouter/auto", "https://openrouter.ai/api/v1"],
			["groq", "Groq", "chat_completions", "openai/gpt-oss-120b", "https://api.groq.com/openai/v1"],
			["together", "Together", "chat_completions", "moonshotai/Kimi-K2.7-Code", "https://api.together.ai/v1"],
			["moonshotai", "Moonshot AI", "chat_completions", "kimi-k2.7-code", "https://api.moonshot.ai/v1"],
			["nvidia", "NVIDIA", "chat_completions", "openai/gpt-oss-120b", "https://integrate.api.nvidia.com/v1"],
			["cerebras", "Cerebras", "chat_completions", "gpt-oss-120b", "https://api.cerebras.ai/v1"],
		],
	);
	assert.equal(
		capturedState?.providers.find((provider) => provider.id === "anthropic")?.configured,
		true,
	);
	assert.equal(JSON.stringify(response).includes("private-secret-value"), false);
	const auth = JSON.parse(await readFile(join(homeDir, ".mycli", "auth.json"), "utf8"));
	assert.equal(auth.compatible.key, "sk-private-secret-value");
	const config = parse(await readFile(join(homeDir, ".mycli", "config.toml"), "utf8")) as {
		model: Record<string, unknown>;
	};
	assert.deepEqual(config.model, {
		provider: "compatible",
		protocol: "chat_completions",
		name: "gpt-test",
		api_base_url: "https://cosmos.example/v1",
		auth_ref: "compatible",
	});
	assert.equal(response.ripgrepInstalled, true);
	assert.equal(response.ripgrepPath, join(homeDir, ".mycli", "vendor", "ripgrep", "test", "rg"));
});

test("non-TTY setup uses explicit options and stdin without attempting TUI startup", async (t) => {
	const homeDir = await temporaryDirectory(t);
	let tuiCalls = 0;
	let inputCalls = 0;
	const response = await runSetupCommand({
		homeDir,
		isTty: false,
		prepareRipgrep: preparedRipgrep,
		runTui: async () => { tuiCalls += 1; return undefined; },
		nonInteractive: {
			provider: "anthropic",
			readApiKeyInput: async () => {
				inputCalls += 1;
				return "secret-value";
			},
		},
	});

	assert.equal(response.ok, true);
	assert.equal(tuiCalls, 0);
	assert.equal(inputCalls, 1);
});

test("non-TTY setup resolves defaults and explicit values for every curated provider", async (t) => {
	const providers = [
		["openrouter", "openrouter/auto", "https://openrouter.ai/api/v1", "medium"],
		["groq", "openai/gpt-oss-120b", "https://api.groq.com/openai/v1", "medium"],
		["together", "moonshotai/Kimi-K2.7-Code", "https://api.together.ai/v1", "high"],
		["moonshotai", "kimi-k2.7-code", "https://api.moonshot.ai/v1", "high"],
		["nvidia", "openai/gpt-oss-120b", "https://integrate.api.nvidia.com/v1", "none"],
		["cerebras", "gpt-oss-120b", "https://api.cerebras.ai/v1", "medium"],
	] as const;

	for (const [provider, defaultModel, defaultBaseUrl, defaultEffort] of providers) {
		for (const explicit of [false, true]) {
			const homeDir = await temporaryDirectory(t);
			const secret = `${provider}-${explicit ? "explicit" : "default"}-secret`;
			const model = explicit ? `${provider}-custom-model` : defaultModel;
			const apiBaseUrl = explicit ? `https://${provider}.example.test/v1` : defaultBaseUrl;
			const response = await runSetupCommand({
				homeDir,
				isTty: false,
				prepareRipgrep: preparedRipgrep,
				nonInteractive: {
					provider,
					...(explicit ? { model, apiBaseUrl } : {}),
					readApiKeyInput: async () => secret,
				},
			});
			assert.equal(response.ok, true);
			assert.equal(response.provider, provider);
			assert.equal(response.protocol, "chat_completions");
			assert.equal(response.model, model);
			assert.equal(response.apiBaseUrl, apiBaseUrl);
			assert.equal(JSON.stringify(response).includes(secret), false);
			const config = parse(await readFile(join(homeDir, ".mycli", "config.toml"), "utf8")) as {
				model: Record<string, unknown>;
				reasoning: Record<string, unknown>;
			};
			assert.deepEqual(config.model, {
				provider,
				protocol: "chat_completions",
				name: model,
				api_base_url: apiBaseUrl,
				auth_ref: provider,
			});
			const expectedEffort = explicit ? "none" : defaultEffort;
			assert.deepEqual(config.reasoning, {
				enabled: expectedEffort !== "none",
				reasoning_effort: expectedEffort,
				...(expectedEffort === "none" ? {} : { effort: expectedEffort }),
			});
			const auth = JSON.parse(await readFile(join(homeDir, ".mycli", "auth.json"), "utf8"));
			assert.equal(auth[provider].key, secret);
			if (process.platform !== "win32") {
				assert.equal((await stat(join(homeDir, ".mycli", "config.toml"))).mode & 0o777, 0o600);
				assert.equal((await stat(join(homeDir, ".mycli", "auth.json"))).mode & 0o777, 0o600);
			}
		}
	}
});

test("non-TTY setup rejects empty keys for every curated provider without writing state", async (t) => {
	for (const provider of [
		"openrouter", "groq", "together", "moonshotai", "nvidia", "cerebras",
	] as const) {
		const homeDir = await temporaryDirectory(t);
		const response = await runSetupCommand({
			homeDir,
			isTty: false,
			prepareRipgrep: preparedRipgrep,
			nonInteractive: {
				provider,
				readApiKeyInput: async () => "  ",
			},
		});
		assert.equal(response.ok, false);
		assert.deepEqual(response.issues, ["setup_invalid_result"]);
		await assert.rejects(() => access(join(homeDir, ".mycli", "config.toml")));
		await assert.rejects(() => access(join(homeDir, ".mycli", "auth.json")));
	}
});

test("non-TTY setup without explicit options fails before reading stdin", async (t) => {
	const homeDir = await temporaryDirectory(t);
	let plainCalls = 0;
	const response = await runSetupCommand({
		homeDir,
		isTty: false,
		runPlain: async () => { plainCalls += 1; return undefined; },
	});

	assert.equal(response.ok, false);
	assert.equal(response.exitCode, 2);
	assert.deepEqual(response.issues, ["setup_non_interactive_required"]);
	assert.equal(plainCalls, 0);
	await assert.rejects(access(join(homeDir, ".mycli")));
});

test("setup reuses packaged ripgrep without downloading a user copy", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const packagedPath = join(homeDir, "package", "native", "ripgrep", "test", "rg");
	let prepareCalls = 0;
	const response = await runSetupCommand({
		homeDir,
		isTty: false,
		resolveRipgrep: () => packagedPath,
		prepareRipgrep: async () => {
			prepareCalls += 1;
			return { path: "unexpected", installed: true };
		},
		nonInteractive: {
			provider: "openai",
			model: "gpt-test",
			readApiKeyInput: async () => "secret-value",
		},
	});

	assert.equal(response.ok, true);
	assert.equal(response.ripgrepPath, packagedPath);
	assert.equal(response.ripgrepInstalled, false);
	assert.equal(prepareCalls, 0);
});

test("TTY setup falls back to plain interaction when TUI startup fails", async (t) => {
	const homeDir = await temporaryDirectory(t);
	let plainCalls = 0;
	const response = await runSetupCommand({
		homeDir,
		isTty: true,
		prepareRipgrep: preparedRipgrep,
		runTui: async () => { throw new Error("private module path"); },
		runPlain: async () => {
			plainCalls += 1;
			return {
				provider: "openai",
				api_base_url: "https://api.openai.com/v1",
				model: "gpt-5",
				api_key: "secret-value",
			};
		},
	});

	assert.equal(response.ok, true);
	assert.equal(plainCalls, 1);
	assert.equal(JSON.stringify(response).includes("private module path"), false);
});

test("plain setup consumes pre-buffered piped answers without echoing the API key", {
	timeout: 2_000,
}, async (t) => {
	const homeDir = await temporaryDirectory(t);
	const input = new PassThrough();
	const output = new PassThrough();
	let rendered = "";
	output.setEncoding("utf8");
	output.on("data", (chunk: string) => { rendered += chunk; });
	input.end("5\n\n\nsecret-piped-value\n");

	const response = await runSetupCommand({
		homeDir,
		isTty: true,
		input,
		output,
		prepareRipgrep: preparedRipgrep,
		runTui: async () => { throw new Error("TUI unavailable"); },
	});

	assert.equal(response.ok, true);
	assert.equal(response.provider, "anthropic");
	assert.equal(rendered.includes("secret-piped-value"), false);
	assert.equal(JSON.stringify(response).includes("secret-piped-value"), false);
});

test("setup keeps saved provider state when ripgrep preparation fails", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const response = await runSetupCommand({
		homeDir,
		isTty: false,
		resolveRipgrep: () => undefined,
		prepareRipgrep: async () => { throw new Error("download details must stay bounded"); },
		nonInteractive: {
			provider: "openai",
			model: "gpt-test",
			readApiKeyInput: async () => "secret-value",
		},
	});

	assert.equal(response.ok, true);
	assert.deepEqual(response.issues, ["ripgrep_prepare_failed"]);
	assert.equal(JSON.stringify(response).includes("download details"), false);
	assert.equal(JSON.parse(await readFile(join(homeDir, ".mycli", "auth.json"), "utf8")).openai.key, "secret-value");
	await access(join(homeDir, ".mycli", "config.toml"));
});

test("setup reports interrupted ripgrep preparation after preserving provider state", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const response = await runSetupCommand({
		homeDir,
		isTty: false,
		resolveRipgrep: () => undefined,
		prepareRipgrep: async () => {
			const error = new Error("interrupted");
			error.name = "AbortError";
			throw error;
		},
		nonInteractive: {
			provider: "anthropic",
			model: "claude-test",
			readApiKeyInput: async () => "secret-value",
		},
	});

	assert.equal(response.ok, true);
	assert.deepEqual(response.issues, ["ripgrep_prepare_interrupted"]);
	await access(join(homeDir, ".mycli", "config.toml"));
	await access(join(homeDir, ".mycli", "auth.json"));
});

async function preparedRipgrep(
	options: PrepareUserRipgrepOptions,
): Promise<RipgrepPrepareResult> {
	return {
		path: join(options.destinationRoot ?? "", "test", "rg"),
		installed: true,
	};
}

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "mycli-node-setup-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}
