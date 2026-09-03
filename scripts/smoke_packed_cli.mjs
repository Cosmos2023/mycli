#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
	RIPGREP_TARGETS,
	ripgrepPlatformKey,
} from "../backend/packages/tools/dist/ripgrep-targets.js";
import {
	APPLICATION_RELEASE_PACKAGE,
	VENDORED_WORKSPACE_PACKAGES,
} from "./release-config.mjs";
import { commandFailureCode } from "./smoke_release_compatibility.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PINNED_PI_AI_VERSION = await readPinnedPiAiVersion();
const ALL_PLATFORM_PACKAGES = Object.entries(RIPGREP_TARGETS).map(([target, info]) => ({
	name: info.npmPackage,
	target,
}));
const CURRENT_PLATFORM_PACKAGE = RIPGREP_TARGETS[ripgrepPlatformKey()].npmPackage;
const FLAGS = new Set(process.argv.slice(2));
const PACK_ALL_PLATFORMS = FLAGS.has("--all-platforms");
const APP_ONLY = FLAGS.has("--app-only");
const REQUIRE_WINDOWS_HELPER = FLAGS.has("--require-windows-helper");
const PLATFORM_PACKAGES = APP_ONLY
	? []
	: (PACK_ALL_PLATFORMS
		? ALL_PLATFORM_PACKAGES
		: ALL_PLATFORM_PACKAGES.filter(({ name }) => name === CURRENT_PLATFORM_PACKAGE));
