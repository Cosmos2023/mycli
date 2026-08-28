import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ProviderEvent, ProviderRequest } from "@mycli/core";
import {
	AnthropicProvider,
	type AnthropicMessagesClient,
} from "../src/anthropic-provider.ts";
import { ProviderFailure } from "../src/errors.ts";

test("serializes Anthropic system, images, tools, signed thinking, and correlated results", async () => {
	let captured: Readonly<Record<string, unknown>> | undefined;
	const client: AnthropicMessagesClient = {
		stream: async (body) => {
			captured = body;
			return events([
				{ type: "message_start", message: { id: "msg-final", usage: { input_tokens: 2 } } },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			]);
		},
	};
	const provider = new AnthropicProvider({ client });
	const request = anthropicRequest({
		developerInstructions: ["Use the child role."],
		items: [
			{
				type: "user",
				text: "describe",
				images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
			},
			{
				type: "assistant_tool_calls",
				text: "",
				calls: [{ callId: "toolu-1", name: "Read", argumentsJson: "{}" }],
				providerState: {
					provider: "anthropic",
					value: {
						thinkingBlocks: [{ thinking: "checked", signature: "sig-test" }],
					},
				},
			},
			{
				type: "tool_result",
				callId: "toolu-1",
				toolName: "Read",
				output: "file contents",
				success: true,
			},
		],
	});

	await collect(provider.stream(request, { signal: new AbortController().signal }));

	assert.deepEqual(captured?.system, [
		{ type: "text", text: "system instructions" },
		{
			type: "text",
			text: "Use the child role.",
			cache_control: { type: "ephemeral" },
		},
	]);
	const messages = captured?.messages as readonly Readonly<Record<string, unknown>>[];
	assert.deepEqual(messages[0], {
		role: "user",
		content: [
			{ type: "text", text: "describe", cache_control: { type: "ephemeral" } },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
		],
	});
	assert.deepEqual(messages[1], {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "checked", signature: "sig-test" },
			{
				type: "tool_use",
				id: "toolu-1",
				name: "Read",
				input: {},
				cache_control: { type: "ephemeral" },
			},
		],
	});
	assert.deepEqual(messages.at(-1), {
		role: "user",
		content: [{
			type: "tool_result",
			tool_use_id: "toolu-1",
			content: "file contents",
			cache_control: { type: "ephemeral" },
		}],
	});
	assert.equal(captured?.stream, true);
	assert.equal(captured?.max_tokens, 4096);
	assert.deepEqual(captured?.tools, [{
		name: "Read",
		description: "Read a file.",
		input_schema: request.tools[0]?.inputSchema,
	}]);
});

test("maps Anthropic thinking, partial tool JSON, usage, and replay state", async () => {
	const fixture = JSON.parse(await readFile(
		new URL("./fixtures/anthropic-stream.json", import.meta.url),
		"utf8",
	)) as readonly unknown[];
	const provider = new AnthropicProvider({
		client: { stream: async () => events(fixture) },
	});

	const result = await collect(provider.stream(anthropicRequest(), {
		signal: new AbortController().signal,
	}));

	assert.deepEqual(result, [
		{ type: "reasoning_delta", text: "checked" },
		{ type: "text_delta", text: "Inspecting." },
		{
			type: "tool_call",
			callId: "toolu-1",
			name: "Read",
			argumentsJson: "{\"file_path\":\"README.md\"}",
		},
		{
			type: "tool_call",
			callId: "toolu-2",
			name: "Read",
			argumentsJson: "{\"file_path\":\"package.json\"}",
		},
		{
			type: "provider_state",
			state: {
				provider: "anthropic",
				value: { thinkingBlocks: [{ thinking: "checked", signature: "sig-test" }] },
			},
		},
		{
			type: "usage",
			usage: {
				input_tokens: 10,
				output_tokens: 7,
				cache_creation_input_tokens: 2,
				cache_read_input_tokens: 3,
			},
		},
		{ type: "completed", responseId: "msg-fixture" },
	]);
});

test("bounds Anthropic cache control to four wire-only breakpoints", async () => {
	let captured: Readonly<Record<string, unknown>> | undefined;
	const provider = new AnthropicProvider({
		client: {
			stream: async (body) => {
				captured = body;
				return events([
					{ type: "message_start", message: { id: "msg-cache", usage: {} } },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
					{ type: "message_stop" },
				]);
			},
		},
	});
	const items = Array.from({ length: 6 }, (_, index) => ({
		type: index % 2 === 0 ? "user" as const : "assistant" as const,
		text: `message-${index}`,
	}));
	const request = anthropicRequest({ items });
	const original = JSON.stringify(request.items);

	await collect(provider.stream(request, { signal: new AbortController().signal }));

	assert.equal(countCacheControls(captured), 4);
	assert.equal(JSON.stringify(request.items), original);
});

test("preserves contextual-user authority and promotes developer context to Anthropic system", async () => {
	let captured: Readonly<Record<string, unknown>> | undefined;
	const provider = new AnthropicProvider({
		client: {
			stream: async (body) => {
				captured = body;
				return events([
					{ type: "message_start", message: { id: "msg-authority", usage: {} } },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
					{ type: "message_stop" },
				]);
			},
		},
	});

	await collect(provider.stream(anthropicRequest({
		developerInstructions: ["durable policy"],
		cacheControlEnabled: false,
		items: [
			contextItem("workspace reference"),
			contextItem("trusted hook policy", "developer"),
			{ type: "user", text: "current intent" },
		],
	}), { signal: new AbortController().signal }));

	assert.deepEqual(captured?.system, [
		{ type: "text", text: "system instructions" },
		{ type: "text", text: "durable policy" },
		{ type: "text", text: "trusted hook policy" },
	]);
	assert.deepEqual(captured?.messages, [{
		role: "user",
		content: [
			{ type: "text", text: "workspace reference" },
			{ type: "text", text: "current intent" },
		],
	}]);
});

