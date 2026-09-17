import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { readBoundedText } from "../headless/io.ts";
import { HeadlessError, type ReviewTarget } from "../headless/types.ts";

const executeFile = promisify(execFile);
export const MAX_REVIEW_CONTEXT_BYTES = 256 * 1024;
const MAX_REVIEW_FILES = 300;

interface GitReviewContext {
	readonly workspaceRoot: string;
	readonly target: ReviewTarget;
	readonly revision: string;
	readonly baseRevision?: string;
	readonly files: readonly string[];
	readonly diff: string;
	readonly untracked: readonly { readonly path: string; readonly content?: string; readonly symlink?: string; readonly binary?: boolean }[];
}

export async function readGitReviewFile(workspaceRoot: string, revision: string, path: string, signal: AbortSignal): Promise<string> {
	if (!/^[a-f0-9]{40,64}$/u.test(revision)) throw new HeadlessError("review_ref_invalid", 2);
	const rel = relative(workspaceRoot, resolve(workspaceRoot, path));
	if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || path.includes("\0")) throw new HeadlessError("review_path_invalid", 2);
	return git(workspaceRoot, ["cat-file", "blob", `${revision}:${rel.split(sep).join("/")}`], signal);
}

export async function loadGitReviewContext(cwd: string, target: ReviewTarget, signal: AbortSignal): Promise<GitReviewContext> {
	const workspaceRoot = (await git(cwd, ["rev-parse", "--show-toplevel"], signal)).trim();
	const resolveRevision = async (ref: string): Promise<string> => {
		const value = (await git(workspaceRoot, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], signal)).trim();
		if (!/^[a-f0-9]{40,64}$/u.test(value)) throw new HeadlessError("review_ref_invalid", 2);
		return value;
	};
	let revision: string;
	let baseRevision: string | undefined;
	let range: readonly string[];
	if (target.kind === "base") {
		revision = await resolveRevision("HEAD");
		const base = await resolveRevision(target.ref);
		baseRevision = (await git(workspaceRoot, ["merge-base", base, revision], signal)).trim();
		range = [baseRevision, revision];
	} else if (target.kind === "commit") {
		revision = await resolveRevision(target.ref);
		const parents = (await git(workspaceRoot, ["rev-list", "--parents", "-n", "1", revision], signal)).trim().split(" ");
		baseRevision = parents[1] ?? await emptyTree(workspaceRoot, signal);
		range = [baseRevision, revision];
	} else {
		try { revision = await resolveRevision("HEAD"); }
		catch (error) {
			signal.throwIfAborted();
			const head = (await git(workspaceRoot, ["symbolic-ref", "-q", "HEAD"], signal)).trim();
			if (!head.startsWith("refs/heads/")) throw error;
			revision = await emptyTree(workspaceRoot, signal);
		}
		range = [revision];
	}
	const diffOptions = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames"];
	const diff = await git(workspaceRoot, [...diffOptions, "--src-prefix=a/", "--dst-prefix=b/", "--unified=5", ...range, "--"], signal);
	const files = splitPaths(await git(workspaceRoot, [...diffOptions, "--name-only", "-z", ...range, "--"], signal));
	const untracked: { path: string; content?: string; symlink?: string; binary?: boolean }[] = [];
	let contextBytes = Buffer.byteLength(diff);
	if (target.kind === "uncommitted") {
		const paths = splitPaths(await git(workspaceRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--"], signal));
		if (paths.length + files.length > MAX_REVIEW_FILES) throw new HeadlessError("review_context_too_large", 2);
		for (const path of paths) {
			const absolute = resolve(workspaceRoot, path);
			const rel = relative(workspaceRoot, absolute);
			if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new HeadlessError("review_path_invalid", 2);
			const stat = await lstat(absolute);
			if (stat.isSymbolicLink()) untracked.push({ path, symlink: await readlink(absolute) });
			else if (stat.isFile()) {
				if (stat.size + contextBytes > MAX_REVIEW_CONTEXT_BYTES) throw new HeadlessError("review_context_too_large", 2);
				let content: string;
				try { content = await readBoundedText(absolute, MAX_REVIEW_CONTEXT_BYTES, signal); }
				catch (error) {
					if (error instanceof TypeError) { untracked.push({ path, binary: true }); files.push(path); continue; }
					throw error;
				}
				untracked.push(content.includes("\0") ? { path, binary: true } : { path, content });
			} else throw new HeadlessError("review_file_unsupported", 2);
			files.push(path);
			contextBytes += Buffer.byteLength(JSON.stringify(untracked.at(-1)));
			if (contextBytes > MAX_REVIEW_CONTEXT_BYTES) throw new HeadlessError("review_context_too_large", 2);
		}
	}
	if (files.length > MAX_REVIEW_FILES) throw new HeadlessError("review_context_too_large", 2);
	return Object.freeze({ workspaceRoot, target, revision, ...(baseRevision ? { baseRevision } : {}), files: Object.freeze([...new Set(files)]), diff, untracked: Object.freeze(untracked) });
}

async function git(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string> {
	try {
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
		const result = await executeFile("git", ["--no-pager", "-C", cwd, ...args], {
			encoding: "utf8", maxBuffer: MAX_REVIEW_CONTEXT_BYTES, timeout: 15_000,
			signal, windowsHide: true, env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
		});
		return result.stdout;
	} catch (error) {
		signal.throwIfAborted();
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		throw new HeadlessError(code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "review_context_too_large" : "review_git_failed", 2);
	}
}

async function emptyTree(cwd: string, signal: AbortSignal): Promise<string> {
	const format = (await git(cwd, ["rev-parse", "--show-object-format"], signal)).trim();
	if (format !== "sha1" && format !== "sha256") throw new HeadlessError("review_object_format_unsupported", 2);
	return createHash(format).update("tree 0\0").digest("hex");
}

function splitPaths(value: string): string[] { return value.split("\0").filter(Boolean); }

export async function listGitReviewFiles(cwd: string, signal: AbortSignal): Promise<{ readonly workspaceRoot: string; readonly files: readonly string[]; readonly truncated: boolean }> {
	const workspaceRoot = (await git(cwd, ["rev-parse", "--show-toplevel"], signal)).trim();
	const files = splitPaths(await git(workspaceRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--"], signal));
	return { workspaceRoot, files: [...new Set(files)].slice(0, MAX_REVIEW_FILES), truncated: files.length > MAX_REVIEW_FILES };
}

/** Separate index/worktree diffs retain changes that cancel each other relative to HEAD. */
export async function loadGitWorkspaceDiff(cwd: string, signal: AbortSignal): Promise<{ readonly text: string; readonly truncated: boolean }> {
	const context = await loadGitReviewContext(cwd, { kind: "uncommitted" }, signal);
	const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames"];
	const [staged, unstaged] = await Promise.all([
		git(context.workspaceRoot, [...args, "--cached", "--"], signal),
		git(context.workspaceRoot, [...args, "--"], signal),
	]);
	const untracked = context.untracked.map((file) => {
		const path = JSON.stringify(file.path);
		if (file.binary) return `Untracked binary file: ${path}`;
		if (file.symlink !== undefined) return `Untracked symlink: ${path} -> ${JSON.stringify(file.symlink)}`;
		return [`Untracked: ${path}`, `--- /dev/null`, `+++ ${path}`, ...(file.content ?? "").split("\n").map((line) => `+${line}`)].join("\n");
	}).join("\n\n");
	const text = [staged && `Staged changes\n${staged}`, unstaged && `Unstaged changes\n${unstaged}`, untracked].filter(Boolean).join("\n\n") || "No local changes.";
	const bytes = Buffer.from(text);
	const truncated = bytes.length > MAX_REVIEW_CONTEXT_BYTES;
	return { text: truncated ? bytes.subarray(0, MAX_REVIEW_CONTEXT_BYTES).toString("utf8") + "\n[Diff truncated]" : text, truncated };
}