const INSTALLED_APPLICATION_ROOT = `./node_modules/${APPLICATION_RELEASE_PACKAGE.name}`;
const INSTALLED_APPLICATION_PATH = [
	"node_modules",
	...APPLICATION_RELEASE_PACKAGE.name.split("/"),
];
const NATIVE_PTY_SMOKE = String.raw`
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import process from "node:process";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { startNodePtyTransport } from "${INSTALLED_APPLICATION_ROOT}/dist/node_modules/@mycli/tools/dist/index.js";

const require = createRequire(import.meta.url);
const nodePtyPackage = require.resolve("node-pty/package.json");
if (process.platform === "darwin") {
	const helper = join(
		dirname(nodePtyPackage),
		"prebuilds",
		process.platform + "-" + process.arch,
		"spawn-helper",
	);
	assert.notEqual(statSync(helper).mode & 0o111, 0, "node-pty spawn-helper is not executable");
}

const windows = process.platform === "win32";
const transport = await startNodePtyTransport({
	executable: windows ? (process.env.ComSpec ?? "cmd.exe") : (process.env.SHELL ?? "/bin/sh"),
	args: windows ? ["/q"] : ["-i"],
	cwd: process.cwd(),
	env: { ...process.env, TERM: "xterm-256color" },
	platform: process.platform,
	tty: true,
	name: "xterm-256color",
	rows: 24,
	columns: 80,
});
let output = "";
let exited = false;
transport.onOutput((chunk) => {
	output += typeof chunk.data === "string"
		? chunk.data
		: Buffer.from(chunk.data).toString("utf8");
});
const exit = new Promise((resolve) => transport.onExit(resolve)).then((value) => {
	exited = true;
	return value;
});
try {
	await transport.resize(40, 100);
	await transport.write(windows
		? "echo packed-pty-ready && exit 0\r\n"
		: "printf 'packed-pty-ready\\n'; exit 0\n");
	const result = await Promise.race([
		exit,
		new Promise((_, reject) => setTimeout(() => reject(new Error("packed PTY timed out")), 5_000)),
	]);
	assert.equal(result.exitCode, 0);
	assert.match(output, /packed-pty-ready/u);
} finally {
	if (!exited) await transport.terminate().catch(() => undefined);
	await transport.close();
}
process.stdout.write("native-pty-ok\n");
`;
const M7_PACKAGE_SMOKE = String.raw`
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	HookAllowlistStore,
	McpClient,
	PluginProcessHost,
	SkillRegistry,
	SubagentController,
} from "${INSTALLED_APPLICATION_ROOT}/dist/node_modules/@mycli/integrations/dist/index.js";

assert.equal(typeof HookAllowlistStore, "function");
assert.equal(typeof McpClient, "function");
assert.equal(typeof PluginProcessHost, "function");
assert.equal(typeof SkillRegistry, "function");
assert.equal(typeof SubagentController, "function");
assert.ok(import.meta.resolve("@anthropic-ai/sdk"));
assert.ok(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"));
const integrationsEntry = fileURLToPath(new URL(
	"${INSTALLED_APPLICATION_ROOT}/dist/node_modules/@mycli/integrations/dist/index.js",
	import.meta.url,
));
const workerBootstrap = join(dirname(integrationsEntry), "plugins", "worker-bootstrap.js");
assert.equal(statSync(workerBootstrap).isFile(), true);
process.stdout.write("m7-package-ok\n");
`;
const PROVIDER_PROTOCOL_SMOKE = String.raw`
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
	BUILTIN_MODEL_CATALOG,
	builtinModelReasoningDefaults,
	listProviderProfiles,
} from "${INSTALLED_APPLICATION_ROOT}/dist/node_modules/@mycli/config/dist/index.js";
import { ProviderRegistry } from "${INSTALLED_APPLICATION_ROOT}/dist/node_modules/@mycli/providers/dist/index.js";

const curated = [
	["openrouter", "openrouter/auto", "medium"],
	["groq", "openai/gpt-oss-120b", "medium"],
	["together", "moonshotai/Kimi-K2.7-Code", "high"],
	["moonshotai", "kimi-k2.7-code", "high"],
	["nvidia", "openai/gpt-oss-120b", "none"],
	["cerebras", "gpt-oss-120b", "medium"],
];
const profiles = listProviderProfiles().filter((profile) => (
	curated.some(([provider]) => provider === profile.provider)
));
assert.deepEqual(profiles.map((profile) => [
	profile.provider,
	profile.defaultProtocol,
	profile.defaultModel,
]), curated.map(([provider, model]) => [provider, "chat_completions", model]));
for (const [provider, model, reasoningEffort] of curated) {
	assert.ok(BUILTIN_MODEL_CATALOG.some((entry) => (
		entry.provider === provider && entry.model === model && entry.isDefault
	)));
	assert.equal(builtinModelReasoningDefaults({
		provider,
		protocol: "chat_completions",
		model,
	}).reasoningEffort, reasoningEffort);
}
const piAiPackage = JSON.parse(readFileSync(
	fileURLToPath(new URL("../package.json", import.meta.resolve("@earendil-works/pi-ai"))),
	"utf8",
));
assert.equal(piAiPackage.version, "${PINNED_PI_AI_VERSION}");

const requests = [];
const server = createServer((request, response) => {
	request.resume();
	request.on("end", () => {
		requests.push(request.url);
		switch (request.url) {
			case "/v1/responses":
				writeResponses(response);
				break;
			case "/v1/chat/completions":
				writeChat(response);
				break;
			case "/v1/messages":
				writeAnthropic(response);
				break;
			default:
				response.writeHead(404).end();
		}
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const serverUrl = "http://127.0.0.1:" + address.port;
try {
	for (const route of [
		{ provider: "compatible", protocol: "responses", model: "responses-smoke" },
		{ provider: "compatible", protocol: "chat_completions", model: "chat-smoke" },
		{ provider: "anthropic", protocol: "anthropic_messages", model: "anthropic-smoke" },
		...curated.map(([provider, model, reasoningEffort]) => ({
			provider,
			protocol: "chat_completions",
			model,
			reasoningEffort,
		})),
		{
			provider: "openrouter",
			protocol: "chat_completions",
			model: "packed-custom-model",
			reasoningEffort: "none",
		},
	]) {
		try {
			const provider = new ProviderRegistry().create({
				...route,
				apiBaseUrl: route.protocol === "anthropic_messages" ? serverUrl : serverUrl + "/v1",
				apiKey: "packed-provider-smoke-key",
				supportsImages: !curated.some(([provider]) => provider === route.provider),
				maxPromptTokens: 2_048,
				modelContextWindowTokens: 4_096,
				maxOutputTokens: 16,
			});
			const events = [];
			for await (const event of provider.stream({
				...route,
				instructions: "provider package smoke",
				messages: [{ role: "user", content: "Reply with OK." }],
				tools: [],
				reasoningEffort: route.reasoningEffort ?? "none",
				maxOutputTokens: 8,
			}, { signal: new AbortController().signal })) {
				events.push(event);
			}
			assert.ok(events.some((event) => event.type === "text_delta"));
			assert.ok(events.some((event) => event.type === "usage"));
			assert.equal(events.filter((event) => event.type === "completed").length, 1);
			assert.equal(events.at(-1)?.type, "completed");
				if (curated.some(([provider]) => provider === route.provider)) {
					assert.ok(events.some((event) => event.type === "provider_state"
						&& event.state.provider === route.provider
						&& event.state.value?.kind === "pi_ai_assistant"
						&& event.state.value?.version === 2
						&& event.state.value?.transport?.routeId === route.provider
						&& event.state.value?.transport?.catalogProviderId === route.provider
						&& event.state.value?.transport?.model === route.model));
				}
			} catch (error) {
				const routeCode = route.provider.toUpperCase().replaceAll("-", "_");
				process.stderr.write(
					"code: 'PACKED_PROVIDER_" + routeCode + "_" + route.protocol.toUpperCase() + "'\n",
				);
				throw error;
			}
	}
} finally {
	await new Promise((resolve, reject) => server.close(
		(error) => error ? reject(error) : resolve(),
	));
}
assert.deepEqual(requests, [
	"/v1/responses",
	"/v1/chat/completions",
	"/v1/messages",
	...Array(7).fill("/v1/chat/completions"),
]);
process.stdout.write("provider-protocols-ok\n");

function writeResponses(response) {
	const item = {
		type: "message",
		id: "msg_packed",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "OK", annotations: [] }],
	};
	writeSse(response, [
		{ type: "response.created", response: { id: "resp_packed", status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...item, status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id: "resp_packed",
				status: "completed",
				output: [item],
				usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
			},
		},
	]);
}

function writeChat(response) {
	writeSse(response, [
		{
			id: "chat_packed",
			choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
		},
		{
			id: "chat_packed",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
		},
	]);
}

function writeAnthropic(response) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	writeAnthropicEvent(response, "message_start", {
		type: "message_start",
		message: {
			id: "msg_packed_anthropic",
			type: "message",
			role: "assistant",
			content: [],
			model: "anthropic-smoke",
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 4, output_tokens: 0 },
		},
	});
	writeAnthropicEvent(response, "content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "" },
	});
	writeAnthropicEvent(response, "content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: "OK" },
	});
	writeAnthropicEvent(response, "content_block_stop", { type: "content_block_stop", index: 0 });
	writeAnthropicEvent(response, "message_delta", {
		type: "message_delta",
		delta: { stop_reason: "end_turn", stop_sequence: null },
		usage: { output_tokens: 1 },
	});
	writeAnthropicEvent(response, "message_stop", { type: "message_stop" });
	response.end();
}

function writeSse(response, frames) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const frame of frames) response.write("data: " + JSON.stringify(frame) + "\n\n");
	response.end("data: [DONE]\n\n");
}

function writeAnthropicEvent(response, event, value) {
	response.write("event: " + event + "\ndata: " + JSON.stringify(value) + "\n\n");
}
`;
const PI_AI_LOAD_HOOK = String.raw`
import { appendFileSync } from "node:fs";

export async function load(url, context, nextLoad) {
	if (url.includes("/node_modules/@earendil-works/pi-ai/")
		|| /\/node_modules\/(?:@google|@aws-sdk|@azure|@mistralai)\//u.test(url)) {
		appendFileSync(process.env.MYCLI_PI_AI_LOAD_LOG, url + "\n", "utf8");
	}
	return nextLoad(url, context);
}
`;
const PI_AI_LOAD_REGISTER = String.raw`
import { register } from "node:module";
register(new URL("./pi-ai-load-hook.mjs", import.meta.url));
`;
const RIPGREP_PACKAGE_SMOKE = String.raw`
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import {
	initializeRipgrepEnvironment,
	RIPGREP_TARGETS,
	RIPGREP_VERSION,
	ripgrepOutputPath,
	ripgrepPlatformKey,
} from "${INSTALLED_APPLICATION_ROOT}/dist/node_modules/@mycli/tools/dist/index.js";

const require = createRequire(import.meta.url);
const target = ripgrepPlatformKey();
const platformPackage = RIPGREP_TARGETS[target].npmPackage;
const packageRoot = dirname(require.resolve(platformPackage + "/package.json"));
const result = initializeRipgrepEnvironment({ env: process.env });
assert.ok(result.executable, "packaged ripgrep was not resolved");
assert.ok(result.directory, "packaged ripgrep directory was not resolved");
assert.equal(process.env.PATH?.split(delimiter)[0], result.directory);
assert.equal(process.env.MYCLI_RIPGREP_PATH_DIR, result.directory);
assert.equal(
	result.executable,
	ripgrepOutputPath(join(packageRoot, "vendor"), target),
	"ripgrep did not come from the installed optional platform package",
);
const probe = spawnSync("rg", ["--version"], { encoding: "utf8", env: process.env });
assert.equal(probe.status, 0, probe.stderr);
assert.match(probe.stdout, new RegExp("ripgrep " + RIPGREP_VERSION.replaceAll(".", "\\.")));
process.stdout.write("ripgrep-package-ok\n");
`;
const SESSION_RESUME_SMOKE = String.raw`
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { fingerprintSubmission } from "${INSTALLED_APPLICATION_ROOT}/dist/node_modules/@mycli/core/dist/index.js";
import { openRuntimeSessionStore } from "${INSTALLED_APPLICATION_ROOT}/dist/node_modules/@mycli/storage/dist/index.js";
import { startNodeBackend } from "${INSTALLED_APPLICATION_ROOT}/dist/node-runtime/node-backend.js";

const homeDir = process.env.HOME;
const workspaceRoot = process.cwd();
const sessionId = "packed-resume-target";
const dbPath = join(homeDir, ".mycli", "sessions.db");
await mkdir(join(homeDir, ".mycli"), { recursive: true });
const store = openRuntimeSessionStore({ dbPath });
try {
	const text = "packed resume fixture";
	store.reserveTurn({
		sessionId,
		clientTurnId: "packed-client-turn",
		clientUserMessageId: "packed-user-message",
		turnId: "packed-turn",
		requestFingerprint: fingerprintSubmission({ message: text, localImages: [] }),
		workspaceRoot,
		threadId: sessionId,
		userText: text,
		startedAt: "2026-09-01T00:00:00.000Z",
	});
	store.completeTurn({
		sessionId,
		clientTurnId: "packed-client-turn",
		assistantText: "packed resume ready",
		usage: {},
		completedAt: "2026-09-01T00:00:01.000Z",
	});
} finally {
	store.close();
}

let updateFetchStarted = false;
const updateFetch = (_input, init = {}) => {
	updateFetchStarted = true;
	return new Promise((_resolve, reject) => {
		const abort = () => {
			const error = new Error("aborted");
			error.name = "AbortError";
			reject(error);
		};
		if (init.signal?.aborted) abort();
		else init.signal?.addEventListener("abort", abort, { once: true });
	});
};
const backend = await deadline(startNodeBackend({
	cwd: workspaceRoot,
	args: ["--session", "packed-bootstrap", "--model", "gpt-5.5"],
	env: {
		...process.env,
		MYCLI_API_KEY: "fixture-key",
		MYCLI_PROVIDER: "openai",
		MYCLI_PROTOCOL: "responses",
		MYCLI_MODEL: "gpt-5.5",
		MYCLI_MEMORY_ENABLED: "false",
	},
	updateFetch,
}), 5_000, "packed backend startup timed out");
const messages = [];
createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
	messages.push(JSON.parse(line));
});
const send = (id, method, params) => {
	backend.transport.output.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
};
try {
	await waitFor(() => messages.some((message) => message.method === "runtime.ready"));
	await waitFor(() => updateFetchStarted);
	send("resume", "session.resume", { session_id: sessionId });
	const response = await waitFor(() => messages.find((message) => message.id === "resume"));
	assert.equal(response.error, undefined, JSON.stringify(response.error ?? {}));
	assert.equal(response.result?.session_id, sessionId);
} finally {
	send("shutdown", "shutdown", {});
	await backend.completion;
}
process.stdout.write("session-resume-ok\n");

async function waitFor(read) {
	const stop = Date.now() + 5_000;
	while (Date.now() < stop) {
		const value = read();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("packed session smoke timed out");
}

async function deadline(value, timeoutMs, message) {
	let timer;
	try {
		return await Promise.race([
			value,
			new Promise((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
`;

