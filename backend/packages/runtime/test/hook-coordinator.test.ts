import assert from "node:assert/strict";
import test from "node:test";
import type { HookRunnerContract } from "@mycli/core";
import { HookCoordinator } from "../src/index.ts";

test("hook coordinator merges modifications and fails closed on pre-hook denial", async () => {
	let denied = false;
	const runner: HookRunnerContract = {
		run: async (input) => input.point === "pre_tool_use"
			? denied
				? [{ hookId: "guard", result: { action: "deny", message: "blocked" } }]
				: [
					{ hookId: "first", result: { action: "modify", arguments: { offset: 2 } } },
					{ hookId: "second", result: { action: "modify", arguments: { limit: 5 } } },
				]
			: [],
	};
	const coordinator = new HookCoordinator({
		runner,
		sessionId: "session-1",
		turnId: "turn-1",
	});

	const modified = await coordinator.beforeTool({
		callId: "call-1",
		name: "Read",
		argumentsJson: '{"file_path":"README.md","offset":1,"limit":20}',
	}, new AbortController().signal);
	denied = true;
	const blocked = await coordinator.beforeTool({
		callId: "call-2",
		name: "Read",
		argumentsJson: "{}",
	}, new AbortController().signal);

	assert.equal(modified.status, "allow");
	assert.deepEqual(JSON.parse(modified.call.argumentsJson), {
		file_path: "README.md",
		offset: 2,
		limit: 5,
	});
	assert.deepEqual(blocked, {
		status: "deny",
		call: { callId: "call-2", name: "Read", argumentsJson: "{}" },
		errorKind: "tool_denied_by_hook",
		message: "blocked",
		contexts: [],
	});
});

test("hook coordinator contains post-hook failure after tool completion", async () => {
	const runner: HookRunnerContract = {
		run: async (input) => {
			if (input.point === "post_tool_use") throw new Error("private hook failure");
			return [];
		},
	};
	const coordinator = new HookCoordinator({ runner, sessionId: "session-1", turnId: "turn-1" });

	const result = await coordinator.afterTool({
		callId: "call-1",
		name: "Read",
		argumentsJson: "{}",
	}, {
		callId: "call-1",
		toolName: "Read",
		success: true,
		modelOutput: "contents",
		summary: "Read file",
		metadata: {},
	}, new AbortController().signal);

	assert.deepEqual(result, { contexts: [], failed: true });
});
