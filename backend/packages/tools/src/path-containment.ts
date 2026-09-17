import { isAbsolute, relative, sep } from "node:path";

export function isOutside(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
}

// The roots are a complete allowlist. An empty list grants no access.
export function isWithinRoots(candidate: string, roots: readonly string[]): boolean {
	return roots.some((root) => !isOutside(root, candidate));
}