test("keeps ordinary Anthropic wire messages as an exact prefix", async () => {
	const captured: Readonly<Record<string, unknown>>[] = [];
	const provider = new AnthropicProvider({
		client: {
			stream: async (body) => {
				captured.push(body);
				return events([
					{ type: "message_start", message: { id: `msg-prefix-${captured.length}`, usage: {} } },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
					{ type: "message_stop" },
				]);
			},
		},
	});
	const firstItems = [
		{ type: "user" as const, text: "U1" },
		{ type: "assistant" as const, text: "A1" },
		{ type: "user" as const, text: "U2" },
		{ type: "assistant" as const, text: "A2" },
	];

	await collect(provider.stream(anthropicRequest({ items: firstItems }), {
		signal: new AbortController().signal,
	}));
	await collect(provider.stream(anthropicRequest({
		items: [
			...firstItems,
			contextItem("workspace reference"),
			{ type: "user", text: "U3" },
		],
	}), { signal: new AbortController().signal }));

	assert.deepEqual(captured[1]?.system, captured[0]?.system);
	const firstMessages = captured[0]?.messages as readonly unknown[];
	const secondMessages = captured[1]?.messages as readonly unknown[];
	assert.deepEqual(secondMessages.slice(0, firstMessages.length), firstMessages);
});

test("rejects uncorrelated results, max-token stops, cancellation, and malformed events", async (t) => {
	await t.test("uncorrelated tool result", async () => {
		const provider = new AnthropicProvider({ client: { stream: async () => events([]) } });
		await assert.rejects(() => collect(provider.stream(anthropicRequest({
			items: [{
				type: "tool_result",
				callId: "missing",
				toolName: "Read",
				output: "nope",
				success: false,
			}],
		}), { signal: new AbortController().signal })), /tool result has no matching Anthropic tool use/);
	});

	await t.test("max tokens", async () => {
		const provider = new AnthropicProvider({
			client: { stream: async () => events([
				{ type: "message_start", message: { id: "msg-max", usage: {} } },
				{ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: {} },
			]) },
		});
		await assert.rejects(() => collect(provider.stream(anthropicRequest(), {
			signal: new AbortController().signal,
		})), /provider_error: provider output token limit reached/);
	});

	await t.test("cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		const provider = new AnthropicProvider({ client: { stream: async () => events([]) } });
		await assert.rejects(() => collect(provider.stream(anthropicRequest(), {
			signal: controller.signal,
		})), /interrupted: provider request interrupted/);
	});

	await t.test("malformed event", async () => {
		const provider = new AnthropicProvider({
			client: { stream: async () => events([{ type: "unknown_event", secret: "hidden" }]) },
		});
		await assert.rejects(() => collect(provider.stream(anthropicRequest(), {
			signal: new AbortController().signal,
		})), /provider_error: unsupported Anthropic stream event/);
	});

	await t.test("missing message start", async () => {
		const provider = new AnthropicProvider({
			client: { stream: async () => events([
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
				{ type: "message_stop" },
			]) },
		});
		await assert.rejects(() => collect(provider.stream(anthropicRequest(), {
			signal: new AbortController().signal,
		})), (error: unknown) => error instanceof ProviderFailure
			&& error.message === "response_stream_error: Anthropic stream ended without completion"
			&& error.retryable);
	});
});

function anthropicRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
	return {
		provider: "anthropic",
		protocol: "anthropic_messages",
		model: "claude-test",
		instructions: "system instructions",
		messages: [{ role: "user", content: "hello" }],
		items: [{ type: "user", text: "hello" }],
		tools: [{
			id: "builtin:Read",
			name: "Read",
			description: "Read a file.",
			inputSchema: {
				type: "object",
				properties: { file_path: { type: "string" } },
				required: ["file_path"],
				additionalProperties: false,
			},
		}],
		maxOutputTokens: 4096,
		cacheControlEnabled: true,
		...overrides,
	};
}

function contextItem(text: string, role?: "developer" | "user") {
	return {
		type: "context" as const,
		text,
		metadata: {
			kind: "hook_context" as const,
			...(role ? { role } : {}),
			cacheClass: "ephemeral" as const,
			durability: "persistent" as const,
			scope: "turn" as const,
			sourceId: `hook-${role ?? "user"}`,
			contentSha256: "a".repeat(64),
			contentLength: text.length,
		},
	};
}

async function* events(values: readonly unknown[]): AsyncIterable<unknown> {
	for (const value of values) yield value;
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
	const result: ProviderEvent[] = [];
	for await (const event of stream) result.push(event);
	return result;
}

function countCacheControls(value: unknown): number {
	if (Array.isArray(value)) return value.reduce((total, item) => total + countCacheControls(item), 0);
	if (typeof value !== "object" || value === null) return 0;
	return Object.entries(value).reduce(
		(total, [key, item]) => total + (key === "cache_control" ? 1 : countCacheControls(item)),
		0,
	);
}
