import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels, type Provider } from "@earendil-works/pi-ai";
import { readProviderCredential } from "@mycli/config";
import { parseProviderRouteId } from "@mycli/core";
import { createNativeProviderAuthOperations, inspectNativeProviderAuth, type NativeAuthEvent } from "../../src/auth/native-auth-management.ts";
import { loadPiAiBuiltinProvider } from "../../src/registry/provider-directory.ts";

const piAi = { createModels };

test("native OAuth management uses SDK login, local status and selected-reference logout", async (t) => {
	const homeDir = await temporaryHome(t);
	const builtin = (await loadPiAiBuiltinProvider(parseProviderRouteId("anthropic")))!;
	const events: NativeAuthEvent[] = [];
	let logins = 0;
	const provider: Provider = { ...builtin, auth: {
		...builtin.auth,
		apiKey: { ...builtin.auth.apiKey!, resolve: async () => assert.fail("status must not resolve credentials") },
		oauth: { ...builtin.auth.oauth!,
			login: async (interaction) => {
				logins += 1;
				interaction.notify({ type: "info", message: "token=private-login-diagnostic" });
				assert.equal(await interaction.prompt({ type: "manual_code", message: "Authorization code" }), "offline-code");
				return { type: "oauth", access: "dummy-access", refresh: "dummy-refresh", expires: 1, accountId: "test-account" };
			},
			refresh: async () => assert.fail("local status must not refresh expired OAuth"),
			toAuth: async () => assert.fail("local status must not resolve OAuth"),
		},
	} };
	const operations = createNativeProviderAuthOperations(piAi, provider, { provider: "anthropic", homeDir, authRef: "work" });
	assert.deepEqual(await operations.status(), { configured: false, source: "missing" });
	assert.deepEqual(await operations.login({ prompt: async () => "offline-code", notify: (event) => events.push(event) }), {
		configured: true, source: "stored", credentialType: "oauth",
	});
	assert.equal(logins, 1);
	assert.deepEqual(events, [{ type: "info", message: "token=[REDACTED]" }]);
	assert.equal((await readProviderCredential({ homeDir, authRef: "work" }))?.type, "oauth");
	assert.equal(await readProviderCredential({ homeDir, authRef: "anthropic" }), undefined);
	assert.equal((await operations.status()).credentialType, "oauth");
	await operations.logout();
	assert.equal(await readProviderCredential({ homeDir, authRef: "work" }), undefined);
});

test("cancelled native OAuth login never persists a late credential", async (t) => {
	const homeDir = await temporaryHome(t);
	const builtin = (await loadPiAiBuiltinProvider(parseProviderRouteId("anthropic")))!;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const returned = Promise.withResolvers<void>();
	const controller = new AbortController();
	const provider: Provider = { ...builtin, auth: { ...builtin.auth, oauth: { ...builtin.auth.oauth!, login: async () => {
		entered.resolve();
		await release.promise;
		returned.resolve();
		return { type: "oauth", access: "late-access", refresh: "late-refresh", expires: 1 };
	} } } };
	const operations = createNativeProviderAuthOperations(piAi, provider, { provider: "anthropic", homeDir, authRef: "work", signal: controller.signal });
	const login = operations.login({ prompt: async () => "", notify: () => undefined });
	const rejected = assert.rejects(login, { name: "AbortError" });
	await entered.promise;
	controller.abort();
	await rejected;
	release.resolve();
	await returned.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(await readProviderCredential({ homeDir, authRef: "work" }), undefined);
});

test("native readiness recognizes isolated ambient credentials and preserves explicit reference failures", async (t) => {
	const homeDir = await temporaryHome(t);
	for (const allowAmbientAuth of [true, false]) {
		const status = await inspectNativeProviderAuth({ provider: "azure-openai-responses", homeDir, authRef: "azure-work",
			allowAmbientAuth, providerEnv: { AZURE_OPENAI_API_KEY: "offline-readiness-key" } });
		assert.deepEqual(status, allowAmbientAuth
			? { configured: true, source: "environment", credentialType: "api_key" }
			: { configured: false, source: "missing" });
		assert.doesNotMatch(JSON.stringify(status), /offline-readiness-key/u);
	}
});

test("native OAuth management retains nonexpiring grants with no refresh token", async (t) => {
	const homeDir = await temporaryHome(t);
	const builtin = (await loadPiAiBuiltinProvider(parseProviderRouteId("openrouter")))!;
	const provider: Provider = { ...builtin, auth: { ...builtin.auth, oauth: { ...builtin.auth.oauth!,
		login: async () => ({ type: "oauth", access: "offline-access", refresh: "", expires: Number.MAX_SAFE_INTEGER }),
	} } };
	const target = { provider: "openrouter", homeDir, authRef: "openrouter" };
	await createNativeProviderAuthOperations(piAi, provider, target).login({ prompt: async () => "", notify: () => undefined });
	assert.equal((await inspectNativeProviderAuth(target)).credentialType, "oauth");
	const credential = await readProviderCredential(target);
	assert(credential?.type === "oauth");
	assert.equal(credential.refresh, "");
});

async function temporaryHome(t: TestContext): Promise<string> {
	const homeDir = await mkdtemp(join(tmpdir(), "mycli-native-auth-"));
	t.after(() => rm(homeDir, { recursive: true, force: true }));
	return homeDir;
}
