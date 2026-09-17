import { ProcessSandboxError } from "../sandbox/process-sandbox-error.ts";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { canonicalMutationPath } from "../files/canonical-path.ts";
import { isWithinRoots } from "../path-containment.ts";

export interface DeniedReadPolicy {
	readonly deniedReadRoots?: readonly string[];
	readonly deniedReadGlobs?: readonly string[];
}

export function hasDeniedReads(policy: DeniedReadPolicy): boolean {
	return (policy.deniedReadRoots?.length ?? 0) > 0 || (policy.deniedReadGlobs?.length ?? 0) > 0;
}

export function validateDeniedReadGlobs(globs: readonly string[]): readonly string[] {
	if (globs.length > 256 || globs.some((glob) => !glob.trim() || glob.length > 4_096
		|| /[\0\r\n\\]/u.test(glob) || isAbsolute(glob) || glob.split("/").includes(".."))) {
		throw new TypeError("denied-read globs must be bounded workspace-relative patterns using forward slashes");
	}
	return Object.freeze([...new Set(globs)]);
}

export function deniedReadPath(workspaceRoot: string, candidate: string, policy: DeniedReadPolicy): boolean {
	if (!hasDeniedReads(policy)) return false;
	const target = resolve(workspaceRoot, candidate);
	const canonical = canonicalMutationPath(target);
	if (!canonical) throw new ProcessSandboxError("sandbox_unavailable", "Could not resolve denied-read policy target.");
	const roots = (policy.deniedReadRoots ?? []).map((root) => {
		const value = canonicalMutationPath(resolve(workspaceRoot, root));
		if (!value) throw new ProcessSandboxError("sandbox_unavailable", "Could not resolve denied-read policy root.");
		return value;
	});
	return isWithinRoots(target, roots) || isWithinRoots(canonical, roots)
		|| matchesDeniedGlob(workspaceRoot, target, policy.deniedReadGlobs ?? [])
		|| matchesDeniedGlob(realpathSync.native(workspaceRoot), canonical, policy.deniedReadGlobs ?? []);
}

/** Globs are a bounded snapshot at process launch, including dotfiles. */
export function resolveDeniedReadRoots(workspaceRoot: string, policy: DeniedReadPolicy): readonly string[] {
	const roots = new Set((policy.deniedReadRoots ?? []).map((root) => resolve(workspaceRoot, root)));
	const globs = validateDeniedReadGlobs(policy.deniedReadGlobs ?? []);
	if (globs.length > 0) {
		const pending = [workspaceRoot];
		const deadline = performance.now() + 2_000;
		let inspected = 0;
		while (pending.length > 0) {
			const directory = pending.pop()!;
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				if (++inspected > 50_000 || performance.now() > deadline) {
					throw new ProcessSandboxError("sandbox_unavailable", "Denied-read glob scan exceeded its limit; use explicit denied_read_roots.");
				}
				const target = join(directory, entry.name);
				if (matchesDeniedGlob(workspaceRoot, target, globs)) {
					roots.add(realpathSync.native(target));
				} else if (entry.isDirectory() && !lstatSync(target).isSymbolicLink()) {
					pending.push(target);
				}
				if (roots.size > 1_024) throw new ProcessSandboxError("sandbox_unavailable", "Denied-read match limit exceeded.");
			}
		}
	}
	return Object.freeze([...roots].map((root) => {
		const canonical = canonicalMutationPath(root);
		if (!canonical) throw new ProcessSandboxError("sandbox_unavailable", "Could not resolve denied-read policy root.");
		return canonical;
	}));
}

function matchesDeniedGlob(workspaceRoot: string, target: string, globs: readonly string[]): boolean {
	let current = target;
	while (isWithinRoots(current, [workspaceRoot]) && current !== workspaceRoot) {
		const path = relative(workspaceRoot, current).split(sep).join("/");
		if (globs.some((glob) => process.platform === "win32"
			? matchesGlob(path.toLowerCase(), glob.toLowerCase()) : matchesGlob(path, glob))) return true;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return false;
}
