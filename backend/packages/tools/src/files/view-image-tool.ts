import { join } from "node:path";
import { imageInputUnsupportedResult } from "../registry/tool-error-context.ts";
import type { ToolAdapter, ToolAdapterResult, ToolExecutionOptions } from "../types.ts";
import { hasUnrestrictedFilesystem } from "../policy/execution-policy.ts";
import { VIEW_IMAGE_TOOL_DEFINITION } from "../registry/context-manifest.ts";
import { LocalImageInputError } from "./local-image-loader.ts";
import { loadPromptImage } from "./prompt-image-loader.ts";
import { resolveReadableWorkspaceFile, WorkspacePathError } from "./path-policy.ts";

export interface ViewImageToolOptions {
	readonly workspaceRoot: string;
	readonly homeDir: string;
}

export class ViewImageTool implements ToolAdapter {
	readonly definition = VIEW_IMAGE_TOOL_DEFINITION;
	readonly supportsParallelToolCalls = true;
	readonly #options: ViewImageToolOptions;

	constructor(options: ViewImageToolOptions) {
		this.#options = options;
	}

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		options.signal.throwIfAborted();
		if (options.imageInputSupported === false) {
			return imageInputUnsupportedResult(options);
		}
		const rawPath = argumentsValue.path;
		const detail = argumentsValue.detail === undefined ? "high" : argumentsValue.detail;
		if (detail !== "high" && detail !== "original") {
			return failure("invalid_arguments", "view_image.detail only supports high or original; omit it for default high resized behavior.");
		}
		if (typeof rawPath !== "string" || !rawPath || rawPath.length > 4_096 || rawPath.includes("\0")
			|| (rawPath.startsWith("~") && !rawPath.startsWith("~/") && !rawPath.startsWith("~\\"))) {
			return failure("invalid_arguments", "A valid local image path is required.");
		}
		try {
			const policy = options.executionPolicy;
			const path = await resolveReadableWorkspaceFile(this.#options.workspaceRoot,
				rawPath.startsWith("~/") || rawPath.startsWith("~\\")
					? join(this.#options.homeDir, rawPath.slice(2)) : rawPath, {
					allowOutsideWorkspace: hasUnrestrictedFilesystem(policy),
					deniedReadPolicy: policy,
					...(policy ? { allowedRoots: [...(policy.readableRoots ?? []), ...policy.writableRoots] } : {}),
				});
			options.signal.throwIfAborted();
			const effectiveDetail = detail === "original" && options.imageDetailOriginalSupported === false ? "high" : detail;
			const images = [await loadPromptImage(path, effectiveDetail, options.signal)];
			options.signal.throwIfAborted();
			return {
				success: true, modelOutput: "Local image attached.", summary: "Viewed image", images,
				metadata: { imageCount: images.length, mediaType: images[0]!.mediaType },
			};
		} catch (error) {
			if (options.signal.aborted) throw error;
			if (error instanceof WorkspacePathError) return failure(error.kind, "Image path is not readable within the current filesystem permissions.");
			if (error instanceof LocalImageInputError) return failure("invalid_image", error.message);
			return failure("image_read_failed", "The local image could not be read.");
		}
	}
}

function failure(errorKind: string, message: string): ToolAdapterResult {
	return { success: false, modelOutput: `view_image failed\nError kind: ${errorKind}\n${message}`, summary: "Image unavailable", errorKind, metadata: {} };
}
