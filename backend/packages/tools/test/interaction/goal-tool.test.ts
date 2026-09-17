import assert from "node:assert/strict";
import test from "node:test";
import { legacyToolReason } from "@mycli/contracts";
import { GoalStateError } from "@mycli/core";
import { GoalTool, type GoalToolService } from "../../src/interaction/goal-tool.ts";
import type { ToolExecutionOptions } from "../../src/types.ts";

const options: ToolExecutionOptions = {
	ownerSessionId: "session", ownerTurnId: "turn", callId: "call",
	signal: new AbortController().signal, publishLifecycle: () => {},
};

test("goal tools reject foreign owners and cancelled calls before touching state", async () => {
	const service: GoalToolService = {
		inspect: () => assert.fail("must not read foreign state"),
		create: () => assert.fail("must not create"), updateFromTool: () => assert.fail("must not update"),
	};
	for (const execution of [undefined, { ...options, ownerSessionId: "foreign" }, { ...options, signal: AbortSignal.abort() }]) {
		const result = await new GoalTool("get", "session", service).execute({}, execution);
		assert.equal(result.success, false);
		assert.equal(result.metadata.goal_error_code, "goal_authority_required");
	}
});

test("goal domain failures retain actionable messages and use established error categories", async () => {
	for (const [code, kind] of [["goal_blocked_too_early", "invalid_arguments"], ["goal_changed", "interrupted"]]) {
		const result = await new GoalTool("update", "session", {
			inspect: () => null, create: () => assert.fail(),
			updateFromTool: () => { throw new GoalStateError(code!, "Read the current goal before retrying."); },
		}).execute({ status: "blocked" }, options);
		assert.equal(result.success, false);
		assert.equal(result.errorKind, kind);
		assert.notEqual(legacyToolReason(result.errorKind), "tool.failure_unclassified");
		assert.equal(result.metadata.goal_error_code, code);
		assert.match(result.modelOutput, /Read the current goal/);
	}
});

test("goal tools leave persistence failures to the runtime recovery boundary", async () => {
	const failure = new Error("store unavailable");
	const tool = new GoalTool("create", "session", {
		inspect: () => null, updateFromTool: () => assert.fail(), create: () => { throw failure; },
	});
	await assert.rejects(tool.execute({ objective: "Finish" }, options), (error: unknown) => error === failure);
});
