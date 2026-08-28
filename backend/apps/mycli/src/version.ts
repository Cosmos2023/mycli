import { readFileSync } from "node:fs";
import { parsePackageVersion } from "@mycli/contracts";

export function parseAppVersion(manifest: unknown): string {
	return parsePackageVersion(manifest);
}

const manifest = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as unknown;

export const MYCLI_VERSION: string = parseAppVersion(manifest);
