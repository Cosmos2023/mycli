import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent, ProviderRequest, RuntimeEvent } from "@mycli/core";
import {
	ProviderFailure,
	ProviderRegistry,
	providerFailureToRuntimeFailure,
} from "@mycli/providers";
import {
	ProviderAgentLoop,
	type ProviderAgentLoopFailure,
	type ProviderStreamDiagnostics,
} from "../src/index.ts";

test("ProviderAgentLoop dispatches the exact committed request", async () => {
	const request = providerRequest();
	const observed: ProviderRequest[] = [];
	const emitted: RuntimeEvent[] = [];
	const result = await new ProviderAgentLoop().runStep({
		provider: scriptedProvider(observed, [[
			{ type: "text_delta", text: "done" },
			{ type: "usage", usage: { total_tokens: 5 } },
			{ type: "completed", responseId: "response-1" },
		]]),
		request,
		requestMaxRetries: 0,
		maxRetries: 0,
		signal: new AbortController().signal,
		toolCallsAllowed: true,
		emit: (event) => emitted.push(event),
		normalizeFailure,
	});

	assert.deepEqual(observed, [request]);
	assert.deepEqual(result, {
		assistantText: "done",
		usage: { total_tokens: 5 },
		toolCalls: [],
		webSearchCalls: [],
		responseId: "response-1",
	});
	assert.deepEqual(emitted.map((event) => event.type), ["text_delta", "message_complete"]);
});

test("ProviderAgentLoop uses the request retry budget before observing provider output", async () => {
	const observed: ProviderRequest[] = [];
	const emitted: RuntimeEvent[] = [];
	let sleeps = 0;
	const result = await new ProviderAgentLoop().runStep({
		provider: scriptedProvider(observed, [
			new ProviderFailure({ code: "connection_error", message: "temporary", retryable: true }),
			[{ type: "completed", responseId: "response-2" }],
		]),
		request: providerRequest(),
		requestMaxRetries: 1,
		maxRetries: 0,
		signal: new AbortController().signal,
		toolCallsAllowed: false,
		emit: (event) => emitted.push(event),
		normalizeFailure,
		sleep: async () => { sleeps += 1; },
		random: () => 0.5,
	});

	assert.equal("failure" in result, false);
	assert.equal(observed.length, 2);
	assert.equal(sleeps, 1);
	assert.deepEqual(emitted.map((event) => event.type), [
		"stream_retrying",
		"message_complete",
		"stream_recovered",
	]);
	assert.deepEqual(emitted[0], {
		type: "stream_retrying",
		attempt: 1,
		maxRetries: 1,
		delayMs: 200,
		recoveryKind: "request",
		resetOutput: false,
		failureKind: "connection_error",
		additionalDetails: "provider connection failed",
	});
});

test("ProviderAgentLoop retries and resets an incomplete streamed attempt", async () => {
	const observed: ProviderRequest[] = [];
	const emitted: RuntimeEvent[] = [];
	let attempts = 0;
	const provider = {
		stream: async function* (request: ProviderRequest): AsyncIterable<ProviderEvent> {
			observed.push(request);
			attempts += 1;
			if (attempts === 1) {
				yield { type: "text_delta", text: "discarded" };
					throw new ProviderFailure({
						code: "connection_error",
					message: "connection lost",
					retryable: true,
				});
			}
			yield { type: "text_delta", text: "recovered" };
			yield { type: "completed", responseId: "response-2" };
		},
	};

	const result = await new ProviderAgentLoop().runStep({
		provider,
		request: providerRequest(),
		requestMaxRetries: 0,
		maxRetries: 1,
		signal: new AbortController().signal,
		toolCallsAllowed: false,
		emit: (event) => emitted.push(event),
		normalizeFailure,
		sleep: async () => undefined,
		random: () => 0.5,
	});

	assert.equal("failure" in result, false);
	assert.equal(observed.length, 2);
	assert.deepEqual(emitted, [
		{ type: "text_delta", text: "discarded" },
		{
			type: "stream_retrying",
			attempt: 1,
			maxRetries: 1,
			delayMs: 200,
			recoveryKind: "stream",
			resetOutput: true,
				failureKind: "response_stream_error",
				additionalDetails: "provider connection failed",
		},
		{ type: "text_delta", text: "recovered" },
		{ type: "message_complete", responseId: "response-2" },
		{ type: "stream_recovered" },
	]);
});

