import assert from "node:assert/strict";
import test from "node:test";
import { NODE_RUNTIME_CONTEXT_DEFAULTS, type NodeRuntimeConfig } from "@mycli/config";
import {
	parseProviderRouteId,
	type ProviderEvent,
	type ProviderRequest,
} from "@mycli/core";
import { PiAiProvider } from "../src/pi-ai-provider.ts";
import type { ProviderRouteDescriptor } from "../src/provider-directory-types.ts";
import { ProviderRegistry } from "../src/provider-registry.ts";
import { startProviderMockServer } from "./provider-mock-server.ts";

test("public provider exports hide transport implementations", async () => {
	const publicApi: Readonly<Record<string, unknown>> = await import("../src/index.ts");
	assert.equal("PiAiProvider" in publicApi, false);
	assert.equal("OpenAIProviderRegistry" in publicApi, false);
});

test("provider registry routes Anthropic through pi-ai", async (context) => {
	const server = await startProviderMockServer({ protocol: "anthropic_messages" });
	context.after(() => server.close());
	const provider = new ProviderRegistry().create(config({
		apiBaseUrl: server.baseUrl,
	}));
	const result = await collect(provider.stream(request(), {
		signal: new AbortController().signal,
	}));

	assert.equal(server.requests.length, 1);
	assert.equal(server.requests[0]?.path, "/v1/messages");
	assert.equal(server.requests[0]?.body.model, "claude-test");
	assert.deepEqual(result.find((event) => event.type === "text_delta"), {
		type: "text_delta",
		text: "OK",
	});
	assert.deepEqual(result.at(-1), { type: "completed", responseId: "msg_mock" });
});

test("provider registry rejects missing credentials before pi-ai construction", () => {
	assert.throws(
		() => new ProviderRegistry().create(config({ apiKey: undefined })),
		/auth_error: provider API key is not configured/,
	);
});

