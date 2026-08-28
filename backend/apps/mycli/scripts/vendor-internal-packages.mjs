#!/usr/bin/env node

import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	RELEASE_ROOT,
	VENDORED_WORKSPACE_PACKAGES,
	releasePackagePath,
} from "../../../../scripts/release-config.mjs";

const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VENDOR_ROOT = join(APP_ROOT, "dist", "node_modules");

export async function vendorInternalPackages({
	root = RELEASE_ROOT,
	destination = VENDOR_ROOT,
} = {}) {
	await rm(destination, { recursive: true, force: true });
	for (const releasePackage of VENDORED_WORKSPACE_PACKAGES) {
		const sourceRoot = releasePackagePath(releasePackage, root);
		const manifest = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
		validateVendoredSource(releasePackage, manifest);
		const packageDestination = join(destination, ...releasePackage.name.split("/"));
		await mkdir(packageDestination, { recursive: true });
		await writeFile(
			join(packageDestination, "package.json"),
			`${JSON.stringify(runtimeManifest(manifest), null, 2)}\n`,
			"utf8",
		);
		for (const relativePath of manifest.files) {
			const source = join(sourceRoot, relativePath);
			const metadata = await stat(source).catch(() => undefined);
			if (!metadata) {
				throw new Error(`release_vendored_artifact_missing: ${releasePackage.name}/${relativePath}`);
			}
			await cp(source, join(packageDestination, relativePath), {
				recursive: metadata.isDirectory(),
			});
		}
	}
	return Object.freeze({ packageCount: VENDORED_WORKSPACE_PACKAGES.length, destination });
}

function validateVendoredSource(releasePackage, manifest) {
	if (manifest.name !== releasePackage.name) {
		throw new Error(`release_package_name_mismatch: ${releasePackage.relativePath}`);
	}
	if (manifest.private !== true || manifest.publishConfig !== undefined) {
		throw new Error(`release_vendored_package_must_be_private: ${releasePackage.name}`);
	}
	if (!Array.isArray(manifest.files) || manifest.files.length === 0
		|| manifest.files.some((value) => (
			typeof value !== "string"
			|| !value
			|| isAbsolute(value)
			|| value.split(/[\\/]/u).includes("..")
		))) {
		throw new Error(`release_vendored_files_invalid: ${releasePackage.name}`);
	}
}

function runtimeManifest(manifest) {
	return Object.fromEntries([
		"name",
		"version",
		"private",
		"type",
		"types",
		"exports",
		"engines",
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
	].flatMap((key) => manifest[key] === undefined ? [] : [[key, manifest[key]]]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	vendorInternalPackages().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : "release_vendoring_failed"}\n`);
		process.exitCode = 1;
	});
}
