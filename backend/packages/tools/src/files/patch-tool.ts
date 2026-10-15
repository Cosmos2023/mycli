import type { FileMutationPreviewChange } from "@mycli/core";
import {
	FileMutationError,
	isAbortError,
	type FileMutationRuntime,
	type PatchOperation,
} from "./file-mutation-runtime.ts";
import { resolveFileSandboxAccess } from "./file-sandbox-permissions.ts";
import { PATCH_TOOL_DEFINITION } from "../registry/manifest.ts";
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
} from "../types.ts";

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
		const parsed = parsePatchOperations(argumentsValue.operations);
		if (!parsed.ok) return emptyPreparation();
		const operations = parsed.operations;
		const sandbox = resolveFileSandboxAccess(argumentsValue, options);
		if (sandbox.ok) {
			try {
				const prepared = await this.#runtime.preparePatch({
					operations,
					allowOutsideWorkspace: sandbox.allowOutsideWorkspace,
					allowedWritableRoots: sandbox.allowedWritableRoots,
					deniedReadPolicy: sandbox.deniedReadPolicy,
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
		const parsed = parsePatchOperations(argumentsValue.operations);
		if (!parsed.ok) return mutationFailure("Patch", parsed.path, parsed.failure);
		const operations = parsed.operations;
		const path = firstOperationPath(operations);
		const sandbox = resolveFileSandboxAccess(argumentsValue, options);
		if (!sandbox.ok) {
			return mutationFailure("Patch", path, new FileMutationError(sandbox.errorKind));
		}
		try {
			const outcomes = await this.#runtime.patch({
				operations,
				allowOutsideWorkspace: sandbox.allowOutsideWorkspace,
				allowedWritableRoots: sandbox.allowedWritableRoots,
				deniedReadPolicy: sandbox.deniedReadPolicy,
				history: {
					turnId: options.ownerTurnId ?? options.callId,
					toolName: "Patch",
				},
				signal: options.signal,
			});
			return patchMutationSuccess(outcomes);
		} catch (error) {
			if (isAbortError(error)) throw error;
			return mutationFailure("Patch", path, error, { operationCount: operations.length });
		}
	}
}

type PatchOperationsParse =
	| { readonly ok: true; readonly operations: readonly PatchOperation[] }
	| { readonly ok: false; readonly failure: FileMutationError; readonly path: string };

function parsePatchOperations(value: unknown): PatchOperationsParse {
	if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
		return patchParseFailure("operations must be an array of 1 to 64 entries");
	}
	const operations: PatchOperation[] = [];
	for (const [index, raw] of value.entries()) {
		if (!isRecord(raw)) return patchParseFailure(`operations[${index}] must be an object`);
		const operation = patchOperation(raw);
		if (!operation) {
			return patchParseFailure(unusableOperationHint(raw, index), declaredOperationPath(raw));
		}
		operations.push(operation);
	}
	return { ok: true, operations: Object.freeze(operations) };
}

function patchParseFailure(hint: string, path = ""): PatchOperationsParse {
	return { ok: false, failure: new FileMutationError("invalid_arguments", { hint }), path };
}

function declaredOperationPath(raw: Readonly<Record<string, unknown>>): string {
	if (nonEmpty(raw.file_path)) return raw.file_path;
	return nonEmpty(raw.from_path) ? raw.from_path : "";
}

/**
 * Models routinely omit `type`, or spell it differently, while still sending unambiguous fields;
 * Codex infers the kind the same way. Deletion stays explicit because it destroys a file.
 */
function patchOperation(raw: Readonly<Record<string, unknown>>): PatchOperation | undefined {
	const declared = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : undefined;
	const inferred = declared === undefined || !KNOWN_OPERATION_KINDS.has(declared);
	if (
		(declared === "update" || inferred)
		&& nonEmpty(raw.file_path)
		&& typeof raw.old_string === "string"
		&& typeof raw.new_string === "string"
		&& (raw.replace_all === undefined || typeof raw.replace_all === "boolean")
	) {
		return {
			type: "update",
			filePath: raw.file_path,
			oldString: raw.old_string,
			newString: raw.new_string,
			replaceAll: raw.replace_all === true,
		};
	}
	if ((declared === "add" || inferred) && nonEmpty(raw.file_path) && typeof raw.content === "string") {
		return { type: "add", filePath: raw.file_path, content: raw.content };
	}
	if ((declared === "move" || inferred) && nonEmpty(raw.from_path) && nonEmpty(raw.to_path)) {
		return { type: "move", fromPath: raw.from_path, toPath: raw.to_path };
	}
	if (declared === "delete" && nonEmpty(raw.file_path)) {
		return { type: "delete", filePath: raw.file_path };
	}
	return undefined;
}

function unusableOperationHint(raw: Readonly<Record<string, unknown>>, index: number): string {
	const declared = typeof raw.type === "string" ? raw.type : "missing";
	return `operations[${index}] has type "${declared}" but no usable shape; expected `
		+ "update (file_path, old_string, new_string), add (file_path, content), "
		+ "delete (file_path), or move (from_path, to_path)";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

const KNOWN_OPERATION_KINDS: ReadonlySet<string> = new Set(["add", "update", "delete", "move"]);

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
