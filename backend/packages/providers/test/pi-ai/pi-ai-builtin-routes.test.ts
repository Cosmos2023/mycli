import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent, ProviderRequest } from "@mycli/core";
import { ProviderFailure } from "../../src/errors.ts";
import { PiAiProvider } from "../../src/pi-ai/pi-ai-provider.ts";
import { createPiAiSnapshot } from "../../src/pi-ai/pi-ai-model.ts";
import { loadPiAiProviderDirectory } from "../../src/registry/provider-directory.ts";
import { resolveProviderNativeTransport } from "../../src/registry/provider-native-transport.ts";
import { providerStreamFixture, type StreamFixtureScenario } from "../support/provider-stream-fixtures.ts";

test("actual builtin provider routes preserve completion, usage and failure evidence", { timeout: 60_000 }, async (context) => {
	const directory = await loadPiAiProviderDirectory();
	for (const entry of directory.providers) {
		if (entry.status === "unsupported") continue;
		for (const protocol of entry.protocols) {
			const model = entry.models.filter((candidate) => candidate.protocol === protocol)
				.sort((left, right) => left.id.localeCompare(right.id, "en"))[0];
			assert(model);
			const nativeTransport = await resolveProviderNativeTransport({ catalogProviderId: entry.catalogProviderId,
				modelId: model.id, protocol, apiBaseUrl: "https://offline.invalid/v1" });
			const config = {
				nativeTransport,
				provider: entry.catalogProviderId, protocol, model: model.id,
				routeSource: "pi_ai_builtin" as const, catalogProviderId: entry.catalogProviderId,
				apiBaseUrl: "https://offline.invalid/v1", apiKey: "offline-fixture-key", supportsImages: false,
				...(entry.catalogProviderId.startsWith("cloudflare-") ? { providerEnv: {
					CLOUDFLARE_ACCOUNT_ID: "fixture-account", CLOUDFLARE_GATEWAY_ID: "fixture-gateway",
				} } : {}),
			};
			const snapshot = await createPiAiSnapshot(config);
			assert.equal(snapshot.catalogued, true, entry.catalogProviderId);
			assert.equal(snapshot.model.provider, entry.catalogProviderId);
			assert.equal(snapshot.catalogProviderId, entry.catalogProviderId);
			for (const scenario of ["healthy", "nested_error", "fatal_type", "empty_error", "premature_eof",
				"transport_reset", "completion_then_error", "overload", "quota_type", "permission_type", "context_type",
				"invalid_request_type", "malformed_json", "empty_json", "http_502", "http_quota_429", "transport_timeout",
				"caller_abort"] as const satisfies readonly StreamFixtureScenario[]) {
				await context.test(`${entry.catalogProviderId}/${protocol}/${scenario}`, async () => {
					let fetchCalls = 0;
					const caller = new AbortController();
					const provider = new PiAiProvider({ config, fetch: async (input, init) => {
						fetchCalls += 1;
						const url = new URL(input instanceof Request ? input.url : String(input));
						assert.equal(url.hostname, "offline.invalid");
						const signal = input instanceof Request ? input.signal : init?.signal;
						return providerStreamFixture(protocol, scenario, {
							...(signal ? { signal } : {}),
							onPendingRead: () => { caller.abort(); },
						});
					} });
					const request: ProviderRequest = {
						nativeTransport,
						provider: entry.catalogProviderId, protocol, model: model.id, instructions: "fixture policy",
						messages: [{ role: "user", content: "fixture input" }], tools: [],
					};
					const events: ProviderEvent[] = [];
					const collect = async (): Promise<void> => {
						for await (const event of provider.stream(request, {
							signal: AbortSignal.any([caller.signal, AbortSignal.timeout(5_000)]),
						})) events.push(event);
					};
					if (scenario === "healthy" || scenario === "completion_then_error") {
						await collect();
						assert.equal(events.at(-1)?.type, "completed");
						assert.equal(events.filter((event) => event.type === "text_delta").map((event) => event.text).join(""), "done");
						assert.deepEqual(events.find((event) => event.type === "usage"), {
							type: "usage", usage: protocol === "anthropic_messages"
								? { input_tokens: 4, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
								: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
						});
					} else {
						await assert.rejects(collect(), (error: unknown) => {
							assert(error instanceof ProviderFailure);
							const expectedCodes: Partial<Record<StreamFixtureScenario, ProviderFailure["code"]>> = {
								fatal_type: "auth_error", nested_error: "provider_error", empty_error: "provider_error",
								overload: "server_overloaded", quota_type: "quota_exceeded", permission_type: "permission_denied",
								context_type: "context_window_exceeded", invalid_request_type: "invalid_request", http_502: "provider_error",
								http_quota_429: "quota_exceeded", caller_abort: "interrupted",
							};
							assert.equal(error.code, expectedCodes[scenario] ?? "response_stream_error");
							assert.equal(error.retryable, !["fatal_type", "quota_type", "permission_type", "context_type",
								"invalid_request_type", "http_quota_429", "caller_abort"].includes(scenario));
							if (scenario === "http_502") assert.equal(error.retryAfterSeconds, 2);
							if (scenario === "transport_timeout") assert.equal(error.diagnostics.transport_error_code, "UND_ERR_BODY_TIMEOUT");
							if (scenario === "nested_error") {
								assert.equal(error.publicDetail, "upstream stream interrupted");
								assert.equal(error.diagnostics.provider_error_code, "stream_read_error");
								assert.equal(error.diagnostics.provider_error_type, "server_error");
							}
							assert.doesNotMatch(JSON.stringify(error), /offline-fixture-key|fixture input|fixture policy|offline\.invalid/u);
							return true;
						});
						assert.equal(events.some((event) => event.type === "completed" || event.type === "tool_call"), false);
					}
					assert.equal(fetchCalls, 1, "native SDK must not retry behind runtime");
				});
			}
		}
	}
});
