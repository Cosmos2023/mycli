import type { FileMutationRuntime } from "./file-mutation-runtime.ts";
import { ExactReplaceTool } from "./edit-tool.ts";
import { PATCH_TOOL_DEFINITION } from "./manifest.ts";

export class PatchTool extends ExactReplaceTool {
	constructor(runtime: FileMutationRuntime) {
		super("Patch", "patched", PATCH_TOOL_DEFINITION, runtime);
	}
}
