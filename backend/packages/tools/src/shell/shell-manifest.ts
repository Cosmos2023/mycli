import type { ToolDefinition } from "@mycli/core";
import type {
	ToolManifestEntry,
	ToolParameterManifest,
} from "../types.ts";
import { deepFreeze, parameterDescription } from "../registry/manifest-helpers.ts";
import { SHELL_JUSTIFICATION_MAX_CHARS } from "./shell-sandbox-permissions.ts";
import {
	DEFAULT_SHELL_MODEL_OUTPUT_MAX_TOKENS,
	SHELL_MODEL_OUTPUT_MAX_TOKENS,
} from "./shell-result.ts";

export const SHELL_DESCRIPTION_MAX_CHARS = 512;

const OUTPUT_BUDGET_DESCRIPTION = `Model-visible output token budget. Defaults to ${DEFAULT_SHELL_MODEL_OUTPUT_MAX_TOKENS} tokens; larger requests are allowed up to ${SHELL_MODEL_OUTPUT_MAX_TOKENS} tokens and may be capped by runtime policy.`;

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
		description: "Working directory for the command. Relative paths resolve from the workspace root; defaults to the workspace root.",
	},
	{
		name: "tty",
		type: "boolean",
		required: false,
		description: "True allocates a PTY for interactive programs; false or omitted uses plain pipes.",
	},
	{
		name: "yield_time_ms",
		type: "integer",
		required: false,
		description: "Wait before returning output. Defaults to 10000 ms; effective values are clamped to 250-30000 ms. The runtime may return a running session ID immediately after startup to advance approvals.",
	},
	{
		name: "max_output_tokens",
		type: "integer",
		required: false,
		description: OUTPUT_BUDGET_DESCRIPTION,
	},
	{
		name: "prefix_rule",
		type: "array",
		required: false,
		description: "Optional executable-token prefix proposed for persistent approval. It is approval metadata and is not executed separately.",
	},
	{
		name: "sandbox_permissions",
		type: "string",
		required: false,
		description: "Per-command sandbox override. Defaults to use_default; use require_escalated only when the command must run outside the active sandbox.",
	},
	{
		name: "justification",
		type: "string",
		required: false,
		description: "User-facing approval question for `require_escalated`; omit otherwise.",
	},
]);

export const SHELL_TOOL_DEFINITION: ToolDefinition = deepFreeze({
	id: "builtin:Shell",
	name: "Shell",
	description: "Run a command in the active user shell and return output or a session ID for ongoing interaction.",
	inputSchema: {
		type: "object",
		properties: {
			command: {
				type: "string",
				minLength: 1,
				description: parameterDescription(SHELL_PARAMETERS, "command"),
			},
			cwd: {
				type: "string",
				minLength: 1,
				description: parameterDescription(SHELL_PARAMETERS, "cwd"),
			},
			tty: {
				type: "boolean",
				description: parameterDescription(SHELL_PARAMETERS, "tty"),
			},
			yield_time_ms: {
				type: "integer",
				minimum: 1,
				description: parameterDescription(SHELL_PARAMETERS, "yield_time_ms"),
			},
			max_output_tokens: {
				type: "integer",
				minimum: 1,
				description: parameterDescription(SHELL_PARAMETERS, "max_output_tokens"),
			},
			prefix_rule: {
				type: "array",
				description: parameterDescription(SHELL_PARAMETERS, "prefix_rule"),
				items: {
					type: "string",
					minLength: 1,
					description: "One executable or argument token in the proposed prefix.",
				},
				minItems: 1,
			},
			sandbox_permissions: {
				type: "string",
				enum: ["use_default", "require_escalated"],
				description: parameterDescription(SHELL_PARAMETERS, "sandbox_permissions"),
			},
			justification: {
				type: "string",
				minLength: 1,
				maxLength: SHELL_JUSTIFICATION_MAX_CHARS,
				description: parameterDescription(SHELL_PARAMETERS, "justification"),
			},
		},
		required: ["command"],
		additionalProperties: false,
	},
});

