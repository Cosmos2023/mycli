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
import {
	createBoundedUnifiedDiff,
	type BoundedFileDiff,
	type FileDiffLimits,
} from "./file-diff.ts";
import {
	revalidateWritableWorkspaceFile,
	resolveWritableWorkspaceFile,
	WorkspacePathError,
	type WritableWorkspaceFile,
} from "./path-policy.ts";
import type { PreparedMutationGuard } from "../types.ts";

const MAX_CONTENT_BYTES = 1_000_000;
const MAX_REPLACEMENT_FILE_BYTES = 1_000_000;
const MAX_PATCH_TOTAL_BYTES = 8_000_000;
const MAX_PATCH_TARGETS = 128;
const BINARY_SAMPLE_BYTES = 1_024;
const LIVE_PREVIEW_DIFF_LIMITS = Object.freeze({ maxChars: 12_000, maxLines: 500 });
const LINE_NUMBER_PATTERN = /^\s*\d+\t/gm;
const SECRET_PATTERNS = [
	/sk-[A-Za-z0-9_-]{12,}/,
	/(api[_-]?key|secret|token|password)\s*=\s*['"][^'"]{8,}['"]/i,
] as const;

export type MutationErrorKind =
	| "string_not_found"
	| "no_op"
	| "edit_existing_content"
	| "already_exists"
	| "not_found"
	| "binary_file"
	| "is_directory"
	| "content_too_large"
	| "file_too_large"
	| "secret_like_content"
	| "invalid_encoding"
	| "permission_denied"
	| "workspace_escape"
	| "invalid_sandbox_permissions"
	| "invalid_justification"
	| "sandbox_override_not_approved"
	| "invalid_path"
	| "write_failed"
	| "edit_failed"
	| "patch_failed";

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
	readonly status: "created" | "overwritten" | "unchanged" | "edited" | "deleted" | "moved";
	readonly previousPath?: string;
	readonly matches?: number;
}

export type PatchOperation =
	| {
		readonly type: "add";
		readonly filePath: string;
		readonly content: string;
	}
	| {
		readonly type: "update";
		readonly filePath: string;
		readonly oldString: string;
		readonly newString: string;
		readonly replaceAll: boolean;
	}
	| {
		readonly type: "delete";
		readonly filePath: string;
	}
	| {
		readonly type: "move";
		readonly fromPath: string;
		readonly toPath: string;
	};

export interface FileMutationRuntimeOptions {
	readonly workspaceRoot: string;
	readonly snapshots?: FileSnapshotStore;
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

export interface PreparedMutationPreview {
	readonly guard: PreparedMutationGuard;
	readonly outcome: MutationOutcome;
}

export interface PreparedPatchPreview {
	readonly guard: PreparedMutationGuard;
	readonly outcomes: readonly MutationOutcome[];
}

interface CapturedFile {
	readonly content: string;
	readonly snapshot: FileSnapshot;
	readonly mode: number;
}

interface PreparedFileMutation extends PreparedMutationPreview {
	readonly operation: "write" | "replace";
	readonly rawPath: string;
	readonly resolved: WritableWorkspaceFile;
	readonly content: string;
	readonly baseline?: CapturedFile;
	readonly allowOutsideWorkspace?: boolean;
	readonly allowedWritableRoots?: readonly string[];
}

interface PreparedPatchFileChange {
	readonly rawPath: string;
	readonly resolved: WritableWorkspaceFile;
	readonly baseline?: CapturedFile;
	readonly content?: string;
	readonly mode?: number;
}

interface PreparedPatchMutation {
	readonly operation: "patch";
	readonly guard: PreparedMutationGuard;
	readonly changes: readonly PreparedPatchFileChange[];
	readonly outcomes: readonly MutationOutcome[];
	readonly allowOutsideWorkspace?: boolean;
	readonly allowedWritableRoots?: readonly string[];
}

interface VirtualPatchFile {
	rawPath: string;
	readonly resolved: WritableWorkspaceFile;
	readonly baseline?: CapturedFile;
	content?: string;
	mode?: number;
	originPath?: string;
	originTarget?: string;
	matches: number;
}

export class FileMutationRuntime {
	readonly #workspaceRoot: string;
	readonly #sessionId?: string;
	readonly #history?: FileMutationRuntimeOptions["history"];

	constructor(options: FileMutationRuntimeOptions) {
		this.#workspaceRoot = options.workspaceRoot;
		this.#sessionId = options.sessionId;
		this.#history = options.history;
	}