test("catalog-backed providers use the mycli request API key override", async (context) => {
	const server = await startProviderMockServer({ protocol: "anthropic_messages" });
	context.after(() => server.close());
	const previousAmbientKey = process.env.ANTHROPIC_API_KEY;
	process.env.ANTHROPIC_API_KEY = "ambient-test-key";
	context.after(() => {
		if (previousAmbientKey === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = previousAmbientKey;
	});

	let usedMycliKey = false;
	const captureFetch: typeof globalThis.fetch = async (input, init) => {
		const headers = input instanceof Request
			? input.headers
			: new Headers(init?.headers);
		usedMycliKey = headers.get("x-api-key") === "test-key";
		return globalThis.fetch(input, init);
	};
	const provider = new ProviderRegistry({ fetch: captureFetch }).create(config({
		apiBaseUrl: server.baseUrl,
	}));
	await collect(provider.stream(request(), {
		signal: new AbortController().signal,
	}));

	assert.equal(usedMycliKey, true);
	assert.equal(server.requests.length, 1);
});

test("provider registry delegates catalog aliases to the selected pi-ai provider", async (context) => {
	const server = await startProviderMockServer({ protocol: "chat_completions" });
	context.after(() => server.close());
	const alias = parseProviderRouteId("nvidia-alias");
	let pollHeader: string | null = null;
	const captureFetch: typeof globalThis.fetch = async (input, init) => {
		const headers = input instanceof Request
			? input.headers
			: new Headers(init?.headers);
		pollHeader = headers.get("NVCF-POLL-SECONDS");
		return globalThis.fetch(input, init);
	};
	const provider = new ProviderRegistry({ fetch: captureFetch }).create(config({
		provider: alias,
		protocol: "chat_completions",
		model: "openai/gpt-oss-120b",
		apiBaseUrl: `${server.baseUrl}/v1`,
		supportsImages: false,
	}), route({
		routeId: alias,
		catalogProviderId: "nvidia",
		protocol: "chat_completions",
		apiBaseUrl: `${server.baseUrl}/v1`,
	}));
	await collect(provider.stream(request({
		provider: alias,
		protocol: "chat_completions",
		model: "openai/gpt-oss-120b",
		cacheRetention: "none",
	}), { signal: new AbortController().signal }));

	assert.equal(pollHeader, "3600");
	assert.equal(server.requests.length, 1);
});

test("provider registry applies model compat over route compat for a private relay", async (context) => {
	const server = await startProviderMockServer({ protocol: "chat_completions" });
	context.after(() => server.close());
	const provider = new ProviderRegistry().create(config({
		provider: "compatible",
		protocol: "chat_completions",
		model: "relay-reasoner",
		apiBaseUrl: `${server.baseUrl}/v1`,
		supportsImages: false,
	}), Object.freeze({
		routeId: "compatible",
		displayName: "Private relay",
		supportTier: "compatible",
		source: "pi_ai_declared",
		protocol: "chat_completions",
		apiBaseUrl: `${server.baseUrl}/v1`,
		authRef: "relay",
		activation: "active",
		modelPolicy: Object.freeze({ kind: "declared", modelIds: Object.freeze(["relay-reasoner"]) }),
		compat: Object.freeze({
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			supportsLongCacheRetention: false,
		}),
		modelCompat: Object.freeze({
			"relay-reasoner": Object.freeze({
				supportsDeveloperRole: true,
				maxTokensField: "max_completion_tokens",
				supportsStore: true,
			}),
		}),
		snapshotVersion: 1,
	}));

	await collect(provider.stream(request({
		provider: "compatible",
		protocol: "chat_completions",
		model: "relay-reasoner",
		reasoningEffort: "medium",
		maxOutputTokens: 64,
		cacheRetention: "long",
		developerInstructions: ["relay policy"],
	}), { signal: new AbortController().signal }));

	assert.equal(server.requests.length, 1);
	const body = server.requests[0]?.body ?? {};
	assert.equal(body.max_tokens, undefined);
	assert.equal(body.max_completion_tokens, 64);
	assert.equal(body.store, false);
	assert.equal(body.prompt_cache_key, undefined);
	assert.deepEqual((body.messages as readonly unknown[])[0], {
		role: "developer",
		content: "system\n\nrelay policy",
	});
});

test("provider registry rejects route snapshots that do not match transport config", () => {
	const base = config();
	for (const descriptor of [
		route({ routeId: "openai" }),
		route({ protocol: "responses" }),
		route({ apiBaseUrl: "https://other.example/v1" }),
		route({ activation: "inactive" }),
	]) {
		assert.throws(
			() => new ProviderRegistry().create(base, descriptor),
			/config_error: provider route snapshot does not match transport configuration/,
		);
	}
});

const CURATED_PROVIDERS = [
	["openrouter", "openrouter/auto", "none"],
	["groq", "openai/gpt-oss-120b", "medium"],
	["together", "moonshotai/Kimi-K2.7-Code", "high"],
	["moonshotai", "kimi-k2.7-code", "high"],
	["nvidia", "openai/gpt-oss-120b", "none"],
	["cerebras", "gpt-oss-120b", "medium"],
] as const satisfies readonly [
	ProviderRequest["provider"],
	string,
	NonNullable<ProviderRequest["reasoningEffort"]>,
][];

test("provider registry routes every curated provider through one pi-ai attempt", async () => {
	for (const [providerId, model, reasoningEffort] of CURATED_PROVIDERS) {
		const server = await startProviderMockServer({
			protocol: "chat_completions",
			mode: "failed",
			status: 429,
		});
		try {
			const provider = new ProviderRegistry().create(config({
				provider: providerId,
				protocol: "chat_completions",
				model,
				apiBaseUrl: `${server.baseUrl}/v1`,
				cacheRetention: "none",
				supportsImages: false,
			}));
			assert(provider instanceof PiAiProvider, providerId);
			await assert.rejects(
				() => collect(provider.stream({
					provider: providerId,
					protocol: "chat_completions",
					model,
					reasoningEffort,
					instructions: "system",
					messages: [{ role: "user", content: "hello" }],
					tools: [],
				}, { signal: new AbortController().signal })),
				/rate_limited/u,
				providerId,
			);
			assert.equal(server.requests.length, 1, providerId);
		} finally {
			await server.close();
		}
	}
});

function config(overrides: Partial<NodeRuntimeConfig> = {}): NodeRuntimeConfig {
	return {
		...NODE_RUNTIME_CONTEXT_DEFAULTS,
		workspaceRoot: "/workspace",
		homeDir: "/home/test",
		provider: "anthropic",
		protocol: "anthropic_messages",
		model: "claude-test",
		apiBaseUrl: "https://api.anthropic.com",
		apiKey: "test-key",
		authRef: "anthropic",
		sessionId: "session-1",
		sessionsDbPath: "/home/test/.mycli/sessions.db",
		maxPromptTokens: 12_000,
		modelContextWindowTokens: 20_000,
		maxOutputTokens: 4_096,
		requestMaxRetries: 4,
		streamMaxRetries: 5,
		reasoningEffort: "medium",
		thinkingEnabled: true,
		supportsImages: true,
		webSearchMode: "disabled",
		cacheRetention: "short",
		requestPermissionsToolEnabled: false,
		updatesCheckOnStartup: true,
		...overrides,
	};
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
	return {
		provider: "anthropic",
		protocol: "anthropic_messages",
		model: "claude-test",
		instructions: "system",
		developerInstructions: ["developer"],
		messages: [{ role: "user", content: "hello" }],
		tools: [],
		maxOutputTokens: 32,
		sessionId: "session-1",
		cacheRetention: "short",
		...overrides,
	};
}

function route(
	overrides: Partial<ProviderRouteDescriptor> = {},
): ProviderRouteDescriptor {
	return Object.freeze({
		routeId: "anthropic",
		displayName: "Anthropic",
		supportTier: "stable",
		source: "pi_ai_builtin",
		catalogProviderId: "anthropic",
		protocol: "anthropic_messages",
		apiBaseUrl: "https://api.anthropic.com",
		authRef: "anthropic",
		activation: "active",
		modelPolicy: Object.freeze({ kind: "catalog" }),
		snapshotVersion: 1,
		...overrides,
	});
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
	const result: ProviderEvent[] = [];
	for await (const event of stream) result.push(event);
	return result;
}
