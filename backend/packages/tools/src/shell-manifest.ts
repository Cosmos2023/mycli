import type { ToolDefinition } from "@mycli/core";
import type {
	ToolManifestEntry,
	ToolParameterManifest,
} from "./types.ts";

const SHELL_PARAMETERS: readonly ToolParameterManifest[] = deepFreeze([
	{
		name: "command",
		type: "string",
		required: true,
		description: "Shell command to execute in the active user shell.",
	},
	{
		name: "cwd",
		type: "string",
		required: false,
		description: "Working directory for the command. Defaults to the workspace root.",
	},
	{ name: "tty", type: "boolean", required: false },
	{ name: "yield_time_ms", type: "integer", required: false },
	{ name: "max_output_tokens", type: "integer", required: false },
	{
		name: "prefix_rule",
		type: "array",
		required: false,
		description: "Optional executable prefix proposed for persistent approval; it is never executed.",
	},
	{
		name: "sandbox_permissions",
		type: "string",
		required: false,
		description: "Use require_escalated only when the command must run outside the active sandbox.",
	},
]);

export const SHELL_TOOL_DEFINITION: ToolDefinition = deepFreeze({
	id: "builtin:Shell",
	name: "Shell",
	description: "Execute a command in the active user shell and return a resumable session if it keeps running.",
	inputSchema: {
		type: "object",
		properties: {
			command: { type: "string", minLength: 1 },
			cwd: { type: "string", minLength: 1 },
			tty: { type: "boolean" },
			yield_time_ms: { type: "integer", minimum: 1 },
			max_output_tokens: { type: "integer", minimum: 1 },
			prefix_rule: {
				type: "array",
				items: { type: "string", minLength: 1 },
				minItems: 1,
			},
			sandbox_permissions: {
				type: "string",
				enum: ["use_default", "require_escalated"],
			},
		},
		required: ["command"],
		additionalProperties: false,
	},
});

const WRITE_STDIN_PARAMETERS: readonly ToolParameterManifest[] = deepFreeze([
	{
		name: "session_id",
		type: "string",
		required: true,
		description: "Identifier returned by a running Shell call.",
	},
	{
		name: "chars",
		type: "string",
		required: false,
		description: "Input to write. Defaults to empty, which only polls output.",
	},
	{ name: "yield_time_ms", type: "integer", required: false },
	{ name: "max_output_tokens", type: "integer", required: false },
]);

export const WRITE_STDIN_TOOL_DEFINITION: ToolDefinition = deepFreeze({
	id: "builtin:WriteStdin",
	name: "WriteStdin",
	description: "Write characters to an existing Shell session or poll its recent output.",
	inputSchema: {
		type: "object",
		properties: {
			session_id: { type: "string", minLength: 1 },
			chars: { type: "string" },
			yield_time_ms: { type: "integer", minimum: 1 },
			max_output_tokens: { type: "integer", minimum: 1 },
		},
		required: ["session_id"],
		additionalProperties: false,
	},
});

const BASH_PARAMETERS: readonly ToolParameterManifest[] = deepFreeze([
	{ name: "command", type: "string", required: true },
	{ name: "args", type: "array", required: false },
	{ name: "timeout", type: "integer", required: false },
	{ name: "cwd", type: "string", required: false },
	{ name: "run_in_background", type: "boolean", required: false },
]);

export const BASH_TOOL_DEFINITION: ToolDefinition = deepFreeze({
	id: "builtin:Bash",
	name: "Bash",
	description: "Compatibility alias for the Shell tool.",
	inputSchema: {
		type: "object",
		properties: {
			command: { type: "string", minLength: 1 },
			args: { type: "array", items: { type: "string" } },
			timeout: { type: "integer", minimum: 1 },
			cwd: { type: "string", minLength: 1 },
			run_in_background: { type: "boolean" },
		},
		required: ["command"],
		additionalProperties: false,
	},
});