	async previewWrite(input: {
		readonly path: string;
		readonly content: string;
		readonly allowOutsideWorkspace?: boolean;
		readonly allowedWritableRoots?: readonly string[];
		readonly signal: AbortSignal;
	}): Promise<MutationOutcome> {
		return (await this.prepareWrite(input)).outcome;
	}

	async prepareWrite(input: {
		readonly path: string;
		readonly content: string;
		readonly allowOutsideWorkspace?: boolean;
		readonly allowedWritableRoots?: readonly string[];
		readonly signal: AbortSignal;
	}): Promise<PreparedMutationPreview> {
		const prepared = await this.#buildWrite(input);
		return Object.freeze({ guard: prepared.guard, outcome: previewOutcome(prepared) });
	}

	async previewReplace(input: {
		readonly path: string;
		readonly oldString: string;
		readonly newString: string;
		readonly replaceAll: boolean;
		readonly allowOutsideWorkspace?: boolean;
		readonly allowedWritableRoots?: readonly string[];
		readonly signal: AbortSignal;
	}): Promise<MutationOutcome> {
		return (await this.prepareReplace(input)).outcome;
	}

	async prepareReplace(input: {
		readonly path: string;
		readonly oldString: string;
		readonly newString: string;
		readonly replaceAll: boolean;
		readonly allowOutsideWorkspace?: boolean;
		readonly allowedWritableRoots?: readonly string[];
		readonly signal: AbortSignal;
	}): Promise<PreparedMutationPreview> {
		const prepared = await this.#buildReplace(input);
		return Object.freeze({ guard: prepared.guard, outcome: previewOutcome(prepared) });
	}

	async write(input: {
		readonly path: string;
		readonly content: string;
		readonly allowOutsideWorkspace?: boolean;
		readonly allowedWritableRoots?: readonly string[];
		readonly history?: FileMutationHistoryContext;
		readonly signal: AbortSignal;
	}): Promise<MutationOutcome> {
		const prepared = await this.#buildWrite(input);
		return await this.#commitPrepared(prepared, input.history, input.signal);
	}

	async replace(input: {
		readonly path: string;
		readonly oldString: string;
		readonly newString: string;
		readonly replaceAll: boolean;
		readonly allowOutsideWorkspace?: boolean;
		readonly allowedWritableRoots?: readonly string[];
		readonly history?: FileMutationHistoryContext;
		readonly signal: AbortSignal;
	}): Promise<MutationOutcome> {
		const prepared = await this.#buildReplace(input);
		return await this.#commitPrepared(prepared, input.history, input.signal);
	}

	async preparePatch(input: {
		readonly operations: readonly PatchOperation[];
		readonly allowOutsideWorkspace?: boolean;
		readonly allowedWritableRoots?: readonly string[];
		readonly signal: AbortSignal;
	}): Promise<PreparedPatchPreview> {
		const prepared = await this.#buildPatch(input);
		return Object.freeze({
			guard: prepared.guard,
			outcomes: previewPatchOutcomes(prepared),
		});
	}

	async patch(input: {
		readonly operations: readonly PatchOperation[];
		readonly allowOutsideWorkspace?: boolean;
		readonly allowedWritableRoots?: readonly string[];
		readonly history?: FileMutationHistoryContext;
		readonly signal: AbortSignal;
	}): Promise<readonly MutationOutcome[]> {
		const prepared = await this.#buildPatch(input);
		return await this.#commitPatch(prepared, input.history, input.signal);
	}

