import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createProvider, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { deleteApiKey, modifyProviderCredential, readProviderCredential, resolveConfig } from "@mycli/config";
import { parseProviderRouteId, type ProviderRequest } from "@mycli/core";
import { createPiAiRequestModels } from "../../src/pi-ai/pi-ai-auth.ts";
import { PiAiProvider } from "../../src/pi-ai/pi-ai-provider.ts";
import { ProviderFailure, providerFailureToRuntimeFailure } from "../../src/errors.ts";
import { providerStreamFixture } from "../support/provider-stream-fixtures.ts";
import { loadPiAiBuiltinProvider } from "../../src/registry/provider-directory.ts";
import { resolveProviderNativeTransport } from "../../src/registry/provider-native-transport.ts";

test("actual native API-key environment auth is isolated and explicit missing references do not fall back", async (t) => {
	const homeDir = await temporaryHome(t);
	for (const allowAmbientAuth of [true, false]) {
		const provider = new PiAiProvider({ config: {
			provider: "deepseek", catalogProviderId: "deepseek", routeSource: "pi_ai_builtin",
			model: "deepseek-chat", protocol: "chat_completions", apiBaseUrl: "https://offline.invalid/v1",
			homeDir, authRef: "selected-reference", allowAmbientAuth,
			providerEnv: { DEEPSEEK_API_KEY: "offline-native-key" }, supportsImages: false,
		}, fetch: async (_url, init) => {
			assert.equal(allowAmbientAuth, true);
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer offline-native-key");
			return providerStreamFixture("chat_completions", "healthy");
		} });
		const collect = async (): Promise<void> => { for await (const event of provider.stream(request("deepseek", "deepseek-chat", "chat_completions"), { signal: AbortSignal.timeout(5_000) })) assert(event.type); };
		if (allowAmbientAuth) await collect();
		else await assert.rejects(collect(), (error: unknown) => {
			assert(error instanceof ProviderFailure);
			assert.equal(error.code, "auth_error");
			assert.equal(error.retryable, false);
			assert.doesNotMatch(JSON.stringify(providerFailureToRuntimeFailure(error)), /offline-native-key/u);
			return true;
		});
	}
});

test("actual builtin OAuth credentials reach native adapters without becoming API-key store entries", async (t) => {
	const homeDir = await temporaryHome(t);
	for (const [id, protocol, token] of [
		["openrouter", "chat_completions", "offline-openrouter-oauth"],
		["anthropic", "anthropic_messages", "sk-ant-oat01-offline-oauth"],
		["xai", "responses", "offline-xai-oauth"],
		["kimi-coding", "anthropic_messages", "offline-kimi-oauth"],
		["github-copilot", "chat_completions", "offline-copilot-oauth"],
		["github-copilot", "responses", "offline-copilot-oauth"],
		["github-copilot", "anthropic_messages", "offline-copilot-oauth"],
	] as const) {
		const providerId = parseProviderRouteId(id);
		const builtin = (await loadPiAiBuiltinProvider(providerId))!;
		const api = { responses: "openai-responses", chat_completions: "openai-completions", anthropic_messages: "anthropic-messages" }[protocol];
		const model = builtin.getModels().find((candidate) => candidate.api === api)!;
		const apiBaseUrl = builtin.baseUrl!;
		const nativeTransport = await resolveProviderNativeTransport({ catalogProviderId: providerId, modelId: model.id, protocol, apiBaseUrl });
		await modifyProviderCredential({ homeDir, authRef: id }, async () => ({
			type: "oauth", access: token, refresh: id === "openrouter" ? "" : "offline-refresh", expires: Date.now() + 3_600_000,
			metadata: { accountId: "offline-account", availableModelIds: [model.id] },
		}));
		let calls = 0;
		let scenario: "healthy" | "nested_error" | "http_quota_429" = "healthy";
		const provider = new PiAiProvider({ config: {
			provider: providerId, catalogProviderId: providerId, routeSource: "pi_ai_builtin", model: model.id, protocol,
			apiBaseUrl, nativeTransport, homeDir, authRef: id, allowAmbientAuth: false, supportsImages: false,
		}, fetch: async (_url, init) => {
			calls += 1;
			assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
			return providerStreamFixture(protocol, scenario);
		} });
		for await (const event of provider.stream({ ...request(providerId, model.id, protocol), nativeTransport }, { signal: AbortSignal.timeout(5_000) })) assert(event.type);
		assert.equal(calls, 1);
		for (const failureScenario of ["nested_error", "http_quota_429"] as const) {
			scenario = failureScenario;
			await assert.rejects(async () => {
				for await (const event of provider.stream({ ...request(providerId, model.id, protocol), nativeTransport }, { signal: AbortSignal.timeout(5_000) })) {
					assert.notEqual(event.type, "completed");
				}
			}, (error: unknown) => {
				assert(error instanceof ProviderFailure);
				assert.equal(error.retryable, failureScenario === "nested_error");
				assert.equal(error.code, failureScenario === "http_quota_429" ? "quota_exceeded" : "provider_error");
				assert.doesNotMatch(JSON.stringify(providerFailureToRuntimeFailure(error)), /offline-.*oauth|sk-ant-oat01/u);
				return true;
			});
		}
		assert.equal(calls, 3);
		assert.equal((await readProviderCredential({ homeDir, authRef: id }))?.type, "oauth");
	}
});