test("ProviderAgentLoop owns request and stream retries for pi-ai failures", async (context) => {
	await context.test("request recovery", async () => {
		const source = piAiBackedProvider(["request_failure", "success"]);
		const emitted: RuntimeEvent[] = [];
		const result = await new ProviderAgentLoop().runStep({
			provider: source.provider,
			request: providerRequest(),
			requestMaxRetries: 1,
			maxRetries: 0,
			signal: new AbortController().signal,
			toolCallsAllowed: false,
			emit: (event) => emitted.push(event),
			normalizeFailure,
			sleep: async () => undefined,
			random: () => 0.5,
		});
		assert.equal("failure" in result, false);
		assert.equal(source.attempts(), 2);
		assert.deepEqual(emitted.map((event) => event.type), [
			"stream_retrying",
			"text_delta",
			"message_complete",
			"stream_recovered",
		]);
		assert.equal(emitted[0]?.type === "stream_retrying" && emitted[0].recoveryKind, "request");
	});

	await context.test("post-output stream recovery", async () => {
		const source = piAiBackedProvider(["stream_failure", "success"]);
		const emitted: RuntimeEvent[] = [];
		const result = await new ProviderAgentLoop().runStep({
			provider: source.provider,
			request: providerRequest(),
			requestMaxRetries: 0,
			maxRetries: 1,
			signal: new AbortController().signal,
			toolCallsAllowed: false,
			emit: (event) => emitted.push(event),
			normalizeFailure,
			sleep: async () => undefined,
			random: () => 0.5,
		});
		assert.equal("failure" in result, false);
		assert.equal(source.attempts(), 2);
		const retrying = emitted.find((event) => event.type === "stream_retrying");
		assert(retrying?.type === "stream_retrying");
		assert.equal(retrying.recoveryKind, "stream");
		assert.equal(retrying.resetOutput, true);
		assert.equal(retrying.failureKind, "response_stream_error");
	});
});

test("ProviderAgentLoop exhausts and aborts pi-ai retry backoff", async (context) => {
	await context.test("exhaustion", async () => {
		const source = piAiBackedProvider(["request_failure", "request_failure"]);
		const result = await new ProviderAgentLoop().runStep({
			provider: source.provider,
			request: providerRequest(),
			requestMaxRetries: 1,
			maxRetries: 0,
			signal: new AbortController().signal,
			toolCallsAllowed: false,
			emit: () => undefined,
			normalizeFailure,
			sleep: async () => undefined,
			random: () => 0.5,
		});
		assert.equal(source.attempts(), 2);
		assert.equal("failure" in result ? result.failure.code : undefined, "retry_exhausted");
	});

	await context.test("abortable backoff", async () => {
		const source = piAiBackedProvider(["request_failure", "success"]);
		const controller = new AbortController();
		let backoffStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => { backoffStarted = resolve; });
		const pending = new ProviderAgentLoop().runStep({
			provider: source.provider,
			request: providerRequest(),
			requestMaxRetries: 1,
			maxRetries: 0,
			signal: controller.signal,
			toolCallsAllowed: false,
			emit: () => undefined,
			normalizeFailure,
			random: () => 0.5,
			sleep: async (_delay, signal) => {
				backoffStarted?.();
				await new Promise<void>((_resolve, reject) => signal.addEventListener(
					"abort",
					() => reject(signal.reason),
					{ once: true },
				));
			},
		});
		await started;
		controller.abort();
		const result = await pending;
		assert.equal(source.attempts(), 1);
		assert.equal("failure" in result ? result.failure.code : undefined, "interrupted");
	});
});

