import assert from "node:assert/strict";
import test from "node:test";
import * as tools from "../../src/index.ts";

test("AskUserQuestion returns a bounded pending clarification with implicit Other", async () => {
	const AskUserQuestionTool = Reflect.get(tools, "AskUserQuestionTool") as
		| (new () => AskUserQuestionAdapter)
		| undefined;
	assert.equal(typeof AskUserQuestionTool, "function", "AskUserQuestionTool must be exported");
	const adapter = new AskUserQuestionTool!();
	const result = await adapter.execute({
		question: "Which runtime should own startup?",
		options: [
			{ label: "Node", description: "Use the Node composition root" },
			{ label: "Python", description: "Keep the sidecar" },
		],
		header: "Runtime",
		multi_select: false,
	});

	assert.equal(result.success, true);
	assert.equal(result.summary, "Awaiting user response");
	assert.equal(result.modelOutput.includes("Which runtime"), false);
	assert.deepEqual(result.metadata, {
		status: "awaiting_user_response",
		question: "Which runtime should own startup?",
		options: [
			{ label: "Node", description: "Use the Node composition root" },
			{ label: "Python", description: "Keep the sidecar" },
			{ label: "Other", description: "Custom answer" },
		],
		header: "Runtime",
		multi_select: false,
	});
});

test("AskUserQuestion rejects malformed question and option payloads", async () => {
	const AskUserQuestionTool = Reflect.get(tools, "AskUserQuestionTool") as
		| (new () => AskUserQuestionAdapter)
		| undefined;
	assert.equal(typeof AskUserQuestionTool, "function", "AskUserQuestionTool must be exported");
	const adapter = new AskUserQuestionTool!();
	for (const input of [
		{ question: "", options: [{ label: "A" }, { label: "B" }] },
		{ question: "Choose", options: [{ label: "Only" }] },
		{ question: "Choose", options: [{ label: "" }, { label: "B" }] },
	] as const) {
		const result = await adapter.execute(input);
		assert.equal(result.success, false);
		assert.equal(result.errorKind, "invalid_arguments");
		assert.equal(JSON.stringify(result).includes("Choose"), false);
	}
});

interface AskUserQuestionAdapter {
	execute(input: Readonly<Record<string, unknown>>): Promise<{
		readonly success: boolean;
		readonly summary: string;
		readonly modelOutput: string;
		readonly errorKind?: string;
		readonly metadata: Readonly<Record<string, unknown>>;
	}>;
}