const tempRoot = await mkdtemp(join(tmpdir(), "mycli-packed-cli-"));
try {
	if (APP_ONLY && (PACK_ALL_PLATFORMS || REQUIRE_WINDOWS_HELPER)) {
		throw new Error("--app-only cannot be combined with platform gates");
	}
	const packDir = join(tempRoot, "packs");
	const installDir = join(tempRoot, "install");
	const cacheDir = join(tempRoot, "npm-cache");
	await mkdir(packDir);
	await mkdir(installDir);
	const packedArtifacts = [];
	const applicationOutput = await run("npm", [
		"pack",
		"--json",
		"--workspace",
		APPLICATION_RELEASE_PACKAGE.name,
		"--pack-destination",
		packDir,
		"--cache",
		cacheDir,
		"--silent",
	], ROOT, true);
	const applicationEntry = assertPackFileList(JSON.parse(applicationOutput));
	packedArtifacts.push({
		name: APPLICATION_RELEASE_PACKAGE.name,
		path: join(packDir, basename(applicationEntry.filename)),
	});
	for (const platformPackage of PLATFORM_PACKAGES) {
		let output;
		try {
			output = await run("npm", [
				"pack",
				"--json",
				"--pack-destination",
				packDir,
				"--cache",
				cacheDir,
				"--silent",
			], join(ROOT, "npm", "ripgrep", platformPackage.target), true);
		} catch (error) {
			const detail = error instanceof Error ? error.message : "unknown_error";
			throw new Error(`platform_pack_failed:${platformPackage.target}: ${detail}`);
		}
		const entry = assertPackFileList(JSON.parse(output), platformPackage.target);
		packedArtifacts.push({
			name: platformPackage.name,
			path: join(packDir, basename(entry.filename)),
		});
	}
	const tarballs = (await readdir(packDir)).filter((name) => name.endsWith(".tgz"));
	if (tarballs.length !== packedArtifacts.length) {
		throw new Error("packed_cli_smoke_failed: release tarball count mismatch");
	}
	const platformNames = new Set(PLATFORM_PACKAGES.map((value) => value.name));
	const installTarballs = packedArtifacts
		.filter((artifact) => !platformNames.has(artifact.name) || artifact.name === CURRENT_PLATFORM_PACKAGE)
		.map((artifact) => artifact.path);
	await writeFile(join(installDir, "package.json"), JSON.stringify({ private: true }), "utf8");
	await run("npm", [
		"install",
		"--ignore-scripts",
		"--omit=optional",
		"--no-audit",
		"--no-fund",
		"--package-lock=false",
		"--cache",
		cacheDir,
		...installTarballs,
	], installDir);
	const pythonProbe = await createPythonProbe(tempRoot);
	const guardedEnv = {
		...process.env,
		PATH: `${pythonProbe.binDir}${delimiter}${dirname(process.execPath)}`,
		MYCLI_PYTHON_PROBE_MARKER: pythonProbe.marker,
	};
	await assertNoPythonRuntimeSurface(join(
		installDir,
		...INSTALLED_APPLICATION_PATH,
		"dist",
	));
	const bin = process.platform === "win32"
		? join(installDir, "node_modules", ".bin", "mycli.cmd")
		: join(installDir, "node_modules", ".bin", "mycli");
	const help = await run(bin, ["--help"], installDir, true, guardedEnv, [0], 5_000);
	if (help.includes("--runtime-backend") || help.includes("python-sidecar")) {
		throw new Error("packed_cli_smoke_failed: installed CLI still advertises Python runtime selection");
	}
	for (const shell of ["bash", "zsh", "fish", "powershell"]) {
		const completion = await run(
			bin,
			["completion", shell],
			installDir,
			true,
			guardedEnv,
			[0],
			5_000,
		);
		if (!completion.endsWith("\n") || !completion.includes("mycli") || /\x1b\[/u.test(completion)) {
			throw new Error(`packed_cli_smoke_failed: ${shell} completion is invalid`);
		}
	}
	const nativeSmoke = join(installDir, "native-pty-smoke.mjs");
	await writeFile(nativeSmoke, NATIVE_PTY_SMOKE, "utf8");
	const nativeOutput = await runStage(
		"native_pty",
		process.execPath,
		[nativeSmoke],
		installDir,
		true,
	);
	if (!nativeOutput.includes("native-pty-ok")) {
		throw new Error("packed_cli_smoke_failed: installed native PTY smoke is incomplete");
	}
	const m7PackageSmoke = join(installDir, "m7-package-smoke.mjs");
	await writeFile(m7PackageSmoke, M7_PACKAGE_SMOKE, "utf8");
	const m7PackageOutput = await runStage(
		"integrations",
		process.execPath,
		[m7PackageSmoke],
		installDir,
		true,
	);
	if (!m7PackageOutput.includes("m7-package-ok")) {
		throw new Error("packed_cli_smoke_failed: installed M7 assets are incomplete");
	}
	const providerProtocolSmoke = join(installDir, "provider-protocol-smoke.mjs");
	const piAiLoadHook = join(installDir, "pi-ai-load-hook.mjs");
	const piAiLoadRegister = join(installDir, "pi-ai-load-register.mjs");
	const piAiLoadLog = join(installDir, "pi-ai-loaded-modules.txt");
	await writeFile(providerProtocolSmoke, PROVIDER_PROTOCOL_SMOKE, "utf8");
	await writeFile(piAiLoadHook, PI_AI_LOAD_HOOK, "utf8");
	await writeFile(piAiLoadRegister, PI_AI_LOAD_REGISTER, "utf8");
	await writeFile(piAiLoadLog, "", "utf8");
	const providerProtocolOutput = await runStage(
		"provider_protocols",
		process.execPath,
		["--import", piAiLoadRegister, providerProtocolSmoke],
		installDir,
		true,
		{ ...process.env, MYCLI_PI_AI_LOAD_LOG: piAiLoadLog },
	);
	if (!providerProtocolOutput.includes("provider-protocols-ok")) {
		throw new Error("packed_cli_smoke_failed: installed provider protocols are incomplete");
	}
		assertCatalogPiAiModuleLoading(await loadedModuleUrls(piAiLoadLog));
	if (!APP_ONLY) {
		const ripgrepPackageSmoke = join(installDir, "ripgrep-package-smoke.mjs");
		await writeFile(ripgrepPackageSmoke, RIPGREP_PACKAGE_SMOKE, "utf8");
		const ripgrepOutput = await runStage(
			"ripgrep",
			process.execPath,
			[ripgrepPackageSmoke],
			installDir,
			true,
			guardedEnv,
		);
		if (!ripgrepOutput.includes("ripgrep-package-ok")) {
			throw new Error("packed_cli_smoke_failed: installed ripgrep is incomplete");
		}
	}
	const packedHome = join(tempRoot, "home");
	const managementEnv = {
		...guardedEnv,
		HOME: packedHome,
		USERPROFILE: packedHome,
		MYCLI_API_KEY: "",
		MYCLI_AUTH_REF: "",
	};
	for (const [args, action, acceptedCodes] of [
		[["hooks", "list", "--json"], "list", [0]],
		[["plugins", "list", "--json"], "list", [0]],
		[["mcp", "list", "--json"], "list", [0]],
		[["doctor", "--json"], "doctor", [0]],
		[["config", "validate", "--json"], "validate", [0]],
		[["session", "list", "--json"], "list", [0]],
		[["update", "status", "--json"], "status", [0]],
		[["sandbox", "status", "--json"], "status", [0, 1]],
	]) {
		const output = await run(bin, args, installDir, true, managementEnv, acceptedCodes, 5_000);
		const payload = JSON.parse(output);
		if (payload.action !== action || typeof payload.ok !== "boolean") {
			throw new Error("packed_cli_smoke_failed: compiled management command is incomplete");
		}
	}
	const plainDoctor = await run(
		bin,
		["doctor"],
		installDir,
		true,
		{ ...managementEnv, NO_COLOR: "1", TERM: "dumb" },
		[0],
		5_000,
	);
	if (/\x1b\[/u.test(plainDoctor)) {
		throw new Error("packed_cli_smoke_failed: no-color management output contains ANSI");
	}
	await assertInstalledConfigMigration({ bin, installDir, root: tempRoot, env: managementEnv });
	const sessionResumeSmoke = join(installDir, "session-resume-smoke.mjs");
	await writeFile(sessionResumeSmoke, SESSION_RESUME_SMOKE, "utf8");
	const sessionOutput = await runStage(
		"session_resume",
		process.execPath,
		[sessionResumeSmoke],
		installDir,
		true,
		managementEnv,
		10_000,
	);
	if (!sessionOutput.includes("session-resume-ok")) {
		throw new Error("packed_cli_smoke_failed: installed session resume is incomplete");
	}
	const m8RuntimeSmoke = join(installDir, "m8-runtime-smoke.mjs");
	const sourceSmoke = await readFile(join(ROOT, "scripts", "smoke_node_m8.mjs"), "utf8");
	const installedSmoke = sourceSmoke
		.replace(
			'../backend/apps/mycli/dist/node-runtime/node-backend.js',
			`${INSTALLED_APPLICATION_ROOT}/dist/node-runtime/node-backend.js`,
		)
		.replace(
			'from "@mycli/contracts"',
			`from "${INSTALLED_APPLICATION_ROOT}/dist/node_modules/@mycli/contracts/dist/index.js"`,
		);
	if (installedSmoke === sourceSmoke
		|| installedSmoke.includes('from "@mycli/contracts"')
		|| installedSmoke.includes('../backend/apps/mycli/dist/node-runtime/node-backend.js')) {
		throw new Error("packed_cli_smoke_failed: M8 runtime smoke entry was not relocated");
	}
	await writeFile(m8RuntimeSmoke, installedSmoke, "utf8");
	await writeFile(piAiLoadLog, "", "utf8");
	const m8Output = await runStage(
		"m8_runtime",
		process.execPath,
		["--import", piAiLoadRegister, m8RuntimeSmoke],
		installDir,
		true,
		{ ...managementEnv, MYCLI_PI_AI_LOAD_LOG: piAiLoadLog },
	);
	const m8Summary = JSON.parse(m8Output);
	if (m8Summary.status !== "completed" || m8Summary.runtime !== "node") {
		throw new Error("packed_cli_smoke_failed: installed Node runtime smoke is incomplete");
	}
	assertProviderFreePiAiModuleLoading(await loadedModuleUrls(piAiLoadLog));
	if (existsSync(pythonProbe.marker)) {
		throw new Error("packed_cli_smoke_failed: installed CLI probed for Python");
	}
	process.stdout.write(`${JSON.stringify({
		status: "completed",
		packed_applications: 1,
		packed_platforms: PLATFORM_PACKAGES.length,
		platform_scope: APP_ONLY ? "none" : PACK_ALL_PLATFORMS ? "all" : "current",
		installed_journeys: 9,
		curated_provider_routes: 6,
		custom_provider_models: 1,
		pi_ai_version: PINNED_PI_AI_VERSION,
			pi_ai_catalog_imported_on_provider_demand: true,
			pi_ai_catalog_imported_on_startup: false,
		startup_budget: {
			awaited_network_operations_before_first_paint: 0,
			pty_readiness_ms: 5_000,
		},
	})}\n`);
} catch (error) {
	const detail = error instanceof Error ? error.message : "unknown_error";
	const bounded = detail
		.replaceAll(tempRoot, "<temp>")
		.replaceAll(ROOT, "<root>")
		.replace(/[\r\n]+/gu, " ")
		.slice(-1_000);
	process.stderr.write(`packed_cli_smoke_failed: ${bounded}\n`);
	process.exitCode = 1;
} finally {
	await rm(tempRoot, { recursive: true, force: true });
}

function assertPackFileList(output, expectedTarget) {
	const entries = Array.isArray(output) ? output : [];
	const entry = entries[0];
	const files = Array.isArray(entry?.files) ? entry.files : [];
	if (entries.length !== 1 || files.length === 0) {
		throw new Error("packed_cli_smoke_failed: npm pack file inventory is unavailable");
	}
	if (typeof entry.filename !== "string" || !entry.filename.endsWith(".tgz")) {
		throw new Error("packed_cli_smoke_failed: npm pack filename is unavailable");
	}
	for (const file of files) {
		const path = typeof file?.path === "string" ? file.path : "";
		if (/\.py$/u.test(path) || /python-sidecar|backend-router/u.test(path)) {
			throw new Error("packed_cli_smoke_failed: Python runtime file entered an npm artifact");
		}
		if (/(?:^|\/)(?:src|test)\//u.test(path) || /(?:^|\/)tsconfig(?:\.[^/]*)?\.json$/u.test(path)) {
			throw new Error(`packed_cli_smoke_failed: development source entered ${entry?.name ?? "package"}`);
		}
	}
	if (entry?.name === APPLICATION_RELEASE_PACKAGE.name) {
		if (!files.some((file) => file?.path === "dist/assets/system.md")) {
			throw new Error("packed_cli_smoke_failed: app system prompt asset is missing");
		}
		for (const releasePackage of VENDORED_WORKSPACE_PACKAGES) {
			const prefix = `dist/node_modules/${releasePackage.name}/`;
			if (!files.some((file) => file?.path === `${prefix}package.json`)
				|| !files.some((file) => file?.path.startsWith(`${prefix}dist/`))) {
				throw new Error(`packed_cli_smoke_failed: vendored package missing: ${releasePackage.name}`);
			}
		}
		const windowsHelper = "dist/node_modules/@mycli/tools/native/windows/mycli-windows-sandbox.exe";
		if (REQUIRE_WINDOWS_HELPER && !files.some((file) => file?.path === windowsHelper)) {
			throw new Error("packed_cli_smoke_failed: Windows sandbox helper is missing");
		}
		if (files.some((file) => typeof file?.path === "string"
			&& file.path.startsWith("dist/node_modules/@mycli/tools/native/ripgrep/"))) {
			throw new Error("packed_cli_smoke_failed: vendored tools still embeds ripgrep");
		}
	}
	if (expectedTarget) {
		const expectedExecutable = expectedTarget.startsWith("windows-") ? "rg.exe" : "rg";
		const expectedPath = `vendor/${expectedTarget}/${expectedExecutable}`;
		if (!files.some((file) => file?.path === expectedPath)) {
			throw new Error("packed_cli_smoke_failed: platform package omitted ripgrep");
		}
		if (files.some((file) => (
			typeof file?.path === "string"
			&& /\/rg(?:\.exe)?$/u.test(file.path)
			&& file.path !== expectedPath
		))) {
			throw new Error("packed_cli_smoke_failed: platform package contains the wrong ripgrep target");
		}
	}
	return entry;
}

async function createPythonProbe(root) {
	const binDir = join(root, "python-probe-bin");
	const marker = join(root, "python-probed");
	await mkdir(binDir);
	if (process.platform === "win32") {
		const source = '@echo off\r\nbreak > "%MYCLI_PYTHON_PROBE_MARKER%"\r\nexit /b 97\r\n';
		await Promise.all(["python.cmd", "python3.cmd", "py.cmd"].map(
			(name) => writeFile(join(binDir, name), source, "utf8"),
		));
	} else {
		const source = '#!/bin/sh\n: > "$MYCLI_PYTHON_PROBE_MARKER"\nexit 97\n';
		const paths = ["python", "python3", "py"].map((name) => join(binDir, name));
		await Promise.all(paths.map((path) => writeFile(path, source, "utf8")));
		await Promise.all(paths.map((path) => chmod(path, 0o755)));
	}
	return { binDir, marker };
}

async function assertNoPythonRuntimeSurface(root) {
	const pending = [root];
	const forbidden = /python-sidecar|MYCLI_RUNTIME_BACKEND|MYCLI_PYTHON|startPythonSidecar|mycli\.cli\.sidecar|backend-router/u;
	while (pending.length > 0) {
		const current = pending.pop();
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				pending.push(path);
			} else if (entry.isFile() && entry.name.endsWith(".js")) {
				if (forbidden.test(await readFile(path, "utf8"))) {
					throw new Error("packed_cli_smoke_failed: app runtime contains a Python startup surface");
				}
			}
		}
	}
}

