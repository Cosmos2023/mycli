import type { FileMutationPreviewChange } from "@mycli/core";
import {
	FileMutationError,
	isAbortError,
	type FileMutationRuntime,
	type PatchOperation,
} from "./file-mutation-runtime.ts";
import { resolveFileSandboxAccess } from "./file-sandbox-permissions.ts";
import { PATCH_TOOL_DEFINITION } from "./manifest.ts";
import {
	fallbackMutationPreviewChanges,
	mutationFailure,
	patchMutationPreviewChanges,
	patchMutationSuccess,
} from "./mutation-result.ts";
import type {
	PreparedToolCall,
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
	ToolPreviewOptions,
} from "./types.ts";

export class PatchTool implements ToolAdapter {
	readonly definition = PATCH_TOOL_DEFINITION;
	readonly #runtime: FileMutationRuntime;

	constructor(runtime: FileMutationRuntime) {
		this.#runtime = runtime;
	}

	async prepare(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolPreviewOptions,
	): Promise<PreparedToolCall> {
		const operations = patchOperations(argumentsValue.operations);
		if (!operations) return emptyPreparation();
		const sandbox = resolveFileSandboxAccess(argumentsValue, options);
		if (sandbox.ok) {
			try {
				const prepared = await this.#runtime.preparePatch({
					operations,
					allowOutsideWorkspace: sandbox.allowOutsideWorkspace,
					allowedWritableRoots: sandbox.allowedWritableRoots,
					signal: options.signal,
				});
				return Object.freeze({
					fileChanges: patchMutationPreviewChanges(prepared.outcomes),
					mutationGuard: prepared.guard,
				});
			} catch (error) {
				if (isAbortError(error)) throw error;
			}
		}
		return Object.freeze({ fileChanges: fallbackPatchChanges(operations) });
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
		const operations = patchOperations(argumentsValue.operations);
		const path = operations ? firstOperationPath(operations) : "";
		if (!operations) return mutationFailure("Patch", path, undefined);
		const sandbox = resolveFileSandboxAccess(argumentsValue, options);
		if (!sandbox.ok) {
			return mutationFailure("Patch", path, new FileMutationError(sandbox.errorKind));
		}
		try {
			const outcomes = await this.#runtime.patch({
				operations,
				allowOutsideWorkspace: sandbox.allowOutsideWorkspace,
				allowedWritableRoots: sandbox.allowedWritableRoots,
				history: {
					turnId: options.ownerTurnId ?? options.callId,
					toolName: "Patch",
				},
				signal: options.signal,
			});
			return patchMutationSuccess(outcomes);
		} catch (error) {
			if (isAbortError(error)) throw error;
			return mutationFailure("Patch", path, error);
		}
	}
}

function patchOperations(value: unknown): readonly PatchOperation[] | undefined {
	if (!Array.isArray(value) || value.length < 1 || value.length > 64) return undefined;
	const operations: PatchOperation[] = [];
	for (const raw of value) {
		if (!isRecord(raw)) return undefined;
		switch (raw.type) {
			case "add":
				if (!nonEmpty(raw.file_path) || typeof raw.content !== "string") return undefined;
				operations.push({ type: "add", filePath: raw.file_path, content: raw.content });
				break;
			case "update":
				if (!nonEmpty(raw.file_path)
					|| typeof raw.old_string !== "string"
					|| typeof raw.new_string !== "string"
					|| raw.replace_all !== undefined && typeof raw.replace_all !== "boolean") return undefined;
				operations.push({
					type: "update",
					filePath: raw.file_path,
					oldString: raw.old_string,
					newString: raw.new_string,
					replaceAll: raw.replace_all === true,
				});
				break;
			case "delete":
				if (!nonEmpty(raw.file_path)) return undefined;
				operations.push({ type: "delete", filePath: raw.file_path });
				break;
			case "move":
				if (!nonEmpty(raw.from_path) || !nonEmpty(raw.to_path)) return undefined;
				operations.push({ type: "move", fromPath: raw.from_path, toPath: raw.to_path });
				break;
			default:
				return undefined;
		}
	}
	return Object.freeze(operations);
}

function fallbackPatchChanges(
	operations: readonly PatchOperation[],
): readonly FileMutationPreviewChange[] {
	return Object.freeze(operations.flatMap((operation) => {
		switch (operation.type) {
			case "add":
				return fallbackMutationPreviewChanges(operation.filePath, "", operation.content);
			case "update":
				return fallbackMutationPreviewChanges(
					operation.filePath,
					operation.oldString,
					operation.newString,
				);
			case "delete":
			case "move":
				return [];
		}
	}));
}

function firstOperationPath(operations: readonly PatchOperation[]): string {
	const first = operations[0];
	if (!first) return "";
	return first.type === "move" ? first.fromPath : first.filePath;
}

function emptyPreparation(): PreparedToolCall {
	return Object.freeze({ fileChanges: Object.freeze([]) });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
