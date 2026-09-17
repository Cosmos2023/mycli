import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

// Synchronous approval preflight; the mutation runtime resolves and validates again before commit.
export function canonicalMutationPath(path: string): string | undefined {
	const missing: string[] = [];
	let ancestor = resolve(path);
	while (true) {
		try {
			return resolve(realpathSync.native(ancestor), ...missing);
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return undefined;
			const parent = dirname(ancestor);
			if (parent === ancestor) return undefined;
			missing.unshift(basename(ancestor));
			ancestor = parent;
		}
	}
}
