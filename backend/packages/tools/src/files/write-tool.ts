import type { FileMutationPreviewChange } from "@mycli/core";
import {
	FileMutationError,
	isAbortError,
} from "./file-mutation-runtime.ts";
import type { FileMutationRuntime } from "./file-mutation-runtime.ts";
import { resolveFileSandboxAccess } from "./file-sandbox-permissions.ts";
import { WRITE_TOOL_DEFINITION } from "../registry/manifest.ts";
import {
	mutationFailure,
	fallbackMutationPreviewChanges,
	mutationPreviewChanges,
	mutationSuccess,
} from "./mutation-result.ts";
import type {
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
	PreparedToolCall,
	ToolPreviewOptions,
} from "../types.ts";

export interface WriteToolOptions {
	readonly runtime: FileMutationRuntime;
}

export class WriteTool implements ToolAdapter {
	readonly definition = WRITE_TOOL_DEFINITION;
	readonly #runtime: FileMutationRuntime;

	constructor(options: WriteToolOptions) {
		this.#runtime = options.runtime;
	}

	async prepare(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolPreviewOptions,
	): Promise<PreparedToolCall> {
		const path = typeof argumentsValue.file_path === "string" ? argumentsValue.file_path : "";
		const content = typeof argumentsValue.content === "string" ? argumentsValue.content : undefined;
		if (!path || content === undefined) return emptyPreparation();
		const sandbox = resolveFileSandboxAccess(argumentsValue, options);
		if (sandbox.ok) {
			try {
				const prepared = await this.#runtime.prepareWrite({
					path,
					content,
					allowOutsideWorkspace: sandbox.allowOutsideWorkspace,
					allowedWritableRoots: sandbox.allowedWritableRoots,
					deniedReadPolicy: sandbox.deniedReadPolicy,
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
		return Object.freeze({ fileChanges: fallbackMutationPreviewChanges(path, "", content) });
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
		const content = typeof argumentsValue.content === "string" ? argumentsValue.content : undefined;
		if (!path || content === undefined) {
			return mutationFailure("Write", path, undefined);
		}
		const sandbox = resolveFileSandboxAccess(argumentsValue, options);
		if (!sandbox.ok) {
			return mutationFailure("Write", path, new FileMutationError(sandbox.errorKind));
		}
		try {
			const outcome = await this.#runtime.write({
				path,
				content,
				allowOutsideWorkspace: sandbox.allowOutsideWorkspace,
				allowedWritableRoots: sandbox.allowedWritableRoots,
				deniedReadPolicy: sandbox.deniedReadPolicy,
				history: {
					turnId: options.ownerTurnId ?? options.callId,
					toolName: "Write",
				},
				signal: options.signal,
			});
			return mutationSuccess("Write", outcome);
		} catch (error) {
			if (isAbortError(error)) throw error;
			return mutationFailure("Write", path, error);
		}
	}
}

function emptyPreparation(): PreparedToolCall {
	return Object.freeze({ fileChanges: Object.freeze([]) });
}
