import type { ToolDefinition } from "@mycli/core";
import {
	isAbortError,
	type FileMutationRuntime,
} from "./file-mutation-runtime.ts";
import { EDIT_TOOL_DEFINITION } from "./manifest.ts";
import {
	mutationFailure,
	mutationSuccess,
	type MutationStatus,
	type MutationToolName,
} from "./mutation-result.ts";
import type {
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
} from "./types.ts";

export class ExactReplaceTool implements ToolAdapter {
	readonly definition: ToolDefinition;
	readonly #toolName: MutationToolName;
	readonly #status: MutationStatus;
	readonly #runtime: FileMutationRuntime;

	constructor(
		toolName: MutationToolName,
		status: MutationStatus,
		definition: ToolDefinition,
		runtime: FileMutationRuntime,
	) {
		this.#toolName = toolName;
		this.#status = status;
		this.definition = definition;
		this.#runtime = runtime;
	}

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		const path = typeof argumentsValue.file_path === "string" ? argumentsValue.file_path : "";
		const oldString = typeof argumentsValue.old_string === "string"
			? argumentsValue.old_string
			: undefined;
		const newString = typeof argumentsValue.new_string === "string"
			? argumentsValue.new_string
			: undefined;
		if (!path || oldString === undefined || newString === undefined) {
			return mutationFailure(this.#toolName, path, undefined);
		}
		try {
			const outcome = await this.#runtime.replace({
				path,
				oldString,
				newString,
				replaceAll: argumentsValue.replace_all === true,
				signal: options.signal,
			});
			return mutationSuccess(this.#toolName, outcome, this.#status);
		} catch (error) {
			if (isAbortError(error)) throw error;
			return mutationFailure(this.#toolName, path, error);
		}
	}
}

export class EditTool extends ExactReplaceTool {
	constructor(runtime: FileMutationRuntime) {
		super("Edit", "edited", EDIT_TOOL_DEFINITION, runtime);
	}
}