	async #buildPatch(input: {
		readonly operations: readonly PatchOperation[];
		readonly allowOutsideWorkspace?: boolean;
		readonly allowedWritableRoots?: readonly string[];
		readonly signal: AbortSignal;
	}): Promise<PreparedPatchMutation> {
		assertNotAborted(input.signal);
		if (input.operations.length < 1 || input.operations.length > 64) {
			throw new FileMutationError("invalid_path");
		}
		const files = new Map<string, VirtualPatchFile>();
		let loadedBytes = 0;
		const load = async (rawPath: string): Promise<VirtualPatchFile> => {
			const resolved = await this.#resolve(
				rawPath,
				input.allowOutsideWorkspace,
				input.allowedWritableRoots,
			);
			const cached = files.get(resolved.target);
			if (cached) return cached;
			const baseline = resolved.existed
				? await captureTextFile(
					resolved.target,
					resolved.relativePath,
					MAX_REPLACEMENT_FILE_BYTES,
				)
				: undefined;
			loadedBytes += baseline?.snapshot.size ?? 0;
			if (loadedBytes > MAX_PATCH_TOTAL_BYTES) {
				throw new FileMutationError("file_too_large");
			}
			const virtual: VirtualPatchFile = {
				rawPath,
				resolved,
				...(baseline ? { baseline, content: baseline.content, mode: baseline.mode } : {}),
				matches: 0,
			};
			files.set(resolved.target, virtual);
			if (files.size > MAX_PATCH_TARGETS) {
				throw new FileMutationError("content_too_large");
			}
			return virtual;
		};

		for (const operation of input.operations) {
			assertNotAborted(input.signal);
			switch (operation.type) {
				case "add": {
					const target = await load(operation.filePath);
					if (target.content !== undefined) throw new FileMutationError("already_exists");
					validateNewContent(operation.content);
					target.rawPath = operation.filePath;
					target.content = operation.content;
					break;
				}
				case "update": {
					const target = await load(operation.filePath);
					if (target.content === undefined) throw new FileMutationError("not_found");
					const replacement = exactReplacement(
						target.content,
						target.resolved.target,
						operation.oldString,
						operation.newString,
						operation.replaceAll,
					);
					target.content = replacement.content;
					target.matches += replacement.matches;
					break;
				}
				case "delete": {
					const target = await load(operation.filePath);
					if (target.content === undefined) throw new FileMutationError("not_found");
					target.content = undefined;
					break;
				}
				case "move": {
					const source = await load(operation.fromPath);
					const destination = await load(operation.toPath);
					if (source.resolved.target === destination.resolved.target) {
						throw new FileMutationError("no_op");
					}
					if (source.content === undefined) throw new FileMutationError("not_found");
					if (destination.content !== undefined) throw new FileMutationError("already_exists");
					destination.rawPath = operation.toPath;
					destination.content = source.content;
					destination.mode = source.mode;
					if (source.baseline || source.originPath) {
						destination.originPath = source.originPath
							?? resultPath(source.resolved.relativePath);
						destination.originTarget = source.originTarget ?? source.resolved.target;
					}
					source.content = undefined;
					break;
				}
			}
		}

		const movedSources = new Set([...files.values()]
			.flatMap((file) => file.content !== undefined && file.originTarget ? [file.originTarget] : []));
		const changes: PreparedPatchFileChange[] = [];
		const outcomes: MutationOutcome[] = [];
		const resultBytes = [...files.values()].reduce(
			(total, file) => total + (file.content === undefined
				? 0
				: Buffer.byteLength(file.content, "utf8")),
			0,
		);
		if (resultBytes > MAX_PATCH_TOTAL_BYTES) {
			throw new FileMutationError("content_too_large");
		}
		for (const file of files.values()) {
			const before = file.baseline?.content;
			if (before === file.content) continue;
			changes.push(Object.freeze({
				rawPath: file.rawPath,
				resolved: file.resolved,
				...(file.baseline ? { baseline: file.baseline } : {}),
				...(file.content === undefined ? {} : { content: file.content }),
				...(file.mode === undefined ? {} : { mode: file.mode }),
			}));
			if (movedSources.has(file.resolved.target) && file.content === undefined) continue;
			const path = resultPath(file.resolved.relativePath);
			if (file.content === undefined) {
				outcomes.push(changedOutcome(path, "deleted", before ?? "", ""));
				continue;
			}
			if (file.originPath) {
				const origin = file.originTarget ? files.get(file.originTarget) : undefined;
				outcomes.push(Object.freeze({
					...changedOutcome(path, "moved", origin?.baseline?.content ?? "", file.content),
					previousPath: file.originPath,
					...(file.matches > 0 ? { matches: file.matches } : {}),
				}));
				continue;
			}
			outcomes.push(Object.freeze({
				...changedOutcome(
					path,
					file.baseline ? "overwritten" : "created",
					before ?? "",
					file.content,
				),
				...(file.matches > 0 ? { matches: file.matches } : {}),
			}));
		}
		if (changes.length === 0) throw new FileMutationError("no_op");
		const frozenChanges = Object.freeze(changes);
		return Object.freeze({
			operation: "patch",
			changes: frozenChanges,
			outcomes: Object.freeze(outcomes),
			...(input.allowOutsideWorkspace === undefined
				? {}
				: { allowOutsideWorkspace: input.allowOutsideWorkspace }),
			...(input.allowedWritableRoots === undefined
				? {}
				: { allowedWritableRoots: Object.freeze([...input.allowedWritableRoots]) }),
			guard: createPatchGuard(frozenChanges),
		});
	}

	async #commitPatch(
		prepared: PreparedPatchMutation,
		history: FileMutationHistoryContext | undefined,
		signal: AbortSignal,
	): Promise<readonly MutationOutcome[]> {
		assertNotAborted(signal);
		const snapshots = new Map<PreparedPatchFileChange, string>();
		const completed = new Set<string>();
		try {
			for (const change of prepared.changes) {
				const snapshotId = await this.#captureHistory(change.rawPath, history);
				if (snapshotId) snapshots.set(change, snapshotId);
			}
			const ordered = [
				...prepared.changes.filter((change) => change.content !== undefined),
				...prepared.changes.filter((change) => change.content === undefined),
			];
			for (const change of ordered) {
				assertNotAborted(signal);
				if (change.content === undefined) {
					await this.#commitDelete(
						change,
						prepared.allowOutsideWorkspace,
						prepared.allowedWritableRoots,
						signal,
					);
				} else {
					await this.#commit({
						rawPath: change.rawPath,
						resolved: change.resolved,
						content: change.content,
						baseline: change.baseline,
						failureKind: "patch_failed",
						allowOutsideWorkspace: prepared.allowOutsideWorkspace,
						allowedWritableRoots: prepared.allowedWritableRoots,
						mode: change.mode,
						signal,
					});
				}
				const snapshotId = snapshots.get(change);
				await this.#completeHistory(snapshotId);
				if (snapshotId) completed.add(snapshotId);
			}
			return prepared.outcomes;
		} finally {
			for (const snapshotId of snapshots.values()) {
				if (!completed.has(snapshotId)) await this.#discardHistory(snapshotId);
			}
		}
	}

	async #commitDelete(
		change: PreparedPatchFileChange,
		allowOutsideWorkspace: boolean | undefined,
		allowedWritableRoots: readonly string[] | undefined,
		signal: AbortSignal,
	): Promise<void> {
		const tombstone = join(
			dirname(change.resolved.target),
			`.${basename(change.resolved.target)}.${randomUUID()}.delete`,
		);
		let renamed = false;
		try {
			await revalidateWritableWorkspaceFile(
				this.#workspaceRoot,
				change.rawPath,
				change.resolved.target,
				{ allowOutsideWorkspace, allowedRoots: allowedWritableRoots },
			);
			assertNotAborted(signal);
			await rename(change.resolved.target, tombstone);
			renamed = true;
			await rm(tombstone, { force: true }).catch(() => undefined);
		} catch (error) {
			if (isAbortError(error) || error instanceof FileMutationError) throw error;
			throw mutationErrorFrom(error, "patch_failed");
		} finally {
			if (!renamed) await rm(tombstone, { force: true }).catch(() => undefined);
		}
	}

	async #buildWrite(input: {
		readonly path: string;
		readonly content: string;
		readonly allowOutsideWorkspace?: boolean;
		readonly allowedWritableRoots?: readonly string[];
		readonly signal: AbortSignal;
	}): Promise<PreparedFileMutation> {
		assertNotAborted(input.signal);
		const resolved = await this.#resolve(
			input.path,
			input.allowOutsideWorkspace,
			input.allowedWritableRoots,
		);
		const existing = resolved.existed
			? await captureTextFile(resolved.target, resolved.relativePath)
			: undefined;
		validateNewContent(input.content);
		const path = resultPath(resolved.relativePath);
		const outcome = existing?.content === input.content
			? unchangedOutcome(path)
			: changedOutcome(
				path,
				existing ? "overwritten" : "created",
				existing?.content ?? "",
				input.content,
			);
		return freezePrepared({
			operation: "write",
			rawPath: input.path,
			resolved,
			content: input.content,
			...(existing ? { baseline: existing } : {}),
			...(input.allowOutsideWorkspace === undefined
				? {}
				: { allowOutsideWorkspace: input.allowOutsideWorkspace }),
			...(input.allowedWritableRoots === undefined
				? {}
				: { allowedWritableRoots: Object.freeze([...input.allowedWritableRoots]) }),
			outcome,
			guard: createPreparedGuard("write", resolved, existing, input.content),
		});
	}

	async #buildReplace(input: {
		readonly path: string;
		readonly oldString: string;
		readonly newString: string;
		readonly replaceAll: boolean;
		readonly allowOutsideWorkspace?: boolean;
		readonly allowedWritableRoots?: readonly string[];
		readonly signal: AbortSignal;
	}): Promise<PreparedFileMutation> {
		assertNotAborted(input.signal);
		const resolved = await this.#resolve(
			input.path,
			input.allowOutsideWorkspace,
			input.allowedWritableRoots,
		);
		if (!resolved.existed) throw new FileMutationError("not_found");
		const existing = await captureTextFile(
			resolved.target,
			resolved.relativePath,
			MAX_REPLACEMENT_FILE_BYTES,
		);
		const replacement = exactReplacement(
			existing.content,
			resolved.target,
			input.oldString,
			input.newString,
			input.replaceAll,
		);
		const outcome = {
			...changedOutcome(
				resultPath(resolved.relativePath),
				"edited",
				existing.content,
				replacement.content,
			),
			matches: replacement.matches,
		};
		return freezePrepared({
			operation: "replace",
			rawPath: input.path,
			resolved,
			content: replacement.content,
			baseline: existing,
			...(input.allowOutsideWorkspace === undefined
				? {}
				: { allowOutsideWorkspace: input.allowOutsideWorkspace }),
			...(input.allowedWritableRoots === undefined
				? {}
				: { allowedWritableRoots: Object.freeze([...input.allowedWritableRoots]) }),
			outcome,
			guard: createPreparedGuard("replace", resolved, existing, replacement.content),
		});
	}

	async #commitPrepared(
		prepared: PreparedFileMutation,
		history: FileMutationHistoryContext | undefined,
		signal: AbortSignal,
	): Promise<MutationOutcome> {
		assertNotAborted(signal);
		if (prepared.outcome.status === "unchanged") {
			return prepared.outcome;
		}
		const historySnapshotId = await this.#captureHistory(prepared.rawPath, history);
		try {
			await this.#commit({
				rawPath: prepared.rawPath,
				resolved: prepared.resolved,
				content: prepared.content,
				baseline: prepared.baseline,
				failureKind: prepared.operation === "replace" ? "edit_failed" : "write_failed",
				allowOutsideWorkspace: prepared.allowOutsideWorkspace,
				allowedWritableRoots: prepared.allowedWritableRoots,
				signal,
			});
		} catch (error) {
			await this.#discardHistory(historySnapshotId);
			throw error;
		}
		await this.#completeHistory(historySnapshotId);
		return prepared.outcome;
	}

	async #resolve(
		rawPath: string,
		allowOutsideWorkspace: boolean | undefined,
		allowedWritableRoots: readonly string[] | undefined,
	): Promise<WritableWorkspaceFile> {
		try {
			return await resolveWritableWorkspaceFile(this.#workspaceRoot, rawPath, {
				allowOutsideWorkspace,
				allowedRoots: allowedWritableRoots,
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
		readonly failureKind: "write_failed" | "edit_failed" | "patch_failed";
		readonly allowOutsideWorkspace?: boolean;
		readonly allowedWritableRoots?: readonly string[];
		readonly mode?: number;
		readonly signal: AbortSignal;
	}): Promise<void> {
		assertNotAborted(input.signal);
		const temporary = join(
			dirname(input.resolved.target),
			`.${basename(input.resolved.target)}.${randomUUID()}.tmp`,
		);
		let committed = false;
		try {
			await revalidateWritableWorkspaceFile(
				this.#workspaceRoot,
				input.rawPath,
				input.resolved.target,
				{
					allowOutsideWorkspace: input.allowOutsideWorkspace,
					allowedRoots: input.allowedWritableRoots,
				},
			);
			await mkdir(dirname(input.resolved.target), { recursive: true });
			const handle = await open(temporary, "wx", input.baseline?.mode ?? input.mode ?? 0o666);
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
				{
					allowOutsideWorkspace: input.allowOutsideWorkspace,
					allowedRoots: input.allowedWritableRoots,
				},
			);
			assertNotAborted(input.signal);
			await rename(temporary, input.resolved.target);
			committed = true;
		} catch (error) {
			if (isAbortError(error) || error instanceof FileMutationError) {
				throw error;
			}
			throw mutationErrorFrom(error, input.failureKind);
		} finally {
			if (!committed) {
				await rm(temporary, { force: true }).catch(() => undefined);
			}
		}
	}
}

