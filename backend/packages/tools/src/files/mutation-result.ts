import { basename, isAbsolute } from "node:path";
import type { FileMutationPreviewChange } from "@mycli/core";
import {
	FileMutationError,
	type MutationOutcome,
} from "./file-mutation-runtime.ts";
import type { ToolAdapterResult } from "../types.ts";
import { createBoundedUnifiedDiff } from "./file-diff.ts";

const MAX_MODEL_OUTPUT_CHARS = 8_000;
const LIVE_PREVIEW_DIFF_LIMITS = Object.freeze({ maxChars: 12_000, maxLines: 500 });

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

export function patchMutationSuccess(
	outcomes: readonly MutationOutcome[],
): ToolAdapterResult {
	const fileChanges = Object.freeze(outcomes.flatMap((outcome) => mutationPreviewChanges(outcome)));
	const paths = outcomes.map((outcome) => displayMutationPath(outcome.path));
	const modelOutput = [
		"Success. Updated the following files:",
		...outcomes.map((outcome) => {
			const path = displayMutationPath(outcome.path);
			if (outcome.status === "created") return `A ${path}`;
			if (outcome.status === "deleted") return `D ${path}`;
			if (outcome.status === "moved") {
				return `R ${displayMutationPath(outcome.previousPath ?? "file")} -> ${path}`;
			}
			return `M ${path}`;
		}),
	].join("\n").slice(0, MAX_MODEL_OUTPUT_CHARS);
	return {
		success: true,
		summary: outcomes.length === 1
			? `Patched ${paths[0] ?? "file"}`
			: `Patched ${outcomes.length} files`,
		modelOutput,
		metadata: Object.freeze({
			...(paths[0] ? { path: paths[0] } : {}),
			status: "patched",
			matches: outcomes.reduce((total, outcome) => total + (outcome.matches ?? 0), 0),
			fileChanges,
		}),
	};
}

export function patchMutationPreviewChanges(
	outcomes: readonly MutationOutcome[],
): readonly FileMutationPreviewChange[] {
	return Object.freeze(outcomes.flatMap((outcome) => mutationPreviewChanges(outcome)));
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

export function mutationPreviewChanges(
	outcome: MutationOutcome,
): readonly FileMutationPreviewChange[] {
	if (outcome.status === "unchanged" || (!outcome.diff && outcome.status !== "moved")) {
		return Object.freeze([]);
	}
	return freezePreviewChange({
		kind: outcome.status === "created"
			? "add"
			: outcome.status === "deleted"
				? "delete"
				: outcome.status === "moved"
					? "move"
					: "update",
		path: outcome.path,
		...(outcome.previousPath ? { previousPath: outcome.previousPath } : {}),
		diff: outcome.diff,
		addedLines: outcome.addedLines,
		removedLines: outcome.removedLines,
		truncated: outcome.truncated,
		omittedChars: outcome.omittedChars,
	});
}

export function fallbackMutationPreviewChanges(
	rawPath: string,
	before: string,
	after: string,
): readonly FileMutationPreviewChange[] {
	const path = displayMutationPath(rawPath);
	const outcome = createBoundedUnifiedDiff(path, before, after, LIVE_PREVIEW_DIFF_LIMITS);
	if (!outcome.diff) return Object.freeze([]);
	return freezePreviewChange({
		kind: "update",
		path,
		...outcome,
	});
}

function freezePreviewChange(
	change: Omit<FileMutationPreviewChange, "version">,
): readonly FileMutationPreviewChange[] {
	return Object.freeze([Object.freeze({ version: 1 as const, ...change })]);
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
		case "string_not_found": return "The old string was not found in the current file content.";
		case "no_op": return "The requested mutation would not change the file.";
		case "edit_existing_content": return "Empty old_string cannot replace non-empty content.";
		case "already_exists": return "The destination file already exists.";
		case "not_found": return "The file was not found.";
		case "binary_file": return "Binary files are not supported.";
		case "is_directory": return "The path is a directory.";
		case "content_too_large": return "The new content exceeds the mutation limit.";
		case "file_too_large": return "The file exceeds the exact-replacement limit.";
		case "secret_like_content": return "The new content looks like a secret and was not written.";
		case "invalid_encoding": return "The existing file is not valid UTF-8.";
		case "permission_denied": return "The file cannot be modified with current permissions.";
		case "workspace_escape": return "The path must stay within the workspace.";
		case "invalid_sandbox_permissions": return "The requested file sandbox permission is invalid.";
		case "invalid_justification": return "danger-full-access requires a bounded non-empty justification.";
		case "sandbox_override_not_approved": return "The file sandbox override was not approved by the runtime.";
		case "invalid_arguments": return "The tool arguments are invalid.";
		default: return "The file mutation failed.";
	}
}
