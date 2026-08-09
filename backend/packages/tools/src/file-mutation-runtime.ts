import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	open,
	readFile,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import type { FileSnapshot, FileSnapshotStore } from "./file-snapshot-store.ts";
import { createBoundedUnifiedDiff, type BoundedFileDiff } from "./file-diff.ts";
import {
	revalidateWritableWorkspaceFile,
	resolveWritableWorkspaceFile,
	WorkspacePathError,
	type WritableWorkspaceFile,
} from "./path-policy.ts";

const MAX_CONTENT_BYTES = 1_000_000;
const MAX_REPLACEMENT_FILE_BYTES = 1_000_000;
const BINARY_SAMPLE_BYTES = 1_024;
const LINE_NUMBER_PATTERN = /^\s*\d+\t/gm;
const SECRET_PATTERNS = [
	/sk-[A-Za-z0-9_-]{12,}/,
	/(api[_-]?key|secret|token|password)\s*=\s*['"][^'"]{8,}['"]/i,
] as const;

export type MutationErrorKind =
	| "missing_read_snapshot"
	| "stale_read_snapshot"
	| "stale_write_snapshot"
	| "multiple_matches"
	| "string_not_found"
	| "no_op"
	| "edit_existing_content"
	| "not_found"
	| "binary_file"
	| "is_directory"
	| "content_too_large"
	| "file_too_large"
	| "secret_like_content"
	| "invalid_encoding"
	| "permission_denied"
	| "workspace_escape"
	| "invalid_path"
	| "write_failed"
	| "edit_failed";

export class FileMutationError extends Error {
	readonly kind: MutationErrorKind;

	constructor(kind: MutationErrorKind) {
		super(`file_mutation_error: ${kind}`);
		this.name = "FileMutationError";
		this.kind = kind;
	}
}

export interface MutationOutcome extends BoundedFileDiff {
	readonly path: string;
	readonly status: "created" | "overwritten" | "unchanged" | "edited";
	readonly matches?: number;
}

export interface FileMutationRuntimeOptions {
	readonly workspaceRoot: string;
	readonly snapshots: FileSnapshotStore;
	readonly sessionId?: string;
	readonly history?: {
		capture(input: {
			readonly sessionId: string;
			readonly turnId: string;
			readonly toolName: string;
			readonly path: string;
		}): Promise<{ readonly snapshotId: string } | undefined>;
		complete(snapshotId: string): Promise<void>;
		discard(snapshotId: string): Promise<void>;
	};
}

export interface FileMutationHistoryContext {
	readonly turnId: string;
	readonly toolName: string;
}

interface CapturedFile {
	readonly content: string;
	readonly snapshot: FileSnapshot;
	readonly mode: number;
}

export class FileMutationRuntime {
	readonly #workspaceRoot: string;
	readonly #snapshots: FileSnapshotStore;
	readonly #sessionId?: string;
	readonly #history?: FileMutationRuntimeOptions["history"];

	constructor(options: FileMutationRuntimeOptions) {
		this.#workspaceRoot = options.workspaceRoot;
		this.#snapshots = options.snapshots;
		this.#sessionId = options.sessionId;
		this.#history = options.history;
	}

