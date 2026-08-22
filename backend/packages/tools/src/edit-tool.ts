import type { FileMutationPreviewChange, ToolDefinition } from "@mycli/core";
import { resolveFileSandboxAccess } from "./file-sandbox-permissions.ts";
import {
	FileMutationError,
	isAbortError,
	type FileMutationRuntime,
} from "./file-mutation-runtime.ts";
import { EDIT_TOOL_DEFINITION } from "./manifest.ts";
import {
	mutationFailure,
	fallbackMutationPreviewChanges,
	mutationPreviewChanges,
	mutationSuccess,
	type MutationStatus,
	type MutationToolName,
} from "./mutation-result.ts";
import type {
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
	PreparedToolCall,
	ToolPreviewOptions,
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

	async prepare(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolPreviewOptions,
	): Promise<PreparedToolCall> {
		const path = typeof argumentsValue.file_path === "string" ? argumentsValue.file_path : "";
		const oldString = typeof argumentsValue.old_string === "string"
			? argumentsValue.old_string
			: undefined;
		const newString = typeof argumentsValue.new_string === "string"
			? argumentsValue.new_string
			: undefined;
		if (!path || oldString === undefined || newString === undefined) return emptyPreparation();
		const sandbox = resolveFileSandboxAccess(argumentsValue, options);
		if (sandbox.ok) {
			try {
				const prepared = await this.#runtime.prepareReplace({
					path,
					oldString,
					newString,
					replaceAll: argumentsValue.replace_all === true,
					allowOutsideWorkspace: sandbox.allowOutsideWorkspace,
					signal: options.signal,
				});
				return Object.freeze({
					fileChanges: mutationPreviewChanges(prepared.outcome),
					mutationGuard: prepared.guard,
				});
			} catch (error) {
				if (isAbortError(error)) throw error;
			}
		}
		return Object.freeze({
			fileChanges: fallbackMutationPreviewChanges(path, oldString, newString),
		});
	}

	async preview(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolPreviewOptions,
	): Promise<readonly FileMutationPreviewChange[]> {
		return (await this.prepare(argumentsValue, options)).fileChanges;
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
		const sandbox = resolveFileSandboxAccess(argumentsValue, options);
		if (!sandbox.ok) {
			return mutationFailure(
				this.#toolName,
				path,
				new FileMutationError(sandbox.errorKind),
			);
		}
		try {
			const outcome = await this.#runtime.replace({
				path,
				oldString,
				newString,
				replaceAll: argumentsValue.replace_all === true,
				allowOutsideWorkspace: sandbox.allowOutsideWorkspace,
				history: {
					turnId: options.ownerTurnId ?? options.callId,
					toolName: this.#toolName,
				},
				signal: options.signal,
			});
			return mutationSuccess(this.#toolName, outcome, this.#status);
		} catch (error) {
			if (isAbortError(error)) throw error;
			return mutationFailure(this.#toolName, path, error);
		}
	}
}

function emptyPreparation(): PreparedToolCall {
	return Object.freeze({ fileChanges: Object.freeze([]) });
}

export class EditTool extends ExactReplaceTool {
	constructor(runtime: FileMutationRuntime) {
		super("Edit", "edited", EDIT_TOOL_DEFINITION, runtime);
	}
}
