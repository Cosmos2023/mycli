import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ProviderEvent, ProviderRequest } from "@mycli/core";
import { ProviderFailure, providerFailureToRuntimeFailure } from "../../src/errors.ts";
import type { PiAiModelConfig } from "../../src/pi-ai/pi-ai-model.ts";
import { PiAiProvider } from "../../src/pi-ai/pi-ai-provider.ts";
import { startProviderMockServer } from "../support/provider-mock-server.ts";

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

test("preserves plain upstream HTTP failure details through the real pi-ai parser", async (context) => {
	for (const protocol of ["responses", "chat_completions", "anthropic_messages"] as const) {
		await context.test(protocol, async () => {
			let calls = 0;
			const failure = await rejectedFailure(new PiAiProvider({
				config: config({ protocol }),
				fetch: async () => {
					calls += 1;
					return new Response("upstream request failed", {
						status: 502,
						headers: { "retry-after-ms": "250", "x-request-id": "req-upstream" },
					});
				},
			}).stream({ ...request(), protocol }, signalOptions()));
			assert.equal(calls, 1, "pi-ai must not retry behind the runtime");
			assert.equal(failure.code, "provider_error");
			assert.equal(failure.retryable, true);
			assert.equal(failure.retryAfterSeconds, 0.25);
			assert.equal(failure.publicDetail, "upstream request failed");
			assert.equal(providerFailureToRuntimeFailure(failure).additionalDetails,
				"upstream request failed (status 502, request id: req-upstream)");
		});
	}
});

test("decodes Responses failed/error envelopes without losing fatal classification", async (context) => {
	const scenarios = [
		["server_error", "provider_error", true],
		["upstream_error", "provider_error", true],
		["unknown", "provider_error", true],
		["invalid_api_key", "auth_error", false],
		["authentication_error", "auth_error", false],
		["permission_denied", "permission_denied", false],
		["insufficient_quota", "quota_exceeded", false],
		["context_window_exceeded", "context_window_exceeded", false],
		["invalid_request_error", "invalid_request", false],
		["invalid_prompt", "invalid_request", false],
		["rate_limit_exceeded", "rate_limited", true],
		["overloaded_error", "server_overloaded", true],
	] as const;
	for (const eventType of ["response.failed", "error", "nested_error"] as const) {
		for (const [code, expectedCode, retryable] of scenarios) {
			await context.test(`${eventType}: ${code}`, async () => {
				const error = { code, message: "upstream request failed" };
				const failure = await rejectedFailure(new PiAiProvider({
					config: config(),
					fetch: async () => responseStream([
						...partialResponseFrames(),
						eventType === "error" ? { type: eventType, ...error }
							: eventType === "nested_error" ? { type: "error", error }
								: { type: eventType, response: { status: "failed", error } },
					]),
				}).stream(request(), signalOptions()));
				assert.equal(failure.code, expectedCode);
				assert.equal(failure.retryable, retryable);
				assert.equal(failure.publicDetail, "upstream request failed");
				assert.equal(failure.diagnostics.provider_error_code, code);
				assert.equal(failure.diagnostics.request_id, "req-stream");
				assert.equal(failure.retryAfterSeconds, retryable ? 0.1 : undefined);
			});
		}
	}
});

test("preserves the reported nested stream_read_error before a trailing response.failed", async () => {
	const failure = await rejectedFailure(new PiAiProvider({
		config: config(),
		fetch: async () => responseStream([
			...partialResponseFrames(),
			{ error: { code: "stream_read_error", message: "stream_read_error", type: "upstream_error" },
				sequence_number: 0, type: "error" },
			{ type: "response.failed", response: { id: "resp-failed", status: "failed", output: [],
				error: { code: "upstream_error", message: "Upstream request failed" } } },
		]),
	}).stream(request(), signalOptions()));
	assert.equal(failure.retryable, true);
	assert.equal(failure.code, "provider_error");
	assert.equal(failure.publicDetail, "stream_read_error");
	assert.deepEqual(failure.diagnostics, {
		error_source: "response_stream", status: 200, request_id: "req-stream",
		provider_error_code: "stream_read_error", provider_error_type: "upstream_error",
	});
	assert.equal(providerFailureToRuntimeFailure(failure).additionalDetails,
		"stream_read_error (status 200, request id: req-stream)");
});

