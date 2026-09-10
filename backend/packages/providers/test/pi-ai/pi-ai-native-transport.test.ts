import assert from "node:assert/strict";
import test from "node:test";
import { modelInputSha256, parseProviderRouteId } from "@mycli/core";
import type { ProviderEvent, ProviderRequest } from "@mycli/core";
import { captureProviderNativeEnvironment, resolveProviderNativeTransport } from "../../src/registry/provider-native-transport.ts";
import { createPiAiSnapshot } from "../../src/pi-ai/pi-ai-model.ts";
import { PiAiProvider } from "../../src/pi-ai/pi-ai-provider.ts";
import { ProviderFailure } from "../../src/errors.ts";
import { emptyPiAiUsage, piAiProviderStateEvent, piAiReplayTransportIdentity, restorePiAiReplay } from "../../src/pi-ai/pi-ai-replay.ts";
import { loadPiAiBuiltinProvider } from "../../src/registry/provider-directory.ts";
import { providerStreamFixture, type StreamFixtureScenario } from "../support/provider-stream-fixtures.ts";

const AZURE = parseProviderRouteId("azure-openai-responses");
const BASE_URL = "https://offline.invalid/openai/v1";

test("native catalog snapshots fail closed on missing models, API mismatches and unsupported families", async () => {
	await assert.rejects(resolveProviderNativeTransport({ catalogProviderId: "openai", modelId: "missing-model",
		protocol: "responses", apiBaseUrl: BASE_URL }), ProviderFailure);
	await assert.rejects(resolveProviderNativeTransport({ catalogProviderId: "openai", modelId: "gpt-5.5",
		protocol: "chat_completions", apiBaseUrl: BASE_URL }), ProviderFailure);
	for (const id of ["google", "google-vertex", "amazon-bedrock", "mistral", "openai-codex"] as const) {
		const catalogProviderId = parseProviderRouteId(id);
		const modelId = (await loadPiAiBuiltinProvider(catalogProviderId))?.getModels()[0]?.id;
		assert(modelId);
		await assert.rejects(resolveProviderNativeTransport({ catalogProviderId, modelId, protocol: "responses", apiBaseUrl: BASE_URL }), ProviderFailure);
		await assert.rejects(createPiAiSnapshot({ provider: catalogProviderId, catalogProviderId, model: modelId,
			protocol: "responses", routeSource: "pi_ai_builtin", apiBaseUrl: BASE_URL, apiKey: "fixture-key", supportsImages: false }), ProviderFailure);
	}
});

test("native configured model additions keep supported dispatch while unsupported families remain closed", async () => {
	const nativeTransport = await resolveProviderNativeTransport({ catalogProviderId: "openai", modelId: "private-model",
		protocol: "responses", apiBaseUrl: BASE_URL, allowDeclaredModel: true });
	assert.equal(nativeTransport.modelSource, "declared");
	const snapshot = await createPiAiSnapshot({ provider: "openai", model: "private-model", protocol: "responses",
		routeSource: "pi_ai_builtin", nativeTransport, apiBaseUrl: BASE_URL, supportsImages: false, apiKey: "fixture-key" });
	assert.equal(snapshot.catalogued, false);
	assert.equal(snapshot.model.api, "openai-responses");
	await assert.rejects(resolveProviderNativeTransport({ catalogProviderId: parseProviderRouteId("google"), modelId: "private-model",
		protocol: "responses", apiBaseUrl: BASE_URL, allowDeclaredModel: true }), ProviderFailure);
});

