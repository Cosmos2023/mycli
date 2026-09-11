import { TOOL_RESULT_OUTPUT_MAX_CHARS } from "@mycli/core";
import type { ToolExecutionResult } from "@mycli/tools";

export interface AgentWorkerToolArtifactStore {
	persist(input: {
		readonly sessionId: string;
		readonly turnId: string;
		readonly attemptId: string;
		readonly callId: string;
		readonly toolName: string;
		readonly output: string;
	}): Promise<string>;
}

export interface ProjectAgentWorkerToolResultInput {
	readonly sessionId: string;
	readonly turnId: string;
	readonly attemptId: string;
	readonly result: ToolExecutionResult;
	readonly artifacts: AgentWorkerToolArtifactStore;
	readonly maxChars?: number;
}

export async function projectAgentWorkerToolResult(
	input: ProjectAgentWorkerToolResultInput,
): Promise<ToolExecutionResult> {
	const maxChars = positiveLimit(input.maxChars ?? TOOL_RESULT_OUTPUT_MAX_CHARS);
	if (input.result.modelOutput.length <= maxChars) return input.result;
	const artifactReference = boundedReference(await input.artifacts.persist({
		sessionId: input.sessionId,
		turnId: input.turnId,
		attemptId: input.attemptId,
		callId: input.result.callId,
		toolName: input.result.toolName,
		output: input.result.modelOutput,
	}));
	const omittedChars = input.result.modelOutput.length - maxChars;
	return Object.freeze({
		...input.result,
		modelOutput: input.result.modelOutput.slice(0, maxChars),
		metadata: Object.freeze({
			...input.result.metadata,
			model_output_truncated: true,
			model_output_omitted_chars: omittedChars,
			artifact_reference: artifactReference,
		}),
	});
}

function boundedReference(value: string): string {
	if (!value || value.length > 512 || value.includes("\0") || /[\r\n]/u.test(value)) {
		throw new TypeError("agent Worker tool artifact reference is invalid");
	}
	return value;
}

function positiveLimit(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > TOOL_RESULT_OUTPUT_MAX_CHARS) {
		throw new TypeError("agent Worker tool output limit is invalid");
	}
	return value;
}
