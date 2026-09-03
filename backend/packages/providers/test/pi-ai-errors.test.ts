import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ProviderEvent, ProviderRequest } from "@mycli/core";
import { ProviderFailure } from "../src/errors.ts";
import type { PiAiModelConfig } from "../src/pi-ai-model.ts";
import { PiAiProvider } from "../src/pi-ai-provider.ts";
import { startProviderMockServer } from "./provider-mock-server.ts";

test("classifies pi-ai HTTP failures from structured attempt evidence", async (context) => {
	const cases: readonly Readonly<{
		name: string;
		status: number;
		error: Readonly<Record<string, unknown>>;
		code: ProviderFailure["code"];
		retryable: boolean;
	}>[] = [
		{
			name: "authentication",
			status: 401,
			error: { error: { type: "invalid_api_key", message: "invalid credential" } },
			code: "auth_error",
			retryable: false,
		},
		{
			name: "permission",
			status: 403,
			error: { error: { type: "permission_error", message: "not allowed" } },
			code: "permission_denied",
			retryable: false,
		},
		{
			name: "quota before rate limit",
			status: 429,
			error: { error: { code: "insufficient_quota", message: "billing limit" } },
			code: "quota_exceeded",
			retryable: false,
		},
		{
			name: "context overflow",
			status: 400,
			error: { error: { code: "context_window_exceeded", message: "maximum context length" } },
			code: "context_window_exceeded",
			retryable: false,
		},
		{
			name: "invalid request",
			status: 400,
			error: { error: { type: "invalid_request_error", message: "invalid input" } },
			code: "invalid_request",
			retryable: false,
		},
		{
			name: "rate limit",
			status: 429,
			error: { error: { type: "rate_limit_error", message: "limited" } },
			code: "rate_limited",
			retryable: true,
		},
		{
			name: "service unavailable",
			status: 503,
			error: { error: { type: "overloaded_error", message: "busy" } },
			code: "server_overloaded",
			retryable: true,
		},
		{
			name: "provider overload",
			status: 529,
			error: { error: { type: "overloaded_error", message: "busy" } },
			code: "server_overloaded",
			retryable: true,
		},
		{
			name: "request timeout",
			status: 408,
			error: { error: { type: "request_timeout", message: "timeout" } },
			code: "connection_error",
			retryable: true,
		},
		{
			name: "server error",
			status: 500,
			error: { error: { type: "server_error", message: "failed" } },
			code: "provider_error",
			retryable: true,
		},
	];

	for (const scenario of cases) {
		await context.test(scenario.name, async () => {
			const server = await startProviderMockServer({
				protocol: "responses",
				mode: "failed",
				status: scenario.status,
				errorBody: scenario.error,
			});
			try {
				const failure = await rejectedFailure(provider({
					apiBaseUrl: `${server.baseUrl}/v1`,
				}).stream(request(), signalOptions()));
				assert.equal(failure.code, scenario.code);
				assert.equal(failure.retryable, scenario.retryable);
				assert.equal(failure.diagnostics.status, scenario.status);
				assert.equal(failure.diagnostics.request_id, "req-mock");
				assert.equal(server.requests.length, 1);
			} finally {
				await server.close();
			}
		});
	}
});

test("bounds Retry-After and rejects unsafe request IDs captured by pi-ai", async () => {
	const server = await startProviderMockServer({
		protocol: "responses",
		mode: "failed",
		status: 429,
		responseHeaders: {
			"retry-after": "999999",
			"x-request-id": "unsafe request id with spaces",
		},
	});
	try {
		const failure = await rejectedFailure(provider({
			apiBaseUrl: `${server.baseUrl}/v1`,
		}).stream(request(), signalOptions()));
		assert.equal(failure.code, "rate_limited");
		assert.equal(failure.retryAfterSeconds, 3_600);
		assert.equal(failure.diagnostics.request_id, undefined);
	} finally {
		await server.close();
	}
});

