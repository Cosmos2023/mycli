#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
	APPLICATION_RELEASE_PACKAGE,
	RELEASE_PACKAGES,
	RELEASE_ROOT,
	VERSIONED_PACKAGE_NAMES,
	VENDORED_WORKSPACE_PACKAGES,
	releaseManifestPath,
} from "./release-config.mjs";
import {
	currentReleaseVersion,
	dependencySpecForVersion,
	synchronizeReleaseVersion,
} from "./set-release-version.mjs";

const DEPENDENCY_FIELDS = Object.freeze([
	"dependencies",
	"optionalDependencies",
	"peerDependencies",
]);

export function validateRootManifest(manifest) {
	if (manifest.private !== true) throw new Error("release_root_must_remain_private");
}

export function validatePublishableManifest(releasePackage, manifest, version) {
	if (manifest.name !== releasePackage.name) {
		throw new Error(`release_package_name_mismatch: ${releasePackage.relativePath}`);
	}
	if (manifest.version !== version) {
		throw new Error(`release_package_version_mismatch: ${releasePackage.name}`);
	}
	if (manifest.private !== false) {
		throw new Error(`release_package_is_private: ${releasePackage.name}`);
	}
	if (manifest.publishConfig?.access !== "public") {
		throw new Error(`release_package_access_invalid: ${releasePackage.name}`);
	}
	validateCoordinatedDependencies(releasePackage.name, manifest, version);
}

export function validateVendoredManifest(releasePackage, manifest, version) {
	if (manifest.name !== releasePackage.name) {
		throw new Error(`release_package_name_mismatch: ${releasePackage.relativePath}`);
	}
	if (manifest.version !== version) {
		throw new Error(`release_package_version_mismatch: ${releasePackage.name}`);
	}
	if (manifest.private !== true || manifest.publishConfig !== undefined) {
		throw new Error(`release_vendored_package_must_be_private: ${releasePackage.name}`);
	}
	validateCoordinatedDependencies(releasePackage.name, manifest, version);
}

function validateCoordinatedDependencies(packageName, manifest, version) {
	for (const field of DEPENDENCY_FIELDS) {
		const dependencies = manifest[field];
		if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
		for (const [name, spec] of Object.entries(dependencies)) {
			if (!VERSIONED_PACKAGE_NAMES.has(name) || typeof spec !== "string") continue;
			if (spec !== dependencySpecForVersion(spec, version)) {
				throw new Error(`release_dependency_version_mismatch: ${packageName} -> ${name}`);
			}
		}
	}
}

export function validateApplicationDependencyClosure(appManifest, vendoredManifests) {
	const vendoredNames = new Set(VENDORED_WORKSPACE_PACKAGES.map(({ name }) => name));
	const required = new Map();
	const optional = new Map();
	for (const { releasePackage, manifest } of vendoredManifests) {
		collectDependencies(required, manifest.dependencies, vendoredNames, releasePackage.name);
		collectDependencies(optional, manifest.optionalDependencies, vendoredNames, releasePackage.name);
	}
	for (const name of required.keys()) optional.delete(name);

	const appDependencies = dependencyMap(appManifest.dependencies);
	const appOptionalDependencies = dependencyMap(appManifest.optionalDependencies);
	const appPeerDependencies = dependencyMap(appManifest.peerDependencies);
	for (const name of vendoredNames) {
		if (appDependencies.has(name)
			|| appOptionalDependencies.has(name)
			|| appPeerDependencies.has(name)) {
			throw new Error(`release_app_vendored_dependency_exposed: ${name}`);
		}
	}
	assertDependencyClosure("dependencies", appDependencies, required);
	assertDependencyClosure("optionalDependencies", appOptionalDependencies, optional);
}

function collectDependencies(target, dependencies, vendoredNames, owner) {
	if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) return;
	for (const [name, spec] of Object.entries(dependencies)) {
		if (vendoredNames.has(name)) continue;
		if (typeof spec !== "string") {
			throw new Error(`release_dependency_spec_invalid: ${owner} -> ${name}`);
		}
		const existing = target.get(name);
		if (existing !== undefined && existing !== spec) {
			throw new Error(`release_dependency_spec_conflict: ${name}`);
		}
		target.set(name, spec);
	}
}

