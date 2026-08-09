import type { ToolAdapterResult } from "@mycli/tools";

export const SUBAGENT_TOOL_MODEL_OUTPUT_MAX_CHARS = 4_000;

export function boundText(value: string): string {
	if (value.length <= SUBAGENT_TOOL_MODEL_OUTPUT_MAX_CHARS) return value;
	const marker = "\n...[subagent output truncated]";
	return `${value.slice(0, SUBAGENT_TOOL_MODEL_OUTPUT_MAX_CHARS - marker.length)}${marker}`;
}

export function success(modelOutput: string, summary: string): ToolAdapterResult {
	return Object.freeze({
		success: true,
		modelOutput,
		summary,
		metadata: Object.freeze({}),
	});
}

export function failure(modelOutput: string, summary: string, errorKind: string): ToolAdapterResult {
	return Object.freeze({
		success: false,
		modelOutput,
		summary,
		errorKind,
		metadata: Object.freeze({}),
	});
}