test("ProviderAgentLoop fails a stream that ends without completion", async () => {
	const result = await new ProviderAgentLoop().runStep({
		provider: scriptedProvider([], [[{ type: "text_delta", text: "partial" }]]),
		request: providerRequest(),
		requestMaxRetries: 0,
		maxRetries: 0,
		signal: new AbortController().signal,
		toolCallsAllowed: false,
		emit: () => undefined,
		normalizeFailure,
	});

	assert.equal("failure" in result ? result.failure.code : undefined, "response_stream_error");
	assert.equal("failure" in result ? result.eventsObserved : undefined, 1);
});

test("ProviderAgentLoop never retries after provider completion", async () => {
	let attempts = 0;
	const result = await new ProviderAgentLoop().runStep({
		provider: {
			stream: async function* (): AsyncIterable<ProviderEvent> {
				attempts += 1;
				yield { type: "completed", responseId: "response-complete" };
					throw new ProviderFailure({
						code: "connection_error",
					message: "late disconnect",
					retryable: true,
				});
			},
		},
		request: providerRequest(),
		requestMaxRetries: 1,
		maxRetries: 1,
		signal: new AbortController().signal,
		toolCallsAllowed: false,
		emit: () => undefined,
		normalizeFailure,
		sleep: async () => undefined,
	});

	assert.equal(attempts, 1);
	assert.equal("failure" in result ? result.failure.code : undefined, "connection_error");
});

test("ProviderAgentLoop publishes only the sanitized provider detail while retrying", async () => {
	const emitted: RuntimeEvent[] = [];
	await new ProviderAgentLoop().runStep({
		provider: scriptedProvider([], [
			new ProviderFailure({
				code: "provider_error",
				message: "internal provider failure",
				publicDetail: "Invalid schema api_key=private-value",
				retryable: true,
				diagnostics: { status: 400, request_id: "req_retry_1" },
			}),
			[{ type: "completed", responseId: "response-2" }],
		]),
		request: providerRequest(),
		requestMaxRetries: 0,
		maxRetries: 1,
		signal: new AbortController().signal,
		toolCallsAllowed: false,
		emit: (event) => emitted.push(event),
		normalizeFailure,
		sleep: async () => undefined,
		random: () => 0.5,
	});

	assert.equal(emitted[0]?.type, "stream_retrying");
	assert.equal(
		emitted[0]?.type === "stream_retrying" ? emitted[0].additionalDetails : undefined,
		"Invalid schema api_key=[REDACTED] (status 400, request id: req_retry_1)",
	);
});

test("ProviderAgentLoop preserves unsupported capability for a disabled tool call", async () => {
	const result = await new ProviderAgentLoop().runStep({
		provider: scriptedProvider([], [[{
			type: "tool_call",
			callId: "call-1",
			name: "Read",
			argumentsJson: "{}",
		}]]),
		request: providerRequest(),
		requestMaxRetries: 0,
		maxRetries: 0,
		signal: new AbortController().signal,
		toolCallsAllowed: false,
		emit: () => undefined,
		normalizeFailure,
	});

	assert.deepEqual(result, {
		failure: {
			code: "unsupported_capability",
			message: "provider requested an unsupported capability",
			retryable: false,
		},
		eventsObserved: 1,
	});
});

