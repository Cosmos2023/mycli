import assert from "node:assert/strict";
import test from "node:test";
import type { HookRunnerContract, RuntimeEvent } from "@mycli/core";
import { HookCoordinator } from "../../src/index.ts";

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

test("slow and failed non-tool hooks publish owned lifecycle feedback", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let reject!: (error: Error) => void;
	const events: RuntimeEvent[] = [];
	const coordinator = new HookCoordinator({ sessionId: "s", turnId: "t", emit: (event) => events.push(event),
		runner: { run: async () => new Promise((_, fail) => { reject = fail; }) },
	});
	const pending = coordinator.runPoint("stop", {}, new AbortController().signal);
	assert.equal(events.length, 0);
	t.mock.timers.tick(200);
	assert.equal(events[0]?.type, "hook_started");
	reject(new Error("private exception payload"));
	const result = await pending;
	assert.equal(result.failed, true);
	assert.equal(events[1]?.type, "hook_completed");
	assert.equal(Reflect.get(events[0]!, "operationId"), Reflect.get(events[1]!, "operationId"));
	assert.equal(Reflect.get(events[1]!, "status"), "failed");
	assert.doesNotMatch(JSON.stringify(events), /private exception payload/);
	t.mock.timers.tick(1000);
	assert.equal(events.length, 2);
});
