#!/usr/bin/env node

import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
	APPLICATION_RELEASE_PACKAGE,
	RELEASE_ROOT,
	VERSIONED_PACKAGE_NAMES,
	VERSIONED_PACKAGES,
	releaseManifestPath,
} from "./release-config.mjs";

const DEPENDENCY_FIELDS = Object.freeze([
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
]);
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function isReleaseVersion(value) {
	return typeof value === "string" && SEMVER_PATTERN.test(value);
}

export function dependencySpecForVersion(current, version) {
	if (current.startsWith("^")) return `^${version}`;
	if (current.startsWith("~")) return `~${version}`;
	return version;
}

export function updateManifestVersions(manifest, version, internalNames, updateOwnVersion = true) {
	const updated = { ...manifest };
	if (updateOwnVersion) updated.version = version;
	for (const field of DEPENDENCY_FIELDS) {
		const dependencies = manifest[field];
		if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
		const next = { ...dependencies };
		let changed = false;
		for (const [name, spec] of Object.entries(dependencies)) {
			if (!internalNames.has(name) || typeof spec !== "string") continue;
			next[name] = dependencySpecForVersion(spec, version);
			changed = true;
		}
		if (changed) updated[field] = next;
	}
	return updated;
}

export function updateLockfileVersions(lockfile, version, internalNames) {
	const updated = structuredClone(lockfile);
	if (!updated.packages || typeof updated.packages !== "object") {
		throw new Error("release_lockfile_packages_missing");
	}
	for (const packageEntry of Object.values(updated.packages)) {
		if (!packageEntry || typeof packageEntry !== "object" || Array.isArray(packageEntry)) continue;
		if (typeof packageEntry.name === "string" && internalNames.has(packageEntry.name)) {
			packageEntry.version = version;
		}
		const transformed = updateManifestVersions(packageEntry, version, internalNames, false);
		Object.assign(packageEntry, transformed);
	}
	return updated;
}

export async function currentReleaseVersion(root = RELEASE_ROOT) {
	const manifest = await readJson(releaseManifestPath(APPLICATION_RELEASE_PACKAGE, root));
	if (!isReleaseVersion(manifest.version)) throw new Error("release_app_version_invalid");
	return manifest.version;
}

export async function synchronizeReleaseVersion({ root = RELEASE_ROOT, version, check = false }) {
	if (!isReleaseVersion(version)) throw new Error(`invalid_release_version: ${String(version)}`);
	const documents = [];
	const rootManifestPath = join(root, "package.json");
	const rootManifest = await readJson(rootManifestPath);
	documents.push({
		path: rootManifestPath,
		before: rootManifest,
		after: updateManifestVersions(rootManifest, version, VERSIONED_PACKAGE_NAMES, false),
	});
	for (const releasePackage of VERSIONED_PACKAGES) {
		const path = releaseManifestPath(releasePackage, root);
		const manifest = await readJson(path);
		if (manifest.name !== releasePackage.name) {
			throw new Error(`release_package_name_mismatch: ${releasePackage.relativePath}`);
		}
		documents.push({
			path,
			before: manifest,
			after: updateManifestVersions(manifest, version, VERSIONED_PACKAGE_NAMES),
		});
	}
	const lockfilePath = join(root, "package-lock.json");
	const lockfile = await readJson(lockfilePath);
	documents.push({
		path: lockfilePath,
		before: lockfile,
		after: updateLockfileVersions(lockfile, version, VERSIONED_PACKAGE_NAMES),
	});

	const changed = documents.filter(({ before, after }) => !jsonEqual(before, after));
	if (check) {
		if (changed.length > 0) {
			throw new Error(`release_version_drift: ${changed.map(({ path }) => relativePath(root, path)).join(", ")}`);
		}
		return { version, changed: [] };
	}
	for (const document of changed) await writeJsonAtomic(document.path, document.after);
	return { version, changed: changed.map(({ path }) => relativePath(root, path)) };
}

function jsonEqual(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonAtomic(path, value) {
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
	try {
		const source = await stat(path);
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
			encoding: "utf8",
			mode: source.mode & 0o777,
		});
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

function relativePath(root, path) {
	return path.slice(resolve(root).length + 1);
}

function parseArguments(argv) {
	const check = argv.includes("--check");
	const values = argv.filter((value) => value !== "--check");
	if (values.length > 1) throw new Error("usage: set-release-version.mjs [--check] [version]");
	return { check, version: values[0] };
}

async function main() {
	const input = parseArguments(process.argv.slice(2));
	const version = input.version ?? await currentReleaseVersion();
	const result = await synchronizeReleaseVersion({ version, check: input.check });
	if (input.check) {
		process.stdout.write(`Release version ${version} is synchronized.\n`);
	} else if (result.changed.length === 0) {
		process.stdout.write(`Release version is already ${version}.\n`);
	} else {
		process.stdout.write(`Updated release version to ${version}:\n`);
		for (const path of result.changed) process.stdout.write(`- ${path}\n`);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : "release_version_failed"}\n`);
		process.exitCode = 1;
	});
}