	async write(input: {
		readonly path: string;
		readonly content: string;
		readonly expectedSha256?: string;
		readonly allowOutsideWorkspace?: boolean;
		readonly history?: FileMutationHistoryContext;
		readonly signal: AbortSignal;
	}): Promise<MutationOutcome> {
		assertNotAborted(input.signal);
		const resolved = await this.#resolve(input.path, input.allowOutsideWorkspace);
		const existing = resolved.existed
			? await captureTextFile(resolved.target, resolved.relativePath)
			: undefined;
		validateNewContent(input.content);
		if (input.expectedSha256) {
			if (!existing || existing.snapshot.sha256 !== input.expectedSha256) {
				throw new FileMutationError("stale_write_snapshot");
			}
		}
		if (existing?.content === input.content) {
			return unchangedOutcome(resultPath(resolved.relativePath));
		}
		await mkdir(dirname(resolved.target), { recursive: true });
		const historySnapshotId = await this.#captureHistory(input.path, input.history);
		try {
			await this.#commit({
				rawPath: input.path,
				resolved,
				content: input.content,
				baseline: existing,
				conflictKind: "stale_write_snapshot",
				allowOutsideWorkspace: input.allowOutsideWorkspace,
				signal: input.signal,
			});
		} catch (error) {
			await this.#discardHistory(historySnapshotId);
			throw error;
		}
		await this.#completeHistory(historySnapshotId);
		return changedOutcome(
			resultPath(resolved.relativePath),
			existing ? "overwritten" : "created",
			existing?.content ?? "",
			input.content,
		);
	}

	async replace(input: {
		readonly path: string;
		readonly oldString: string;
		readonly newString: string;
		readonly replaceAll: boolean;
		readonly allowOutsideWorkspace?: boolean;
		readonly history?: FileMutationHistoryContext;
		readonly signal: AbortSignal;
	}): Promise<MutationOutcome> {
		assertNotAborted(input.signal);
		const resolved = await this.#resolve(input.path, input.allowOutsideWorkspace);
		const readSnapshot = this.#snapshots.latest(resolved.relativePath);
		if (!readSnapshot) {
			throw new FileMutationError("missing_read_snapshot");
		}
		if (!resolved.existed) {
			throw new FileMutationError("stale_read_snapshot");
		}
		const existing = await captureTextFile(
			resolved.target,
			resolved.relativePath,
			MAX_REPLACEMENT_FILE_BYTES,
		);
		if (!sameSnapshot(existing.snapshot, readSnapshot)) {
			throw new FileMutationError("stale_read_snapshot");
		}
		validateNewContent(input.newString);
		const oldString = preprocessOldString(input.oldString, resolved.target);
		if (oldString === input.newString) {
			throw new FileMutationError("no_op");
		}

		let content: string;
		let matches: number;
		if (oldString === "") {
			if (existing.content.trim()) {
				throw new FileMutationError("edit_existing_content");
			}
			content = input.newString;
			matches = 1;
		} else {
			matches = countOccurrences(existing.content, oldString);
			if (matches === 0) {
				throw new FileMutationError("string_not_found");
			}
			if (matches > 1 && !input.replaceAll) {
				throw new FileMutationError("multiple_matches");
			}
			content = input.replaceAll
				? existing.content.split(oldString).join(input.newString)
				: replaceFirst(existing.content, oldString, input.newString);
		}

		const historySnapshotId = await this.#captureHistory(input.path, input.history);
		try {
			await this.#commit({
				rawPath: input.path,
				resolved,
				content,
				baseline: existing,
				conflictKind: "stale_read_snapshot",
				allowOutsideWorkspace: input.allowOutsideWorkspace,
				signal: input.signal,
			});
		} catch (error) {
			await this.#discardHistory(historySnapshotId);
			throw error;
		}
		await this.#completeHistory(historySnapshotId);
		return {
			...changedOutcome(resultPath(resolved.relativePath), "edited", existing.content, content),
			matches: input.replaceAll ? matches : 1,
		};
	}

	async #resolve(
		rawPath: string,
		allowOutsideWorkspace: boolean | undefined,
	): Promise<WritableWorkspaceFile> {
		try {
			return await resolveWritableWorkspaceFile(this.#workspaceRoot, rawPath, {
				allowOutsideWorkspace,
			});
		} catch (error) {
			throw mutationErrorFrom(error, "invalid_path");
		}
	}

	async #captureHistory(
		path: string,
		context: FileMutationHistoryContext | undefined,
	): Promise<string | undefined> {
		if (!this.#history || !this.#sessionId || !context) return undefined;
		try {
			return (await this.#history.capture({
				sessionId: this.#sessionId,
				turnId: context.turnId,
				toolName: context.toolName,
				path,
			}))?.snapshotId;
		} catch {
			return undefined;
		}
	}

	async #completeHistory(snapshotId: string | undefined): Promise<void> {
		if (!snapshotId || !this.#history) return;
		await this.#history.complete(snapshotId).catch(() => undefined);
	}

	async #discardHistory(snapshotId: string | undefined): Promise<void> {
		if (!snapshotId || !this.#history) return;
		await this.#history.discard(snapshotId).catch(() => undefined);
	}

	async #commit(input: {
		readonly rawPath: string;
		readonly resolved: WritableWorkspaceFile;
		readonly content: string;
		readonly baseline?: CapturedFile;
		readonly conflictKind: "stale_read_snapshot" | "stale_write_snapshot";
		readonly allowOutsideWorkspace?: boolean;
		readonly signal: AbortSignal;
	}): Promise<void> {
		assertNotAborted(input.signal);
		const temporary = join(
			dirname(input.resolved.target),
			`.${basename(input.resolved.target)}.${randomUUID()}.tmp`,
		);
		let committed = false;
		try {
			const handle = await open(temporary, "wx", input.baseline?.mode ?? 0o666);
			try {
				await handle.writeFile(input.content, "utf8");
				if (input.baseline) {
					await handle.chmod(input.baseline.mode);
				}
				await handle.sync();
			} finally {
				await handle.close();
			}

			await revalidateWritableWorkspaceFile(
				this.#workspaceRoot,
				input.rawPath,
				input.resolved.target,
				{ allowOutsideWorkspace: input.allowOutsideWorkspace },
			);
			await assertBaseline(input.resolved, input.baseline, input.conflictKind);
			assertNotAborted(input.signal);
			await rename(temporary, input.resolved.target);
			committed = true;
		} catch (error) {
			if (isAbortError(error) || error instanceof FileMutationError) {
				throw error;
			}
			throw mutationErrorFrom(error, input.conflictKind === "stale_read_snapshot"
				? "edit_failed"
				: "write_failed");
		} finally {
			if (!committed) {
				await rm(temporary, { force: true }).catch(() => undefined);
			}
		}
	}
}

