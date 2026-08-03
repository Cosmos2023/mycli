import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ProviderEvent, ProviderRequest } from "@mycli/core";
import * as providers from "../src/index.ts";

type ChatCompletionsClient = {
	create: (
		request: Record<string, unknown>,
		options: { signal: AbortSignal },
	) => Promise<AsyncIterable<unknown>>;
};

type ChatProviderConstructor = new (options: { client: ChatCompletionsClient }) => {
	stream: (
		request: ProviderRequest,
		options: { signal: AbortSignal },
	) => AsyncIterable<ProviderEvent>;
};

test("maps a sanitized Chat stream into provider-neutral events", async () => {
	const ChatProvider = Reflect.get(providers, "ChatProvider") as ChatProviderConstructor | undefined;
	assert.equal(typeof ChatProvider, "function");
	const fixture = JSON.parse(await readFile(
		new URL("./fixtures/chat-stream.json", import.meta.url),
		"utf8",
	)) as unknown[];
	let capturedRequest: Record<string, unknown> | undefined;
	let capturedSignal: AbortSignal | undefined;
	const client: ChatCompletionsClient = {
		create: async (request, options) => {
			capturedRequest = request;
			capturedSignal = options.signal;
			return events(fixture);
		},
	};
	const controller = new AbortController();
	const provider = new ChatProvider!({ client });

	const result = await collect(provider.stream(request(), { signal: controller.signal }));

	assert.deepEqual(result, [
		{ type: "reasoning_delta", text: "checking" },
		{ type: "text_delta", text: "hello " },
		{ type: "text_delta", text: "world" },
		{
			type: "tool_call",
			callId: "call-1",
			name: "Read",
			argumentsJson: "{\"path\":\"README.md\"}",
		},
		{
			type: "usage",
			usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, cached_tokens: 4 },
		},
		{ type: "completed", responseId: "chatcmpl-1" },
	]);
	assert.equal(capturedSignal, controller.signal);
	assert.equal(capturedRequest?.stream, true);
	assert.deepEqual(capturedRequest?.stream_options, { include_usage: true });
	assert.equal(capturedRequest?.model, "gpt-test");
	assert.equal("tools" in (capturedRequest ?? {}), false);
	assert.deepEqual(capturedRequest?.messages, [
		{ role: "system", content: "You are mycli." },
		{ role: "user", content: "older question" },
		{ role: "assistant", content: "older answer" },
		{ role: "user", content: "current question" },
	]);
});

test("rejects a Chat stream that ends without a finish reason", async () => {
	const ChatProvider = Reflect.get(providers, "ChatProvider") as ChatProviderConstructor | undefined;
	assert.equal(typeof ChatProvider, "function");
	const client: ChatCompletionsClient = {
		create: async () => events([{
			id: "chatcmpl-incomplete",
			choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
		}]),
	};

	await assert.rejects(
		() => collect(new ChatProvider!({ client }).stream(request(), {
			signal: new AbortController().signal,
		})),
		(error: unknown) => error instanceof Error
			&& error.message === "provider_error: Chat stream ended without a finish reason",
	);
});

function request(): ProviderRequest {
	return {
		provider: "compatible",
		protocol: "chat_completions",
		model: "gpt-test",
		instructions: "You are mycli.",
		messages: [
			{ role: "user", content: "older question" },
			{ role: "assistant", content: "older answer" },
			{ role: "user", content: "current question" },
		],
		tools: [],
		maxOutputTokens: 64,
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
