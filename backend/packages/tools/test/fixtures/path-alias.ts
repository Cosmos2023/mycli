import { symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function createFilePathAlias(target: string, alias: string): Promise<string> {
	if (process.platform === "win32") {
		// Junctions exercise real reparse boundaries without machine-wide symlink privileges.
		await symlink(dirname(target), alias, "junction");
		return join(alias, basename(target));
	}
	await symlink(target, alias, "file");
	return alias;
}
