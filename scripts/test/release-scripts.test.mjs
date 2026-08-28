import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import {
	RELEASE_PACKAGES,
	VERSIONED_PACKAGE_NAMES,
	VERSIONED_PACKAGES,
	VENDORED_WORKSPACE_PACKAGES,
	releaseManifestPath,
} from "../release-config.mjs";
import {
	dependencySpecForVersion,
	isReleaseVersion,
	synchronizeReleaseVersion,
	updateLockfileVersions,
	updateManifestVersions,
} from "../set-release-version.mjs";
import {
	isMissingRegistryVersion,
	parsePublishArguments,
	publishInvocation,
	registryVersionExists,
} from "../publish-release.mjs";
import {
	validateApplicationDependencyClosure,
	validatePublishableManifest,
	validateVendoredManifest,
	validateWindowsHelper,
	verifyReleaseState,
} from "../verify-release.mjs";

test("release versions require canonical semantic version syntax", () => {
	for (const version of ["0.1.0", "2.10.3", "1.0.0-beta.2"]) {
		assert.equal(isReleaseVersion(version), true, version);
	}
	for (const version of ["v0.1.0", "01.0.0", "1.0", "latest", "1.0.0 beta"]) {
		assert.equal(isReleaseVersion(version), false, version);
	}
});

test("manifest and lockfile version transforms preserve dependency intent", () => {
	const manifest = {
		name: "fixture",
		version: "0.1.0",
		dependencies: { "@mycli/core": "0.1.0", "@cosmos2023/mycli": "^0.1.0", external: "^4.0.0" },
		optionalDependencies: { "@cosmos2023/ripgrep-linux-x64": "~0.1.0" },
	};
	const updated = updateManifestVersions(manifest, "0.2.0", VERSIONED_PACKAGE_NAMES);
	assert.equal(updated.version, "0.2.0");
	assert.equal(updated.dependencies["@mycli/core"], "0.2.0");
	assert.equal(updated.dependencies["@cosmos2023/mycli"], "^0.2.0");
	assert.equal(updated.dependencies.external, "^4.0.0");
	assert.equal(updated.optionalDependencies["@cosmos2023/ripgrep-linux-x64"], "~0.2.0");
	assert.equal(manifest.version, "0.1.0");
	assert.equal(updateManifestVersions({}, "0.2.0", VERSIONED_PACKAGE_NAMES).version, "0.2.0");
	assert.equal(dependencySpecForVersion("0.1.0", "0.2.0"), "0.2.0");

	const lockfile = { lockfileVersion: 3, packages: { "": manifest, app: {
		name: "@cosmos2023/mycli",
		version: "0.1.0",
		dependencies: { "@mycli/core": "0.1.0" },
	} } };
	const updatedLockfile = updateLockfileVersions(lockfile, "0.2.0", VERSIONED_PACKAGE_NAMES);
	assert.equal(updatedLockfile.packages.app.version, "0.2.0");
	assert.equal(updatedLockfile.packages.app.dependencies["@mycli/core"], "0.2.0");
	assert.equal(lockfile.packages.app.version, "0.1.0");
});

