#!/usr/bin/env node

import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const requestedTarget = process.argv[3];

async function main() {
	const action = process.argv[2];
	const target = requestedTarget;
	if (!target) throw new Error("ripgrep_platform_target_required");
	const [{ prepareUserRipgrep }, { RIPGREP_TARGETS, isRipgrepTarget, ripgrepOutputPath }] = (
		await Promise.all([
			import("../backend/packages/tools/dist/ripgrep/ripgrep-prepare.js"),
			import("../backend/packages/tools/dist/ripgrep/ripgrep-targets.js"),
		])
	);
	if (!isRipgrepTarget(target)) throw new Error("ripgrep_platform_target_unsupported");
	const packageRoot = join(root, "npm", "ripgrep", target);
	const vendorRoot = join(packageRoot, "vendor");
	await validateManifest(packageRoot, RIPGREP_TARGETS[target]);

	if (action === "clean") {
		await rm(vendorRoot, { recursive: true, force: true });
	} else if (action === "stage") {
		await stageRipgrep({ prepareUserRipgrep, ripgrepOutputPath, target, vendorRoot });
	} else {
		throw new Error("ripgrep_platform_action_invalid");
	}
}

async function stageRipgrep({ prepareUserRipgrep, ripgrepOutputPath, target, vendorRoot }) {
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
		throw new Error("ripgrep_platform_manifest_mismatch");
	}
}

function failureKind(error) {
	let current = error;
	for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
		if (typeof current.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(current.code)) {
			return current.code;
		}
		current = current.cause;
	}
	return "unknown";
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : "";
	const detail = /^ripgrep_platform_[a-z_]+$/u.test(message)
		? message
		: `ripgrep_platform_stage_failed: kind=${failureKind(error)}`;
	process.stderr.write(`${detail}\n`);
	process.exitCode = 1;
});
