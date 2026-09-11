import { READ_TOOL_DEFINITION, type ToolAdapter, type ToolAdapterResult, type ToolExecutionOptions } from "@mycli/tools";
import { readGitReviewFile } from "./git-context.ts";

export class GitReviewReadTool implements ToolAdapter {
	readonly definition = READ_TOOL_DEFINITION;
	readonly supportsParallelToolCalls = true;

	constructor(readonly workspaceRoot: string, readonly revision: string) {}

	async execute(argumentsValue: Readonly<Record<string, unknown>>, options: ToolExecutionOptions): Promise<ToolAdapterResult> {
		const { file_path: path, offset, limit } = argumentsValue;
		if (typeof path !== "string" || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 1
			|| typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0) return failure("invalid_arguments");
		try {
			const content = await readGitReviewFile(this.workspaceRoot, this.revision, path, options.signal);
			if (content.includes("\0")) return failure("unsupported_file_type");
			const lines = content.split(/\r?\n/u);
			if (lines.at(-1) === "") lines.pop();
			const selected = lines.slice(offset - 1, offset - 1 + Math.min(limit, 500));
			const rendered = selected.map((line, index) => `${offset + index}\t${line}`).join("\n");
			const characters = Array.from(rendered);
			const truncated = characters.length > 8_000;
			return {
				success: true, summary: "Read revision file",
				modelOutput: `Revision: ${this.revision}\nPath: ${JSON.stringify(path)}\n${characters.slice(0, 8_000).join("")}${truncated ? "\n[read output truncated]" : ""}`,
				metadata: { revision: this.revision, offset, shown_lines: selected.length, total_lines: lines.length, truncated },
			};
		} catch {
			options.signal.throwIfAborted();
			return failure("revision_file_unavailable");
		}
	}
}

function failure(code: string): ToolAdapterResult {
	return { success: false, summary: "Revision file read failed", modelOutput: code, errorKind: code, metadata: {} };
}