test("ProviderAgentLoop forwards and returns hosted web-search calls", async () => {
	const emitted: RuntimeEvent[] = [];
	const result = await new ProviderAgentLoop().runStep({
		provider: scriptedProvider([], [[
			{ type: "web_search_started", callId: "ws-1" },
			{
				type: "web_search_completed",
				call: { callId: "ws-1", action: { type: "search", queries: ["mycli"] } },
			},
			{ type: "completed", responseId: "response-search" },
		]]),
		request: providerRequest(),
		requestMaxRetries: 0,
		maxRetries: 0,
		signal: new AbortController().signal,
		toolCallsAllowed: false,
		emit: (event) => emitted.push(event),
		normalizeFailure,
	});

	assert.deepEqual(result, {
		assistantText: "",
		usage: {},
		toolCalls: [],
		webSearchCalls: [{ callId: "ws-1", action: { type: "search", queries: ["mycli"] } }],
		responseId: "response-search",
	});
	assert.deepEqual(emitted, [
		{ type: "web_search_started", callId: "ws-1" },
		{
			type: "web_search_completed",
			call: { callId: "ws-1", action: { type: "search", queries: ["mycli"] } },
		},
		{ type: "message_complete", responseId: "response-search" },
	]);
});

test("ProviderAgentLoop records TTFB, TTFT, TBT, event counts, and UTF-8 bytes", async () => {
	const diagnostics: ProviderStreamDiagnostics[] = [];
	const result = await new ProviderAgentLoop().runStep({
		provider: scriptedProvider([], [[
			{ type: "reasoning_delta", text: "想" },
			{ type: "text_delta", text: "" },
			{ type: "text_delta", text: "done" },
			{ type: "text_delta", text: "!" },
			{ type: "provider_state", state: { provider: "openai", value: {} } },
			{ type: "usage", usage: { total_tokens: 5 } },
			{ type: "completed", responseId: "response-diagnostic" },
		]]),
		request: providerRequest(),
		requestMaxRetries: 0,
		maxRetries: 0,
		signal: new AbortController().signal,
		toolCallsAllowed: false,
		emit: () => undefined,
		recordDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		normalizeFailure,
		monotonicClock: numberSequence([0, 5, 10, 15, 20, 25, 30, 35, 45]),
	});

	assert.equal("failure" in result, false);
	assert.deepEqual(diagnostics, [{
		attempt: 1,
		elapsedMs: 45,
		ttfbMs: 5,
		ttftMs: 15,
		tbtMs: 5,
		maxTbtMs: 5,
		textDeltaIntervalCount: 1,
		providerEventCount: 7,
		reasoningEventCount: 1,
		textEventCount: 3,
		providerStateEventCount: 1,
		toolCallEventCount: 0,
		usageEventCount: 1,
		completedEventCount: 1,
		reasoningBytes: 3,
		textBytes: 5,
		success: true,
	}]);
});

test("ProviderAgentLoop records each real retry attempt and pre-event failures", async () => {
	const diagnostics: ProviderStreamDiagnostics[] = [];
	const result = await new ProviderAgentLoop().runStep({
		provider: scriptedProvider([], [
			new ProviderFailure({ code: "connection_error", message: "temporary", retryable: true }),
			[{ type: "completed", responseId: "response-retried" }],
		]),
		request: providerRequest(),
		requestMaxRetries: 1,
		maxRetries: 0,
		signal: new AbortController().signal,
		toolCallsAllowed: false,
		emit: () => undefined,
		recordDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		normalizeFailure,
		sleep: async () => undefined,
		random: () => 0.5,
		monotonicClock: numberSequence([0, 5, 10, 20, 25]),
	});

	assert.equal("failure" in result, false);
	assert.equal(diagnostics.length, 2);
	assert.deepEqual(diagnostics[0], {
		attempt: 1,
		elapsedMs: 5,
		textDeltaIntervalCount: 0,
		providerEventCount: 0,
		reasoningEventCount: 0,
		textEventCount: 0,
		providerStateEventCount: 0,
		toolCallEventCount: 0,
		usageEventCount: 0,
		completedEventCount: 0,
		reasoningBytes: 0,
		textBytes: 0,
		success: false,
		failureKind: "connection_error",
	});
	assert.deepEqual(diagnostics[1], {
		attempt: 2,
		elapsedMs: 15,
		ttfbMs: 10,
		textDeltaIntervalCount: 0,
		providerEventCount: 1,
		reasoningEventCount: 0,
		textEventCount: 0,
		providerStateEventCount: 0,
		toolCallEventCount: 0,
		usageEventCount: 0,
		completedEventCount: 1,
		reasoningBytes: 0,
		textBytes: 0,
		success: true,
	});
});

