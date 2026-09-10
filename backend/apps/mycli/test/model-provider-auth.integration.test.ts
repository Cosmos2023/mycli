import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { GatewayClient, type JsonObject } from "@mycli/gateway";
import { loadPiAiProviderDirectory } from "@mycli/providers";
import { startTestNodeBackend } from "./support/offline-update-fetch.ts";
import {
	MycliShellRuntime,
} from "../../../../tui/mycli-shell/src/application/shell-runtime.ts";
import { HeadlessTerminal } from "../../../../tui/mycli-shell/test/support/headless-terminal.ts";
import {
	initialRuntimeState,
} from "../../../../tui/mycli-shell/src/state/runtime-state-model.ts";
import {
	modelsFromResult,
	providerRoutesFromResult,
	runtimeStateWithCredentialReadiness,
} from "../../../../tui/mycli-shell/src/state/catalog-state.ts";
import {
	projectRuntimeState,
} from "../../../../tui/mycli-shell/src/state/runtime-projection.ts";
import {
	runtimeStateFromBootstrap,
} from "../../../../tui/mycli-shell/src/state/session-state.ts";

async function authHarness(t: TestContext): Promise<{ client: GatewayClient; home: string }> {
	const root = await mkdtemp(join(tmpdir(), "mycli-model-provider-auth-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(join(home, ".mycli"), { recursive: true });
	await mkdir(workspace);
	await writeFile(join(home, ".mycli", "models.json"), JSON.stringify({
		version: 2,
		providers: {
			deepseek: { protocol: "chat_completions", auth_ref: "deepseek-work" },
			qwen: { protocol: "chat_completions", auth_ref: "qwen-work" },
			"fireworks-alt": { catalog_provider: "fireworks", protocol: "chat_completions", auth_ref: "qwen-work" },
		},
	}));
	await writeFile(join(home, ".mycli", "auth.json"), JSON.stringify({
		openai: { type: "api_key", key: "synthetic-current" },
		"deepseek-work": { type: "api_key", key: "synthetic-custom" },
		qwen: { type: "api_key", key: "synthetic-default" },
	}));
	const backend = await startTestNodeBackend({
		cwd: workspace,
		args: ["--session", "model-provider-auth"],
		env: { HOME: home, MYCLI_MEMORY_ENABLED: "false" },
	});
	const client = new GatewayClient({ ...backend.transport, requestTimeoutMs: 5_000 });
	client.start();
	t.after(async () => {
		client.stop();
		await backend.close();
		await backend.completion;
		await rm(root, { recursive: true, force: true });
	});
	return { client, home };
}

function authRows(payload: JsonObject): JsonObject[] {
	assert.ok(Array.isArray(payload.auth_providers));
	return payload.auth_providers as JsonObject[];
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let index = 0; index < 200; index += 1) {
		if (check()) return;
		await setTimeout(10);
	}
	assert.fail("Provider UI did not reach the expected state.");
}

test("provider auth lists and saves use the route ref for non-current and shared credentials", async (t) => {
	const { client, home } = await authHarness(t);
	const bootstrap = await client.request("session.bootstrap", { protocol_version: 1 });
	const routes = providerRoutesFromResult(await client.request("provider.list", {}));
	for (const [id, authRef, ready] of [
		["openai", "openai", true],
		["deepseek", "deepseek-work", true],
		["qwen", "qwen-work", false],
		["fireworks-alt", "qwen-work", false],
	] as const) {
		const auth = authRows(bootstrap).find((row) => row.id === id);
		const route = routes.find((row) => row.id === id);
		assert.equal(auth?.auth_ref, authRef);
		assert.equal(route?.authRef, authRef);
		assert.equal(auth?.configured, ready);
		assert.equal(route?.ready, ready);
		assert.equal(route?.credentialSource, auth?.credential_source);
	}
	const legacySave = await client.request("auth.api_key.save", {
		provider_id: "qwen", auth_ref: "qwen", api_key: "synthetic-legacy-replacement",
	});
	assert.equal(legacySave.auth_ref, "qwen");
	assert.equal(authRows(legacySave).find((row) => row.id === "qwen")?.configured, false);
	const saved = await client.request("auth.api_key.save", {
		provider_id: "qwen", api_key: "synthetic-route-replacement",
	});
	assert.equal(saved.auth_ref, "qwen-work");
	for (const id of ["qwen", "fireworks-alt"]) {
		assert.equal(authRows(saved).find((row) => row.id === id)?.configured, true);
		assert.equal(authRows(saved).find((row) => row.id === id)?.auth_ref, "qwen-work");
	}
	assert.doesNotMatch(JSON.stringify(saved), /synthetic-/);
	const stored = JSON.parse(await readFile(join(home, ".mycli", "auth.json"), "utf8"));
	assert.equal(stored["qwen-work"].key, "synthetic-route-replacement");
	assert.equal(stored.qwen.key, "synthetic-legacy-replacement");
	const model = modelsFromResult(await client.request("model.list", { provider: "qwen" }))[0]!;
	const selected = await client.request("model.select", {
		provider: model.provider, model: model.model, protocol: model.protocol!, base_url: model.baseUrl!,
	});
	assert.equal(authRows(selected).find((row) => row.id === "qwen")?.auth_ref, "qwen-work");
	assert.equal(authRows(selected).find((row) => row.id === "deepseek")?.configured, true);
	assert.equal(authRows(selected).find((row) => row.id === "openai")?.configured, true);
});

test("TUI logs into pi-ai Qwen routes and selects the full SDK catalog without model declarations", async (t) => {
	const { client, home } = await authHarness(t);
	const providerId = "qwen-token-plan-cn";
	const catalogPath = join(home, ".mycli", "models.json");
	const originalCatalog = await readFile(catalogPath, "utf8");
	const upstream = await loadPiAiProviderDirectory();
	const routes = providerRoutesFromResult(await client.request("provider.list", {}));
	for (const id of ["qwen-token-plan", providerId, "qwen-token-plan-individual"]) {
		const route = routes.find((entry) => entry.id === id);
		assert.equal(route?.activation, "active");
		assert.equal(route?.ready, false);
		assert.equal(route?.authRef, id);
		const expected = upstream.providers.find((entry) => entry.catalogProviderId === id);
		assert.ok(expected);
		const models = modelsFromResult(await client.request("model.list", { provider: id }));
		assert.deepEqual(models.map((entry) => entry.model), expected.models.map((entry) => entry.id));
		assert.ok(models.every((entry) => entry.baseUrl === expected.baseUrl));
	}
	const bootstrap = await client.request("session.bootstrap", { protocol_version: 1 });
	let state = runtimeStateFromBootstrap(initialRuntimeState(), bootstrap);
	const shell = projectRuntimeState(state);
	const terminal = new HeadlessTerminal({ columns: 100, rows: 40, nativeScrollback: true });
	const runtime = new MycliShellRuntime({
		initialState: { ...shell, messages: [], transcript: [], footer: { ...shell.footer, trust: "trusted" } },
		terminal,
		onProviderLoad: async () => providerRoutesFromResult(await client.request("provider.list", {})),
		onModelLoad: async (provider) => modelsFromResult(await client.request("model.list", { provider })),
		onApiKeyLogin: async (id, apiKey, authRef) => {
			const result = await client.request("auth.api_key.save", { provider_id: id, api_key: apiKey, auth_ref: authRef });
			state = runtimeStateWithCredentialReadiness(state, result);
			return { authProviders: state.authProviders, authReadiness: state.authReadiness ?? undefined };
		},
		onModelSelect: async (model, scope) => {
			await client.request("model.select", {
				provider: model.provider, protocol: model.protocol!, model: model.model, base_url: model.baseUrl!, scope,
				...(model.thinkingLevel ? { reasoning_effort: model.thinkingLevel } : {}),
			});
		},
	});
	t.after(async () => {
		await runtime.shutdown();
		await terminal.flush();
		terminal.dispose();
	});
	const screen = (): string => runtime.ui.render(100).join("\n");
	runtime.start();
	runtime.showModelSelector();
	await waitFor(() => /Select model/.test(screen()) && !/Loading models/.test(screen()));
	terminal.sendInput("\x1b");
	terminal.sendInput(providerId);
	assert.match(screen(), /Qwen Token Plan CN/);
	terminal.sendInput("\r");
	assert.match(screen(), /Login to Qwen Token Plan CN/);
	terminal.sendInput("\x1b[200~synthetic-qwen-key\x1b[201~");
	terminal.sendInput("\r");
	await waitFor(() => runtime.getState().modelsProvider === providerId && !/Loading models/.test(screen()));
	terminal.sendInput("qwen3.8-max");
	await waitFor(() => /qwen3\.8-max/.test(terminal.visibleLines().join("\n")));
	await terminal.flush();
	assert.match(terminal.visibleLines().join("\n"), /qwen3\.8-max/);
	assert.doesNotMatch(screen(), /No matching models/);
	terminal.sendInput("\r");
	await waitFor(() => runtime.editorContainer.children[0] === runtime.editor);
	assert.equal(runtime.getState().currentModel?.model, "qwen3.8-max");
	assert.equal(runtime.getState().currentModel?.provider, providerId);
	assert.equal((await client.request("status.inspect", {})).model, "qwen3.8-max");
	const readyRoutes = providerRoutesFromResult(await client.request("provider.list", {}));
	assert.equal(readyRoutes.find((route) => route.id === providerId)?.ready, true);
	assert.equal(readyRoutes.find((route) => route.id === "qwen-token-plan")?.ready, false);
	assert.equal(readyRoutes.find((route) => route.id === "qwen-token-plan-individual")?.ready, false);
	await assert.rejects(readFile(join(home, ".mycli", "config.toml")), { code: "ENOENT" });
	await runtime.shutdown();

	await client.request("session.new", {});
	assert.notEqual((await client.request("status.inspect", {})).model, "qwen3.8-max");
	await client.request("session.resume", { session_id: "model-provider-auth" });
	assert.equal((await client.request("status.inspect", {})).model, "qwen3.8-max");
	const refreshed = modelsFromResult(await client.request("model.list", { provider: providerId }));
	assert.equal(refreshed[0]?.model, "qwen3.8-max");
	assert.equal(refreshed[0]?.current, true);
	const flash = refreshed.find((model) => model.model === "qwen3.8-flash");
	assert.ok(flash);
	assert.equal(flash.baseUrl, upstream.providers.find((entry) => entry.catalogProviderId === providerId)?.baseUrl);
	await client.request("model.select", {
		provider: flash.provider, protocol: flash.protocol!, model: flash.model, base_url: flash.baseUrl!, scope: "user",
	});
	assert.match(await readFile(join(home, ".mycli", "config.toml"), "utf8"), /name = "qwen3.8-flash"/);
	await client.request("session.new", {});
	assert.equal((await client.request("status.inspect", {})).model, "qwen3.8-flash");
	assert.equal(await readFile(catalogPath, "utf8"), originalCatalog);
});

test("every model in the enabled pi-ai Qwen catalogs can be selected", async (t) => {
	const { client } = await authHarness(t);
	for (const provider of ["qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual"]) {
		await client.request("auth.api_key.save", { provider_id: provider, api_key: "synthetic-qwen-key" });
		const models = modelsFromResult(await client.request("model.list", { provider }));
		assert.ok(models.length > 0);
		for (const model of models) {
			await assert.doesNotReject(() => client.request("model.select", {
				provider, model: model.model, protocol: model.protocol!, base_url: model.baseUrl!,
			}), `${provider}/${model.model}`);
		}
		const status = await client.request("status.inspect", {});
		assert.equal(status.provider, provider);
		assert.equal(status.model, models.at(-1)?.model);
	}
});

test("model login returns to its filtered provider list and saves the same route credential", async (t) => {
	const { client } = await authHarness(t);
	let state = runtimeStateFromBootstrap(initialRuntimeState(), await client.request("session.bootstrap", { protocol_version: 1 }));
	const shell = projectRuntimeState(state);
	const terminal = new HeadlessTerminal({ columns: 100, rows: 40, nativeScrollback: true });
	const savedRefs: string[] = [];
	const modelLoads: string[] = [];
	const runtime = new MycliShellRuntime({
		initialState: { ...shell, messages: [], transcript: [], footer: { ...shell.footer, trust: "trusted" } },
		terminal,
		onProviderLoad: async () => providerRoutesFromResult(await client.request("provider.list", {})),
		onModelLoad: async (provider) => {
			modelLoads.push(provider);
			return modelsFromResult(await client.request("model.list", { provider }));
		},
		onApiKeyLogin: async (providerId, apiKey, authRef) => {
			const result = await client.request("auth.api_key.save", { provider_id: providerId, api_key: apiKey, auth_ref: authRef });
			savedRefs.push(result.auth_ref!);
			state = runtimeStateWithCredentialReadiness(state, result);
			return { authProviders: state.authProviders, authReadiness: state.authReadiness ?? undefined };
		},
	});
	t.after(async () => {
		await runtime.shutdown();
		await terminal.flush();
		terminal.dispose();
	});
	const screen = (): string => runtime.ui.render(100).join("\n");
	runtime.start();
	runtime.showModelSelector();
	await waitFor(() => /Select model/.test(screen()) && !/Loading models/.test(screen()));
	terminal.sendInput("\x1b");
	terminal.sendInput("qwen");
	const providerSelector = runtime.editorContainer.children[0];
	assert.match(screen(), /login required/);
	terminal.sendInput("\r");
	assert.match(screen(), /Login to Qwen/);
	terminal.sendInput("\x1b");
	assert.equal(runtime.editorContainer.children[0], providerSelector);
	assert.match(screen(), /Select provider/);
	assert.doesNotMatch(screen(), /Select provider to configure|DeepSeek|Login to/);
	terminal.sendInput("\r");
	assert.match(screen(), /Login to Qwen/);
	terminal.sendInput("\x1b[200~synthetic-login-key\x1b[201~");
	terminal.sendInput("\r");
	await waitFor(() => savedRefs.length === 1 && modelLoads.includes("qwen") && /Select model/.test(screen()) && !/Loading models/.test(screen()));
	assert.deepEqual(savedRefs, ["qwen-work"]);
	assert.equal(runtime.editorContainer.children[0], providerSelector);
	assert.equal(runtime.getState().authProviders?.find((row) => row.id === "fireworks-alt")?.configured, true);
	await setTimeout(30);
	await terminal.flush();
	assert.match(terminal.visibleLines().join("\n"), /Select model/);
	assert.doesNotMatch(terminal.bufferLines().join("\n"), /synthetic-login-key/);
	terminal.sendInput("\x1b");
	terminal.sendInput("\x1b");
	assert.equal(runtime.editorContainer.children[0], runtime.editor);
	await runtime.handleClientAction("open_login", "");
	terminal.sendInput("deepseek");
	assert.match(screen(), /ready/);
	assert.doesNotMatch(screen(), /unconfigured|login required/);
});
