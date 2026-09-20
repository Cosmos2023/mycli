#!/usr/bin/env node

// Promote the freshly built helper into the packaged tools tree, record its hash,
// and re-vendor the application copy that the M7 smoke loads through
// `backend/apps/mycli/dist/node_modules`. Skipping the vendoring step silently
// tests the previous helper, so it is part of promotion rather than a manual note.
import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { vendorInternalPackages } from "../backend/apps/mycli/scripts/vendor-internal-packages.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SOURCE = join(ROOT, "native/windows-sandbox-helper/build/Release/mycli-windows-sandbox.exe");
const TARGET = join(ROOT, "backend/packages/tools/native/windows/mycli-windows-sandbox.exe");
const MANIFEST = join(ROOT, "backend/packages/tools/native/windows/mycli-windows-sandbox.sha256");

const bytes = await readFile(SOURCE).catch(() => undefined);
if (bytes === undefined) {
	process.stderr.write("windows_sandbox_helper_build_missing\n");
	process.exitCode = 1;
} else {
	await copyFile(SOURCE, TARGET);
	const helperSha256 = createHash("sha256").update(bytes).digest("hex");
	await writeFile(MANIFEST, `${helperSha256}\n`, "utf8");
	const vendored = await vendorInternalPackages();
	process.stdout.write(`${JSON.stringify({
		helper_sha256: helperSha256,
		promoted: "backend/packages/tools/native/windows/mycli-windows-sandbox.exe",
		vendored: vendored.destination,
	})}\n`);
}
