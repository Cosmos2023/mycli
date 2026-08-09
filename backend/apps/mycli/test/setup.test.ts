import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { parse } from "smol-toml";
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
		readonly providers: readonly { readonly id: string; readonly configured?: boolean }[];
	} | undefined;
	const response = await runSetupCommand({
		homeDir,
		isTty: true,
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
	assert.deepEqual(capturedState?.providers.map((provider) => provider.id), [
		"openai",
		"codex",
		"deepseek",
		"qwen",
		"anthropic",
		"compatible",
	]);
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

test("non-TTY setup uses the plain interaction without attempting TUI startup", async (t) => {
	const homeDir = await temporaryDirectory(t);
	let tuiCalls = 0;
	let plainCalls = 0;
	const response = await runSetupCommand({
		homeDir,
		isTty: false,
		prepareRipgrep: preparedRipgrep,
		runTui: async () => { tuiCalls += 1; return undefined; },
		runPlain: async () => {
			plainCalls += 1;
			return {
				provider: "anthropic",
				api_base_url: "https://api.anthropic.com",
				model: "claude-sonnet-4-6",
				api_key: "secret-value",
			};
		},
	});

	assert.equal(response.ok, true);
	assert.equal(tuiCalls, 0);
	assert.equal(plainCalls, 1);
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
		runPlain: async () => ({
			provider: "openai",
			api_base_url: "https://api.openai.com/v1",
			model: "gpt-test",
			api_key: "secret-value",
		}),
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
		isTty: false,
		input,
		output,
		prepareRipgrep: preparedRipgrep,
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
		prepareRipgrep: async () => { throw new Error("download details must stay bounded"); },
		runPlain: async () => ({
			provider: "openai",
			api_base_url: "https://api.openai.com/v1",
			model: "gpt-test",
			api_key: "secret-value",
		}),
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
		prepareRipgrep: async () => {
			const error = new Error("interrupted");
			error.name = "AbortError";
			throw error;
		},
		runPlain: async () => ({
			provider: "anthropic",
			api_base_url: "https://api.anthropic.com",
			model: "claude-test",
			api_key: "secret-value",
		}),
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
