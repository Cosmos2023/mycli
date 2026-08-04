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

const EXACT_REPLACE_PARAMETERS: readonly ToolParameterManifest[] = deepFreeze([
	{ name: "file_path", type: "string", required: true },
	{ name: "old_string", type: "string", required: true },
	{ name: "new_string", type: "string", required: true },
	{ name: "replace_all", type: "boolean", required: false },
]);

const EXACT_REPLACE_INPUT_SCHEMA = deepFreeze({
	type: "object",
	properties: Object.fromEntries(EXACT_REPLACE_PARAMETERS.map((parameter) => [
		parameter.name,
		parameter.name === "file_path"
			? { type: parameter.type, minLength: 1 }
			: { type: parameter.type },
	])),
	required: EXACT_REPLACE_PARAMETERS
		.filter((parameter) => parameter.required)
		.map((parameter) => parameter.name),
	additionalProperties: false,
});

export const EDIT_TOOL_DEFINITION: ToolDefinition = deepFreeze({
	id: "builtin:Edit",
	name: "Edit",
	description: "Apply an exact old_string/new_string edit to a recently read workspace file.",
	inputSchema: EXACT_REPLACE_INPUT_SCHEMA,
});

export const PATCH_TOOL_DEFINITION: ToolDefinition = deepFreeze({
	id: "builtin:Patch",
	name: "Patch",
	description: "Apply an exact replacement patch to a recently read workspace file.",
	inputSchema: EXACT_REPLACE_INPUT_SCHEMA,
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

const EDIT_MANIFEST_ENTRY: ToolManifestEntry = deepFreeze({
	...EDIT_TOOL_DEFINITION,
	source: "builtin",
	toolset: "file",
	parameters: EXACT_REPLACE_PARAMETERS,
	risk_level: "medium",
	supports_parallel_tool_calls: false,
	approval_policy: "auto_allow_or_request",
	capability_tags: ["file", "edit", "mutation", "snapshot_guard", "diff"],
	effects: { filesystem: "write", network: false, process: false },
	availability: { status: "available" },
});

const PATCH_MANIFEST_ENTRY: ToolManifestEntry = deepFreeze({
	...PATCH_TOOL_DEFINITION,
	source: "builtin",
	toolset: "file",
	parameters: EXACT_REPLACE_PARAMETERS,
	risk_level: "medium",
	supports_parallel_tool_calls: false,
	approval_policy: "auto_allow_or_request",
	capability_tags: ["file", "patch", "mutation", "snapshot_guard", "diff"],
	effects: { filesystem: "write", network: false, process: false },
	availability: { status: "available" },
});

const WRITE_MANIFEST_ENTRY: ToolManifestEntry = deepFreeze({
	...WRITE_TOOL_DEFINITION,
	source: "builtin",
	toolset: "file",
	parameters: WRITE_PARAMETERS,
	risk_level: "medium",
	supports_parallel_tool_calls: false,
	approval_policy: "auto_allow_or_request",
	capability_tags: ["file", "write", "mutation", "conflict_guard", "diff"],
	effects: { filesystem: "write", network: false, process: false },
	availability: { status: "available" },
});

const BUILTIN_MANIFEST: BuiltInToolManifest = deepFreeze({
	schema_version: 1,
	source: "builtin",
	toolsets: [{ id: "file", tool_count: 4 }],
	tools: [READ_MANIFEST_ENTRY, EDIT_MANIFEST_ENTRY, PATCH_MANIFEST_ENTRY, WRITE_MANIFEST_ENTRY],
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