test("wire failure stays authoritative if the SDK changes its terminal translation", async (context) => {
	for (const transport of ["sse", "http"] as const) {
		for (const outcome of ["done", "eof", "throw", "abort"] as const) {
			await context.test(`${transport}/${outcome}`, async () => {
				const controller = new AbortController();
				const failure = await rejectedFailure(new PiAiProvider({
					config: config(), fetch: async () => transport === "http" ? Response.json({
						error: { type: "authentication_error", message: "invalid credential" },
					}, { status: 401 }) : responseStream([
						{ type: "error", error: { type: "authentication_error", message: "invalid credential" } },
					]),
					streamFactory: (_model, _context, options) => (async function* (): AsyncIterable<AssistantMessageEvent> {
						assert.ok(options.fetch);
						await (await options.fetch("https://offline.invalid")).text();
						if (outcome === "abort") controller.abort();
						if (outcome === "throw") throw new Error("SDK discarded the original failure");
						if (outcome === "done") yield { type: "done", reason: "stop", message: assistant({
							content: [{ type: "text", text: "must not commit" }],
						}) };
					})(),
				}).stream(request(), { signal: controller.signal }));
				assert.equal(failure.code, outcome === "abort" ? "interrupted" : "auth_error");
				assert.equal(failure.retryable, false);
				assert.equal(failure.publicDetail, outcome === "abort" ? undefined : "invalid credential");
			});
		}
	}
});

test("classifies structured stream errors independently of SDK message formatting", async (context) => {
	const scenarios: readonly {
		readonly name: string;
		readonly error: Readonly<Record<string, unknown>> | null;
		readonly code: ProviderFailure["code"];
		readonly retryable: boolean;
	}[] = [
		{ name: "message only", error: { message: "Upstream failed" }, code: "provider_error", retryable: true },
		{ name: "missing details", error: null, code: "provider_error", retryable: true },
		{ name: "empty details", error: {}, code: "provider_error", retryable: true },
		{ name: "type only auth", error: { type: "authentication_error" }, code: "auth_error", retryable: false },
		{ name: "null code quota", error: { code: null, type: "insufficient_quota" }, code: "quota_exceeded", retryable: false },
		{ name: "invalid code permission", error: { code: 42, type: "permission_error" }, code: "permission_denied", retryable: false },
		{ name: "fatal type before server code", error: { code: "server_error", type: "invalid_request_error" }, code: "invalid_request", retryable: false },
	];
	for (const eventType of ["response.failed", "error"] as const) {
		for (const scenario of scenarios) {
			await context.test(`${eventType}: ${scenario.name}`, async () => {
				const failure = await rejectedFailure(new PiAiProvider({
					config: config(), fetch: async () => responseStream([
						eventType === "error" ? { type: eventType, error: scenario.error }
							: { type: eventType, response: { status: "failed", error: scenario.error } },
					]),
				}).stream(request(), signalOptions()));
				assert.equal(failure.code, scenario.code);
				assert.equal(failure.retryable, scenario.retryable);
				assert.equal(failure.diagnostics.error_source, "response_stream");
				assert.equal(failure.diagnostics.provider_error_type, scenario.error?.type);
				assert.equal(failure.publicDetail, scenario.error?.message);
			});
		}
	}
});

test("retains body-read transport causes after partial output", async (context) => {
	for (const code of ["UND_ERR_SOCKET", "UND_ERR_BODY_TIMEOUT", "ECONNRESET"] as const) {
		await context.test(code, async () => {
			const cause = Object.assign(new Error("private socket data"), { code });
			const failure = await rejectedFailure(new PiAiProvider({
				config: config(),
				fetch: async () => responseStream(partialResponseFrames(),
					new TypeError("terminated", { cause })),
			}).stream(request(), signalOptions()));
			assert.equal(failure.code, "response_stream_error");
			assert.equal(failure.retryable, true);
			assert.equal(failure.diagnostics.transport_error_code, code);
			assert.equal(failure.diagnostics.request_id, "req-stream");
			assert.doesNotMatch(JSON.stringify(providerFailureToRuntimeFailure(failure)), /private socket data/u);
		});
	}
});

