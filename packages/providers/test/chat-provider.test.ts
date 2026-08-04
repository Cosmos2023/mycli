import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
	ProviderEvent,
	ProviderRequest,
	ToolDefinition,
} from "@mycli/core";
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

test("serializes optional file-tool parameters without strict mode for Chat continuation", async () => {
	const ChatProvider = Reflect.get(providers, "ChatProvider") as ChatProviderConstructor | undefined;
	assert.equal(typeof ChatProvider, "function");
	let capturedRequest: Record<string, unknown> | undefined;
	const client: ChatCompletionsClient = {
		create: async (body) => {
			capturedRequest = body;
			return events([{
				id: "chatcmpl-final",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			}]);
		},
	};

	await collect(new ChatProvider!({ client }).stream(toolRequest(), {
		signal: new AbortController().signal,
	}));

	assert.deepEqual(capturedRequest?.tools, FILE_TOOLS.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema,
		},
	})));
	assert.equal(JSON.stringify(capturedRequest?.tools).includes("strict"), false);
	assert.deepEqual(capturedRequest?.messages, [
		{ role: "system", content: "You are mycli." },
		{ role: "user", content: "Read README.md" },
		{
			role: "assistant",
			content: "",
			tool_calls: [{
				id: "call-1",
				type: "function",
				function: { name: "Read", arguments: READ_ARGUMENTS },
			}],
		},
		{ role: "tool", tool_call_id: "call-1", content: READ_OUTPUT },
	]);
});

test("decodes an Edit tool call with its provider call id", async () => {
	const ChatProvider = Reflect.get(providers, "ChatProvider") as ChatProviderConstructor | undefined;
	assert.equal(typeof ChatProvider, "function");
	const client: ChatCompletionsClient = {
		create: async () => events([{
			id: "chatcmpl-edit",
			choices: [{
				index: 0,
				delta: { tool_calls: [{
					index: 0,
					id: "call-edit",
					function: {
						name: "Edit",
						arguments: "{\"file_path\":\"a.ts\",\"old_string\":\"1\",\"new_string\":\"2\"}",
					},
				}] },
				finish_reason: "tool_calls",
			}],
		}]),
	};

	const result = await collect(new ChatProvider!({ client }).stream(toolRequest(), {
		signal: new AbortController().signal,
	}));

	assert.deepEqual(result[0], {
		type: "tool_call",
		callId: "call-edit",
		name: "Edit",
		argumentsJson: "{\"file_path\":\"a.ts\",\"old_string\":\"1\",\"new_string\":\"2\"}",
	});
});

test("rejects a completed Chat tool call without a call id", async () => {
	const ChatProvider = Reflect.get(providers, "ChatProvider") as ChatProviderConstructor | undefined;
	assert.equal(typeof ChatProvider, "function");
	const client: ChatCompletionsClient = {
		create: async () => events([{
			id: "chatcmpl-tool",
			choices: [{
				index: 0,
				delta: { tool_calls: [{ index: 0, function: {
					name: "Read", arguments: READ_ARGUMENTS,
				} }] },
				finish_reason: "tool_calls",
			}],
		}]),
	};

	await assert.rejects(
		() => collect(new ChatProvider!({ client }).stream(toolRequest(), {
			signal: new AbortController().signal,
		})),
		(error: unknown) => error instanceof Error
			&& error.message === "tool_protocol_error: Chat tool call is missing a call id",
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

const READ_ARGUMENTS = "{\"file_path\":\"README.md\",\"offset\":1,\"limit\":20}";
const READ_OUTPUT = "Read succeeded\nPath: README.md";
const READ_TOOL: ToolDefinition = {
	id: "builtin:Read",
	name: "Read",
	description: "Read a bounded file range from the workspace.",
	inputSchema: {
		type: "object",
		properties: {
			file_path: { type: "string" },
			offset: { type: "integer" },
			limit: { type: "integer" },
			pages: { type: "string" },
		},
		required: ["file_path", "offset", "limit"],
		additionalProperties: false,
	},
};

const EDIT_TOOL = exactReplacementTool("Edit");
const PATCH_TOOL = exactReplacementTool("Patch");
const WRITE_TOOL: ToolDefinition = {
	id: "builtin:Write",
	name: "Write",
	description: "Write complete UTF-8 text content to a workspace file.",
	inputSchema: {
		type: "object",
		properties: {
			file_path: { type: "string" },
			content: { type: "string" },
			expected_sha256: { type: "string" },
		},
		required: ["file_path", "content"],
		additionalProperties: false,
	},
};
const FILE_TOOLS = [READ_TOOL, EDIT_TOOL, PATCH_TOOL, WRITE_TOOL] as const;

function toolRequest(): ProviderRequest {
	return {
		...request(),
		items: [
			{ type: "user", text: "Read README.md" },
			{
				type: "assistant_tool_calls",
				text: "",
				calls: [{ callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS }],
				responseId: "chatcmpl-tool",
			},
			{
				type: "tool_result",
				callId: "call-1",
				toolName: "Read",
				output: READ_OUTPUT,
				success: true,
			},
		],
		tools: FILE_TOOLS,
	};
}

function exactReplacementTool(name: "Edit" | "Patch"): ToolDefinition {
	return {
		id: `builtin:${name}`,
		name,
		description: `${name} a recently read workspace file.`,
		inputSchema: {
			type: "object",
			properties: {
				file_path: { type: "string" },
				old_string: { type: "string" },
				new_string: { type: "string" },
				replace_all: { type: "boolean" },
			},
			required: ["file_path", "old_string", "new_string"],
			additionalProperties: false,
		},
	};
}