test("retains DNS and timeout transport identity through pi-ai", async (context) => {
	for (const [name, code] of [["dns", "ENOTFOUND"], ["timeout", "ETIMEDOUT"]] as const) {
		await context.test(name, async () => {
			const cause = Object.assign(new Error(name), { code });
			const failingFetch: typeof globalThis.fetch = async () => {
				throw new TypeError("fetch failed", { cause });
			};
			const failure = await rejectedFailure(new PiAiProvider({
				config: config(),
				fetch: failingFetch,
			}).stream(request(), signalOptions()));
			assert.equal(failure.code, "connection_error");
			assert.equal(failure.retryable, true);
			assert.equal(failure.diagnostics.transport_error_code, code);
		});
	}
});

test("classifies truncated and premature pi-ai streams as retryable stream failures", async (context) => {
	await context.test("truncated HTTP stream", async () => {
		const server = await startProviderMockServer({
			protocol: "responses",
			mode: "truncated",
		});
		try {
			const failure = await rejectedFailure(provider({
				apiBaseUrl: `${server.baseUrl}/v1`,
			}).stream(request(), signalOptions()));
			assert.equal(failure.code, "response_stream_error");
			assert.equal(failure.retryable, true);
		} finally {
			await server.close();
		}
	});

	await context.test("premature parser failure", async () => {
		const failure = await rejectedFailure(new PiAiProvider({
			config: config(),
			streamFactory: () => {
				throw new Error("response stream ended prematurely");
			},
		}).stream(request(), signalOptions()));
		assert.equal(failure.code, "response_stream_error");
		assert.equal(failure.retryable, true);
	});
});

test("caller abort wins during pi-ai setup and streaming", async (context) => {
	await context.test("setup", async () => {
		const controller = new AbortController();
		const failure = await rejectedFailure(new PiAiProvider({
			config: config(),
			streamFactory: () => {
				controller.abort();
				throw new Error("fetch failed");
			},
		}).stream(request(), { signal: controller.signal }));
		assert.equal(failure.code, "interrupted");
		assert.equal(failure.retryable, false);
	});

	await context.test("streaming", async () => {
		const controller = new AbortController();
		const provider = new PiAiProvider({
			config: config(),
			streamFactory: () => (async function* (): AsyncIterable<AssistantMessageEvent> {
				yield { type: "start", partial: assistant() };
				controller.abort();
				yield {
					type: "error",
					reason: "error",
					error: assistant({ stopReason: "error", errorMessage: "server error" }),
				};
			})(),
		});
		const failure = await rejectedFailure(provider.stream(request(), {
			signal: controller.signal,
		}));
		assert.equal(failure.code, "interrupted");
	});
});

function provider(overrides: Partial<PiAiModelConfig> = {}): PiAiProvider {
	return new PiAiProvider({ config: config(overrides) });
}

function config(overrides: Partial<PiAiModelConfig> = {}): PiAiModelConfig {
	return {
		provider: "openai",
		protocol: "responses",
		model: "gpt-test",
		apiBaseUrl: "https://api.openai.com/v1",
		apiKey: "test-key",
		supportsImages: true,
		modelContextWindowTokens: 128_000,
		maxOutputTokens: 16_000,
		maxPromptTokens: 100_000,
		...overrides,
	};
}

function request(): ProviderRequest {
	return {
		provider: "openai",
		protocol: "responses",
		model: "gpt-test",
		instructions: "system",
		messages: [{ role: "user", content: "hello" }],
		tools: [],
	};
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

function signalOptions(): { readonly signal: AbortSignal } {
	return { signal: new AbortController().signal };
}

async function rejectedFailure(stream: AsyncIterable<ProviderEvent>): Promise<ProviderFailure> {
	try {
		for await (const event of stream) void event;
		assert.fail("expected provider stream to fail");
	} catch (error) {
		assert(error instanceof ProviderFailure);
		return error;
	}
}
