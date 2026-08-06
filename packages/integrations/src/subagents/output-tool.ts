import type { ToolDefinition } from "@mycli/core";
import type {
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
} from "@mycli/tools";
import type { SubagentControlContract } from "./controller.ts";
import { boundText, failure, success } from "./task-tool.ts";

export interface SubagentOutputToolOptions {
	readonly control: SubagentControlContract;
}

export const SUBAGENT_OUTPUT_TOOL_DEFINITION: ToolDefinition = deepFreeze({
	id: "subagent:SubagentOutput",
	name: "SubagentOutput",
	description: "Read the current state or completed report for a child session.",
	inputSchema: {
		type: "object",
		properties: {
			child_session_id: { type: "string", minLength: 1 },
		},
		required: ["child_session_id"],
		additionalProperties: false,
	},
});

export class SubagentOutputTool implements ToolAdapter {
	readonly definition = SUBAGENT_OUTPUT_TOOL_DEFINITION;
	readonly #control: SubagentControlContract;

	constructor(options: SubagentOutputToolOptions) {
		this.#control = options.control;
	}

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		assertNotAborted(options.signal);
		const childSessionId = typeof argumentsValue.child_session_id === "string"
			? argumentsValue.child_session_id.trim()
			: "";
		const output = this.#control.output(childSessionId, options.ownerSessionId);
		if (!output.found) {
			return failure(
				"Subagent output unavailable",
				"Subagent output unavailable",
				"subagent_not_found",
			);
		}
		const rendered = [
			`Status: ${output.status}`,
			`Child session: ${output.childSessionId}`,
			`Task: ${output.taskId}`,
			...(output.progressSummary ? [`Progress: ${output.progressSummary}`] : []),
			...(output.report !== undefined ? [output.report] : []),
			...(output.outputReference ? [`Output reference: ${output.outputReference}`] : []),
		].join("\n");
		return success(boundText(rendered), `Subagent ${output.status}`);
	}
}

function assertNotAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	const error = new Error("interrupted");
	error.name = "AbortError";
	throw error;
}

function deepFreeze<Value>(value: Value): Value {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}
