import assert from "node:assert/strict";
import test from "node:test";
import { projectNoToolRequest } from "../src/index.ts";

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
