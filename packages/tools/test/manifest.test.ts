import assert from "node:assert/strict";
import test from "node:test";
import * as tools from "../src/index.ts";

test("built-in M3 manifest exposes only Read with stable safety metadata", () => {
	const builtinToolManifest = requiredFunction("builtinToolManifest");
	const manifest = builtinToolManifest() as {
		readonly schema_version: number;
		readonly source: string;
		readonly toolsets: readonly unknown[];
		readonly tools: readonly Record<string, unknown>[];
	};

	assert.equal(manifest.schema_version, 1);
	assert.equal(manifest.source, "builtin");
	assert.deepEqual(manifest.toolsets, [{ id: "file", tool_count: 1 }]);
	assert.equal(manifest.tools.length, 1);
	assert.deepEqual(manifest.tools[0], {
		id: "builtin:Read",
		name: "Read",
		source: "builtin",
		toolset: "file",
		description: "Read a bounded file range from the workspace.",
		parameters: [
			{ name: "file_path", type: "string", required: true },
			{ name: "offset", type: "integer", required: true },
			{ name: "limit", type: "integer", required: true },
			{ name: "pages", type: "string", required: false },
		],
		inputSchema: {
			type: "object",
			properties: {
				file_path: { type: "string", minLength: 1 },
				offset: { type: "integer", minimum: 1 },
				limit: { type: "integer", minimum: 0 },
				pages: { type: "string" },
			},
			required: ["file_path", "offset", "limit"],
			additionalProperties: false,
		},
		risk_level: "low",
		supports_parallel_tool_calls: true,
		approval_policy: "auto_allow",
		capability_tags: ["file", "read", "structured_data", "snapshot"],
		effects: { filesystem: "read", network: false, process: false },
		availability: { status: "available" },
	});
	assert.equal(JSON.stringify(manifest).includes("LS"), false);
	assert.equal(JSON.stringify(manifest).includes("Glob"), false);
	assert.equal(JSON.stringify(manifest).includes("Grep"), false);
	assert.equal(Object.isFrozen(manifest), true);
	assert.equal(Object.isFrozen(manifest.tools), true);
});

test("exposure planner preserves manifest order and provider schema", () => {
	const builtinToolManifest = requiredFunction("builtinToolManifest");
	const planToolExposure = requiredFunction("planToolExposure");
	const manifest = builtinToolManifest();

	assert.deepEqual(planToolExposure(manifest), [{
		id: "builtin:Read",
		name: "Read",
		description: "Read a bounded file range from the workspace.",
		inputSchema: (manifest as { tools: Array<{ inputSchema: unknown }> }).tools[0]?.inputSchema,
	}]);
});

function requiredFunction(name: string): (...args: unknown[]) => unknown {
	const value = Reflect.get(tools, name);
	assert.equal(typeof value, "function", `${name} must be exported`);
	return value as (...args: unknown[]) => unknown;
}
