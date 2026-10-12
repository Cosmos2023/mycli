import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const WORKTREE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const POOL_DIRECTORY = "worktrees";

export type WorktreeErrorCode =
	| "worktree_not_a_repository"
	| "worktree_invalid_name"
	| "worktree_path_exists"
	| "worktree_not_managed"
	| "worktree_current"
	| "worktree_local_changes"
	| "worktree_git_failed";

export class WorktreeError extends Error {
	constructor(readonly code: WorktreeErrorCode, message: string, options?: { readonly cause?: unknown }) {
		super(message, options);
		this.name = "WorktreeError";
	}
}

export interface WorkspaceWorktree {
	/** Absolute path of the linked checkout. */
	readonly path: string;
	/** Name inside the managed pool, unique per repository. */
	readonly name: string;
	/** Branch checked out in the worktree, when it is not detached. */
	readonly branch?: string;
	/** True when this call created the checkout. */
	readonly created: boolean;
}

export interface WorkspaceWorktreeSource {
	readonly workspaceRoot: string;
	readonly homeDir: string;
	readonly signal: AbortSignal;
}

/**
 * Managed checkouts live in one pool under the mycli home, named `<repository>-<name>`, so the
 * user's project tree stays clean and every checkout of one repository is easy to list.
 */
export async function createWorkspaceWorktree(
	input: WorkspaceWorktreeSource & { readonly name?: string; readonly clock?: () => Date },
): Promise<WorkspaceWorktree> {
	const repository = await repositoryIdentity(input.workspaceRoot, input.signal);
	const name = worktreeName(input.name, input.clock?.() ?? new Date());
	const path = join(await ensurePool(input.homeDir), `${repository.name}-${name}`);
	if (existsSync(join(path, ".git"))) {
		return Object.freeze({ path, name, created: false });
	}
	if (existsSync(path)) {
		throw new WorktreeError(
			"worktree_path_exists",
			`${path} already exists and is not a managed worktree.`,
		);
	}
	try {
		await git(repository.root, ["worktree", "add", "-b", name, path], input.signal);
	} catch (error) {
		input.signal.throwIfAborted();
		if (!(error instanceof WorktreeError && error.code === "worktree_git_failed")) throw error;
		// A branch with this name already exists: reuse it instead of failing the command.
		await git(repository.root, ["worktree", "add", path, name], input.signal);
	}
	return Object.freeze({ path, name, branch: name, created: true });
}