test("ProviderAgentLoop isolates diagnostic sink failures", async () => {
	const result = await new ProviderAgentLoop().runStep({
		provider: scriptedProvider([], [[{ type: "completed", responseId: "response-1" }]]),
		request: providerRequest(),
		requestMaxRetries: 0,
		maxRetries: 0,
		signal: new AbortController().signal,
		toolCallsAllowed: false,
		emit: () => undefined,
		recordDiagnostic: () => { throw new Error("diagnostic sink failed"); },
		normalizeFailure,
	});

	assert.equal("failure" in result, false);
});

function providerRequest(): ProviderRequest {
	const request: ProviderRequest = {
		provider: "openai",
		protocol: "responses",
		model: "test-model",
		instructions: "You are mycli.",
		messages: Object.freeze([{ role: "user", content: "Inspect the repo" }]),
		items: Object.freeze([{ type: "user", text: "Inspect the repo" }]),
		tools: Object.freeze([]),
	};
	return Object.freeze(request);
}

function scriptedProvider(
	observed: ProviderRequest[],
	scripts: readonly (readonly ProviderEvent[] | Error)[],
) {
	let index = 0;
	return {
		stream: async function* (request: ProviderRequest) {
			observed.push(request);
			const script = scripts[index++];
			if (script instanceof Error) throw script;
			for (const event of script ?? []) yield event;
		},
	};
}

function normalizeFailure(error: unknown): ProviderAgentLoopFailure {
	if (error instanceof ProviderFailure) {
		return providerFailureToRuntimeFailure(error);
	}
	if (error instanceof Error && error.name === "AbortError") {
		return { code: "interrupted", message: "provider request interrupted", retryable: false };
	}
	return { code: "provider_error", message: "provider failed", retryable: false };
}

type PiAiAttempt = "request_failure" | "stream_failure" | "success";

function piAiBackedProvider(scripts: readonly PiAiAttempt[]) {
	let attempt = 0;
	const provider = new ProviderRegistry({
		fetch: async () => {
			const script = scripts[attempt++] ?? "request_failure";
			if (script === "request_failure") {
				return new Response(JSON.stringify({
					error: { type: "server_error", message: "temporarily unavailable" },
				}), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(responsesStream(script === "success"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		},
	}).create({
		provider: "openai",
		protocol: "responses",
		model: "test-model",
		apiBaseUrl: "https://provider.example/v1",
		apiKey: "test-key",
		supportsImages: true,
		modelContextWindowTokens: 128_000,
		maxOutputTokens: 16_000,
		maxPromptTokens: 100_000,
	});
	return { provider, attempts: () => attempt };
}

function responsesStream(completed: boolean): string {
	const message = {
		type: "message",
		id: "msg_runtime_retry",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: completed ? "done" : "discarded", annotations: [] }],
	};
	const frames: unknown[] = [
		{ type: "response.created", response: { id: "resp_runtime_retry", status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...message, status: "in_progress", content: [] },
		},
		{
			type: "response.output_text.delta",
			output_index: 0,
			content_index: 0,
			delta: completed ? "done" : "discarded",
		},
	];
	if (completed) {
		frames.push(
			{ type: "response.output_item.done", output_index: 0, item: message },
			{
				type: "response.completed",
				response: {
					id: "resp_runtime_retry",
					status: "completed",
					output: [message],
					usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
				},
			},
		);
	}
	return `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}${
		completed ? "data: [DONE]\n\n" : ""
	}`;
}

function numberSequence(values: readonly number[]): () => number {
	let index = 0;
	return () => values[index++] ?? values.at(-1) ?? 0;
}