function freezePrepared(input: PreparedFileMutation): PreparedFileMutation {
	return Object.freeze({
		...input,
		guard: Object.freeze({
			...input.guard,
			targets: Object.freeze(input.guard.targets.map((target) => Object.freeze({ ...target }))),
		}),
		outcome: Object.freeze({ ...input.outcome }),
	});
}

function createPreparedGuard(
	operation: PreparedFileMutation["operation"],
	resolved: WritableWorkspaceFile,
	baseline: CapturedFile | undefined,
	resultContent: string,
): PreparedMutationGuard {
	const pathSha256 = sha256(resolved.target);
	const resultSha256 = sha256(resultContent);
	const intentSha256 = sha256(JSON.stringify({
		operation,
		path_sha256: pathSha256,
		result_sha256: resultSha256,
	}));
	const target = Object.freeze({
		pathSha256,
		existed: baseline !== undefined,
		resultSha256,
	});
	const targets = Object.freeze([target]);
	const mutationId = sha256(JSON.stringify({
		version: 1,
		intent_sha256: intentSha256,
		targets: targets.map((value) => ({
			path_sha256: value.pathSha256,
			existed: value.existed,
			result_sha256: value.resultSha256 ?? null,
		})),
	}));
	return Object.freeze({ version: 1, mutationId, intentSha256, targets });
}

