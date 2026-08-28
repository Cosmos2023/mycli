import { readFileSync } from "node:fs";
import { parsePackageVersion } from "@mycli/contracts";

export const INTEGRATIONS_VERSION: string = parsePackageVersion(JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as unknown);