test("OAuth refresh is serialized across independent Models instances and survives reopening", async (t) => {
	const homeDir = await temporaryHome(t);
	await seedExpired(homeDir);
	let refreshes = 0;
	const provider = authProvider(async (credential) => {
		refreshes += 1;
		return { ...credential, access: "rotated-access", refresh: "rotated-refresh", expires: Date.now() + 3_600_000 };
	});
	const config = { provider: "fixture", homeDir, authRef: "fixture", allowAmbientAuth: false };
	const first = createPiAiRequestModels(provider, config, () => assert.fail("unexpected auth failure"));
	const second = createPiAiRequestModels(provider, config, () => assert.fail("unexpected auth failure"));
	const results = await Promise.all([first.getAuth("fixture"), second.getAuth("fixture")]);
	assert.equal(refreshes, 1);
	assert(results.every((result) => result?.auth.apiKey === "rotated-access"));
	const reopened = createPiAiRequestModels(provider, config, () => assert.fail("unexpected auth failure"));
	assert.equal((await reopened.getAuth("fixture"))?.auth.apiKey, "rotated-access");
	assert.equal(refreshes, 1);
	const stored = await readProviderCredential({ homeDir, authRef: "fixture" });
	assert(stored?.type === "oauth");
	assert.deepEqual(stored.metadata, { accountId: "account-1", availableModelIds: ["fixture-model"] });
	if (process.platform !== "win32") assert.equal((await stat(join(homeDir, ".mycli", "auth.json"))).mode & 0o777, 0o600);
});

test("native OAuth cannot change the committed endpoint or bypass account model filtering", async (t) => {
	const homeDir = await temporaryHome(t);
	const providerId = parseProviderRouteId("github-copilot");
	const builtin = (await loadPiAiBuiltinProvider(providerId))!;
	const model = builtin.getModels().find((candidate) => candidate.api === "openai-responses")!;
	for (const denied of ["endpoint", "model"] as const) {
		await modifyProviderCredential({ homeDir, authRef: providerId }, async () => ({
			type: "oauth", access: "offline-copilot-oauth", refresh: "offline-refresh", expires: Date.now() + 3_600_000,
			metadata: { availableModelIds: denied === "model" ? [] : [model.id] },
		}));
		const apiBaseUrl = denied === "endpoint" ? "https://other.invalid" : builtin.baseUrl!;
		const nativeTransport = await resolveProviderNativeTransport({ catalogProviderId: providerId,
			modelId: model.id, protocol: "responses", apiBaseUrl });
		const provider = new PiAiProvider({ config: { provider: providerId, model: model.id, protocol: "responses",
			apiBaseUrl, nativeTransport, homeDir, authRef: providerId, supportsImages: false, allowAmbientAuth: false,
		}, fetch: async () => assert.fail("denied OAuth must not dispatch a request") });
		await assert.rejects(async () => {
			for await (const event of provider.stream({ ...request(providerId, model.id, "responses"), nativeTransport },
				{ signal: AbortSignal.timeout(5_000) })) assert.fail(`Unexpected ${event.type}`);
		}, (error: unknown) => {
			assert(error instanceof ProviderFailure);
			assert.equal(error.code, denied === "endpoint" ? "config_error" : "permission_denied");
			if (denied === "model") assert.equal(error.errorReason?.reason, "auth.model_access_denied");
			assert.equal(error.retryable, false);
			return true;
		});
	}
});

