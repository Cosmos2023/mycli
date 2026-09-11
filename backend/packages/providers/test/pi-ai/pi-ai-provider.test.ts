import assert from "node:assert/strict";
import test from "node:test";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type {
	ProviderEvent,
	ProviderReplayState,
	ProviderRequest,
} from "@mycli/core";
import {
	parseProviderRouteId,
	PROVIDER_REPLAY_STATE_MAX_JSON_CHARS,
} from "@mycli/core";
import { toPiAiContext } from "../../src/pi-ai/pi-ai-context.ts";
import type { PiAiApi, PiAiModelConfig } from "../../src/pi-ai/pi-ai-model.ts";
import { PiAiProvider } from "../../src/pi-ai/pi-ai-provider.ts";
import { piAiReplayTransportIdentity } from "../../src/pi-ai/pi-ai-replay.ts";

test("normalizes pi-ai deltas, tools, usage, replay, and completion", async () => {
	let capturedOptions: SimpleStreamOptions | undefined;
	const phases: string[] = [];
	const final = assistant({
		content: [
			{ type: "thinking", thinking: "checked", thinkingSignature: "reasoning_content" },
			{ type: "text", text: "done", textSignature: "msg_1" },
			{
				type: "toolCall",
				id: "call-1|fc_1",
				name: "Read",
				arguments: { file_path: "README.md" },
				thoughtSignature: "thought-1",
			},
		],
		responseId: "resp_1",
		stopReason: "toolUse",
		usage: {
			input: 6,
			output: 3,
			cacheRead: 4,
			cacheWrite: 2,
			reasoning: 1,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	const provider = new PiAiProvider({
		config: config(),
		streamFactory: (_model, _context, options) => {
			capturedOptions = options;
			return eventStream([
				{ type: "start", partial: assistant() },
				{ type: "thinking_delta", contentIndex: 0, delta: "checked", partial: final },
				{ type: "text_delta", contentIndex: 1, delta: "done", partial: final },
				{ type: "done", reason: "toolUse", message: final },
			]);
		},
	});

	const result = await collect(provider.stream(request(), {
		signal: new AbortController().signal,
		onPhase: (phase) => { phases.push(phase); throw new Error("timing sink failed"); },
	}));

	assert.deepEqual(phases, ["sdk_terminal"]);
	assert.equal(capturedOptions?.maxRetries, 0);
	assert.deepEqual(result.map((event) => event.type), [
		"reasoning_delta",
		"text_delta",
		"provider_state",
		"tool_call",
		"usage",
		"completed",
	]);
	assert.deepEqual(result.find((event) => event.type === "tool_call"), {
		type: "tool_call",
		callId: "call-1",
		name: "Read",
		argumentsJson: "{\"file_path\":\"README.md\"}",
	});
	assert.deepEqual(result.find((event) => event.type === "usage"), {
		type: "usage",
		usage: {
			input_tokens: 12,
			output_tokens: 3,
			total_tokens: 15,
			cached_tokens: 4,
			cache_write_tokens: 2,
			reasoning_tokens: 1,
		},
	});
	assert.deepEqual(result.at(-1), { type: "completed", responseId: "resp_1" });
});

test("projects Chat and Anthropic usage without losing cache accounting", async () => {
	const usage = {
		input: 6,
		output: 3,
		cacheRead: 4,
		cacheWrite: 2,
		reasoning: 1,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const cases = [
		{
			config: config({ provider: "compatible", protocol: "chat_completions" }),
			request: request({ provider: "compatible", protocol: "chat_completions" }),
			message: assistant({
				api: "openai-completions",
				provider: "compatible",
				content: [{ type: "text", text: "done" }],
				usage,
			}),
			expected: {
				input_tokens: 12,
				output_tokens: 3,
				total_tokens: 15,
				cached_tokens: 4,
				reasoning_tokens: 1,
			},
		},
		{
			config: config({ provider: "anthropic", protocol: "anthropic_messages" }),
			request: request({ provider: "anthropic", protocol: "anthropic_messages" }),
			message: assistant({
				api: "anthropic-messages",
				provider: "anthropic",
				content: [{ type: "text", text: "done" }],
				usage,
			}),
			expected: {
				input_tokens: 6,
				output_tokens: 3,
				cache_creation_input_tokens: 2,
				cache_read_input_tokens: 4,
			},
		},
	] as const;
	for (const scenario of cases) {
		const provider = new PiAiProvider({
			config: scenario.config,
			streamFactory: () => eventStream([{
				type: "done",
				reason: "stop",
				message: scenario.message,
			}]),
		});
		const result = await collect(provider.stream(scenario.request, {
			signal: new AbortController().signal,
		}));
		assert.deepEqual(result.find((event) => event.type === "usage"), {
			type: "usage",
			usage: scenario.expected,
		});
	}
});

test("rejects non-JSON tool schemas before pi-ai transport setup", async () => {
	let started = false;
	const provider = new PiAiProvider({
		config: config(),
		streamFactory: () => {
			started = true;
			return eventStream([]);
		},
	});
	await assert.rejects(
		() => collect(provider.stream(request({
			tools: [{
				id: "invalid",
				name: "Invalid",
				description: "invalid schema",
				inputSchema: { type: "object", properties: { value: undefined } },
			}],
		}), { signal: new AbortController().signal })),
		/tool input schema must be a JSON object/u,
	);
	assert.equal(started, false);
});

test("round-trips versioned pi-ai replay without replacing canonical content", async () => {
	const firstMessage = assistant({
		content: [
			{ type: "thinking", thinking: "private", thinkingSignature: "reasoning_content" },
			{ type: "text", text: "answer", textSignature: "msg_native" },
			{
				type: "toolCall",
				id: "call-1|fc_native",
				name: "Read",
				arguments: { file_path: "README.md" },
			},
		],
		responseId: "resp_native",
		stopReason: "toolUse",
	});
	const first = new PiAiProvider({
		config: config(),
		streamFactory: () => eventStream([{
			type: "done",
			reason: "toolUse",
			message: firstMessage,
		}]),
	});
	const firstEvents = await collect(first.stream(request(), {
		signal: new AbortController().signal,
	}));
	const stateEvent = firstEvents.find((event) => event.type === "provider_state");
	assert(stateEvent?.type === "provider_state");
	assert.equal(stateEvent.state.value.version, 2);
	assert.deepEqual(stateEvent.state.value.transport, {
		version: 1,
		routeId: "openai",
		catalogProviderId: "openai",
		api: "openai-responses",
		model: "gpt-test",
		endpointSha256: "d9617135d6fdd0a2cde722d637a1dfcc3da37515708b3ea5d66ae607c8ac785e",
	});
	const serializedState = JSON.stringify(stateEvent.state);
	assert.equal(serializedState.includes("test-key"), false);
	assert.equal(serializedState.includes("https://api.openai.com"), false);

	let replayContext: Context | undefined;
	const second = new PiAiProvider({
		config: config(),
		streamFactory: (_model, context) => {
			replayContext = context;
			return eventStream([{
				type: "done",
				reason: "stop",
				message: assistant({ content: [{ type: "text", text: "next" }] }),
			}]);
		},
	});
	await collect(second.stream({
		...request(),
		items: [
			{ type: "user", text: "read" },
			{
				type: "assistant_tool_calls",
				text: "answer",
				calls: [{
					callId: "call-1",
					name: "Read",
					argumentsJson: "{\"file_path\":\"README.md\"}",
				}],
				providerState: stateEvent.state,
			},
			{
				type: "tool_result",
				callId: "call-1",
				toolName: "Read",
				output: "contents",
				success: true,
			},
		],
	}, { signal: new AbortController().signal }));

	const replayed = replayContext?.messages.find((message) => message.role === "assistant");
	assert(replayed?.role === "assistant");
	assert.deepEqual(replayed.content, [
		{ type: "thinking", thinking: "private", thinkingSignature: "reasoning_content" },
		{ type: "text", text: "answer", textSignature: "msg_native" },
		{
			type: "toolCall",
			id: "call-1|fc_native",
			name: "Read",
			arguments: { file_path: "README.md" },
		},
	]);

	const mismatched = toPiAiContext({
		...request(),
		items: [{
			type: "assistant_tool_calls",
			text: "answer",
			calls: [{
				callId: "call-1",
				name: "Read",
				argumentsJson: "{\"file_path\":\"README.md\"}",
			}],
			providerState: stateEvent.state,
		}],
	}, "openai-responses", "openai", piAiReplayTransportIdentity({
		routeId: "openai",
		catalogProviderId: "openai",
		api: "openai-responses",
		model: "gpt-test",
		apiBaseUrl: "https://other.example/v1",
	}));
	const mismatchedAssistant = mismatched.context.messages.at(-1);
	assert(mismatchedAssistant?.role === "assistant");
	assert.deepEqual(mismatchedAssistant.content, [
		{ type: "text", text: "answer" },
		{
			type: "toolCall",
			id: "call-1",
			name: "Read",
			arguments: { file_path: "README.md" },
		},
	]);
	assert.deepEqual(mismatched.replayDiagnostics, [{
		code: "provider_replay_degraded",
		reason: "transport_mismatch",
	}]);
});

test("degrades replay for every mismatched or malformed transport identity", () => {
	const expectedTransport = piAiReplayTransportIdentity({
		routeId: "openai",
		catalogProviderId: "openai",
		api: "openai-responses",
		model: "gpt-test",
		apiBaseUrl: "https://api.openai.com/v1",
	});
	const cases: readonly Readonly<{
		name: string;
		transport: Readonly<Record<string, unknown>>;
		reason: "malformed" | "transport_mismatch";
	}>[] = [
		{
			name: "route",
			transport: { ...expectedTransport, routeId: "compatible" },
			reason: "transport_mismatch",
		},
		{
			name: "catalog provider",
			transport: { ...expectedTransport, catalogProviderId: "deepseek" },
			reason: "transport_mismatch",
		},
		{
			name: "API",
			transport: { ...expectedTransport, api: "openai-completions" },
			reason: "transport_mismatch",
		},
		{
			name: "model",
			transport: { ...expectedTransport, model: "gpt-other" },
			reason: "transport_mismatch",
		},
		{
			name: "endpoint",
			transport: { ...expectedTransport, endpointSha256: "a".repeat(64) },
			reason: "transport_mismatch",
		},
		{
			name: "malformed metadata",
			transport: { ...expectedTransport, endpointSha256: "not-a-sha256" },
			reason: "malformed",
		},
	];

	for (const scenario of cases) {
		const state: ProviderReplayState = {
			provider: "openai",
			value: {
				kind: "pi_ai_assistant",
				version: 2,
				transport: scenario.transport,
				textBlocks: [{ text: "answer", textSignature: "msg_native" }],
				thinkingBlocks: [],
				toolCalls: [],
			},
		};
		const projection = toPiAiContext({
			...request(),
			items: [{ type: "assistant", text: "answer", providerState: state }],
		}, "openai-responses", "openai", expectedTransport);
		const message = projection.context.messages.find((candidate) => candidate.role === "assistant");
		assert(message?.role === "assistant", scenario.name);
		assert.deepEqual(message.content, [{ type: "text", text: "answer" }], scenario.name);
		assert.deepEqual(projection.replayDiagnostics, [{
			code: "provider_replay_degraded",
			reason: scenario.reason,
		}], scenario.name);
	}
});

test("degrades transport-unbound replay for experimental routes", () => {
	const route = parseProviderRouteId("catalog-alias");
	const state = currentReplayState({ provider: route });
	const projection = toPiAiContext({
		...request(),
		provider: route,
		items: [{
			type: "assistant",
			text: "answer",
			providerState: { provider: route, value: state.value },
		}],
	}, "openai-responses", route);

	assert.deepEqual(projection.replayDiagnostics, [{
		code: "provider_replay_degraded",
		reason: "legacy_transport_unbound",
	}]);
});

test("reads legacy Responses, Anthropic, and DeepSeek replay states", () => {
	const cases: Array<{
		api: PiAiApi;
		provider: ProviderRequest["provider"];
		protocol: ProviderRequest["protocol"];
		state: ProviderReplayState;
		expectedSignature: string;
	}> = [
		{
			api: "openai-responses",
			provider: "openai",
			protocol: "responses",
			state: {
				provider: "openai",
				value: { responsesNativeItems: [{
					type: "reasoning",
					summary: [{ type: "summary_text", text: "checked" }],
					encrypted_content: "encrypted",
				}] },
			},
			expectedSignature: "encrypted_content",
		},
		{
			api: "anthropic-messages",
			provider: "anthropic",
			protocol: "anthropic_messages",
			state: {
				provider: "anthropic",
				value: { thinkingBlocks: [{ thinking: "checked", signature: "sig-test" }] },
			},
			expectedSignature: "sig-test",
		},
		{
			api: "openai-completions",
			provider: "deepseek",
			protocol: "chat_completions",
			state: {
				provider: "deepseek",
				value: { reasoningContent: "checked" },
			},
			expectedSignature: "reasoning_content",
		},
	];
	for (const scenario of cases) {
		const projected = toPiAiContext({
			...request(),
			provider: scenario.provider,
			protocol: scenario.protocol,
			items: [{ type: "assistant", text: "answer", providerState: scenario.state }],
		}, scenario.api);
		const message = projected.context.messages.at(-1);
		assert(message?.role === "assistant");
		const thinking = message.content.find((block) => block.type === "thinking");
		assert(thinking?.type === "thinking");
		assert(thinking.thinkingSignature?.includes(scenario.expectedSignature));
	}
});

test("degrades malformed, foreign, unsupported, and oversized replay to canonical content", () => {
	const cases: readonly Readonly<{
		state: ProviderReplayState;
		reason: string;
	}>[] = [
		{
			state: currentReplayState({ version: 3 }),
			reason: "unsupported_version",
		},
		{
			state: currentReplayState({ model: "other-model" }),
			reason: "foreign_identity",
		},
		{
			state: currentReplayState({ textBlocks: [{ text: 42 }] }),
			reason: "malformed",
		},
		{
			state: currentReplayState({ textBlocks: [{ text: "different" }] }),
			reason: "content_mismatch",
		},
		{
			state: {
				provider: "compatible",
				value: {},
			},
			reason: "foreign_provider",
		},
		{
			state: {
				provider: "openai",
				value: { oversized: "x".repeat(PROVIDER_REPLAY_STATE_MAX_JSON_CHARS + 1) },
			},
			reason: "oversized",
		},
	];

	for (const scenario of cases) {
		const projection = toPiAiContext({
			...request(),
			items: [{ type: "assistant", text: "answer", providerState: scenario.state }],
		}, "openai-responses");
		const message = projection.context.messages.find((candidate) => candidate.role === "assistant");
		assert(message?.role === "assistant");
		assert.deepEqual(message.content, [{ type: "text", text: "answer" }]);
		assert.deepEqual(projection.replayDiagnostics, [{
			code: "provider_replay_degraded",
			reason: scenario.reason,
		}]);
	}
});

test("restores response identity and semantically equivalent tool arguments", () => {
	const projection = toPiAiContext({
		...request(),
		items: [{
			type: "assistant_tool_calls",
			text: "answer",
			calls: [{ callId: "call-1", name: "Read", argumentsJson: "{\"a\":1,\"b\":2}" }],
			providerState: currentReplayState({
				responseId: "resp_native",
				toolCalls: [{
					callId: "call-1",
					nativeId: "call-1|fc_native",
					name: "Read",
					argumentsJson: "{\"b\":2,\"a\":1}",
				}],
			}),
		}, {
			type: "tool_result", callId: "call-1", toolName: "Read", output: "file contents", success: true,
		}],
	}, "openai-responses", "openai");
	const message = projection.context.messages.find((candidate) => candidate.role === "assistant");
	assert(message?.role === "assistant");
	assert.equal(message.responseId, "resp_native");
	const result = projection.context.messages.find((candidate) => candidate.role === "toolResult");
	assert.equal(result?.toolCallId, "call-1|fc_native");
	assert.deepEqual(message.content, [
		{ type: "text", text: "answer", textSignature: "msg_native" },
		{
			type: "toolCall",
			id: "call-1|fc_native",
			name: "Read",
			arguments: { a: 1, b: 2 },
		},
	]);
	assert.deepEqual(projection.replayDiagnostics, []);
});

test("ignores legacy hosted-search replay while retaining valid Responses reasoning", () => {
	const projection = toPiAiContext({
		...request(),
		items: [{
			type: "assistant",
			text: "answer",
			providerState: {
				provider: "openai",
				value: {
					responsesNativeItems: [
						{ type: "web_search_call", id: "ws_1", status: "completed" },
						{
							type: "reasoning",
							summary: [{ type: "summary_text", text: "checked" }],
							encrypted_content: "encrypted",
						},
					],
				},
			},
		}],
	}, "openai-responses");
	const message = projection.context.messages.find((candidate) => candidate.role === "assistant");
	assert(message?.role === "assistant");
	assert.equal(message.content[0]?.type, "thinking");
	assert.deepEqual(projection.replayDiagnostics, []);
});

test("aborts pi-ai and closes its iterator when the consumer stops early", async () => {
	let upstreamSignal: AbortSignal | undefined;
	let iteratorClosed = false;
	const provider = new PiAiProvider({
		config: config(),
		streamFactory: (_model, _context, options) => (async function* () {
			upstreamSignal = options.signal;
			try {
				yield {
					type: "text_delta",
					contentIndex: 0,
					delta: "partial",
					partial: assistant(),
				} satisfies AssistantMessageEvent;
				await new Promise<void>((resolve) => options.signal?.addEventListener(
					"abort",
					() => resolve(),
					{ once: true },
				));
			} finally {
				iteratorClosed = true;
			}
		})(),
	});
	const iterator = provider.stream(request(), {
		signal: new AbortController().signal,
	})[Symbol.asyncIterator]();

	assert.deepEqual(await iterator.next(), {
		done: false,
		value: { type: "text_delta", text: "partial" },
	});
	await iterator.return?.();
	assert.equal(upstreamSignal?.aborted, true);
	assert.equal(iteratorClosed, true);
});

test("settles pi-ai terminal events without reading further and closes the iterator", { timeout: 5_000 }, async (context) => {
	for (const type of ["done", "error"] as const) {
		await context.test(type, async () => {
			let reads = 0;
			let closed = false;
			let signal: AbortSignal | undefined;
			const provider = new PiAiProvider({
				config: config(),
				streamFactory: (_model, _context, options) => {
					signal = options.signal;
					return {
						[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
							return {
								async next(): Promise<IteratorResult<AssistantMessageEvent>> {
									reads += 1;
									if (reads > 1) return new Promise(() => undefined);
									return { done: false, value: type === "done"
										? { type: "done", reason: "stop", message: assistant({ content: [{ type: "text", text: "done" }] }) }
										: { type: "error", reason: "error", error: assistant({ errorMessage: "stream ended prematurely" }) } };
								},
								async return(): Promise<IteratorResult<AssistantMessageEvent>> {
									closed = true;
									return { done: true, value: undefined };
								},
							};
						},
					};
				},
			});
			const result = collect(provider.stream(request(), { signal: new AbortController().signal }));
			if (type === "done") assert.equal((await result).at(-1)?.type, "completed");
			else await assert.rejects(result, /response_stream_error/u);
			assert.equal(reads, 1);
			assert.equal(closed, true);
			assert.equal(signal?.aborted, true);
		});
	}
});

test("rejects invalid pi-ai terminal states", async (context) => {
	const cases: Array<{
		name: string;
		events: readonly AssistantMessageEvent[];
		pattern: RegExp;
	}> = [
		{
			name: "missing terminal",
			events: [{ type: "start", partial: assistant() }],
			pattern: /response_stream_error/u,
		},
		{
			name: "empty success",
			events: [{ type: "done", reason: "stop", message: assistant() }],
			pattern: /empty successful response/u,
		},
		{
			name: "length",
			events: [{
				type: "done",
				reason: "length",
				message: assistant({
					content: [{ type: "text", text: "partial" }],
					stopReason: "length",
				}),
			}],
			pattern: /output token limit/u,
		},
		{
			name: "error",
			events: [{
				type: "error",
				reason: "error",
				error: assistant({ stopReason: "error", errorMessage: "stream ended prematurely" }),
			}],
			pattern: /response_stream_error/u,
		},
		{
			name: "deferred",
			events: [{
				type: "done",
				reason: "deferred",
				message: assistant({
					content: [{ type: "text", text: "queued" }],
					stopReason: "deferred",
				}),
			}],
			pattern: /unsupported deferred response/u,
		},
		{
			name: "malformed tool call",
			events: [{
				type: "done",
				reason: "toolUse",
				message: assistant({
					content: [{ type: "toolCall", id: "", name: "Read", arguments: {} }],
					stopReason: "toolUse",
				}),
			}],
			pattern: /tool_protocol_error/u,
		},
		{
			name: "non-JSON tool arguments",
			events: [{
				type: "done",
				reason: "toolUse",
				message: assistant({
					content: [{
						type: "toolCall",
						id: "call-1",
						name: "Read",
						arguments: { value: undefined },
					}],
					stopReason: "toolUse",
				}),
			}],
			pattern: /pi-ai tool arguments must be a JSON object/u,
		},
	];
	for (const scenario of cases) {
		await context.test(scenario.name, async () => {
			const provider = new PiAiProvider({
				config: config(),
				streamFactory: () => eventStream(scenario.events),
			});
			await assert.rejects(
				() => collect(provider.stream(request(), {
					signal: new AbortController().signal,
				})),
				scenario.pattern,
			);
		});
	}
});

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

function currentReplayState(
	overrides: Readonly<Record<string, unknown>> = {},
): ProviderReplayState {
	return {
		provider: "openai",
		value: {
			kind: "pi_ai_assistant",
			version: 1,
			api: "openai-responses",
			provider: "openai",
			model: "gpt-test",
			textBlocks: [{ text: "answer", textSignature: "msg_native" }],
			thinkingBlocks: [],
			toolCalls: [],
			...overrides,
		},
	};
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
	return {
		provider: "openai",
		protocol: "responses",
		model: "gpt-test",
		instructions: "system",
		messages: [{ role: "user", content: "hello" }],
		tools: [],
		...overrides,
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

async function* eventStream(
	events: readonly AssistantMessageEvent[],
): AsyncIterable<AssistantMessageEvent> {
	for (const event of events) yield event;
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
	const result: ProviderEvent[] = [];
	for await (const event of stream) result.push(event);
	return result;
}