async function loadedModuleUrls(path) {
	return (await readFile(path, "utf8")).split("\n").filter(Boolean);
}

function assertCatalogPiAiModuleLoading(urls) {
	if (!urls.some((url) => url.includes("/providers/all.js"))) {
		throw new Error("packed_cli_smoke_failed: provider catalog demand did not load pi-ai providers/all");
	}
	for (const provider of [
		"openrouter",
		"groq",
		"together",
		"moonshotai",
		"nvidia",
		"cerebras",
	]) {
		if (!urls.some((url) => url.includes(`/providers/${provider}.js`))) {
			throw new Error(`packed_cli_smoke_failed: pi-ai provider module missing: ${provider}`);
		}
	}
	assertNoPiAiOAuthFlowModules(urls);
	assertNoExternalProviderSdkModules(urls);
}

function assertProviderFreePiAiModuleLoading(urls) {
	if (urls.some(isCuratedPiAiProviderModuleUrl)) {
		throw new Error("packed_cli_smoke_failed: provider-free startup loaded a curated pi-ai provider module");
	}
	if (urls.some((url) => url.includes("/auth/oauth/"))) {
		throw new Error("packed_cli_smoke_failed: provider-free startup loaded a pi-ai OAuth module");
	}
	assertNoUnrelatedPiAiModules(urls);
}