function createPatchGuard(
	changes: readonly PreparedPatchFileChange[],
): PreparedMutationGuard {
	const targets = Object.freeze(changes.map((change) => Object.freeze({
		pathSha256: sha256(change.resolved.target),
		existed: change.baseline !== undefined,
		...(change.content === undefined ? {} : { resultSha256: sha256(change.content) }),
	})).sort((left, right) => left.pathSha256.localeCompare(right.pathSha256)));
	const intentSha256 = sha256(JSON.stringify({
		operation: "patch",
		targets: targets.map((target) => ({
			path_sha256: target.pathSha256,
			result_sha256: target.resultSha256 ?? null,
		})),
	}));
	const mutationId = sha256(JSON.stringify({
		version: 1,
		intent_sha256: intentSha256,
		targets: targets.map((target) => ({
			path_sha256: target.pathSha256,
			existed: target.existed,
			result_sha256: target.resultSha256 ?? null,
		})),
	}));
	return Object.freeze({ version: 1, mutationId, intentSha256, targets });
}

function previewOutcome(prepared: PreparedFileMutation): MutationOutcome {
	if (prepared.outcome.status === "unchanged") return prepared.outcome;
	return Object.freeze({
		...changedOutcome(
			prepared.outcome.path,
			prepared.outcome.status,
			prepared.baseline?.content ?? "",
			prepared.content,
			LIVE_PREVIEW_DIFF_LIMITS,
		),
		...(prepared.outcome.matches === undefined ? {} : { matches: prepared.outcome.matches }),
	});
}

