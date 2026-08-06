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
			"Task",
			"SubagentOutput",
			"SendMessage",
			"AskUserQuestion",
		],
		allowed: [
			"Write",
			"Read",
			"Task",
			"SubagentOutput",
			"SendMessage",
			"AskUserQuestion",
		],
		denied: [],
	});

	assert.deepEqual(result, { tools: ["Read"], unknown: [] });
	assert.deepEqual(GLOBAL_CHILD_TOOL_DENYLIST, [
		"Task",
		"SubagentOutput",
		"SendMessage",
		"AskUserQuestion",
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