function isCuratedPiAiProviderModuleUrl(url) {
	return /\/providers\/(?:openrouter|groq|together|moonshotai|nvidia|cerebras)(?:\.models)?\.js$/u.test(url);
}

function assertNoPiAiOAuthFlowModules(urls) {
	if (urls.some((url) => (
		url.includes("/auth/oauth/") && !url.endsWith("/auth/oauth/load.js")
	))) {
		throw new Error("packed_cli_smoke_failed: actual pi-ai OAuth flow module loaded");
	}
}

function assertNoUnrelatedPiAiModules(urls) {
	const forbidden = [
		"/providers/all.js",
		"/providers/amazon-bedrock.js",
		"/providers/azure-openai-responses.js",
		"/providers/google.js",
		"/providers/google-vertex.js",
		"/providers/mistral.js",
	];
	for (const marker of forbidden) {
		if (urls.some((url) => url.includes(marker))) {
			throw new Error(`packed_cli_smoke_failed: unrelated provider module loaded: ${marker}`);
		}
	}
	assertNoExternalProviderSdkModules(urls);
}

function assertNoExternalProviderSdkModules(urls) {
	for (const marker of [
		"/node_modules/@google/",
		"/node_modules/@aws-sdk/",
		"/node_modules/@azure/",
		"/node_modules/@mistralai/",
	]) {
		if (urls.some((url) => url.includes(marker))) {
			throw new Error(`packed_cli_smoke_failed: unrelated provider SDK loaded: ${marker}`);
		}
	}
}

