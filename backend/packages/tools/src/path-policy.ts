import {
	realpath,
	stat,
} from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	relative,
	resolve,
	sep,
} from "node:path";

export type WorkspacePathErrorKind =
	| "not_found"
	| "permission_denied"
	| "workspace_escape"
	| "is_directory"
	| "invalid_path";

export class WorkspacePathError extends Error {
	readonly kind: WorkspacePathErrorKind;

	constructor(kind: WorkspacePathErrorKind) {
		super(`read_path_error: ${kind}`);
		this.name = "WorkspacePathError";
		this.kind = kind;
	}
}

export interface WritableWorkspaceFile {
	readonly workspaceRoot: string;
	readonly target: string;
	readonly relativePath: string;
	readonly existed: boolean;
}

export interface WorkspacePathResolutionOptions {
	readonly allowOutsideWorkspace?: boolean;
	readonly allowedRoots?: readonly string[];
}

export async function resolveReadableWorkspaceFile(
	workspaceRoot: string,
	rawPath: string,
	options: WorkspacePathResolutionOptions = {},
): Promise<string> {
	if (!rawPath.trim()) {
		throw new WorkspacePathError("invalid_path");
	}
	let realRoot: string;
	let realTarget: string;
	try {
		const unresolvedRoot = resolve(workspaceRoot);
		realRoot = await realpath(unresolvedRoot);
		const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(unresolvedRoot, rawPath);
		if (!options.allowOutsideWorkspace
			&& options.allowedRoots === undefined
			&& isOutside(unresolvedRoot, candidate)) {
			throw new WorkspacePathError("workspace_escape");
		}
		realTarget = await realpath(candidate);
	} catch (error) {
		if (error instanceof WorkspacePathError) {
			throw error;
		}
		throw classifyPathError(error);
	}
	if (!options.allowOutsideWorkspace
		&& !isWithinAllowedRoots(realRoot, realTarget, options.allowedRoots)) {
		throw new WorkspacePathError("workspace_escape");
	}
	try {
		const targetStat = await stat(realTarget);
		if (!targetStat.isFile()) {
			throw new WorkspacePathError("is_directory");
		}
	} catch (error) {
		if (error instanceof WorkspacePathError) {
			throw error;
		}
		throw classifyPathError(error);
	}
	return realTarget;
}

export async function resolveWritableWorkspaceFile(
	workspaceRoot: string,
	rawPath: string,
	options: WorkspacePathResolutionOptions = {},
): Promise<WritableWorkspaceFile> {
	if (!rawPath.trim()) {
		throw new WorkspacePathError("invalid_path");
	}
	let realRoot: string;
	try {
		realRoot = await realpath(resolve(workspaceRoot));
	} catch (error) {
		throw classifyPathError(error);
	}
	const unresolvedRoot = resolve(workspaceRoot);
	const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(unresolvedRoot, rawPath);
	if (!options.allowOutsideWorkspace
		&& options.allowedRoots === undefined
		&& isOutside(unresolvedRoot, candidate)) {
		throw new WorkspacePathError("workspace_escape");
	}
	if (candidate === unresolvedRoot) {
		throw new WorkspacePathError("is_directory");
	}

	const located = await locateWritableTarget(candidate);
	if (!options.allowOutsideWorkspace
		&& !isWithinAllowedRoots(realRoot, located.target, options.allowedRoots)) {
		throw new WorkspacePathError("workspace_escape");
	}
	return {
		workspaceRoot: realRoot,
		target: located.target,
		relativePath: isOutside(realRoot, located.target)
			? located.target
			: relative(realRoot, located.target).split(sep).join("/"),
		existed: located.existed,
	};
}

export async function revalidateWritableWorkspaceFile(
	workspaceRoot: string,
	rawPath: string,
	expectedTarget: string,
	options: WorkspacePathResolutionOptions = {},
): Promise<WritableWorkspaceFile> {
	const current = await resolveWritableWorkspaceFile(workspaceRoot, rawPath, options);
	if (current.target !== resolve(expectedTarget)) {
		throw new WorkspacePathError("workspace_escape");
	}
	return current;
}

async function locateWritableTarget(candidate: string): Promise<{
	readonly target: string;
	readonly existed: boolean;
}> {
	try {
		const target = await realpath(candidate);
		const targetStat = await stat(target);
		if (!targetStat.isFile()) {
			throw new WorkspacePathError("is_directory");
		}
		return { target, existed: true };
	} catch (error) {
		if (error instanceof WorkspacePathError) {
			throw error;
		}
		if (!hasCode(error, "ENOENT")) {
			throw classifyPathError(error);
		}
	}

	const missingSegments: string[] = [];
	let ancestor = candidate;
	while (true) {
		const parent = dirname(ancestor);
		if (parent === ancestor) {
			throw new WorkspacePathError("invalid_path");
		}
		missingSegments.unshift(basename(ancestor));
		ancestor = parent;
		try {
			const realAncestor = await realpath(ancestor);
			const ancestorStat = await stat(realAncestor);
			if (!ancestorStat.isDirectory()) {
				throw new WorkspacePathError("invalid_path");
			}
			return {
				target: resolve(realAncestor, ...missingSegments),
				existed: false,
			};
		} catch (error) {
			if (error instanceof WorkspacePathError) {
				throw error;
			}
			if (!hasCode(error, "ENOENT")) {
				throw classifyPathError(error);
			}
		}
	}
}

function isOutside(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
}

function isWithinAllowedRoots(
	workspaceRoot: string,
	candidate: string,
	allowedRoots: readonly string[] | undefined,
): boolean {
	return !isOutside(workspaceRoot, candidate)
		|| (allowedRoots ?? []).some((root) => !isOutside(resolve(root), candidate));
}

function classifyPathError(error: unknown): WorkspacePathError {
	if (hasCode(error, "ENOENT")) {
		return new WorkspacePathError("not_found");
	}
	if (hasCode(error, "EACCES") || hasCode(error, "EPERM")) {
		return new WorkspacePathError("permission_denied");
	}
	return new WorkspacePathError("invalid_path");
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& error.code === code;
}