test("logout serializes with OAuth refresh and a failed refresh never replaces the stored grant", async (t) => {
	const homeDir = await temporaryHome(t);
	await seedExpired(homeDir);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const provider = authProvider(async (credential) => {
		entered.resolve(); await release.promise;
		return { ...credential, access: "rotated-access", expires: Date.now() + 3_600_000 };
	});
	const config = { provider: "fixture", homeDir, authRef: "fixture", allowAmbientAuth: false };
	const pending = createPiAiRequestModels(provider, config, () => undefined).getAuth("fixture");
	await entered.promise;
	const logout = deleteApiKey({ homeDir, authRef: "fixture" });
	release.resolve();
	await pending;
	await logout;
	assert.equal(await readProviderCredential({ homeDir, authRef: "fixture" }), undefined);
	await seedExpired(homeDir);
	const before = await readFile(join(homeDir, ".mycli", "auth.json"), "utf8");
	let failed = false;
	const failureModels = createPiAiRequestModels(authProvider(async () => { throw new Error("private refresh payload"); }), config, () => { failed = true; });
	await assert.rejects(failureModels.getAuth("fixture"));
	assert.equal(failed, true);
	assert.equal(await readFile(join(homeDir, ".mycli", "auth.json"), "utf8"), before);
});

test("stored OAuth owns config resolution ahead of legacy API keys, while explicit request key overrides", async (t) => {
	const homeDir = await temporaryHome(t);
	await seedExpired(homeDir);
	const options = { homeDir, workspaceRoot: homeDir, env: { MYCLI_PROVIDER: "openai", MYCLI_AUTH_REF: "fixture" } };
	const config = await resolveConfig(options);
	assert.equal(config.apiKey, undefined);
	assert.equal((await resolveConfig({ ...options, env: { ...options.env, MYCLI_API_KEY: "explicit" } })).apiKey, "explicit");
});

function authProvider(refresh: (credential: OAuthCredential) => Promise<OAuthCredential>): Provider {
	return createProvider({ id: "fixture", name: "fixture", auth: { oauth: {
		name: "fixture OAuth", login: async () => { throw new Error("unused login"); }, refresh,
		toAuth: async (credential) => ({ apiKey: credential.access }),
	} }, models: [], api: openAICompletionsApi() });
}

async function seedExpired(homeDir: string): Promise<void> {
	await modifyProviderCredential({ homeDir, authRef: "fixture" }, async () => ({
		type: "oauth", access: "expired-access", refresh: "original-refresh", expires: 1,
		metadata: { accountId: "account-1", availableModelIds: ["fixture-model"] },
	}));
}

function request(provider: ProviderRequest["provider"], model: string, protocol: ProviderRequest["protocol"]): ProviderRequest {
	return { provider, model, protocol, instructions: "fixture", messages: [{ role: "user", content: "fixture" }], tools: [] };
}

async function temporaryHome(t: TestContext): Promise<string> {
	const homeDir = await mkdtemp(join(tmpdir(), "mycli-native-auth-"));
	t.after(async () => { await rm(homeDir, { recursive: true, force: true }); });
	return homeDir;
}