/** Lists the managed checkouts of the current repository, name order. */
export async function listWorkspaceWorktrees(
	input: WorkspaceWorktreeSource,
): Promise<readonly WorkspaceWorktree[]> {
	const repository = await repositoryIdentity(input.workspaceRoot, input.signal);
	const prefix = `${repository.name}-`;
	const pool = await canonicalPath(join(input.homeDir, POOL_DIRECTORY));
	const output = await git(repository.root, ["worktree", "list", "--porcelain", "-z"], input.signal);
	const worktrees: WorkspaceWorktree[] = [];
	for (const block of output.split("\0\0")) {
		const fields = block.split("\0");
		const path = fieldValue(fields, "worktree ");
		if (!path || !existsSync(join(path, ".git"))) continue;
		const canonical = await canonicalPath(path);
		if (!isInside(pool, canonical) || !basename(canonical).startsWith(prefix)) continue;
		const branch = fieldValue(fields, "branch ");
		worktrees.push(Object.freeze({
			path: canonical,
			name: basename(canonical).slice(prefix.length),
			...(branch ? { branch: branch.replace(/^refs\/heads\//u, "") } : {}),
			created: false,
		}));
	}
	return Object.freeze(worktrees.sort((left, right) => left.name.localeCompare(right.name)));
}

/**
 * Removes one managed checkout. Local changes are refused so a delete can never lose work, and the
 * checkout that owns the current session is refused so the session keeps a valid workspace.
 */
export async function removeWorkspaceWorktree(
	input: WorkspaceWorktreeSource & { readonly path: string },
): Promise<void> {
	const repository = await repositoryIdentity(input.workspaceRoot, input.signal);
	const managed = await listWorkspaceWorktrees(input);
	const requested = await canonicalPath(input.path);
	const target = managed.find((worktree) => worktree.path === requested);
	if (!target) {
		throw new WorktreeError(
			"worktree_not_managed",
			`${input.path} is not a managed worktree of this repository.`,
		);
	}
	if (isInside(target.path, await canonicalPath(input.workspaceRoot))) {
		throw new WorktreeError(
			"worktree_current",
			"Switch to another checkout before deleting this worktree.",
		);
	}
	if (!await isCleanCheckout(target.path, input.signal)) {
		throw new WorktreeError(
			"worktree_local_changes",
			"This worktree still has local changes or ignored files. Commit or remove them first.",
		);
	}
	await git(repository.root, ["worktree", "remove", target.path], input.signal);
}

/** An unreadable status counts as dirty: refusing is the only direction that cannot lose work. */
async function isCleanCheckout(path: string, signal: AbortSignal): Promise<boolean> {
	try {
		return (await git(path, ["status", "--porcelain", "--ignored"], signal)).trim() === "";
	} catch (error) {
		signal.throwIfAborted();
		if (error instanceof WorktreeError) return false;
		throw error;
	}
}

/**
 * A linked checkout reports its own directory as the top level, so the pool name has to come from
 * the shared Git directory instead: that name is stable for every checkout of one repository.
 */
async function repositoryIdentity(
	workspaceRoot: string,
	signal: AbortSignal,
): Promise<{ readonly root: string; readonly name: string }> {
	const root = await repositoryRoot(workspaceRoot, signal);
	const common = (await git(root, ["rev-parse", "--git-common-dir"], signal)).trim();
	const mainRoot = common ? dirname(resolve(root, common)) : root;
	return { root, name: basename(mainRoot) };
}

async function repositoryRoot(workspaceRoot: string, signal: AbortSignal): Promise<string> {
	let root: string;
	try {
		root = (await git(workspaceRoot, ["rev-parse", "--show-toplevel"], signal)).trim();
	} catch (error) {
		signal.throwIfAborted();
		// A missing Git binary is an environment failure, not a workspace that lacks a repository.
		if (error instanceof WorktreeError && isMissingExecutable(error.cause)) throw error;
		throw new WorktreeError(
			"worktree_not_a_repository",
			"The workspace is not inside a Git repository.",
		);
	}
	if (!root) {
		throw new WorktreeError(
			"worktree_not_a_repository",
			"The workspace is not inside a Git repository.",
		);
	}
	return root;
}

function isMissingExecutable(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Creates the pool when needed and returns its canonical path. */
async function ensurePool(homeDir: string): Promise<string> {
	const pool = join(homeDir, POOL_DIRECTORY);
	await mkdir(pool, { recursive: true });
	if (process.platform === "darwin") {
		// Managed checkouts are disposable build trees; keep Spotlight out of them.
		await writeFile(join(pool, ".metadata_never_index"), "")
			.catch(() => undefined);
	}
	return canonicalPath(pool);
}

/** Git prints resolved paths, so the pool has to be resolved too or a symlinked home never matches. */
async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

function worktreeName(name: string | undefined, now: Date): string {
	const trimmed = name?.trim() ?? "";
	if (!trimmed) {
		const stamp = now.toISOString().replace(/[^0-9]/gu, "").slice(0, 14);
		return `wt-${stamp}`;
	}
	if (!WORKTREE_NAME.test(trimmed)) {
		throw new WorktreeError(
			"worktree_invalid_name",
			"Worktree names start with a letter or digit and use only letters, digits, '.', '_' or '-'.",
		);
	}
	return trimmed;
}

function fieldValue(fields: readonly string[], prefix: string): string | undefined {
	return fields.find((candidate) => candidate.startsWith(prefix))?.slice(prefix.length);
}

function isInside(parent: string, child: string): boolean {
	const path = relative(resolve(parent), resolve(child));
	return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

async function git(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string> {
	try {
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
		);
		const result = await executeFile("git", ["--no-pager", "-C", cwd, ...args], {
			encoding: "utf8",
			maxBuffer: MAX_GIT_OUTPUT_BYTES,
			timeout: GIT_TIMEOUT_MS,
			signal,
			windowsHide: true,
			env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
		});
		return result.stdout;
	} catch (error) {
		signal.throwIfAborted();
		throw new WorktreeError(
			"worktree_git_failed",
			"Unable to run git for this worktree.",
			{ cause: error },
		);
	}
}