test("does not expose proxy HTML, malformed JSON, or empty-body SDK boilerplate", async (context) => {
	for (const [body, status] of [["<html>private proxy internals</html>", 502], ['{"private":"payload"', 502], [null, 401]] as const) {
		await context.test(String(status), async () => {
			const failure = await rejectedFailure(new PiAiProvider({
				config: config(), fetch: async () => new Response(body, { status }),
			}).stream(request(), signalOptions()));
			assert.equal(failure.publicDetail, undefined);
			assert.doesNotMatch(JSON.stringify(providerFailureToRuntimeFailure(failure)), /private|payload|no body|status code/u);
		});
	}
});

test("remote details are bounded and redacted before leaving pi-ai", async () => {
	const failure = await rejectedFailure(new PiAiProvider({
		config: config(), fetch: async () => responseStream([{ type: "response.failed", response: {
			status: "failed", error: { code: "server_error", message: `upstream request failed api_key=sk-private-value\n    at request (/private/app.ts:1:2)\n${"x".repeat(2_000)}` },
		} }]),
	}).stream(request(), signalOptions()));
	assert.ok((failure.publicDetail?.length ?? 0) <= 1_000);
	assert.match(failure.publicDetail ?? "", /upstream request failed api_key=\[REDACTED\]/u);
	assert.doesNotMatch(JSON.stringify(providerFailureToRuntimeFailure(failure)), /private-value|app\.ts|at request/u);
});

test("transport abort without caller cancellation is a retryable disconnect", async () => {
	const failure = await rejectedFailure(new PiAiProvider({
		config: config(), fetch: async () => responseStream(partialResponseFrames(), new DOMException("The operation was aborted", "AbortError")),
	}).stream(request(), signalOptions()));
	assert.equal(failure.code, "response_stream_error");
	assert.equal(failure.retryable, true);
});

test("local pi-ai exceptions cannot masquerade as remote envelopes or leak details", async (context) => {
	for (const message of [
		"TypeError: private local state",
		"server_error: private local state",
		'{"error":{"code":"server_error","message":"private local state"}}',
	]) {
		await context.test(message, async () => {
			const failure = await rejectedFailure(new PiAiProvider({
				config: config(),
				streamFactory: () => { throw new Error(message); },
			}).stream(request(), signalOptions()));
			assert.equal(failure.retryable, false);
			assert.equal(failure.publicDetail, undefined);
			assert.doesNotMatch(JSON.stringify(providerFailureToRuntimeFailure(failure)), /private local state/u);
		});
		await context.test(`after HTTP success: ${message}`, async () => {
			const failure = await rejectedFailure(new PiAiProvider({
				config: config(), fetch: async () => new Response(null, { status: 200 }),
				streamFactory: (_model, _context, options) => (async function* (): AsyncIterable<AssistantMessageEvent> {
					assert.ok(options.fetch);
					await options.fetch("https://offline.invalid");
					yield { type: "start", partial: assistant() };
					throw new Error(message);
				})(),
			}).stream(request(), signalOptions()));
			assert.equal(failure.retryable, false);
			assert.equal(failure.publicDetail, undefined);
			assert.doesNotMatch(JSON.stringify(providerFailureToRuntimeFailure(failure)), /private local state/u);
		});
	}
});

function partialResponseFrames(): readonly Readonly<Record<string, unknown>>[] {
	return [
		{ type: "response.created", response: { id: "resp-test", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0,
			item: { type: "message", id: "msg-test", role: "assistant", content: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "partial" },
	];
}

function responseStream(
	frames: readonly Readonly<Record<string, unknown>>[],
	readError?: Error,
): Response {
	let index = 0;
	return new Response(new ReadableStream<Uint8Array>({
		pull(controller): void {
			const frame = frames[index++];
			if (frame) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
			else if (readError) controller.error(readError);
			else controller.close();
		},
	}, { highWaterMark: 0 }), {
		headers: {
			"content-type": "text/event-stream",
			"retry-after-ms": "100",
			"x-request-id": "req-stream",
		},
	});
}

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
