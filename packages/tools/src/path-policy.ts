import {
	realpath,
	stat,
} from "node:fs/promises";
import {
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

export async function resolveReadableWorkspaceFile(
	workspaceRoot: string,
	rawPath: string,
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
		if (isOutside(unresolvedRoot, candidate)) {
			throw new WorkspacePathError("workspace_escape");
		}
		realTarget = await realpath(candidate);
	} catch (error) {
		if (error instanceof WorkspacePathError) {
			throw error;
		}
		throw classifyPathError(error);
	}
	if (isOutside(realRoot, realTarget)) {
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

function isOutside(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
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
