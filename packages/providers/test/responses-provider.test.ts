import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ProviderEvent, ProviderRequest } from "@mycli/core";
import * as providers from "../src/index.ts";

type ResponsesClient = {
	create: (
		request: Record<string, unknown>,
		options: { signal: AbortSignal },
	) => Promise<AsyncIterable<unknown>>;
};

type ResponsesProviderConstructor = new (options: { client: ResponsesClient }) => {
	stream: (
		request: ProviderRequest,
		options: { signal: AbortSignal },
	) => AsyncIterable<ProviderEvent>;
};

test("maps a sanitized Responses stream into provider-neutral events", async () => {
	const ResponsesProvider = Reflect.get(providers, "ResponsesProvider") as ResponsesProviderConstructor | undefined;
	assert.equal(typeof ResponsesProvider, "function");
	const fixture = JSON.parse(await readFile(
		new URL("./fixtures/responses-stream.json", import.meta.url),
		"utf8",
	)) as unknown[];
	let capturedRequest: Record<string, unknown> | undefined;
	let capturedSignal: AbortSignal | undefined;
	const client: ResponsesClient = {
		create: async (request, options) => {
			capturedRequest = request;
			capturedSignal = options.signal;
			return events(fixture);
		},
	};
	const controller = new AbortController();
	const provider = new ResponsesProvider!({ client });

	const result = await collect(provider.stream(request(), { signal: controller.signal }));

	assert.deepEqual(result, [
		{ type: "reasoning_delta", text: "checking" },
		{ type: "text_delta", text: "hello" },
		{
			type: "usage",
			usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, cached_tokens: 4 },
		},
		{ type: "completed", responseId: "resp_1" },
	]);
	assert.equal(capturedSignal, controller.signal);
	assert.equal(capturedRequest?.stream, true);
	assert.equal(capturedRequest?.model, "gpt-test");
	assert.equal("tools" in (capturedRequest ?? {}), false);
});

test("surfaces a provider tool call without executing it", async () => {
	const ResponsesProvider = Reflect.get(providers, "ResponsesProvider") as ResponsesProviderConstructor | undefined;
	assert.equal(typeof ResponsesProvider, "function");
	const client: ResponsesClient = {
		create: async () => events([{
			type: "response.output_item.done",
			item: {
				type: "function_call",
				call_id: "call_1",
				name: "Read",
				arguments: "{\"path\":\"README.md\"}",
			},
		}]),
	};

	assert.deepEqual(await collect(new ResponsesProvider!({ client }).stream(request(), {
		signal: new AbortController().signal,
	})), [{
		type: "tool_call",
		callId: "call_1",
		name: "Read",
		argumentsJson: "{\"path\":\"README.md\"}",
	}]);
});

test("rejects malformed Responses events with a stable provider failure", async () => {
	const ResponsesProvider = Reflect.get(providers, "ResponsesProvider") as ResponsesProviderConstructor | undefined;
	assert.equal(typeof ResponsesProvider, "function");
	const client: ResponsesClient = { create: async () => events(["not-an-event"]) };

	await assert.rejects(
		() => collect(new ResponsesProvider!({ client }).stream(request(), {
			signal: new AbortController().signal,
		})),
		(error: unknown) => error instanceof Error
			&& error.message === "provider_error: malformed Responses stream event",
	);
});

function request(): ProviderRequest {
	return {
		provider: "openai",
		protocol: "responses",
		model: "gpt-test",
		instructions: "You are mycli.",
		messages: [{ role: "user", content: "hello" }],
		tools: [],
		reasoningEffort: "medium",
		maxOutputTokens: 64,
		promptCacheKey: "cache-key",
	};
}

async function* events(items: readonly unknown[]): AsyncIterable<unknown> {
	for (const item of items) {
		yield item;
	}
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
	const collected: ProviderEvent[] = [];
	for await (const event of stream) {
		collected.push(event);
	}
	return collected;
}