function previewPatchOutcomes(prepared: PreparedPatchMutation): readonly MutationOutcome[] {
	return Object.freeze(prepared.outcomes.map((outcome) => {
		const lines = outcome.diff.split("\n");
		const selectedLines = lines.slice(0, LIVE_PREVIEW_DIFF_LIMITS.maxLines);
		let diff = selectedLines.join("\n");
		if (diff.length > LIVE_PREVIEW_DIFF_LIMITS.maxChars) {
			diff = diff.slice(0, LIVE_PREVIEW_DIFF_LIMITS.maxChars);
		}
		const omittedChars = Math.max(0, outcome.diff.length - diff.length);
		return Object.freeze({
			...outcome,
			diff,
			truncated: outcome.truncated || omittedChars > 0,
			omittedChars: outcome.omittedChars + omittedChars,
		});
	}));
}

function exactReplacement(
	content: string,
	target: string,
	oldValue: string,
	newValue: string,
	replaceAll: boolean,
): { readonly content: string; readonly matches: number } {
	validateNewContent(newValue);
	const oldString = preprocessOldString(oldValue, target);
	if (oldString === newValue) throw new FileMutationError("no_op");
	if (oldString === "") {
		if (content.trim()) throw new FileMutationError("edit_existing_content");
		return { content: newValue, matches: 1 };
	}
	const matches = countOccurrences(content, oldString);
	if (matches === 0) throw new FileMutationError("string_not_found");
	return {
		content: replaceAll
			? content.split(oldString).join(newValue)
			: replaceFirst(content, oldString, newValue),
		matches: replaceAll ? matches : 1,
	};
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
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
	limits?: FileDiffLimits,
): MutationOutcome {
	return { path, status, ...createBoundedUnifiedDiff(path, before, after, limits) };
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
