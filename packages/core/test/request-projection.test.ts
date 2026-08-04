import assert from "node:assert/strict";
import test from "node:test";
import * as core from "../src/index.ts";

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
