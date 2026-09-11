import assert from "node:assert/strict";
import test from "node:test";
import { providerAttemptId, type ProviderAttemptUpdate } from "@mycli/contracts";
import type { ProviderEvent, ProviderRequest, RuntimeEvent } from "@mycli/core";
import {
	ProviderFailure,
	ProviderRegistry,
	providerFailureToRuntimeFailure,
} from "@mycli/providers";
import {
	ProviderAgentLoop,
	UserTurnCancellation,
	type ProviderAgentLoopFailure,
	type ProviderStreamDiagnostics,
} from "../../src/index.ts";

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

test("ProviderAgentLoop keeps request and stream budgets additive across the committed step", async () => {
	const observed: ProviderRequest[] = [];
	const events: RuntimeEvent[] = [];
	const request = providerRequest();
	const result = await new ProviderAgentLoop().runStep({
		provider: {
			stream: async function* (value: ProviderRequest): AsyncIterable<ProviderEvent> {
				observed.push(value);
				if (observed.length === 2) yield { type: "text_delta", text: "partial" };
				throw new ProviderFailure({ code: "connection_error", message: "temporary", retryable: true });
			},
		},
		request,
		requestMaxRetries: 1,
		maxRetries: 1,
		signal: new AbortController().signal,
		toolCallsAllowed: false,
		emit: (event) => events.push(event),
		normalizeFailure,
		sleep: async () => {},
		random: () => 0.5,
	});
	assert.equal(observed.length, 3);
	assert(observed.every((value) => value === request));
	assert("failure" in result);
	assert.equal(result.failure.code, "retry_exhausted");
	assert.deepEqual(events.filter((event) => event.type === "stream_retrying").map((event) => event.recoveryKind), ["request", "stream"]);
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
		monotonicClock: numberSequence([0, 5, 10, 15, 20, 25, 30, 35, 40, 45]),
	});

	assert.equal("failure" in result, false);
	assert.deepEqual(diagnostics, [{
		attempt: 1,
		elapsedMs: 45,
		ttfbMs: 5,
		ttftMs: 15,
		tbtMs: 5,
		maxTbtMs: 5,
		lastTextDeltaMs: 20,
		completedEventMs: 35,
		streamSettledMs: 40,
		textTailMs: 25,
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
		monotonicClock: numberSequence([0, 5, 5, 10, 20, 25, 25]),
	});

	assert.equal("failure" in result, false);
	assert.equal(diagnostics.length, 2);
	assert.deepEqual(diagnostics[0], {
		attempt: 1,
		elapsedMs: 5,
		streamSettledMs: 5,
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
		failure: { code: "connection_error", message: "provider connection failed", retryable: true },
	});
	assert.deepEqual(diagnostics[1], {
		attempt: 2,
		elapsedMs: 15,
		ttfbMs: 10,
		completedEventMs: 10,
		streamSettledMs: 15,
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

test("provider timing separates upstream wait, SDK completion, cleanup, and persistence on each retry", async () => {
	let now = 0;
	let calls = 0;
	const diagnostics: ProviderStreamDiagnostics[] = [];
	const result = await new ProviderAgentLoop().runStep({
		provider: {
			stream: async function* (_request, options): AsyncIterable<ProviderEvent> {
				const offset = now;
				calls += 1;
				try {
					now = offset + 10;
					yield { type: "text_delta", text: "last text" };
					now = offset + 8_010;
					options.onPhase?.("response_terminal");
					now = offset + 8_020;
					options.onPhase?.("sdk_terminal");
					if (calls === 1) throw new ProviderFailure({
						code: "response_stream_error", message: "upstream failed", retryable: true,
					});
					now = offset + 8_025;
					yield { type: "completed" };
				} finally {
					now = offset + 8_120;
				}
			},
		},
		request: providerRequest(), requestMaxRetries: 0, maxRetries: 1,
		signal: new AbortController().signal, toolCallsAllowed: false,
		emit: () => undefined, normalizeFailure, monotonicClock: () => now,
		recordDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
		recordAttempt: async (update) => {
			if (update.state === "failed" || update.state === "recovered") now += 300;
		},
		sleep: async () => { now += 500; },
	});
	assert.equal("failure" in result, false);
	assert.equal(diagnostics.length, 2);
	for (const [index, diagnostic] of diagnostics.entries()) {
		assert.equal(diagnostic.attempt, index + 1);
		assert.equal(diagnostic.lastTextDeltaMs, 10);
		assert.equal(diagnostic.responseTerminalMs, 8_010);
		assert.equal(diagnostic.sdkTerminalMs, 8_020);
		assert.equal(diagnostic.streamSettledMs, 8_120);
		assert.equal(diagnostic.terminalPersistMs, 300);
		assert.equal(diagnostic.elapsedMs, 8_420);
		assert.equal(diagnostic.textTailMs, 8_410);
		assert.equal(diagnostic.completedEventMs, index === 0 ? undefined : 8_025);
	}
});

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

test("enriched retries retain the concrete cause and attempt ownership after exhaustion", async () => {
	const records: ProviderAttemptUpdate[] = [];
	const observed: ProviderRequest[] = [];
	const errors = [1, 2].map(() => new ProviderFailure({ code: "connection_error", message: "timeout", retryable: true,
		errorReason: { reason: "transport.timed_out", details: { transport_code: "ETIMEDOUT" } },
	}));
	const result = await new ProviderAgentLoop().runStep({
		provider: scriptedProvider(observed, errors), request: providerRequest(), requestId: "request:error",
		errorContextVersion: 1, requestMaxRetries: 1, maxRetries: 0, signal: new AbortController().signal,
		toolCallsAllowed: true, emit: () => {}, normalizeFailure, sleep: async () => {},
		recordAttempt: async (record) => { records.push(record); },
	});
	assert.ok("failure" in result);
	assert.equal(observed.length, 2);
	const context = result.failure.errorContext;
	assert.equal(context?.reason, "runtime.retry_exhausted");
	assert.equal(context?.causes?.[0]?.reason, "transport.timed_out");
	assert.match(result.failure.message, /connection timed out/iu);
	const failures = records.filter((record) => record.state === "failed");
	assert.deepEqual(failures.map((record) => record.failure?.errorContext?.scope.id), [1, 2].map((attempt) => providerAttemptId("request:error", attempt)));
	assert.notEqual(failures[0]?.failure?.errorContext?.id, failures[1]?.failure?.errorContext?.id);
	assert.equal(context?.causes?.[0]?.id, failures[1]?.failure?.errorContext?.id);
});

test("cancelling enriched retry backoff retains the connection cause and dispatches no second request", async () => {
	const controller = new AbortController();
	const observed: ProviderRequest[] = [];
	const result = await new ProviderAgentLoop().runStep({
		provider: scriptedProvider(observed, [new ProviderFailure({ code: "connection_error", message: "timeout", retryable: true,
			errorReason: { reason: "transport.timed_out" },
		})]), request: providerRequest(), requestId: "request:cancel", errorContextVersion: 1,
		requestMaxRetries: 1, maxRetries: 1, signal: controller.signal,
		toolCallsAllowed: true, emit: () => {}, normalizeFailure,
		sleep: async () => { controller.abort(new UserTurnCancellation()); controller.signal.throwIfAborted(); },
	});
	assert.ok("failure" in result);
	assert.equal(observed.length, 1);
	assert.equal(result.failure.code, "interrupted");
	assert.equal(result.failure.errorContext?.outcome.state, "cancelled");
	assert.equal(result.failure.errorContext?.reason, "runtime.user_cancelled");
	assert.equal(result.failure.errorContext?.causes?.[0]?.reason, "transport.timed_out");
});

type PiAiAttempt = "request_failure" | "stream_failure" | "success"
	| "upstream_failure" | "body_failure" | "request_upstream_failure" | "auth_failure"
	| "nested_upstream_failure" | "reasoning_upstream_failure" | "nested_auth_failure";

test("real pi-ai upstream failures recover with safe details and reset partial tool output", async (context) => {
	for (const script of ["upstream_failure", "body_failure", "request_upstream_failure", "nested_upstream_failure", "reasoning_upstream_failure"] as const) {
		await context.test(script, async () => {
			const backed = piAiBackedProvider([script, "success"]);
			const events: RuntimeEvent[] = [];
			const diagnostics: ProviderStreamDiagnostics[] = [];
			const delays: number[] = [];
			const result = await new ProviderAgentLoop().runStep({
				provider: backed.provider, request: providerRequest(), requestMaxRetries: 1, maxRetries: 1,
				signal: new AbortController().signal, toolCallsAllowed: true, normalizeFailure,
				emit: (event) => events.push(event), recordDiagnostic: (item) => diagnostics.push(item),
				sleep: async (ms) => { delays.push(ms); }, random: () => 0.5,
			});
			assert.ok(!("failure" in result));
			assert.equal(backed.attempts(), 2);
			assert.equal(result.assistantText, "done");
			assert.deepEqual(result.toolCalls, []);
			assert.deepEqual(delays, [2_000]);
			const retry = events.find((event) => event.type === "stream_retrying");
			assert.ok(retry?.type === "stream_retrying");
			assert.equal(retry.resetOutput, script !== "request_upstream_failure");
			assert.equal(retry.recoveryKind, script === "request_upstream_failure" ? "request" : "stream");
			assert.equal(events.filter((event) => event.type === "stream_recovered").length, 1);
			assert.equal(diagnostics[0]?.failure?.retryable, true);
			assert.equal(diagnostics[1]?.failure, undefined);
			if (script === "body_failure") {
				assert.equal(diagnostics[0]?.failure?.diagnostics?.transport_error_code, "UND_ERR_SOCKET");
			} else if (script === "nested_upstream_failure" || script === "reasoning_upstream_failure") {
				assert.match(retry.additionalDetails ?? "", /stream_read_error/u);
				assert.equal(diagnostics[0]?.failure?.diagnostics?.provider_error_code, "stream_read_error");
				assert.equal(diagnostics[0]?.failure?.diagnostics?.provider_error_type, "upstream_error");
				if (script === "reasoning_upstream_failure") {
					assert.equal(diagnostics[0]?.reasoningEventCount, 6);
					assert.equal(diagnostics[0]?.textEventCount, 0);
					assert.equal(diagnostics[0]?.providerEventCount, 6);
				}
			} else {
				assert.match(retry.additionalDetails ?? "", /upstream request failed/u);
				assert.match(diagnostics[0]?.failure?.additionalDetails ?? "", /upstream request failed/u);
			}
		});
	}
});

test("real pi-ai upstream exhaustion keeps the last safe reason and fatal errors never retry", async (context) => {
	for (const script of ["upstream_failure", "auth_failure", "nested_upstream_failure", "nested_auth_failure"] as const) {
		await context.test(script, async () => {
			const backed = piAiBackedProvider([script, script]);
			const result = await new ProviderAgentLoop().runStep({
				provider: backed.provider, request: providerRequest(), requestMaxRetries: 0, maxRetries: 1,
				signal: new AbortController().signal, toolCallsAllowed: true, normalizeFailure,
				emit: () => undefined, sleep: async () => undefined,
			});
			assert.ok("failure" in result);
			const fatal = script === "auth_failure" || script === "nested_auth_failure";
			assert.equal(result.failure.code, fatal ? "auth_error" : "retry_exhausted");
			assert.equal(backed.attempts(), fatal ? 1 : 2);
			assert.match(result.failure.additionalDetails ?? "", script.startsWith("nested_") ? /stream_read_error/u : /upstream request failed/u);
			assert.equal(result.failure.retryable, false);
		});
	}
});

function piAiBackedProvider(scripts: readonly PiAiAttempt[]) {
	let attempt = 0;
	const provider = new ProviderRegistry({
		fetch: async () => {
			const script = scripts[attempt++] ?? "request_failure";
			if (script === "request_upstream_failure") {
				return new Response("upstream request failed", { status: 502, headers: { "retry-after": "2" } });
			}
			if (script === "request_failure") {
				return new Response(JSON.stringify({
					error: { type: "server_error", message: "temporarily unavailable" },
				}), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
			let wire = (script === "reasoning_upstream_failure" ? responsesReasoningStream() : responsesStream(script === "success")) + (
				script === "upstream_failure" || script === "auth_failure"
					? `data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: {
						code: script === "auth_failure" ? "invalid_api_key" : "server_error",
						message: "upstream request failed",
					} } })}\n\n` : ""
			);
			if (script === "nested_upstream_failure" || script === "reasoning_upstream_failure" || script === "nested_auth_failure") {
				wire += [
					{ type: "error", sequence_number: 0, error: {
						code: "stream_read_error", message: "stream_read_error",
						type: script === "nested_auth_failure" ? "authentication_error" : "upstream_error",
					} },
					{ type: "response.failed", response: { id: "resp-failed", status: "failed", output: [],
						error: { code: "upstream_error", message: "Upstream request failed" } } },
				].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
			}
			let sent = false;
			const body = script === "body_failure" ? new ReadableStream<Uint8Array>({
				pull(controller): void {
					if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(wire)); }
					else controller.error(new TypeError("terminated", {
						cause: Object.assign(new Error("private transport state"), { code: "UND_ERR_SOCKET" }),
					}));
				},
			}, { highWaterMark: 0 }) : wire;
			return new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream", "retry-after": "2" },
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
	} else {
		frames.push({
			type: "response.output_item.added", output_index: 1,
			item: { type: "function_call", id: "fc-partial", call_id: "call-partial", name: "Write", arguments: "" },
		}, {
			type: "response.function_call_arguments.delta", output_index: 1,
			delta: '{"file_path":"must-not-write.txt","content":"partial"}',
		});
	}
	return `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}${
		completed ? "data: [DONE]\n\n" : ""
	}`;
}

function responsesReasoningStream(): string {
	return [
		{ type: "response.created", response: { id: "resp-reasoning", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0,
			item: { type: "reasoning", id: "rs-reasoning", summary: [] } },
		...Array.from({ length: 6 }, () => ({
			type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "thinking ",
		})),
	].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
}

function numberSequence(values: readonly number[]): () => number {
	let index = 0;
	return () => values[index++] ?? values.at(-1) ?? 0;
}
