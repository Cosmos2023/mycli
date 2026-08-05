import assert from "node:assert/strict";
import test from "node:test";
import type {
	ChildTaskStatus,
	HookExecution,
	HookInvocation,
	HookRunnerContract,
} from "../src/extensions.ts";

test("hook and child-task contracts remain provider-neutral", async () => {
	const invocation: HookInvocation = {
		point: "pre_tool_use",
		sessionId: "session-1",
		turnId: "turn-1",
		toolName: "Read",
		arguments: { file_path: "README.md" },
		metadata: {},
	};
	const executions: readonly HookExecution[] = [{
		hookId: "builtin:read-guard",
		result: { action: "allow", additionalContexts: ["bounded context"] },
	}];
	const runner: HookRunnerContract = {
		run: async () => executions,
	};
	const status: ChildTaskStatus = "queued";

	assert.deepEqual(await runner.run(invocation, new AbortController().signal), executions);
	assert.equal(status, "queued");
});
