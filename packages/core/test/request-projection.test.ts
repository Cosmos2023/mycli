import assert from "node:assert/strict";
import test from "node:test";
import * as core from "../src/index.ts";
import type { CanonicalConversationItem } from "../src/index.ts";

const projectNoToolRequest = core.projectNoToolRequest;

test("projects a no-tool Responses request with current intent last", () => {
	const request = projectNoToolRequest({
		config: {
			provider: "openai",
			protocol: "responses",
			model: "gpt-test",
			reasoningEffort: "medium",
			maxOutputTokens: 128,
		},
		instructions: "You are mycli.",
		history: [
			{ role: "user", content: "earlier" },
			{ role: "assistant", content: "earlier answer" },
		],
		userText: "current",
	});

	assert.equal(request.protocol, "responses");
	assert.equal(request.instructions, "You are mycli.");
	assert.deepEqual(request.messages.at(-1), { role: "user", content: "current" });
	assert.equal(request.messages.filter((item) => item.content === "current").length, 1);
	assert.deepEqual(request.tools, []);
});

test("Chat and Responses use the same canonical message timeline", () => {
	const base = {
		provider: "openai" as const,
		model: "gpt-test",
	};
	const input = {
		instructions: "You are mycli.",
		history: [{ role: "assistant" as const, content: "prior" }],
		userText: "current",
	};

	const responses = projectNoToolRequest({
		...input,
		config: { ...base, protocol: "responses" },
	});
	const chat = projectNoToolRequest({
		...input,
		config: { ...base, protocol: "chat_completions" },
	});

	assert.deepEqual(chat.messages, responses.messages);
	assert.deepEqual(chat.tools, responses.tools);
});

test("projects ordered tool definitions and canonical tool transcript items", () => {
	const projectProviderRequest = Reflect.get(core, "projectProviderRequest") as unknown as
		| ((input: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>)
		| undefined;
	assert.equal(typeof projectProviderRequest, "function");
	const readTool = {
		id: "builtin:Read",
		name: "Read",
		description: "Read a bounded file range.",
		inputSchema: {
			type: "object",
			properties: { file_path: { type: "string" } },
			required: ["file_path"],
			additionalProperties: false,
		},
	};
	const history = [
		{ type: "user", text: "Read README.md" },
		{
			type: "assistant_tool_calls",
			text: "",
			calls: [{
				callId: "call-1",
				name: "Read",
				argumentsJson: "{\"file_path\":\"README.md\",\"offset\":1,\"limit\":20}",
			}],
			responseId: "resp-1",
		},
		{
			type: "tool_result",
			callId: "call-1",
			toolName: "Read",
			output: "Read succeeded",
			success: true,
		},
	] as const;

	const request = projectProviderRequest!({
		config: {
			provider: "openai",
			protocol: "responses",
			model: "gpt-test",
		},
		instructions: "You are mycli.",
		history,
		tools: [readTool],
		previousResponseId: "resp-1",
	});

	assert.deepEqual(request.tools, [readTool]);
	assert.deepEqual(request.items, history);
	assert.equal(request.previousResponseId, "resp-1");
});

test("orders compacted replay, rehydration, memory, current input, and steers", () => {
	const projectProviderRequest = core.projectProviderRequest;
	const durableHistory = Object.freeze([
		{ type: "user" as const, text: "[compact-summary]\nsummary" },
		{ type: "assistant" as const, text: "retained answer" },
	]);
	const fragments = {
		compactedSummary: durableHistory.slice(0, 1),
		retainedTail: durableHistory.slice(1),
		rehydration: [{ type: "user" as const, text: "[rehydration]\nREADME.md" }],
		memory: [{ type: "user" as const, text: "<memory-reference>workspace</memory-reference>" }],
		currentInput: { type: "user" as const, text: "current request" },
		steers: [{ type: "user" as const, text: "steer-q1" }],
	};
	const config = {
		provider: "openai" as const,
		model: "gpt-test",
	};

	const responses = projectProviderRequest({
		config: { ...config, protocol: "responses" },
		instructions: "You are mycli.",
		fragments,
		tools: [],
	});
	const chat = projectProviderRequest({
		config: { ...config, protocol: "chat_completions" },
		instructions: "You are mycli.",
		fragments,
		tools: [],
	});

	assert.deepEqual(responses.items?.map(itemText), [
		"[compact-summary]\nsummary",
		"retained answer",
		"[rehydration]\nREADME.md",
		"<memory-reference>workspace</memory-reference>",
		"current request",
		"steer-q1",
	]);
	assert.deepEqual(chat.items, responses.items);
	assert.equal(responses.items?.filter((item) => itemText(item) === "current request").length, 1);
	assert.deepEqual(durableHistory.map(itemText), [
		"[compact-summary]\nsummary",
		"retained answer",
	]);
});

test("preserves tool call and result order across request fragments", () => {
	const calls = [{
		callId: "call-1",
		name: "Read",
		argumentsJson: "{\"file_path\":\"README.md\"}",
	}];
	const request = core.projectProviderRequest({
		config: {
			provider: "openai",
			protocol: "responses",
			model: "gpt-test",
		},
		instructions: "You are mycli.",
		fragments: {
			retainedTail: [
				{ type: "assistant_tool_calls", text: "checking", calls },
				{
					type: "tool_result",
					callId: "call-1",
					toolName: "Read",
					output: "contents",
					success: true,
				},
			],
			currentInput: { type: "user", text: "continue" },
		},
		tools: [],
	});

	assert.deepEqual(request.items?.map((item) => item.type), [
		"assistant_tool_calls",
		"tool_result",
		"user",
	]);
});

function itemText(item: CanonicalConversationItem): string {
	switch (item.type) {
		case "user":
		case "assistant":
		case "assistant_tool_calls":
			return item.text;
		case "tool_result":
			return item.output;
	}
}
