import type { ToolDefinition } from "@mycli/core";
import type {
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
} from "@mycli/tools";
import type { SubagentControlContract } from "./controller.ts";

export interface TaskToolOptions {
	readonly control: SubagentControlContract;
}

export const SUBAGENT_TOOL_MODEL_OUTPUT_MAX_CHARS = 4_000;

export const TASK_TOOL_DEFINITION: ToolDefinition = deepFreeze({
	id: "subagent:Task",
	name: "Task",
	description: "Start a scoped subagent using a configured profile.",
	inputSchema: {
		type: "object",
		properties: {
			profile: { type: "string", minLength: 1 },
			prompt: { type: "string", minLength: 1 },
			mode: { type: "string", enum: ["foreground", "background"] },
			allowed_tools: {
				type: "array",
				items: { type: "string", minLength: 1 },
				uniqueItems: true,
			},
		},
		required: ["profile", "prompt"],
		additionalProperties: false,
	},
});

export class TaskTool implements ToolAdapter {
	readonly definition = TASK_TOOL_DEFINITION;
	readonly #control: SubagentControlContract;

	constructor(options: TaskToolOptions) {
		this.#control = options.control;
	}

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		assertNotAborted(options.signal);
		const profileId = stringValue(argumentsValue.profile);
		const prompt = stringValue(argumentsValue.prompt);
		const mode = argumentsValue.mode === "foreground" ? "foreground" : "background";
		const allowedTools = stringList(argumentsValue.allowed_tools);
		const result = await this.#control.start({
			profileId,
			prompt,
			mode,
			...(allowedTools ? { allowedTools } : {}),
		});
		if (result.status === "running") {
			return success(`${result.summary}\nChild session: ${result.childSessionId}`, result.summary);
		}
		if (result.status === "completed") {
			return success(boundText([
				result.summary,
				`Child session: ${result.childSessionId}`,
				result.report ?? "",
			].filter(Boolean).join("\n")), result.summary);
		}
		return failure(
			boundText(`${result.summary}\nChild session: ${result.childSessionId}`),
			result.summary,
			result.status === "interrupted" ? "subagent_interrupted" : "subagent_failed",
		);
	}
}

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

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return Object.freeze(value.flatMap((item) =>
		typeof item === "string" && item.trim() ? [item.trim()] : []
	));
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
