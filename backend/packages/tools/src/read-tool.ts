import { realpath } from "node:fs/promises";
import {
	basename,
	extname,
	isAbsolute,
	relative,
	sep,
} from "node:path";
import type {
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
} from "./types.ts";
import {
	DelimitedReadError,
	readDelimitedFile,
} from "./read-delimited.ts";
import { hasUnrestrictedFilesystem } from "./execution-policy.ts";
import { FileSnapshotStore } from "./file-snapshot-store.ts";
import { READ_TOOL_DEFINITION } from "./manifest.ts";
import {
	resolveReadableWorkspaceFile,
	WorkspacePathError,
} from "./path-policy.ts";
import {
	ReadContentError,
	readTextWindow,
} from "./read-text.ts";

const MAX_MODEL_OUTPUT_CHARS = 8_000;
const UNSUPPORTED_STRUCTURED_EXTENSIONS = new Set([
	".docx",
	".ipynb",
	".pdf",
	".xls",
	".xlsx",
]);

interface Snapshot {
	readonly sha256: string;
	readonly mtimeNs: string;
	readonly size: number;
}

export interface ReadToolOptions {
	readonly workspaceRoot: string;
	readonly snapshots?: FileSnapshotStore;
}

export class ReadTool implements ToolAdapter {
	readonly definition = READ_TOOL_DEFINITION;
	readonly supportsParallelToolCalls = true;
	readonly #workspaceRoot: string;
	readonly #readRanges = new Map<string, Snapshot>();
	readonly #snapshots: FileSnapshotStore;

	constructor(options: ReadToolOptions) {
		this.#workspaceRoot = options.workspaceRoot;
		this.#snapshots = options.snapshots ?? new FileSnapshotStore();
	}

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		const rawPath = typeof argumentsValue.file_path === "string"
			? argumentsValue.file_path
			: "";
		const offset = integerValue(argumentsValue.offset);
		const limit = integerValue(argumentsValue.limit);
		const pages = typeof argumentsValue.pages === "string" ? argumentsValue.pages : undefined;
		if (!rawPath || offset === undefined || limit === undefined) {
			return failure(displayPath(rawPath), "invalid_arguments", "Invalid tool arguments.");
		}

		let target: string;
		let path: string;
		let snapshotPath: string;
		try {
			target = await resolveReadableWorkspaceFile(this.#workspaceRoot, rawPath, {
				allowOutsideWorkspace: hasUnrestrictedFilesystem(options.executionPolicy),
			});
			snapshotPath = await this.#snapshotPath(target);
			path = displayPath(snapshotPath);
		} catch (error) {
			return failureFrom(error, displayPath(rawPath));
		}

		const extension = extname(target).toLowerCase();
		if (UNSUPPORTED_STRUCTURED_EXTENSIONS.has(extension)) {
			return failure(path, "unsupported_file_type", "File type is not supported in Node M3.");
		}

		try {
			const payload = extension === ".csv" || extension === ".tsv"
				? await readDelimitedFile(target, { offset, limit, signal: options.signal })
				: await readTextWindow(target, { offset, limit, signal: options.signal });
			const snapshot = {
				sha256: payload.sha256,
				mtimeNs: payload.mtimeNs,
				size: payload.size,
			};
			this.#snapshots.record({
				path: snapshotPath,
				...snapshot,
				capturedAt: payload.capturedAt,
			});
			const rangeKey = `${snapshotPath}\0${offset}\0${payload.effectiveLimit}\0${pages ?? ""}`;
			const previous = this.#readRanges.get(rangeKey);
			const metadata = readMetadata(path, offset, payload);
			if (previous && sameSnapshot(previous, snapshot)) {
				return {
					success: true,
					summary: `Read ${path} (unchanged duplicate)`,
					modelOutput: boundedOutput([
						"Read succeeded",
						`Path: ${path}`,
						rangeText(offset, payload.shownLines, payload.totalLines),
						"Status: unchanged duplicate",
					], "Note: file is unchanged for this offset/limit; reuse the previous content."),
					metadata: { ...metadata, dedup: true },
				};
			}
			this.#readRanges.set(rangeKey, snapshot);
			return "headers" in payload
				? delimitedSuccess(path, offset, payload, metadata)
				: textSuccess(path, offset, payload, metadata);
		} catch (error) {
			if (isInterrupted(error)) {
				throw error;
			}
			return failureFrom(error, path);
		}
	}

	async #snapshotPath(target: string): Promise<string> {
		const root = await realpath(this.#workspaceRoot);
		const projected = relative(root, target);
		return projected === ".." || projected.startsWith(`..${sep}`) || isAbsolute(projected)
			? target
			: projected.split(sep).join("/");
	}
}

function textSuccess(
	path: string,
	offset: number,
	payload: Awaited<ReturnType<typeof readTextWindow>>,
	metadata: Readonly<Record<string, unknown>>,
): ToolAdapterResult {
	const note = payload.truncated
		? `Note: output truncated; use Read with offset=${offset + payload.shownLines} and limit to continue.`
		: "Note: file read complete.";
	return {
		success: true,
		summary: `Read ${path}`,
		modelOutput: boundedOutput([
			"Read succeeded",
			`Path: ${path}`,
			rangeText(offset, payload.shownLines, payload.totalLines),
		], note, stripContinuation(payload.content)),
		metadata,
	};
}