test("version synchronization updates all release manifests and detects drift", async () => {
	const root = await mkdtemp(join(tmpdir(), "mycli-release-version-"));
	try {
		await writeJson(join(root, "package.json"), {
			name: "fixture-root",
			private: true,
			dependencies: { "@cosmos2023/mycli": "^0.1.0" },
		});
		const lockPackages = {
			"": { dependencies: { "@cosmos2023/mycli": "^0.1.0" } },
		};
		for (const releasePackage of VERSIONED_PACKAGES) {
			const manifestPath = releaseManifestPath(releasePackage, root);
			await mkdir(dirname(manifestPath), { recursive: true });
			const vendored = VENDORED_WORKSPACE_PACKAGES.some(
				({ name }) => name === releasePackage.name,
			);
			await writeJson(manifestPath, {
				name: releasePackage.name,
				version: "0.1.0",
				private: vendored,
				...(vendored ? {} : { publishConfig: { access: "public" } }),
			});
			if (releasePackage.workspace) {
				lockPackages[releasePackage.relativePath] = {
					name: releasePackage.name,
					version: "0.1.0",
				};
			}
		}
		await writeJson(join(root, "package-lock.json"), { lockfileVersion: 3, packages: lockPackages });

		const result = await synchronizeReleaseVersion({ root, version: "0.2.0" });
		assert.equal(result.changed.length, VERSIONED_PACKAGES.length + 2);
		assert.equal((await readJson(join(root, "package.json"))).dependencies["@cosmos2023/mycli"], "^0.2.0");
		assert.equal(
			(await readJson(releaseManifestPath(RELEASE_PACKAGES.at(-1), root))).version,
			"0.2.0",
		);
		await synchronizeReleaseVersion({ root, version: "0.2.0", check: true });
		const appPath = releaseManifestPath(RELEASE_PACKAGES.at(-1), root);
		const app = await readJson(appPath);
		await writeJson(appPath, { ...app, version: "0.1.0" });
		await assert.rejects(
			synchronizeReleaseVersion({ root, version: "0.2.0", check: true }),
			/release_version_drift/u,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("publish manifests must be public and coordinated", () => {
	const releasePackage = RELEASE_PACKAGES[0];
	const valid = {
		name: releasePackage.name,
		version: "0.1.0",
		private: false,
		publishConfig: { access: "public" },
	};
	assert.doesNotThrow(() => validatePublishableManifest(releasePackage, valid, "0.1.0"));
	assert.throws(
		() => validatePublishableManifest(releasePackage, { ...valid, private: true }, "0.1.0"),
		/release_package_is_private/u,
	);
	assert.throws(
		() => validatePublishableManifest(releasePackage, { ...valid, version: "0.2.0" }, "0.1.0"),
		/release_package_version_mismatch/u,
	);
});

test("vendored manifests stay private and the app carries their external dependency closure", () => {
	const releasePackage = VENDORED_WORKSPACE_PACKAGES[0];
	const manifest = {
		name: releasePackage.name,
		version: "0.1.0",
		private: true,
		dependencies: { ajv: "^8.17.1", "@mycli/core": "0.1.0" },
		optionalDependencies: { "@cosmos2023/ripgrep-linux-x64": "0.1.0" },
	};
	assert.doesNotThrow(() => validateVendoredManifest(releasePackage, manifest, "0.1.0"));
	assert.throws(
		() => validateVendoredManifest(releasePackage, { ...manifest, private: false }, "0.1.0"),
		/release_vendored_package_must_be_private/u,
	);
	const vendoredManifests = [{ releasePackage, manifest }];
	assert.doesNotThrow(() => validateApplicationDependencyClosure({
		dependencies: { ajv: "^8.17.1" },
		optionalDependencies: { "@cosmos2023/ripgrep-linux-x64": "0.1.0" },
	}, vendoredManifests));
	assert.throws(
		() => validateApplicationDependencyClosure({ dependencies: {} }, vendoredManifests),
		/release_app_dependency_missing/u,
	);
	assert.throws(
		() => validateApplicationDependencyClosure({
			dependencies: { ajv: "^8.17.1", "@mycli/contracts": "0.1.0" },
			optionalDependencies: { "@cosmos2023/ripgrep-linux-x64": "0.1.0" },
		}, vendoredManifests),
		/release_app_vendored_dependency_exposed/u,
	);
	assert.throws(
		() => validateApplicationDependencyClosure({
			dependencies: { ajv: "^8.17.1" },
			optionalDependencies: { "@cosmos2023/ripgrep-linux-x64": "0.1.0" },
			peerDependencies: { "@mycli/contracts": "0.1.0" },
		}, vendoredManifests),
		/release_app_vendored_dependency_exposed/u,
	);
});

test("publisher defaults to dry-run and guards real publication", () => {
	assert.deepEqual(parsePublishArguments([]), {
		publish: false,
		confirm: undefined,
		provenance: false,
		tag: "latest",
	});
	assert.throws(() => parsePublishArguments(["--publish"]), /confirmation_required/u);
	assert.throws(
		() => parsePublishArguments(["--confirm", "0.1.0"]),
		/confirmation_without_publish/u,
	);
	assert.deepEqual(
		parsePublishArguments(["--publish", "--confirm", "0.1.0", "--provenance", "--tag", "next"]),
		{ publish: true, confirm: "0.1.0", provenance: true, tag: "next" },
	);
});

test("publish invocations preserve dependency order and registry boundary", () => {
	assert.equal(RELEASE_PACKAGES[0].name, "@cosmos2023/ripgrep-darwin-arm64");
	assert.equal(RELEASE_PACKAGES.at(-1).name, "@cosmos2023/mycli");
	const platform = publishInvocation(RELEASE_PACKAGES[0], {
		publish: false,
		provenance: false,
		tag: "latest",
	}, "/repo");
	assert.deepEqual(platform.args, [
		"publish", "--access", "public", "--tag", "latest",
		"--registry", "https://registry.npmjs.org/", "--cache", "/repo/.npm-cache/release",
		"--dry-run",
	]);
	const app = publishInvocation(RELEASE_PACKAGES.at(-1), {
		publish: true,
		provenance: true,
		tag: "latest",
	}, "/repo");
	assert.deepEqual(app.args, [
		"publish", "--workspace", "@cosmos2023/mycli", "--access", "public", "--tag", "latest",
		"--registry", "https://registry.npmjs.org/", "--cache", "/repo/.npm-cache/release",
		"--provenance",
	]);
	assert.equal(isMissingRegistryVersion("npm error code E404"), true);
	assert.equal(isMissingRegistryVersion("npm error code E401"), false);
});

test("registry checks distinguish existing, missing, and failed lookups", async () => {
	assert.equal(await registryVersionExists(
		"@cosmos2023/mycli",
		"0.1.0",
		async () => ({ code: 0, stdout: '"0.1.0"\n', stderr: "" }),
	), true);
	assert.equal(await registryVersionExists(
		"@cosmos2023/mycli",
		"0.1.0",
		async () => ({ code: 1, stdout: "", stderr: "npm error code E404" }),
	), false);
	await assert.rejects(
		registryVersionExists(
			"@cosmos2023/mycli",
			"0.1.0",
			async () => ({ code: 1, stdout: "", stderr: "npm error code E401 npm_secret_value_1234567890" }),
		),
		/release_registry_check_failed.*\[REDACTED\]/u,
	);
});

test("current repository release metadata is valid", async () => {
	const result = await verifyReleaseState();
	assert.equal(result.packageCount, RELEASE_PACKAGES.length);
	assert.equal(result.packageCount, 7);
	assert.equal(result.vendoredPackageCount, 9);
	assert.equal(isReleaseVersion(result.version), true);
	await assert.rejects(
		verifyReleaseState({ tag: "v99.0.0" }),
		/release_tag_version_mismatch/u,
	);
});

test("Windows release helper must be a non-empty PE executable", async () => {
	const root = await mkdtemp(join(tmpdir(), "mycli-release-helper-"));
	try {
		await assert.rejects(validateWindowsHelper(root), /release_windows_sandbox_helper_missing/u);
		const helper = join(root, "backend/packages/tools/native/windows/mycli-windows-sandbox.exe");
		await mkdir(dirname(helper), { recursive: true });
		await writeFile(helper, "not-a-pe", "utf8");
		await assert.rejects(validateWindowsHelper(root), /release_windows_sandbox_helper_invalid/u);
		await writeFile(helper, Buffer.from([0x4d, 0x5a, 0x00]));
		await assert.doesNotReject(validateWindowsHelper(root));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("release workflow keeps publication behind the release gates", async () => {
	const workflow = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
	assert.match(workflow, /environment: npm/u);
	assert.match(workflow, /id-token: write/u);
	assert.match(workflow, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/u);
	assert.match(workflow, /release:verify -- --tag/u);
	assert.match(workflow, /apparmor_restrict_unprivileged_userns=0/u);
	assert.match(workflow, /smoke:package -- --all-platforms --require-windows-helper/u);
	assert.match(workflow, /release:publish -- --confirm/u);
	assert.ok(
		workflow.indexOf("smoke:package -- --all-platforms")
		< workflow.indexOf("release:publish -- --confirm"),
	);
});

test("cross-platform long-history gate seeds the current session schema", async () => {
	const workflow = await readFile(
		new URL("../../.github/workflows/cross-platform.yml", import.meta.url),
		"utf8",
	);
	assert.match(
		workflow,
		/benchmark:long-history -- --profile compact_stress --storage-schema v12/u,
	);

	const root = await mkdtemp(join(tmpdir(), "mycli-long-history-v12-"));
	try {
		await mkdir(join(root, "home"), { recursive: true });
		await mkdir(join(root, "workspace"), { recursive: true });
		const script = fileURLToPath(new URL("../benchmark_long_history_resume.mjs", import.meta.url));
		const result = spawnSync(process.execPath, [
			"--conditions=mycli-source",
			"--import",
			"tsx",
			"--expose-gc",
			script,
			"--profile",
			"blob_smoke",
			"--storage-schema",
			"v12",
			"--seed-only",
			"--fixture-root",
			root,
		], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(typeof JSON.parse(result.stdout).seedMilliseconds, "number");

		const database = new Database(join(root, "home", ".mycli", "sessions.db"), {
			readonly: true,
		});
		try {
			assert.equal(database.prepare("SELECT version FROM schema_version").pluck().get(), 12);
			assert.equal(database.prepare(`
				SELECT COUNT(*) FROM transcript_events WHERE session_id = 'target'
			`).pluck().get(), 195);
			assert.equal(database.prepare(`
				SELECT COUNT(*) FROM transcript_events
				WHERE session_id = 'target' AND event_type = 'compaction'
			`).pluck().get(), 3);
			assert.equal(database.prepare(`
				SELECT COUNT(*) FROM sqlite_master
				WHERE type = 'table' AND name IN (
					'conversation_messages', 'history_items', 'turn_rollouts', 'session_summaries'
				)
			`).pluck().get(), 0);
		} finally {
			database.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("ripgrep package staging reports bounded failures without a Node stack", () => {
	const script = fileURLToPath(new URL("../stage_ripgrep_platform_package.mjs", import.meta.url));
	const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.equal(result.stderr, "ripgrep_platform_target_required\n");
	assert.doesNotMatch(result.stderr, /node:internal|at main|TypeError/u);
});

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