async function assertInstalledConfigMigration({ bin, installDir, root, env }) {
	const home = join(root, "migration-home");
	const legacyDirectory = join(home, ".config", "mycli");
	const legacyPath = join(legacyDirectory, "config.toml");
	const userPath = join(home, ".mycli", "config.toml");
	await mkdir(legacyDirectory, { recursive: true });
	await writeFile(legacyPath, "memory_enabled = true\n", "utf8");
	const migrationEnv = { ...env, HOME: home, USERPROFILE: home };
	const preview = JSON.parse(await run(
		bin,
		["config", "migrate", "--dry-run", "--json"],
		installDir,
		true,
		migrationEnv,
		[0],
		5_000,
	));
	if (preview.action !== "migrate" || preview.operation !== "preview"
		|| preview.needed !== true || typeof preview.expectedVersion !== "string") {
		throw new Error("packed_cli_smoke_failed: migration preview is incomplete");
	}
	const applied = JSON.parse(await run(
		bin,
		["config", "migrate", "--apply", "--expected-version", preview.expectedVersion, "--json"],
		installDir,
		true,
		migrationEnv,
		[0],
		5_000,
	));
	if (applied.applied !== true || typeof applied.backupId !== "string" || !existsSync(userPath)) {
		throw new Error("packed_cli_smoke_failed: migration apply is incomplete");
	}
	const migrated = await run(
		bin,
		["config", "get", "memory.enabled", "--json"],
		installDir,
		true,
		migrationEnv,
		[0],
		5_000,
	);
	if (JSON.parse(migrated).setting?.value !== true) {
		throw new Error("packed_cli_smoke_failed: migrated configuration is unreadable");
	}
	const rolledBack = JSON.parse(await run(
		bin,
		["config", "migrate", "--rollback", applied.backupId, "--json"],
		installDir,
		true,
		migrationEnv,
		[0],
		5_000,
	));
	if (rolledBack.restored !== true || existsSync(userPath)
		|| await readFile(legacyPath, "utf8") !== "memory_enabled = true\n") {
		throw new Error("packed_cli_smoke_failed: migration rollback is incomplete");
	}
}