const SHELL_OUTPUT_PARAMETERS: readonly ToolParameterManifest[] = deepFreeze([
	{ name: "shell_id", type: "string", required: true },
]);

export const SHELL_OUTPUT_TOOL_DEFINITION: ToolDefinition = shellIdDefinition(
	"ShellOutput",
	"Read incremental output and status for a background Shell process.",
);

export const BASH_OUTPUT_TOOL_DEFINITION: ToolDefinition = shellIdDefinition(
	"BashOutput",
	"Compatibility alias for the ShellOutput tool.",
);

export const KILL_SHELL_TOOL_DEFINITION: ToolDefinition = shellIdDefinition(
	"KillShell",
	"Terminate an owner-scoped Shell process.",
);

export const SHELL_MANIFEST_ENTRIES: readonly ToolManifestEntry[] = deepFreeze([
	terminalEntry({
		definition: SHELL_TOOL_DEFINITION,
		parameters: SHELL_PARAMETERS,
		riskLevel: "high",
		approvalPolicy: "shell_command_analysis",
		capabilityTags: ["shell", "process", "terminal", "approval"],
		modelVisible: true,
	}),
	terminalEntry({
		definition: WRITE_STDIN_TOOL_DEFINITION,
		parameters: WRITE_STDIN_PARAMETERS,
		riskLevel: "low",
		approvalPolicy: "auto_allow",
		capabilityTags: ["shell", "process", "terminal", "continuation"],
		modelVisible: true,
	}),
	terminalEntry({
		definition: BASH_TOOL_DEFINITION,
		parameters: BASH_PARAMETERS,
		riskLevel: "high",
		approvalPolicy: "shell_command_analysis",
		capabilityTags: ["shell", "process", "terminal", "approval", "compatibility"],
		modelVisible: false,
	}),
	terminalEntry({
		definition: SHELL_OUTPUT_TOOL_DEFINITION,
		parameters: SHELL_OUTPUT_PARAMETERS,
		riskLevel: "low",
		approvalPolicy: "auto_allow",
		capabilityTags: ["shell", "process", "background", "compatibility"],
		modelVisible: false,
	}),
	terminalEntry({
		definition: BASH_OUTPUT_TOOL_DEFINITION,
		parameters: SHELL_OUTPUT_PARAMETERS,
		riskLevel: "low",
		approvalPolicy: "auto_allow",
		capabilityTags: ["shell", "process", "background", "compatibility"],
		modelVisible: false,
	}),
	terminalEntry({
		definition: KILL_SHELL_TOOL_DEFINITION,
		parameters: SHELL_OUTPUT_PARAMETERS,
		riskLevel: "medium",
		approvalPolicy: "auto_allow_or_request",
		capabilityTags: ["shell", "process", "control", "mutation", "compatibility"],
		modelVisible: false,
	}),
]);

interface TerminalEntryInput {
	readonly definition: ToolDefinition;
	readonly parameters: readonly ToolParameterManifest[];
	readonly riskLevel: ToolManifestEntry["risk_level"];
	readonly approvalPolicy: string;
	readonly capabilityTags: readonly string[];
	readonly modelVisible: boolean;
}

function terminalEntry(input: TerminalEntryInput): ToolManifestEntry {
	return {
		...input.definition,
		source: "builtin",
		toolset: "terminal",
		parameters: input.parameters,
		risk_level: input.riskLevel,
		supports_parallel_tool_calls: false,
		approval_policy: input.approvalPolicy,
		capability_tags: input.capabilityTags,
		effects: { filesystem: "write", network: false, process: true },
		availability: { status: "available" },
		model_visible: input.modelVisible,
	};
}

function shellIdDefinition(name: string, description: string): ToolDefinition {
	return deepFreeze({
		id: `builtin:${name}`,
		name,
		description,
		inputSchema: {
			type: "object",
			properties: { shell_id: { type: "string", minLength: 1 } },
			required: ["shell_id"],
			additionalProperties: false,
		},
	});
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
