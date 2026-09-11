import assert from "node:assert/strict";
import test from "node:test";
import {
	builtinToolManifest,
	combinedToolManifest,
	type ManifestToolRegistration,
} from "../../src/index.ts";

const registration: ManifestToolRegistration = {
	id: "mcp:files:read",
	source: "mcp",
	definition: {
		id: "mcp:files:read",
		name: "mcp_files_read",
		description: "Read a remote file.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	originMetadata: { server: "files", tool: "read" },
	supportsParallelToolCalls: true,
};

test("projects extension registrations without mutating the built-in manifest", () => {
	const builtin = builtinToolManifest();
	const before = JSON.stringify(builtin);
	const combined = combinedToolManifest(builtin, [registration]);

	assert.deepEqual(combined.tools.find((tool) => tool.id === "mcp:files:read"), {
		...registration.definition,
		id: "mcp:files:read",
		source: "mcp",
		toolset: "external",
		supports_parallel_tool_calls: true,
		availability: { status: "available" },
		origin_metadata: { server: "files", tool: "read" },
	});
	assert.deepEqual(combined.toolsets.find((toolset) => toolset.id === "external"), {
		id: "external",
		tool_count: 1,
	});
	assert.equal(combined.source, "combined");
	assert.equal(JSON.stringify(builtin), before);
	assert.equal(builtinToolManifest(), builtin);
	assert.equal(Object.isFrozen(combined), true);
	assert.equal(Object.isFrozen(combined.tools), true);
});

test("rejects duplicate manifest ids and provider routes", () => {
	const builtin = builtinToolManifest();
	assert.throws(
		() => combinedToolManifest(builtin, [{
			...registration,
			id: "builtin:Read",
			definition: { ...registration.definition, id: "builtin:Read" },
		}]),
		/duplicate_tool_id/,
	);
	assert.throws(
		() => combinedToolManifest(builtin, [{
			...registration,
			definition: { ...registration.definition, name: "Read" },
		}]),
		/duplicate_tool_route/,
	);
});

test("projects one stable Skill route instead of one route per discovered skill", () => {
	const combined = combinedToolManifest(builtinToolManifest(), [{
		id: "skill:Skill",
		source: "skill",
		definition: {
			id: "skill:Skill",
			name: "Skill",
			description: "Load one discovered skill.",
			inputSchema: {
				type: "object",
				properties: { name: { type: "string" } },
				required: ["name"],
				additionalProperties: false,
			},
		},
		originMetadata: { skill: "catalog" },
		supportsParallelToolCalls: false,
	}]);

	assert.deepEqual(
		combined.tools.filter((tool) => tool.source === "skill").map((tool) => tool.name),
		["Skill"],
	);
});