function dependencyMap(value) {
	return new Map(
		value && typeof value === "object" && !Array.isArray(value)
			? Object.entries(value).filter((entry) => typeof entry[1] === "string")
			: [],
	);
}

function assertDependencyClosure(field, actual, expected) {
	for (const [name, spec] of expected) {
		if (actual.get(name) !== spec) {
			throw new Error(`release_app_dependency_missing: ${field}.${name}`);
		}
	}
}

export function validatePublishOrder(packageManifests) {
	const position = new Map(RELEASE_PACKAGES.map(({ name }, index) => [name, index]));
	for (const { releasePackage, manifest } of packageManifests) {
		const packagePosition = position.get(releasePackage.name);
		for (const field of DEPENDENCY_FIELDS) {
			const dependencies = manifest[field];
			if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
			for (const dependency of Object.keys(dependencies)) {
				const dependencyPosition = position.get(dependency);
				if (dependencyPosition !== undefined && dependencyPosition >= packagePosition) {
					throw new Error(`release_publish_order_invalid: ${releasePackage.name} -> ${dependency}`);
				}
			}
		}
	}
}

export async function verifyReleaseState({
	root = RELEASE_ROOT,
	tag,
	requireWindowsHelper = false,
} = {}) {
	const version = await currentReleaseVersion(root);
	await synchronizeReleaseVersion({ root, version, check: true });
	const rootManifest = await readJson(join(root, "package.json"));
	validateRootManifest(rootManifest);

	const vendoredManifests = [];
	for (const releasePackage of VENDORED_WORKSPACE_PACKAGES) {
		const manifest = await readJson(releaseManifestPath(releasePackage, root));
		validateVendoredManifest(releasePackage, manifest, version);
		vendoredManifests.push({ releasePackage, manifest });
	}

	const packageManifests = [];
	for (const releasePackage of RELEASE_PACKAGES) {
		const manifest = await readJson(releaseManifestPath(releasePackage, root));
		validatePublishableManifest(releasePackage, manifest, version);
		packageManifests.push({ releasePackage, manifest });
	}
	validatePublishOrder(packageManifests);
	const appManifest = packageManifests.find(
		({ releasePackage }) => releasePackage.name === APPLICATION_RELEASE_PACKAGE.name,
	)?.manifest;
	if (!appManifest) throw new Error("release_app_package_missing");
	validateApplicationDependencyClosure(appManifest, vendoredManifests);

	if (tag !== undefined && tag !== `v${version}`) {
		throw new Error(`release_tag_version_mismatch: expected v${version}, received ${tag}`);
	}
	if (requireWindowsHelper) await validateWindowsHelper(root);
	return {
		version,
		packageCount: packageManifests.length,
		vendoredPackageCount: vendoredManifests.length,
	};
}

export async function validateWindowsHelper(root) {
	const helper = join(root, "backend/packages/tools/native/windows/mycli-windows-sandbox.exe");
	const metadata = await stat(helper).catch(() => undefined);
	if (!metadata?.isFile() || metadata.size < 2) {
		throw new Error("release_windows_sandbox_helper_missing");
	}
	const header = (await readFile(helper)).subarray(0, 2).toString("ascii");
	if (header !== "MZ") throw new Error("release_windows_sandbox_helper_invalid");
}

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

function parseArguments(argv) {
	let tag;
	let requireWindowsHelper = false;
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--require-windows-helper") {
			requireWindowsHelper = true;
			continue;
		}
		if (value === "--tag" && argv[index + 1]) {
			tag = argv[index + 1];
			index += 1;
			continue;
		}
		throw new Error("usage: verify-release.mjs [--tag vX.Y.Z] [--require-windows-helper]");
	}
	return { tag, requireWindowsHelper };
}

async function main() {
	const result = await verifyReleaseState(parseArguments(process.argv.slice(2)));
	process.stdout.write(
		`Verified release ${result.version} (${result.packageCount} publishable packages).\n`,
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : "release_verification_failed"}\n`);
		process.exitCode = 1;
	});
}
