import { basename, isAbsolute } from "node:path";
import {
	FileMutationError,
	type MutationOutcome,
} from "./file-mutation-runtime.ts";
import type { ToolAdapterResult } from "./types.ts";

const MAX_MODEL_OUTPUT_CHARS = 8_000;

export type MutationToolName = "Write" | "Edit" | "Patch";
export type MutationStatus = MutationOutcome["status"] | "patched";

export function mutationSuccess(
	toolName: MutationToolName,
	outcome: MutationOutcome,
	status: MutationStatus = outcome.status,
): ToolAdapterResult {
	const path = displayMutationPath(outcome.path);
	const metadata = {
		path,
		status,
		...(outcome.matches === undefined ? {} : { matches: outcome.matches }),
		diff: outcome.diff,
		addedLines: outcome.addedLines,
		removedLines: outcome.removedLines,
		diffTruncated: outcome.truncated,
		...(outcome.omittedChars > 0 ? { omittedChars: outcome.omittedChars } : {}),
	};
	return {
		success: true,
		summary: summaryFor(toolName, path),
		modelOutput: (status === "unchanged"
			? `No changes to ${path}`
			: `Success. Updated the following files:\n${status === "created" ? "A" : "M"} ${path}`
		).slice(0, MAX_MODEL_OUTPUT_CHARS),
		metadata,
	};
}

export function mutationFailure(
	toolName: MutationToolName,
	rawPath: string,
	error: unknown,
): ToolAdapterResult {
	const path = displayMutationPath(rawPath);
	const errorKind = error instanceof FileMutationError ? error.kind : "invalid_arguments";
	const modelOutput = [
		`${toolName} failed`,
		`Path: ${path}`,
		`Error kind: ${errorKind}`,
		`Error: ${publicError(errorKind)}`,
	].join("\n").slice(0, MAX_MODEL_OUTPUT_CHARS);
	return {
		success: false,
		summary: `Failed to ${verbFor(toolName)} ${path}`,
		modelOutput,
		errorKind,
		metadata: { path, errorKind },
	};
}

export function displayMutationPath(rawPath: string): string {
	const normalized = rawPath.trim().replaceAll("\\", "/");
	if (!normalized) return "file";
	return (isAbsolute(normalized) || normalized.split("/").includes("..")
		? basename(normalized)
		: normalized).slice(0, 240);
}

function summaryFor(toolName: MutationToolName, path: string): string {
	switch (toolName) {
		case "Write": return `Wrote ${path}`;
		case "Edit": return `Edited ${path}`;
		case "Patch": return `Patched ${path}`;
	}
}

function verbFor(toolName: MutationToolName): string {
	switch (toolName) {
		case "Write": return "write";
		case "Edit": return "edit";
		case "Patch": return "patch";
	}
}

function publicError(kind: string): string {
	switch (kind) {
		case "missing_read_snapshot": return "Read the target file before modifying it.";
		case "stale_read_snapshot": return "The file changed after Read. Read it again and retry.";
		case "stale_write_snapshot": return "The file changed after the expected hash was captured.";
		case "multiple_matches": return "The old string has multiple matches; include more context or use replace_all.";
		case "string_not_found": return "The old string was not found; read the file and retry.";
		case "no_op": return "The requested mutation would not change the file.";
		case "edit_existing_content": return "Empty old_string cannot replace non-empty content.";
		case "not_found": return "The file was not found.";
		case "binary_file": return "Binary files are not supported.";
		case "is_directory": return "The path is a directory.";
		case "content_too_large": return "The new content exceeds the mutation limit.";
		case "file_too_large": return "The file exceeds the exact-replacement limit.";
		case "secret_like_content": return "The new content looks like a secret and was not written.";
		case "invalid_encoding": return "The existing file is not valid UTF-8.";
		case "permission_denied": return "The file cannot be modified with current permissions.";
		case "workspace_escape": return "The path must stay within the workspace.";
		case "invalid_arguments": return "The tool arguments are invalid.";
		default: return "The file mutation failed.";
	}
}