function run(
	command,
	args,
	cwd,
	capture = false,
	env = process.env,
	acceptedExitCodes = [0],
	timeoutMs,
) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"],
			shell: process.platform === "win32",
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => {
			if (timeout) clearTimeout(timeout);
			if (timedOut) {
				reject(new Error(`command_timed_out: ${command}`));
				return;
			}
			if (acceptedExitCodes.includes(code)) {
				resolve(stdout);
				return;
			}
			const missingModule = commandFailureModule(stderr);
			reject(new Error(
				`command_failed: ${command} (${code ?? "signal"}) kind=${commandFailureKind(stderr)}`
				+ (missingModule ? ` module=${missingModule}` : ""),
			));
		});
	});
}

async function runStage(stage, command, args, cwd, capture = false, env = process.env, timeoutMs) {
	try {
		return await run(command, args, cwd, capture, env, [0], timeoutMs);
	} catch (error) {
		throw new Error(
			`stage=${stage} ${error instanceof Error ? error.message : "command_failed"}`,
		);
	}
}

function commandFailureModule(stderr) {
	const match = /Cannot find (?:package|module) ['"]([^'"]{1,500})['"]/u.exec(stderr);
	if (!match?.[1]) return undefined;
	const normalized = match[1].replaceAll("\\", "/");
	const marker = normalized.lastIndexOf("/node_modules/");
	const value = marker >= 0 ? normalized.slice(marker + "/node_modules/".length) : normalized;
	return /^[A-Za-z0-9@._/+:-]{1,200}$/u.test(value) ? value : undefined;
}

function commandFailureKind(stderr) {
	const releaseCode = commandFailureCode(stderr);
	if (releaseCode !== "command_failed") return releaseCode;
	for (const pattern of [
		/code: ['"]([A-Z0-9_]+)['"]/u,
		/DOMException \[([A-Za-z]+)\]/u,
	]) {
		const match = pattern.exec(stderr);
		if (match?.[1]) return match[1];
	}
	return "unknown";
}

async function readPinnedPiAiVersion() {
	const manifestPaths = [
		"backend/apps/mycli/package.json",
		"backend/packages/providers/package.json",
	];
	const manifests = await Promise.all(manifestPaths.map(async (path) =>
		JSON.parse(await readFile(join(ROOT, path), "utf8"))));
	const versions = manifests.map((manifest) =>
		manifest.dependencies?.["@earendil-works/pi-ai"]);
	const exactSemver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
	if (versions.some((version) => typeof version !== "string" || !exactSemver.test(version))
		|| versions.some((version) => version !== versions[0])) {
		throw new Error("pi_ai_workspace_pin_invalid");
	}
	return versions[0];
}
