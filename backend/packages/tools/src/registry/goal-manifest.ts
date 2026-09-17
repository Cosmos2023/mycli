import type { ToolDefinition } from "@mycli/core";
import type { ToolManifestEntry, ToolParameterManifest } from "../types.ts";
import { deepFreeze } from "./manifest-helpers.ts";

export const CREATE_GOAL_TOOL_DEFINITION: ToolDefinition = deepFreeze({
	id: "builtin:create_goal", name: "create_goal",
	description: "Create one durable session goal only when the user explicitly requests a goal or asks to keep working toward an objective across turns. Do not infer goals from ordinary tasks. An unfinished goal cannot be replaced. Omit token_budget unless the user explicitly requests one; units are uncached input plus output tokens. The runtime continues ordinary turns while the goal is active. Goals do not grant additional permissions.",
	inputSchema: { type: "object", properties: {
		objective: { type: "string", minLength: 1, maxLength: 16384, description: "The concrete objective and completion criteria." },
		token_budget: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Optional user-requested token budget. In-flight usage may exceed it before the next safe boundary." },
	}, required: ["objective"], additionalProperties: false },
});

export const GET_GOAL_TOOL_DEFINITION: ToolDefinition = deepFreeze({
	id: "builtin:get_goal", name: "get_goal",
	description: "Read this session's current goal, status, optional budget, reported tokens, active elapsed time, and continuation count. Reading does not resume or change a goal. usage_incomplete means reported tokens are a lower bound.",
	inputSchema: { type: "object", properties: {}, additionalProperties: false },
});

export const UPDATE_GOAL_TOOL_DEFINITION: ToolDefinition = deepFreeze({
	id: "builtin:update_goal", name: "update_goal",
	description: "Update the current goal to complete only after verifying the objective with evidence and no required work remaining. Mark blocked only when the same blocker persists for at least three consecutive goal turns in the current run and further progress needs user input or an external change; count the initiating turn and reset the audit after resume. The runtime enforces the minimum turn count, while you must assess whether the blocker is the same. Do not mark complete to stop early or because the budget is nearly exhausted. Use paused only on an explicit human request. Resume, edit, and budget control belong to /goal. Report final usage when completing a budgeted goal.",
	inputSchema: { type: "object", properties: {
		status: { type: "string", enum: ["complete", "blocked", "paused"], description: "The evidenced terminal status, or an explicitly requested pause." },
	}, required: ["status"], additionalProperties: false },
});

export const GOAL_MANIFEST_ENTRIES: readonly ToolManifestEntry[] = deepFreeze([
	CREATE_GOAL_TOOL_DEFINITION, GET_GOAL_TOOL_DEFINITION, UPDATE_GOAL_TOOL_DEFINITION,
].map((definition) => ({
	...definition, source: "builtin" as const, toolset: "goals",
	parameters: parameters(definition), risk_level: "low" as const,
	supports_parallel_tool_calls: false, approval_policy: "auto_allow",
	capability_tags: ["goal", "session"], effects: { filesystem: "none" as const, network: false, process: false },
	availability: { status: "available" as const }, model_visible: true,
})));

function parameters(definition: ToolDefinition): readonly ToolParameterManifest[] {
	const schema = definition.inputSchema as { properties: Record<string, { type: "string" | "integer"; description: string }>; required?: string[] };
	return Object.entries(schema.properties).map(([name, value]) => ({
		name, type: value.type, required: schema.required?.includes(name) ?? false, description: value.description,
	}));
}