function resultPath(path: string): string {
	return isAbsolute(path) ? basename(path) : path;
}

async function captureTextFile(
	target: string,
	relativePath: string,
	maxBytes?: number,
): Promise<CapturedFile> {
	try {
		const bytes = await readFile(target);
		if (looksBinary(bytes.subarray(0, BINARY_SAMPLE_BYTES))) {
			throw new FileMutationError("binary_file");
		}
		if (maxBytes !== undefined && bytes.length > maxBytes) {
			throw new FileMutationError("file_too_large");
		}
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new FileMutationError("invalid_encoding");
		}
		const targetStat = await stat(target, { bigint: true });
		return {
			content,
			snapshot: {
				path: relativePath,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				mtimeNs: targetStat.mtimeNs.toString(),
				size: bytes.length,
				capturedAt: new Date().toISOString(),
			},
			mode: Number(targetStat.mode & 0o777n),
		};
	} catch (error) {
		if (error instanceof FileMutationError) {
			throw error;
		}
		throw mutationErrorFrom(error, "not_found");
	}
}

async function assertBaseline(
	resolved: WritableWorkspaceFile,
	baseline: CapturedFile | undefined,
	conflictKind: "stale_read_snapshot" | "stale_write_snapshot",
): Promise<void> {
	if (!baseline) {
		try {
			await stat(resolved.target);
			throw new FileMutationError(conflictKind);
		} catch (error) {
			if (error instanceof FileMutationError) {
				throw error;
			}
			if (hasCode(error, "ENOENT")) {
				return;
			}
			throw mutationErrorFrom(error, conflictKind);
		}
	}
	const current = await captureTextFile(resolved.target, resolved.relativePath);
	if (!sameSnapshot(current.snapshot, baseline.snapshot)) {
		throw new FileMutationError(conflictKind);
	}
}

function validateNewContent(content: string): void {
	if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
		throw new FileMutationError("content_too_large");
	}
	if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
		throw new FileMutationError("secret_like_content");
	}
}

function preprocessOldString(value: string, target: string): string {
	const withoutLineNumbers = value.replace(LINE_NUMBER_PATTERN, "");
	return new Set([".md", ".mdx"]).has(extname(target).toLowerCase())
		? withoutLineNumbers
		: withoutLineNumbers.replace(/[ \t\r]+$/, "");
}

function countOccurrences(content: string, needle: string): number {
	let count = 0;
	let offset = 0;
	while (offset <= content.length - needle.length) {
		const found = content.indexOf(needle, offset);
		if (found < 0) break;
		count += 1;
		offset = found + needle.length;
	}
	return count;
}

function replaceFirst(content: string, oldString: string, newString: string): string {
	const index = content.indexOf(oldString);
	return `${content.slice(0, index)}${newString}${content.slice(index + oldString.length)}`;
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
	return left.sha256 === right.sha256
		&& left.mtimeNs === right.mtimeNs
		&& left.size === right.size;
}

function looksBinary(sample: Uint8Array): boolean {
	if (sample.includes(0)) return true;
	if (sample.length === 0) return false;
	const allowedControls = new Set([7, 8, 9, 10, 12, 13, 27]);
	let suspicious = 0;
	for (const byte of sample) {
		if (byte < 32 && !allowedControls.has(byte)) suspicious += 1;
	}
	return suspicious / sample.length > 0.3;
}

function unchangedOutcome(path: string): MutationOutcome {
	return {
		path,
		status: "unchanged",
		diff: "",
		addedLines: 0,
		removedLines: 0,
		truncated: false,
		omittedChars: 0,
	};
}

function changedOutcome(
	path: string,
	status: MutationOutcome["status"],
	before: string,
	after: string,
): MutationOutcome {
	return { path, status, ...createBoundedUnifiedDiff(path, before, after) };
}

function mutationErrorFrom(error: unknown, fallback: MutationErrorKind): FileMutationError {
	if (error instanceof FileMutationError) return error;
	if (error instanceof WorkspacePathError) {
		return new FileMutationError(error.kind as MutationErrorKind);
	}
	if (hasCode(error, "EACCES") || hasCode(error, "EPERM")) {
		return new FileMutationError("permission_denied");
	}
	return new FileMutationError(fallback);
}

export function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function assertNotAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	const error = new Error("mutation interrupted");
	error.name = "AbortError";
	throw error;
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& error.code === code;
}
