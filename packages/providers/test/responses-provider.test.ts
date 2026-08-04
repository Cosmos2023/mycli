import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
	ProviderEvent,
	ProviderRequest,
	ToolDefinition,
} from "@mycli/core";
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

test("serializes Read for an initial Responses request", async () => {
	const ResponsesProvider = Reflect.get(providers, "ResponsesProvider") as ResponsesProviderConstructor | undefined;
	assert.equal(typeof ResponsesProvider, "function");
	let capturedRequest: Record<string, unknown> | undefined;
	const client: ResponsesClient = {
		create: async (body) => {
			capturedRequest = body;
			return events([completedResponse("resp-tools-1")]);
		},
	};

	await collect(new ResponsesProvider!({ client }).stream(toolRequest(), {
		signal: new AbortController().signal,
	}));

	assert.deepEqual(capturedRequest?.tools, [{
		type: "function",
		name: "Read",
		description: READ_TOOL.description,
		parameters: READ_TOOL.inputSchema,
		strict: true,
	}]);
	assert.deepEqual(capturedRequest?.input, [{ role: "user", content: "Read README.md" }]);
	assert.equal("previous_response_id" in (capturedRequest ?? {}), false);
});

test("serializes only trailing function outputs for a Responses continuation", async () => {
	const ResponsesProvider = Reflect.get(providers, "ResponsesProvider") as ResponsesProviderConstructor | undefined;
	assert.equal(typeof ResponsesProvider, "function");
	let capturedRequest: Record<string, unknown> | undefined;
	const client: ResponsesClient = {
		create: async (body) => {
			capturedRequest = body;
			return events([completedResponse("resp-tools-2")]);
		},
	};
	const continuation: ProviderRequest = {
		...toolRequest(),
		previousResponseId: "resp-tools-1",
		items: [
			{ type: "user", text: "Read README.md" },
			{
				type: "assistant_tool_calls",
				text: "",
				calls: [{
					callId: "call-1",
					name: "Read",
					argumentsJson: READ_ARGUMENTS,
				}],
				responseId: "resp-tools-1",
			},
			{
				type: "tool_result",
				callId: "call-1",
				toolName: "Read",
				output: READ_OUTPUT,
				success: true,
			},
		],
	};

	await collect(new ResponsesProvider!({ client }).stream(continuation, {
		signal: new AbortController().signal,
	}));

	assert.equal(capturedRequest?.previous_response_id, "resp-tools-1");
	assert.deepEqual(capturedRequest?.input, [{
		type: "function_call_output",
		call_id: "call-1",
		output: READ_OUTPUT,
	}]);
});

test("preserves assistant text alongside historical Responses tool calls", async () => {
	const ResponsesProvider = Reflect.get(providers, "ResponsesProvider") as ResponsesProviderConstructor | undefined;
	assert.equal(typeof ResponsesProvider, "function");
	let capturedRequest: Record<string, unknown> | undefined;
	const client: ResponsesClient = {
		create: async (body) => {
			capturedRequest = body;
			return events([completedResponse("resp-next")]);
		},
	};
	const historical: ProviderRequest = {
		...toolRequest(),
		items: [
			{ type: "user", text: "Read README.md" },
			{
				type: "assistant_tool_calls",
				text: "Checking the file.",
				calls: [{ callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS }],
			},
			{ type: "tool_result", callId: "call-1", toolName: "Read", output: READ_OUTPUT, success: true },
			{ type: "user", text: "What did it say?" },
		],
	};

	await collect(new ResponsesProvider!({ client }).stream(historical, {
		signal: new AbortController().signal,
	}));

	assert.deepEqual(capturedRequest?.input, [
		{ role: "user", content: "Read README.md" },
		{ role: "assistant", content: "Checking the file." },
		{ type: "function_call", call_id: "call-1", name: "Read", arguments: READ_ARGUMENTS },
		{ type: "function_call_output", call_id: "call-1", output: READ_OUTPUT },
		{ role: "user", content: "What did it say?" },
	]);
});

test("rejects a Responses tool call without a call id", async () => {
	const ResponsesProvider = Reflect.get(providers, "ResponsesProvider") as ResponsesProviderConstructor | undefined;
	assert.equal(typeof ResponsesProvider, "function");
	const client: ResponsesClient = {
		create: async () => events([{
			type: "response.output_item.done",
			item: { type: "function_call", name: "Read", arguments: READ_ARGUMENTS },
		}]),
	};

	await assert.rejects(
		() => collect(new ResponsesProvider!({ client }).stream(toolRequest(), {
			signal: new AbortController().signal,
		})),
		(error: unknown) => error instanceof Error
			&& error.message === "tool_protocol_error: Responses tool call is missing a call id",
	);
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
		},
		required: ["file_path", "offset", "limit"],
		additionalProperties: false,
	},
};

function toolRequest(): ProviderRequest {
	return {
		...request(),
		messages: [{ role: "user", content: "Read README.md" }],
		items: [{ type: "user", text: "Read README.md" }],
		tools: [READ_TOOL],
	};
}

function completedResponse(id: string): Record<string, unknown> {
	return { type: "response.completed", response: { id, usage: {} } };
}
