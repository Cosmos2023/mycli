#!/usr/bin/env node

import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const action = process.argv[2];
const target = process.argv[3];

if (!target) throw new Error("ripgrep platform target is required");

const [{ prepareUserRipgrep }, { RIPGREP_TARGETS, isRipgrepTarget, ripgrepOutputPath }] = (
	await Promise.all([
		import("../backend/packages/tools/dist/ripgrep-prepare.js"),
		import("../backend/packages/tools/dist/ripgrep-targets.js"),
	])
);
if (!isRipgrepTarget(target)) throw new Error(`unsupported ripgrep target: ${target}`);
const targetInfo = RIPGREP_TARGETS[target];
const packageRoot = join(root, "npm", "ripgrep", target);
const vendorRoot = join(packageRoot, "vendor");
await validateManifest(packageRoot, targetInfo);

if (action === "clean") {
	await rm(vendorRoot, { recursive: true, force: true });
} else if (action === "stage") {
	await stageRipgrep();
} else {
	throw new Error("usage: stage_ripgrep_platform_package.mjs <stage|clean> <target>");
}

async function stageRipgrep() {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "mycli-platform-ripgrep-"));
	try {
		const prepared = await prepareUserRipgrep({
			destinationRoot: join(temporaryRoot, "ripgrep"),
			downloadAttempts: 3,
			downloadTimeoutMs: 180_000,
			force: true,
			target,
		});
		const outputPath = ripgrepOutputPath(vendorRoot, target);
		const stagedPath = join(dirname(outputPath), `.${basename(outputPath)}.tmp`);
		await rm(vendorRoot, { recursive: true, force: true });
		await mkdir(dirname(outputPath), { recursive: true });
		await copyFile(prepared.path, stagedPath);
		await chmod(stagedPath, 0o755);
		await rename(stagedPath, outputPath);
	} catch (error) {
		await rm(vendorRoot, { recursive: true, force: true });
		throw error;
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

async function validateManifest(rootPath, expected) {
	const manifest = JSON.parse(await readFile(join(rootPath, "package.json"), "utf8"));
	if (
		manifest.name !== expected.npmPackage
		|| manifest.os?.[0] !== expected.npmOs
		|| manifest.cpu?.[0] !== expected.npmCpu
	) {
		throw new Error(`ripgrep platform package manifest mismatch: ${expected.npmPackage}`);
	}
}
