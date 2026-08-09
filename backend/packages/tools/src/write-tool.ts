import { isAbortError } from "./file-mutation-runtime.ts";
import type { FileMutationRuntime } from "./file-mutation-runtime.ts";
import { hasUnrestrictedFilesystem } from "./execution-policy.ts";
import { WRITE_TOOL_DEFINITION } from "./manifest.ts";
import {
	mutationFailure,
	mutationSuccess,
} from "./mutation-result.ts";
import type {
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
} from "./types.ts";

export interface WriteToolOptions {
	readonly runtime: FileMutationRuntime;
}

export class WriteTool implements ToolAdapter {
	readonly definition = WRITE_TOOL_DEFINITION;
	readonly #runtime: FileMutationRuntime;

	constructor(options: WriteToolOptions) {
		this.#runtime = options.runtime;
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
		const expectedSha256 = typeof argumentsValue.expected_sha256 === "string"
			? argumentsValue.expected_sha256
			: undefined;
		try {
			const outcome = await this.#runtime.write({
				path,
				content,
				...(expectedSha256 ? { expectedSha256 } : {}),
				allowOutsideWorkspace: hasUnrestrictedFilesystem(options.executionPolicy),
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
