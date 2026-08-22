import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent, ProviderRequest, RuntimeEvent } from "@mycli/core";
import { ProviderFailure } from "@mycli/providers";
import {
	ProviderAgentLoop,
	type ProviderAgentLoopFailure,
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
		responseId: "response-1",
	});
	assert.deepEqual(emitted.map((event) => event.type), ["text_delta", "message_complete"]);
});

test("ProviderAgentLoop retries only before observing provider output", async () => {
	const observed: ProviderRequest[] = [];
	const emitted: RuntimeEvent[] = [];
	let sleeps = 0;
	const result = await new ProviderAgentLoop().runStep({
		provider: scriptedProvider(observed, [
			new ProviderFailure({ code: "provider_error", message: "temporary", retryable: true }),
			[{ type: "completed", responseId: "response-2" }],
		]),
		request: providerRequest(),
		maxRetries: 1,
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
});

test("ProviderAgentLoop fails a stream that ends without completion", async () => {
	const result = await new ProviderAgentLoop().runStep({
		provider: scriptedProvider([], [[{ type: "text_delta", text: "partial" }]]),
		request: providerRequest(),
		maxRetries: 0,
		signal: new AbortController().signal,
		toolCallsAllowed: false,
		emit: () => undefined,
		normalizeFailure,
	});

	assert.equal("failure" in result ? result.failure.code : undefined, "provider_error");
	assert.equal("failure" in result ? result.eventsObserved : undefined, 1);
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
		maxRetries: 0,
		signal: new AbortController().signal,
		toolCallsAllowed: false,
		emit: () => undefined,
		normalizeFailure,
	});

	assert.deepEqual(result, {
		failure: {
			code: "unsupported_capability",
			message: "unsupported_capability: provider requested an unsupported capability",
			retryable: false,
		},
		eventsObserved: 1,
	});
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
		return {
			code: error.code,
			message: error.message,
			retryable: error.retryable,
		};
	}
	return { code: "provider_error", message: "provider failed", retryable: false };
}
