import assert from "node:assert/strict";
import test from "node:test";
import { UpdatePlanTool } from "../../src/index.ts";

test("update_plan returns one structured full-plan effect", async () => {
	const result = await new UpdatePlanTool().execute({
		explanation: "Start implementation",
		plan: [
			{ step: "Inspect runtime", status: "completed" },
			{ step: "Wire plan updates", status: "in_progress" },
			{ step: "Run tests", status: "pending" },
		],
	});

	assert.equal(result.success, true);
	assert.equal(result.modelOutput, "Plan updated.");
	assert.deepEqual(result.metadata, { completed: 1, total: 3 });
	assert.deepEqual(result.planUpdate, {
		explanation: "Start implementation",
		items: [
			{ id: "step-1", text: "Inspect runtime", status: "completed" },
			{ id: "step-2", text: "Wire plan updates", status: "in_progress" },
			{ id: "step-3", text: "Run tests", status: "pending" },
		],
	});
});

test("update_plan accepts an empty plan as a clear operation", async () => {
	const result = await new UpdatePlanTool().execute({ plan: [] });

	assert.equal(result.success, true);
	assert.equal(result.summary, "Cleared plan");
	assert.deepEqual(result.planUpdate, { items: [] });
});

test("update_plan rejects multiple active steps", async () => {
	const result = await new UpdatePlanTool().execute({
		plan: [
			{ step: "First", status: "in_progress" },
			{ step: "Second", status: "in_progress" },
		],
	});

	assert.equal(result.success, false);
	assert.equal(result.errorKind, "invalid_plan");
	assert.equal(result.planUpdate, undefined);
});

test("update_plan rejects malformed items when called outside the schema router", async () => {
	for (const plan of [
		["not-an-object"],
		[{ step: "", status: "pending" }],
		[{ step: "Valid", status: "unknown" }],
	]) {
		const result = await new UpdatePlanTool().execute({ plan });
		assert.equal(result.success, false);
		assert.equal(result.errorKind, "invalid_plan");
		assert.equal(result.planUpdate, undefined);
	}
});

test("update_plan rejects invalid explanations outside the schema router", async () => {
	for (const explanation of [null, "x".repeat(4_097)]) {
		const result = await new UpdatePlanTool().execute({ explanation, plan: [] });
		assert.equal(result.success, false);
		assert.equal(result.errorKind, "invalid_plan");
		assert.equal(result.planUpdate, undefined);
	}
});
