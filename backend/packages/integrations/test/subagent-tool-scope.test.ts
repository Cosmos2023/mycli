import assert from "node:assert/strict";
import test from "node:test";
import {
	GLOBAL_CHILD_TOOL_DENYLIST,
	resolveChildTools,
} from "../src/index.ts";

test("tool scope diagnoses retired Python tools without aliasing them", () => {
	assert.deepEqual(resolveChildTools({
		parentTools: ["Read", "Edit", "Patch", "Write", "Shell"],
		allowed: ["Read", "LS", "Glob", "Grep"],
		denied: ["Shell"],
	}), { tools: ["Read"], unknown: ["Glob", "Grep", "LS"] });
});

test("tool scope only narrows the parent and applies global recursion denies", () => {
	const result = resolveChildTools({
		parentTools: [
			"Read",
			"spawn_agent",
			"wait_agent",
			"AskUserQuestion",
		],
		allowed: [
			"Write",
			"Read",
			"spawn_agent",
			"wait_agent",
			"AskUserQuestion",
		],
		denied: [],
	});

	assert.deepEqual(result, { tools: ["Read", "AskUserQuestion"], unknown: [] });
	assert.deepEqual(GLOBAL_CHILD_TOOL_DENYLIST, [
		"spawn_agent",
		"send_message",
		"followup_task",
		"interrupt_agent",
		"list_agents",
		"wait_agent",
	]);
});

test("tool scope preserves allowed order and accepts exposed extension tools", () => {
	const result = resolveChildTools({
		parentTools: ["Read", "mcp:docs:lookup", "Write"],
		allowed: ["mcp:docs:lookup", "Write", "Read"],
		denied: ["Write"],
	});

	assert.deepEqual(result, {
		tools: ["mcp:docs:lookup", "Read"],
		unknown: [],
	});
	assert.ok(Object.isFrozen(result));
	assert.ok(Object.isFrozen(result.tools));
});

test("tool scope exposes coordination only when depth policy allows it", () => {
	const input = {
		parentTools: ["Read", "spawn_agent", "send_message", "wait_agent"],
		allowed: ["Read", "spawn_agent", "send_message", "wait_agent"],
		denied: [],
	} as const;
	assert.deepEqual(resolveChildTools(input).tools, ["Read"]);
	assert.deepEqual(resolveChildTools({ ...input, allowCoordination: true }).tools, [
		"Read",
		"spawn_agent",
		"send_message",
		"wait_agent",
	]);
	assert.deepEqual(resolveChildTools({
		...input,
		allowCoordination: true,
		denied: ["spawn_agent"],
	}).tools, ["Read", "send_message", "wait_agent"]);
});