test("native environment capture retains only SDK-requested values and Azure configuration is frozen", async () => {
	const providerEnv = await captureProviderNativeEnvironment({ catalogProviderId: "openai",
		environment: { OPENAI_API_KEY: "fixture-key", UNRELATED_PRIVATE_VALUE: "omit-me" } });
	assert.deepEqual(providerEnv, { OPENAI_API_KEY: "fixture-key" });
	assert(Object.isFrozen(providerEnv));
	const native = await resolveProviderNativeTransport({ catalogProviderId: AZURE, modelId: "gpt-5.5",
		protocol: "responses", apiBaseUrl: BASE_URL, environment: {
			AZURE_OPENAI_API_VERSION: "2025-04-01-preview", AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-5.5=fixture-deployment",
		} });
	assert.deepEqual(native.azure, { apiVersion: "2025-04-01-preview", deploymentName: "fixture-deployment" });
	await assert.rejects(resolveProviderNativeTransport({ catalogProviderId: AZURE, modelId: "gpt-5.5",
		protocol: "responses", apiBaseUrl: BASE_URL, environment: { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-5.5=first,gpt-5.5=second" } }), ProviderFailure);
});

test("native aliases retain the SDK catalog identity and native provider auth", async () => {
	const nativeTransport = await resolveProviderNativeTransport({ catalogProviderId: "openai", modelId: "gpt-5.5", protocol: "responses", apiBaseUrl: BASE_URL });
	const snapshot = await createPiAiSnapshot({ provider: parseProviderRouteId("private-openai-route"), catalogProviderId: "openai",
		model: "gpt-5.5", protocol: "responses", routeSource: "pi_ai_builtin", nativeTransport,
		apiBaseUrl: BASE_URL, apiKey: "fixture-key", supportsImages: false });
	assert.equal(snapshot.model.provider, "openai");
	assert.equal(snapshot.model.api, "openai-responses");
	assert.equal(snapshot.nativeTransport?.api, "openai-responses");
	assert.strictEqual(snapshot.models.getProvider("openai")?.auth, (await loadPiAiBuiltinProvider("openai"))?.auth);
});

test("native replay degrades when the Azure API version or deployment changes", async () => {
	const model = (await loadPiAiBuiltinProvider(AZURE))?.getModels()[0];
	assert(model);
	const native = await resolveProviderNativeTransport({ catalogProviderId: AZURE, modelId: model.id,
		protocol: "responses", apiBaseUrl: BASE_URL, azure: { apiVersion: "v1", deploymentName: "first" } });
	const identity = { routeId: AZURE, catalogProviderId: AZURE, api: "azure-openai-responses" as const, model: model.id, apiBaseUrl: BASE_URL };
	const transport = piAiReplayTransportIdentity({ ...identity, nativeTransport: native });
	const state = piAiProviderStateEvent({ role: "assistant", api: "azure-openai-responses", provider: AZURE, model: model.id,
		content: [{ type: "text", text: "hello" }], responseId: "response-fixture", usage: emptyPiAiUsage(), stopReason: "stop", timestamp: 0 }, AZURE, transport);
	assert(state?.type === "provider_state");
	const item = { type: "assistant" as const, text: "hello", providerState: state.state };
	assert.equal(restorePiAiReplay(item, transport.api, AZURE, model.id, transport).responseId, "response-fixture");
	for (const azure of [{ apiVersion: "v2", deploymentName: "first" }, { apiVersion: "v1", deploymentName: "second" }]) {
		const changed = piAiReplayTransportIdentity({ ...identity, nativeTransport: { ...native, azure } });
		assert.equal(restorePiAiReplay(item, transport.api, AZURE, model.id, changed).diagnostic?.reason, "transport_mismatch");
	}
});

test("Azure uses its real native SDK API with frozen endpoint, deployment, error evidence and EOF rules", { timeout: 30_000 }, async (t) => {
	const model = (await loadPiAiBuiltinProvider(AZURE))?.getModels()[0];
	assert(model);
	const nativeTransport = await resolveProviderNativeTransport({ catalogProviderId: AZURE, modelId: model.id,
		protocol: "responses", apiBaseUrl: BASE_URL, azure: { apiVersion: "2025-04-01-preview", deploymentName: "frozen-deployment" } });
	for (const scenario of ["healthy", "nested_error", "fatal_type", "premature_eof", "transport_reset", "overload",
		"quota_type", "permission_type", "context_type", "invalid_request_type", "http_502", "http_quota_429", "transport_timeout",
		"completion_then_error", "caller_abort"] as const satisfies readonly StreamFixtureScenario[]) {
		await t.test(scenario, async () => {
			let calls = 0;
			const caller = new AbortController();
			const provider = new PiAiProvider({ config: { provider: AZURE, catalogProviderId: AZURE, routeSource: "pi_ai_builtin",
				model: model.id, protocol: "responses", nativeTransport, apiBaseUrl: BASE_URL, apiKey: "fixture-key", supportsImages: false,
				providerEnv: { AZURE_OPENAI_BASE_URL: "https://wrong.invalid", AZURE_OPENAI_API_VERSION: "wrong",
					AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${model.id}=wrong` },
			}, fetch: async (input, init) => {
				calls += 1;
				const request = input instanceof Request ? input : new Request(input, init);
				const url = new URL(request.url);
				assert.equal(url.origin, "https://offline.invalid");
				assert.equal(url.searchParams.get("api-version"), "2025-04-01-preview");
				const body = await request.json() as { readonly model: string };
				assert.equal(body.model, "frozen-deployment");
				assert.equal(request.headers.get("api-key"), "fixture-key");
				return providerStreamFixture("responses", scenario, { signal: request.signal, onPendingRead: () => caller.abort() });
			} });
			const request: ProviderRequest = { provider: AZURE, model: model.id, protocol: "responses", nativeTransport,
				instructions: "fixture policy", messages: [{ role: "user", content: "fixture input" }], tools: [] };
			const events: ProviderEvent[] = [];
			const collect = async (): Promise<void> => { for await (const event of provider.stream(request, { signal: caller.signal })) events.push(event); };
			if (scenario === "healthy" || scenario === "completion_then_error") {
				await collect();
				assert.equal(events.at(-1)?.type, "completed");
				const replay = events.find((event) => event.type === "provider_state");
				assert(replay?.type === "provider_state");
				assert.equal((replay.state.value.transport as { readonly api: string }).api, "azure-openai-responses");
				assert.equal((replay.state.value.transport as { readonly nativeTransportSha256: string }).nativeTransportSha256, modelInputSha256(nativeTransport));
			} else await assert.rejects(collect(), (error: unknown) => {
				assert(error instanceof ProviderFailure);
				const codes: Partial<Record<StreamFixtureScenario, ProviderFailure["code"]>> = {
					nested_error: "provider_error", fatal_type: "auth_error", overload: "server_overloaded", quota_type: "quota_exceeded",
					permission_type: "permission_denied", context_type: "context_window_exceeded", invalid_request_type: "invalid_request",
					http_502: "provider_error", http_quota_429: "quota_exceeded", caller_abort: "interrupted",
				};
				assert.equal(error.code, codes[scenario] ?? "response_stream_error");
				assert.equal(error.retryable, !["fatal_type", "quota_type", "permission_type", "context_type", "invalid_request_type", "http_quota_429", "caller_abort"].includes(scenario));
				return true;
			});
			assert.equal(calls, 1);
		});
	}
});
