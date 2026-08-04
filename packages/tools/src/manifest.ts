import type { ToolDefinition } from "@mycli/core";
import type {
	BuiltInToolManifest,
	ToolManifestEntry,
	ToolParameterManifest,
} from "./types.ts";

const READ_PARAMETERS: readonly ToolParameterManifest[] = deepFreeze([
	{ name: "file_path", type: "string", required: true },
	{ name: "offset", type: "integer", required: true },
	{ name: "limit", type: "integer", required: true },
	{ name: "pages", type: "string", required: false },
]);

const READ_INPUT_SCHEMA = deepFreeze({
	type: "object",
	properties: Object.fromEntries(READ_PARAMETERS.map((parameter) => [
		parameter.name,
		parameter.name === "file_path"
			? { type: parameter.type, minLength: 1 }
			: parameter.name === "offset"
				? { type: parameter.type, minimum: 1 }
				: parameter.name === "limit"
					? { type: parameter.type, minimum: 0 }
					: { type: parameter.type },
	])),
	required: READ_PARAMETERS
		.filter((parameter) => parameter.required)
		.map((parameter) => parameter.name),
	additionalProperties: false,
});

export const READ_TOOL_DEFINITION: ToolDefinition = deepFreeze({
	id: "builtin:Read",
	name: "Read",
	description: "Read a bounded file range from the workspace.",
	inputSchema: READ_INPUT_SCHEMA,
});

const WRITE_PARAMETERS: readonly ToolParameterManifest[] = deepFreeze([
	{ name: "file_path", type: "string", required: true },
	{ name: "content", type: "string", required: true },
	{ name: "expected_sha256", type: "string", required: false },
]);

export const WRITE_TOOL_DEFINITION: ToolDefinition = deepFreeze({
	id: "builtin:Write",
	name: "Write",
	description: "Write complete UTF-8 text content to a workspace file.",
	inputSchema: {
		type: "object",
		properties: Object.fromEntries(WRITE_PARAMETERS.map((parameter) => [
			parameter.name,
			parameter.name === "file_path" || parameter.name === "expected_sha256"
				? { type: parameter.type, minLength: 1 }
				: { type: parameter.type },
		])),
		required: WRITE_PARAMETERS
			.filter((parameter) => parameter.required)
			.map((parameter) => parameter.name),
		additionalProperties: false,
	},
});

const READ_MANIFEST_ENTRY: ToolManifestEntry = deepFreeze({
	...READ_TOOL_DEFINITION,
	source: "builtin",
	toolset: "file",
	parameters: READ_PARAMETERS,
	risk_level: "low",
	supports_parallel_tool_calls: true,
	approval_policy: "auto_allow",
	capability_tags: ["file", "read", "structured_data", "snapshot"],
	effects: { filesystem: "read", network: false, process: false },
	availability: { status: "available" },
});

const BUILTIN_MANIFEST: BuiltInToolManifest = deepFreeze({
	schema_version: 1,
	source: "builtin",
	toolsets: [{ id: "file", tool_count: 1 }],
	tools: [READ_MANIFEST_ENTRY],
});

export function builtinToolManifest(): BuiltInToolManifest {
	return BUILTIN_MANIFEST;
}

function deepFreeze<Value>(value: Value): Value {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
		return value;
	}
	for (const nested of Object.values(value)) {
		deepFreeze(nested);
	}
	return Object.freeze(value);
}