export const SHELL_LEGACY_INPUT_SCHEMA: Readonly<Record<string, unknown>> = deepFreeze({
	...SHELL_TOOL_DEFINITION.inputSchema,
	properties: {
		...SHELL_TOOL_DEFINITION.inputSchema.properties as Readonly<Record<string, unknown>>,
		description: { type: "string", minLength: 1, maxLength: SHELL_DESCRIPTION_MAX_CHARS },
	},
	required: ["command", "description"],
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
		description: "Characters to write to the session. Empty or omitted input only polls recent output.",
	},
	{
		name: "yield_time_ms",
		type: "integer",
		required: false,
		description: "Wait after the interaction. Writes default to 250 ms and clamp to 250-30000 ms; polls default to 5000 ms and clamp to 5000-300000 ms.",
	},
	{
		name: "max_output_tokens",
		type: "integer",
		required: false,
		description: OUTPUT_BUDGET_DESCRIPTION,
	},
]);

export const WRITE_STDIN_TOOL_DEFINITION: ToolDefinition = deepFreeze({
	id: "builtin:WriteStdin",
	name: "WriteStdin",
	description: "Write characters to an existing Shell session, or poll recent output when chars is empty or omitted.",
	inputSchema: {
		type: "object",
		properties: {
			session_id: {
				type: "string",
				minLength: 1,
				description: parameterDescription(WRITE_STDIN_PARAMETERS, "session_id"),
			},
			chars: {
				type: "string",
				description: parameterDescription(WRITE_STDIN_PARAMETERS, "chars"),
			},
			yield_time_ms: {
				type: "integer",
				minimum: 1,
				description: parameterDescription(WRITE_STDIN_PARAMETERS, "yield_time_ms"),
			},
			max_output_tokens: {
				type: "integer",
				minimum: 1,
				description: parameterDescription(WRITE_STDIN_PARAMETERS, "max_output_tokens"),
			},
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
		supportsParallelToolCalls: true,
		approvalPolicy: "shell_command_analysis",
		capabilityTags: ["shell", "process", "terminal", "approval"],
		modelVisible: true,
	}),
	terminalEntry({
		definition: WRITE_STDIN_TOOL_DEFINITION,
		parameters: WRITE_STDIN_PARAMETERS,
		riskLevel: "low",
		supportsParallelToolCalls: false,
		approvalPolicy: "auto_allow",
		capabilityTags: ["shell", "process", "terminal", "continuation"],
		modelVisible: true,
	}),
	terminalEntry({
		definition: BASH_TOOL_DEFINITION,
		parameters: BASH_PARAMETERS,
		riskLevel: "high",
		supportsParallelToolCalls: false,
		approvalPolicy: "shell_command_analysis",
		capabilityTags: ["shell", "process", "terminal", "approval", "compatibility"],
		modelVisible: false,
	}),
	terminalEntry({
		definition: SHELL_OUTPUT_TOOL_DEFINITION,
		parameters: SHELL_OUTPUT_PARAMETERS,
		riskLevel: "low",
		supportsParallelToolCalls: false,
		approvalPolicy: "auto_allow",
		capabilityTags: ["shell", "process", "background", "compatibility"],
		modelVisible: false,
	}),
	terminalEntry({
		definition: BASH_OUTPUT_TOOL_DEFINITION,
		parameters: SHELL_OUTPUT_PARAMETERS,
		riskLevel: "low",
		supportsParallelToolCalls: false,
		approvalPolicy: "auto_allow",
		capabilityTags: ["shell", "process", "background", "compatibility"],
		modelVisible: false,
	}),
	terminalEntry({
		definition: KILL_SHELL_TOOL_DEFINITION,
		parameters: SHELL_OUTPUT_PARAMETERS,
		riskLevel: "medium",
		supportsParallelToolCalls: false,
		approvalPolicy: "auto_allow_or_request",
		capabilityTags: ["shell", "process", "control", "mutation", "compatibility"],
		modelVisible: false,
	}),
]);

interface TerminalEntryInput {
	readonly definition: ToolDefinition;
	readonly parameters: readonly ToolParameterManifest[];
	readonly riskLevel: ToolManifestEntry["risk_level"];
	readonly supportsParallelToolCalls: boolean;
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
		supports_parallel_tool_calls: input.supportsParallelToolCalls,
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