function delimitedSuccess(
	path: string,
	offset: number,
	payload: Awaited<ReturnType<typeof readDelimitedFile>>,
	metadata: Readonly<Record<string, unknown>>,
): ToolAdapterResult {
	const note = payload.truncated
		? `Note: output truncated; use Read with offset=${offset + payload.shownLines} and limit to continue.`
		: "Note: file read complete.";
	return {
		success: true,
		summary: `Read ${path}`,
		modelOutput: boundedOutput([
			"Read succeeded",
			`Path: ${path}`,
			`Columns: ${payload.headers.join(", ")}`,
			`Rows: ${payload.rows}`,
		], note, payload.content),
		metadata: {
			...metadata,
			rows: payload.rows,
			columns: payload.columns,
		},
	};
}

function readMetadata(
	path: string,
	offset: number,
	payload: Awaited<ReturnType<typeof readTextWindow | typeof readDelimitedFile>>,
): Readonly<Record<string, unknown>> {
	const actualEndLine = payload.shownLines > 0
		? offset + payload.shownLines - 1
		: offset;
	return {
		path,
		offset,
		actualStartLine: offset,
		actualEndLine,
		totalLines: payload.totalLines,
		shownLines: payload.shownLines,
		truncated: payload.truncated,
		...(payload.truncated ? { nextOffset: offset + payload.shownLines } : {}),
		requestedLimit: payload.requestedLimit,
		effectiveLimit: payload.effectiveLimit,
		limitClamped: payload.limitClamped,
		size: payload.size,
		mtimeNs: payload.mtimeNs,
		sha256: payload.sha256,
		capturedAt: payload.capturedAt,
	};
}

function boundedOutput(parts: readonly string[], note: string, content = ""): string {
	const prefix = parts.filter(Boolean).join("\n");
	if (!content.trim()) {
		return `${prefix}\n${note}`.slice(0, MAX_MODEL_OUTPUT_CHARS);
	}
	const fixed = `${prefix}\nOutput:\n\n${note}`;
	const budget = Math.max(0, MAX_MODEL_OUTPUT_CHARS - fixed.length);
	const normalized = content.trimEnd();
	const rendered = normalized.length <= budget
		? normalized
		: `${normalized.slice(0, Math.max(0, budget - 3)).trimEnd()}...`;
	return `${prefix}\nOutput:\n${rendered}\n${note}`;
}

function stripContinuation(content: string): string {
	const lines = content.trimEnd().split("\n");
	if (lines.at(-1)?.startsWith("... (output truncated, showing ")) {
		lines.pop();
	}
	return lines.join("\n");
}

function rangeText(offset: number, shownLines: number, totalLines: number): string {
	const end = shownLines > 0 ? offset + shownLines - 1 : offset;
	return `Range: lines ${offset}-${end} of ${totalLines}`;
}

function failureFrom(error: unknown, path: string): ToolAdapterResult {
	if (error instanceof WorkspacePathError
		|| error instanceof ReadContentError
		|| error instanceof DelimitedReadError) {
		return failure(path, error.kind, publicError(error.kind));
	}
	return failure(path, "read_failed", "File read failed.");
}

function failure(path: string, errorKind: string, message: string): ToolAdapterResult {
	return {
		success: false,
		summary: `Failed to read ${path}`,
		modelOutput: boundedOutput([
			"Read failed",
			`Path: ${path}`,
			`Error kind: ${errorKind}`,
			`Error: ${message}`,
		], ""),
		errorKind,
		metadata: { path, errorKind },
	};
}

function publicError(kind: string): string {
	switch (kind) {
		case "not_found":
			return "File was not found.";
		case "permission_denied":
			return "File cannot be read with current permissions.";
		case "workspace_escape":
			return "Path must stay within the workspace.";
		case "is_directory":
			return "Path is a directory.";
		case "invalid_encoding":
			return "File is not valid UTF-8.";
		case "binary_file":
			return "Binary files are not supported.";
		case "file_too_large":
			return "Structured file exceeds the 8 MiB limit.";
		case "empty_file":
			return "Structured file is empty.";
		default:
			return "File read failed.";
	}
}

function displayPath(rawPath: string): string {
	const normalized = rawPath.trim();
	if (!normalized) {
		return "file";
	}
	return (isAbsolute(normalized) || normalized.includes("..")
		? basename(normalized)
		: normalized).slice(0, 240);
}

function integerValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function sameSnapshot(left: Snapshot, right: Snapshot): boolean {
	return left.sha256 === right.sha256
		&& left.mtimeNs === right.mtimeNs
		&& left.size === right.size;
}

function isInterrupted(error: unknown): boolean {
	return (error instanceof ReadContentError || error instanceof DelimitedReadError)
		&& error.kind === "interrupted";
}
