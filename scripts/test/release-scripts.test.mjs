import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import Database from "better-sqlite3";
import {
	APPLICATION_RELEASE_PACKAGE,
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
import {
	loadCompatibilityPolicy,
	validateCompatibilityPolicy,
	verifyReleaseCompatibility,
} from "../verify-release-compatibility.mjs";
import {
	commandFailureCode,
	isExternalBlocker,
	isExternalBlockerCode,
	parseArguments as parseCompatibilitySmokeArguments,
} from "../smoke_release_compatibility.mjs";
import {
	canonicalProviderChecks,
	CURATED_LIVE_PROVIDER_IDS,
	parseArguments as parseProviderSmokeArguments,
	runCuratedProviderSmoke,
} from "../smoke_curated_providers.mjs";

test("curated provider live smoke accepts only the closed provider set", () => {
	assert.deepEqual(parseProviderSmokeArguments([]).providers, CURATED_LIVE_PROVIDER_IDS);
	assert.deepEqual(
		parseProviderSmokeArguments(["--provider", "groq", "--provider", "nvidia"]).providers,
		["groq", "nvidia"],
	);
	assert.throws(
		() => parseProviderSmokeArguments(["--provider", "google"]),
		/unsupported_provider/u,
	);
});

test("curated provider live smoke validates redacted canonical evidence", async () => {
	const secret = "private-provider-smoke-sentinel";
	const result = await runCuratedProviderSmoke({
		providers: ["groq"],
		dryRun: false,
		help: false,
	}, {
		env: { MYCLI_API_KEY: secret },
		homeDir: "/unused",
		createProvider: () => ({
			async *stream() {
				yield { type: "text_delta", text: "private upstream output" };
				yield {
				type: "provider_state",
				state: {
					provider: "groq",
					value: {
						kind: "pi_ai_assistant",
						version: 2,
						transport: {
							version: 1,
							routeId: "groq",
							catalogProviderId: "groq",
							api: "openai-completions",
							model: "openai/gpt-oss-120b",
							endpointSha256: "a".repeat(64),
						},
					},
				},
				};
				yield { type: "usage", usage: { input_tokens: 4, output_tokens: 1 } };
				yield { type: "completed", responseId: "private-response-id" };
			},
		}),
	});
	assert.equal(result.exitCode, 0);
	assert.equal(result.evidence.status, "passed");
	assert.deepEqual(result.evidence.providers[0].checks, {
		text: true,
		usage: true,
		provider_state: true,
		completion: true,
	});
	assert.equal(JSON.stringify(result.evidence).includes(secret), false);
	assert.equal(JSON.stringify(result.evidence).includes("private upstream output"), false);
	assert.equal(JSON.stringify(result.evidence).includes("private-response-id"), false);
});

test("curated provider live smoke skips missing credentials without traffic", async () => {
	let providerCalls = 0;
	const result = await runCuratedProviderSmoke({
		providers: ["openrouter", "cerebras"],
		dryRun: false,
		help: false,
	}, {
		env: { MYCLI_API_KEY: "must-not-be-reused-for-multiple-providers" },
		homeDir: "/unused",
		readApiKey: async () => undefined,
		createProvider: () => {
			providerCalls += 1;
			throw new Error("provider must not start");
		},
	});
	assert.equal(result.exitCode, 77);
	assert.equal(result.evidence.status, "skipped");
	assert.equal(providerCalls, 0);
});

test("canonical provider checks reject mismatched replay identity and duplicate completion", () => {
	assert.deepEqual(canonicalProviderChecks([
		{ type: "text_delta", text: "OK" },
		{ type: "usage", usage: { total_tokens: 1 } },
		{
			type: "provider_state",
			state: {
				provider: "groq",
				value: {
					kind: "pi_ai_assistant",
					version: 2,
					transport: {
						version: 1,
						routeId: "openrouter",
						catalogProviderId: "groq",
						api: "openai-completions",
						model: "model",
						endpointSha256: "a".repeat(64),
					},
				},
			},
		},
		{ type: "completed" },
		{ type: "completed" },
	], "groq", "model"), {
		text: true,
		usage: true,
		provider_state: false,
		completion: false,
	});
});

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
		dependencies: {
			"@mycli/core": "0.1.0",
			[APPLICATION_RELEASE_PACKAGE.name]: "^0.1.0",
			external: "^4.0.0",
		},
		optionalDependencies: { [RELEASE_PACKAGES[2].name]: "~0.1.0" },
	};
	const updated = updateManifestVersions(manifest, "0.2.0", VERSIONED_PACKAGE_NAMES);
	assert.equal(updated.version, "0.2.0");
	assert.equal(updated.dependencies["@mycli/core"], "0.2.0");
	assert.equal(updated.dependencies[APPLICATION_RELEASE_PACKAGE.name], "^0.2.0");
	assert.equal(updated.dependencies.external, "^4.0.0");
	assert.equal(updated.optionalDependencies[RELEASE_PACKAGES[2].name], "~0.2.0");
	assert.equal(manifest.version, "0.1.0");
	assert.equal(updateManifestVersions({}, "0.2.0", VERSIONED_PACKAGE_NAMES).version, "0.2.0");
	assert.equal(dependencySpecForVersion("0.1.0", "0.2.0"), "0.2.0");

	const lockfile = { lockfileVersion: 3, packages: { "": manifest, app: {
		name: APPLICATION_RELEASE_PACKAGE.name,
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
			dependencies: { [APPLICATION_RELEASE_PACKAGE.name]: "^0.1.0" },
		});
		const lockPackages = {
			"": { dependencies: { [APPLICATION_RELEASE_PACKAGE.name]: "^0.1.0" } },
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
		assert.equal(
			(await readJson(join(root, "package.json"))).dependencies[APPLICATION_RELEASE_PACKAGE.name],
			"^0.2.0",
		);
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
		optionalDependencies: { [RELEASE_PACKAGES[2].name]: "0.1.0" },
	};
	assert.doesNotThrow(() => validateVendoredManifest(releasePackage, manifest, "0.1.0"));
	assert.throws(
		() => validateVendoredManifest(releasePackage, { ...manifest, private: false }, "0.1.0"),
		/release_vendored_package_must_be_private/u,
	);
	const vendoredManifests = [{ releasePackage, manifest }];
	assert.doesNotThrow(() => validateApplicationDependencyClosure({
		dependencies: { ajv: "^8.17.1" },
		optionalDependencies: { [RELEASE_PACKAGES[2].name]: "0.1.0" },
	}, vendoredManifests));
	assert.throws(
		() => validateApplicationDependencyClosure({ dependencies: {} }, vendoredManifests),
		/release_app_dependency_missing/u,
	);
	assert.throws(
		() => validateApplicationDependencyClosure({
			dependencies: { ajv: "^8.17.1", "@mycli/contracts": "0.1.0" },
			optionalDependencies: { [RELEASE_PACKAGES[2].name]: "0.1.0" },
		}, vendoredManifests),
		/release_app_vendored_dependency_exposed/u,
	);
	assert.throws(
		() => validateApplicationDependencyClosure({
			dependencies: { ajv: "^8.17.1" },
			optionalDependencies: { [RELEASE_PACKAGES[2].name]: "0.1.0" },
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
		APPLICATION_RELEASE_PACKAGE.name,
		"0.1.0",
		async () => ({ code: 0, stdout: '"0.1.0"\n', stderr: "" }),
	), true);
	assert.equal(await registryVersionExists(
		APPLICATION_RELEASE_PACKAGE.name,
		"0.1.0",
		async () => ({ code: 1, stdout: "", stderr: "npm error code E404" }),
	), false);
	await assert.rejects(
		registryVersionExists(
			APPLICATION_RELEASE_PACKAGE.name,
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
	assert.equal(result.vendoredPackageCount, 10);
	assert.equal(isReleaseVersion(result.version), true);
	await assert.rejects(
		verifyReleaseState({ tag: "v99.0.0" }),
		/release_tag_version_mismatch/u,
	);
});

test("active release and update surfaces contain no retired package identity", async () => {
	const roots = [
		new URL("../../backend/apps/mycli/src/", import.meta.url),
		new URL("../../backend/apps/mycli/test/", import.meta.url),
		new URL("../../backend/packages/config/src/", import.meta.url),
		new URL("../../backend/packages/config/test/", import.meta.url),
		new URL("../../tui/mycli-shell/src/", import.meta.url),
		new URL("../../tui/mycli-shell/test/", import.meta.url),
		new URL("../", import.meta.url),
	];
	const retiredPackage = ["@mycli", "app"].join("/");
	const escapedRetiredPackage = retiredPackage.replace("/", "\\/");
	for (const root of roots) {
		for (const path of await listTextFiles(fileURLToPath(root))) {
			const content = await readFile(path, "utf8");
			assert.equal(content.includes(retiredPackage), false, path);
			assert.equal(content.includes(escapedRetiredPackage), false, path);
		}
	}
});

test("release compatibility policy matches runtime constants and documentation", async () => {
	const result = await verifyReleaseCompatibility();
	assert.equal(result.applicationPackage, "@cosmos2023/mycli");
	assert.equal(result.predecessorPackage, "@cosmos2023/app");
	assert.equal(result.predecessorVersion, "0.1.0");
	assert.equal(result.platformCount, 3);
	assert.equal(result.runtimeSessionSchema, 12);

	const policy = await loadCompatibilityPolicy();
	assert.deepEqual(policy.node.tested, ["22.19.0", "24.x"]);
	assert.deepEqual(policy.platforms.supported, [
		{ id: "darwin", runner: "macos-latest" },
		{ id: "linux", runner: "ubuntu-latest" },
		{ id: "win32", runner: "windows-2022" },
	]);
	assert.deepEqual(policy.model_catalog.readable_formats, ["provider_grouped", "legacy_flat"]);
	assert.equal(policy.deprecations[0].migration_guide, "docs/upgrading.md#package-name-migration");
	assert.equal(policy.documentation.changelog, "CHANGELOG.md");
	assert.equal(policy.documentation.release_notes, "docs/release-notes.md");
	assert.equal(
		policy.documentation.evidence,
		"docs/parity/configuration-ux-release-evidence.md",
	);
});

test("release compatibility policy rejects semantic drift", async () => {
	const policy = await loadCompatibilityPolicy();
	const samePackage = structuredClone(policy);
	samePackage.application.predecessor.package = samePackage.application.package;
	assert.throws(() => validateCompatibilityPolicy(samePackage), /policy_invalid: application/u);

	const missingRuntime = structuredClone(policy);
	missingRuntime.sessions.directly_readable_schemas = [11];
	assert.throws(() => validateCompatibilityPolicy(missingRuntime), /policy_invalid: sessions/u);

	const duplicatePlatform = structuredClone(policy);
	duplicatePlatform.platforms.supported[1].id = "darwin";
	assert.throws(() => validateCompatibilityPolicy(duplicatePlatform), /policy_invalid: platforms/u);

	const missingPreferredCatalog = structuredClone(policy);
	missingPreferredCatalog.model_catalog.readable_formats = ["legacy_flat"];
	assert.throws(() => validateCompatibilityPolicy(missingPreferredCatalog), /policy_invalid: model_catalog/u);

	const duplicateDocument = structuredClone(policy);
	duplicateDocument.documentation.release_notes = duplicateDocument.documentation.release;
	assert.throws(() => validateCompatibilityPolicy(duplicateDocument), /policy_invalid: documentation/u);
});

test("release compatibility smoke classifies only bounded network failures as external", () => {
	assert.deepEqual(parseCompatibilitySmokeArguments([
		"--allow-external-blocker",
		"--evidence",
		"evidence.json",
	]), {
		allowExternalBlocker: true,
		evidencePath: join(process.cwd(), "evidence.json"),
	});
	assert.equal(commandFailureCode("npm error code ETIMEDOUT secret-token-value"), "ETIMEDOUT");
	assert.equal(
		commandFailureCode("ripgrep_platform_stage_failed: kind=UND_ERR_CONNECT_TIMEOUT"),
		"UND_ERR_CONNECT_TIMEOUT",
	);
	assert.equal(isExternalBlockerCode("ETIMEDOUT"), true);
	assert.equal(isExternalBlocker({ stage: "predecessor_install", code: "ETIMEDOUT" }), true);
	assert.equal(isExternalBlocker({ stage: "candidate_pack", code: "ETIMEDOUT" }), false);
	assert.equal(isExternalBlocker({ stage: "migration_apply", code: "ETIMEDOUT" }), false);
	assert.equal(commandFailureCode("npm error code E401 secret-token-value"), "E401");
	assert.equal(isExternalBlockerCode("E401"), false);
	assert.equal(commandFailureCode("unexpected secret-token-value"), "command_failed");
	assert.equal(isExternalBlockerCode("command_failed"), false);
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
	assert.match(workflow, /release:compatibility/u);
	assert.match(workflow, /apparmor_restrict_unprivileged_userns=0/u);
	assert.match(workflow, /smoke:package -- --all-platforms --require-windows-helper/u);
	assert.match(workflow, /smoke:release-compatibility/u);
	assert.match(workflow, /release-evidence\/ubuntu-packed\.json/u);
	assert.match(workflow, /release-evidence\/ubuntu-upgrade\.json/u);
	assert.doesNotMatch(workflow, /--allow-external-blocker/u);
	assert.match(workflow, /release:publish -- --confirm/u);
	assert.ok(
		workflow.indexOf("smoke:release-compatibility")
		< workflow.indexOf("release:publish -- --confirm"),
	);
});

test("independent release compatibility workflow covers three installed-artifact platforms", async () => {
	const workflow = await readFile(
		new URL("../../.github/workflows/release-compatibility.yml", import.meta.url),
		"utf8",
	);
	for (const marker of ["ubuntu-latest", "macos-latest", "windows-2022"]) {
		assert.match(workflow, new RegExp(marker, "u"));
	}
	assert.match(workflow, /release:compatibility/u);
	assert.match(workflow, /smoke:package/u);
	assert.match(workflow, /smoke:release-compatibility/u);
	assert.match(workflow, /--allow-external-blocker/u);
	assert.match(workflow, /release-evidence\/\$\{\{ matrix\.platform \}\}-packed\.json/u);
	assert.match(workflow, /release-evidence\/\$\{\{ matrix\.platform \}\}-upgrade\.json/u);
	assert.match(workflow, /path: release-evidence\/\$\{\{ matrix\.platform \}\}-\*\.json/u);
	assert.match(workflow, /Upload sanitized compatibility evidence/u);
	assert.doesNotMatch(workflow, /continue-on-error/u);
});

test("Windows release artifacts require native, Shell, and maintenance verification", async () => {
	const release = parseYaml(await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8"));
	assert.equal(release.jobs.publish.needs, "windows-sandbox-helper");
	const workflow = parseYaml(await readFile(new URL("../../.github/workflows/windows-sandbox.yml", import.meta.url), "utf8"));
	const job = workflow.jobs.verify;
	assert.notEqual(job["continue-on-error"], true);
	const steps = job.steps;
	const native = steps.findIndex((step) => step.run?.includes("ctest --test-dir"));
	const integration = steps.findIndex((step) => step.run?.includes("windows-sandbox.platform.test.ts"));
	const artifact = steps.findIndex((step) => step.uses?.startsWith("actions/upload-artifact@"));
	assert.ok(native >= 0 && integration > native && artifact > integration);
	assert.equal(steps[integration].env.MYCLI_WINDOWS_SANDBOX_SETUP_TESTS, "1");
	assert.equal(steps[integration].env.MYCLI_WINDOWS_SANDBOX_MAINTENANCE_TESTS, "1");
	for (const index of [native, integration, artifact]) {
		assert.notEqual(steps[index]["continue-on-error"], true);
		assert.equal(steps[index].if ?? "success()", "success()");
	}
});

test("release workflows remain valid YAML", async () => {
	for (const relativePath of [
		"../../.github/workflows/release.yml",
		"../../.github/workflows/release-compatibility.yml",
		"../../.github/workflows/cross-platform.yml",
		"../../.github/workflows/windows-sandbox.yml",
		"../../.github/dependabot.yml",
	]) {
		const workflow = await readFile(new URL(relativePath, import.meta.url), "utf8");
		assert.doesNotThrow(() => parseYaml(workflow), relativePath);
	}
});

test("Dependabot checks only the exact pi-ai workspace pin every day", async () => {
	const config = parseYaml(await readFile(
		new URL("../../.github/dependabot.yml", import.meta.url),
		"utf8",
	));
	assert.equal(config.version, 2);
	assert.equal(config.updates.length, 1);
	const update = config.updates[0];
	assert.equal(update["package-ecosystem"], "npm");
	assert.equal(update.directory, "/");
	assert.deepEqual(update.schedule, {
		interval: "daily",
		time: "09:00",
		timezone: "Asia/Shanghai",
	});
	assert.deepEqual(update.allow, [{
		"dependency-name": "@earendil-works/pi-ai",
		"dependency-type": "direct",
	}]);
	assert.equal(update["versioning-strategy"], "increase");
	assert.equal(update["open-pull-requests-limit"], 1);

	const appManifest = await readJson(fileURLToPath(new URL(
		"../../backend/apps/mycli/package.json",
		import.meta.url,
	)));
	const providerManifest = await readJson(fileURLToPath(new URL(
		"../../backend/packages/providers/package.json",
		import.meta.url,
	)));
	const appPin = appManifest.dependencies["@earendil-works/pi-ai"];
	const providerPin = providerManifest.dependencies["@earendil-works/pi-ai"];
	assert.match(appPin, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
	assert.equal(providerPin, appPin);
});

test("cross-platform long-history gate seeds the current session schema", async () => {
	const workflow = await readFile(
		new URL("../../.github/workflows/cross-platform.yml", import.meta.url),
		"utf8",
	);
	assert.match(
		workflow,
		/benchmark:long-history -- --profile compact_stress --storage-schema v15/u,
	);

	const root = await mkdtemp(join(tmpdir(), "mycli-long-history-v15-"));
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
			"v15",
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
			assert.equal(database.prepare("SELECT version FROM schema_version").pluck().get(), 15);
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

test("packed smoke covers the closed curated provider and pi-ai module boundary", async () => {
	const source = await readFile(new URL("../smoke_packed_cli.mjs", import.meta.url), "utf8");
	for (const provider of CURATED_LIVE_PROVIDER_IDS) {
		assert.equal(source.includes(`["${provider}",`), true, provider);
	}
	assert.match(source, /curated_provider_routes: 6/u);
	assert.match(source, /pi_ai_version: PINNED_PI_AI_VERSION/u);
	assert.match(source, /provider-free startup loaded a curated pi-ai provider module/u);
	assert.match(source, /provider-free startup loaded a pi-ai OAuth module/u);
	assert.match(source, /actual pi-ai OAuth flow module loaded/u);
	assert.match(source, /\/auth\/oauth\/load\.js/u);
	assert.match(source, /provider catalog demand did not load pi-ai providers\/all/u);
	assert.match(source, /pi_ai_catalog_imported_on_provider_demand: true/u);
	assert.match(source, /pi_ai_catalog_imported_on_startup: false/u);
});

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function listTextFiles(root) {
	const paths = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "dist" && entry.name !== "node_modules") {
				paths.push(...await listTextFiles(path));
			}
		} else if (entry.isFile() && /\.(?:json|md|mjs|ts|yml)$/u.test(entry.name)) {
			paths.push(path);
		}
	}
	return paths;
}
