#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { CONFIG_MIGRATION_VERSION } from "@mycli/config";
import {
	SCHEMA_V10_VERSION,
	SCHEMA_V11_VERSION,
	SCHEMA_V12_VERSION,
	SCHEMA_VERSION,
} from "@mycli/storage";
import {
	APPLICATION_RELEASE_PACKAGE,
	RELEASE_ROOT,
	releaseManifestPath,
} from "./release-config.mjs";

const POLICY_PATH = "release/compatibility-policy.json";
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u;
const DOCUMENTATION_PATH = /^(?:README\.md|CHANGELOG\.md|docs\/[a-z0-9./_-]+\.md)$/u;

export async function verifyReleaseCompatibility(root = RELEASE_ROOT) {
	const policy = await loadCompatibilityPolicy(root);
	const rootManifest = await readJson(join(root, "package.json"));
	const appManifest = await readJson(releaseManifestPath(APPLICATION_RELEASE_PACKAGE, root));
	const startup = await readJson(join(root, policy.startup_budget_fixture));
	const compatibilityWorkflow = parseYaml(await readFile(
		join(root, ".github/workflows/release-compatibility.yml"),
		"utf8",
	));

	assertEqual(policy.application.package, APPLICATION_RELEASE_PACKAGE.name, "application_package");
	assertEqual(appManifest.name, policy.application.package, "application_manifest_name");
	assertEqual(appManifest.bin?.[policy.application.binary], "dist/cli.js", "application_binary");
	assertEqual(rootManifest.engines?.node, `>=${policy.node.minimum}`, "node_engine");
	assertArrayEqual(
		compatibilityWorkflow?.jobs?.["packed-release-journey"]?.strategy?.matrix?.include,
		policy.platforms.supported.map(({ id, runner }) => ({
			platform: id,
			os: runner,
			packed_args: id === "win32"
				? "--require-windows-helper --require-windows-ready --setup-windows-sandbox" : "",
		})),
		"compatibility_platform_matrix",
	);
	assertEqual(
		policy.configuration.migration_contract_version,
		CONFIG_MIGRATION_VERSION,
		"config_migration_contract",
	);
	assertEqual(policy.sessions.runtime_schema, SCHEMA_V12_VERSION, "runtime_session_schema");
	assertArrayEqual(
		policy.sessions.directly_readable_schemas,
		[SCHEMA_V12_VERSION],
		"direct_session_schemas",
	);
	assertArrayEqual(
		policy.sessions.maintenance_inspectable_schemas,
		[SCHEMA_VERSION, SCHEMA_V10_VERSION, SCHEMA_V11_VERSION, SCHEMA_V12_VERSION],
		"maintenance_session_schemas",
	);
	assertEqual(
		startup.budgets?.awaited_network_operations_before_first_paint,
		0,
		"first_paint_network_budget",
	);
	assertEqual(startup.budgets?.pty_readiness_ms, 5_000, "pty_readiness_budget");

	for (const path of Object.values(policy.documentation)) {
		const content = await readFile(join(root, path), "utf8").catch(() => undefined);
		if (content === undefined) throw new Error(`release_compatibility_document_missing: ${path}`);
	}
	const compatibilityDocument = await readFile(
		join(root, policy.documentation.compatibility),
		"utf8",
	);
	const upgradeDocument = await readFile(join(root, policy.documentation.upgrade), "utf8");
	for (const deprecation of policy.deprecations) {
		for (const marker of [
			deprecation.id,
			deprecation.subject,
			deprecation.replacement,
		]) {
			if (!compatibilityDocument.includes(marker)) {
				throw new Error(`release_compatibility_document_drift: ${deprecation.id}`);
			}
		}
		if (!upgradeDocument.includes(deprecation.subject)
			|| !upgradeDocument.includes(deprecation.replacement)) {
			throw new Error(`release_upgrade_document_drift: ${deprecation.id}`);
		}
		const [guidePath, guideAnchor] = deprecation.migration_guide.split("#", 2);
		if (guidePath !== policy.documentation.upgrade
			|| !markdownHeadingAnchors(upgradeDocument).has(guideAnchor)) {
			throw new Error(`release_upgrade_guide_drift: ${deprecation.id}`);
		}
	}

	return Object.freeze({
		schemaVersion: policy.schema_version,
		applicationPackage: policy.application.package,
		predecessorPackage: policy.application.predecessor.package,
		predecessorVersion: policy.application.predecessor.version,
		platformCount: policy.platforms.supported.length,
		runtimeSessionSchema: policy.sessions.runtime_schema,
	});
}

export async function loadCompatibilityPolicy(root = RELEASE_ROOT) {
	return validateCompatibilityPolicy(await readJson(join(root, POLICY_PATH)));
}

export function validateCompatibilityPolicy(value) {
	if (!isRecord(value) || value.schema_version !== 1) invalid("schema");
	if (!isRecord(value.application)
		|| !PACKAGE_NAME.test(value.application.package ?? "")
		|| value.application.binary !== "mycli"
		|| !isRecord(value.application.predecessor)
		|| !PACKAGE_NAME.test(value.application.predecessor.package ?? "")
		|| value.application.predecessor.package === value.application.package
		|| !SEMVER.test(value.application.predecessor.version ?? "")) invalid("application");
	if (!isRecord(value.node)
		|| !SEMVER.test(value.node.minimum ?? "")
		|| !stringArray(value.node.tested)
		|| !value.node.tested.includes(value.node.minimum)) invalid("node");
	if (!isRecord(value.platforms)
		|| !Array.isArray(value.platforms.supported)
		|| value.platforms.supported.length !== 3) invalid("platforms");
	const platformIds = new Set();
	const platformRunners = new Set();
	for (const platform of value.platforms.supported) {
		if (!isRecord(platform)
			|| !["darwin", "linux", "win32"].includes(platform.id)
			|| platformIds.has(platform.id)
			|| typeof platform.runner !== "string"
			|| !/^(?:macos|ubuntu|windows)-[a-z0-9.]+$/u.test(platform.runner)
			|| platformRunners.has(platform.runner)) invalid("platforms");
		platformIds.add(platform.id);
		platformRunners.add(platform.runner);
	}
	if (!["darwin", "linux", "win32"].every((id) => platformIds.has(id))) invalid("platforms");
	if (!isRecord(value.configuration)
		|| !Number.isSafeInteger(value.configuration.migration_contract_version)
		|| typeof value.configuration.canonical_path !== "string"
		|| !value.configuration.canonical_path.startsWith("~/")
		|| typeof value.configuration.legacy_path !== "string"
		|| !value.configuration.legacy_path.startsWith("~/")
		|| value.configuration.canonical_path === value.configuration.legacy_path
		|| value.configuration.rollback !== "explicit_backup") invalid("configuration");
	if (!isRecord(value.model_catalog)
		|| value.model_catalog.preferred_format !== "provider_grouped"
		|| !stringArray(value.model_catalog.readable_formats)
		|| !value.model_catalog.readable_formats.includes(value.model_catalog.preferred_format)
		|| !value.model_catalog.readable_formats.includes("legacy_flat")) invalid("model_catalog");
	if (!isRecord(value.sessions)
		|| !Number.isSafeInteger(value.sessions.runtime_schema)
		|| !integerArray(value.sessions.directly_readable_schemas)
		|| !integerArray(value.sessions.maintenance_inspectable_schemas)
		|| !Array.isArray(value.sessions.maintenance_migrations)
		|| value.sessions.downgrade !== "same_schema_only") invalid("sessions");
	if (!value.sessions.directly_readable_schemas.includes(value.sessions.runtime_schema)
		|| !value.sessions.directly_readable_schemas.every(
			(schema) => value.sessions.maintenance_inspectable_schemas.includes(schema),
		)
		|| new Set(value.sessions.directly_readable_schemas).size
			!== value.sessions.directly_readable_schemas.length
		|| new Set(value.sessions.maintenance_inspectable_schemas).size
			!== value.sessions.maintenance_inspectable_schemas.length) invalid("sessions");
	for (const migration of value.sessions.maintenance_migrations) {
		if (!isRecord(migration)
			|| !Number.isSafeInteger(migration.from)
			|| !Number.isSafeInteger(migration.to)
			|| migration.from >= migration.to
			|| !value.sessions.maintenance_inspectable_schemas.includes(migration.from)
			|| !value.sessions.maintenance_inspectable_schemas.includes(migration.to)
			|| typeof migration.action !== "string"
			|| !migration.action.startsWith("/session maintenance --apply-")) invalid("session_migration");
	}
	if (typeof value.startup_budget_fixture !== "string"
		|| !/^tests\/fixtures\/[a-z0-9./_-]+\.json$/u.test(value.startup_budget_fixture)) {
		invalid("startup_budget_fixture");
	}
	if (!Array.isArray(value.deprecations) || value.deprecations.length === 0) invalid("deprecations");
	const ids = new Set();
	for (const deprecation of value.deprecations) {
		if (!isRecord(deprecation)
			|| typeof deprecation.id !== "string"
			|| !/^[a-z0-9-]+$/u.test(deprecation.id)
			|| ids.has(deprecation.id)
			|| !PACKAGE_NAME.test(deprecation.subject ?? "")
			|| !SEMVER.test(deprecation.introduced_in ?? "")
			|| !SEMVER.test(deprecation.deprecated_in ?? "")
			|| !(deprecation.removed_in === null || SEMVER.test(deprecation.removed_in ?? ""))
			|| !PACKAGE_NAME.test(deprecation.replacement ?? "")
			|| typeof deprecation.migration_guide !== "string"
			|| !/^docs\/[a-z0-9./_-]+\.md#[a-z0-9-]+$/u.test(deprecation.migration_guide)) {
			invalid("deprecation");
		}
		ids.add(deprecation.id);
	}
	if (!isRecord(value.documentation)
		|| ![
			"compatibility",
			"upgrade",
			"release",
			"release_notes",
			"changelog",
			"evidence",
			"troubleshooting",
			"windows",
		].every((key) => DOCUMENTATION_PATH.test(value.documentation[key] ?? ""))
		|| new Set(Object.values(value.documentation)).size
			!== Object.values(value.documentation).length) invalid("documentation");
	return value;
}

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

function assertEqual(actual, expected, field) {
	if (actual !== expected) throw new Error(`release_compatibility_drift: ${field}`);
}

function assertArrayEqual(actual, expected, field) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`release_compatibility_drift: ${field}`);
	}
}

function invalid(field) {
	throw new Error(`release_compatibility_policy_invalid: ${field}`);
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value) {
	return Array.isArray(value) && value.length > 0
		&& value.every((item) => typeof item === "string" && item.length > 0);
}

function integerArray(value) {
	return Array.isArray(value) && value.length > 0 && value.every(Number.isSafeInteger);
}

function markdownHeadingAnchors(content) {
	const anchors = new Set();
	for (const line of content.split(/\r?\n/gu)) {
		const match = /^#{1,6}\s+(.+?)\s*#*$/u.exec(line);
		if (!match?.[1]) continue;
		const anchor = match[1]
			.toLowerCase()
			.replace(/[`*_~]/gu, "")
			.replace(/[^a-z0-9\s-]/gu, "")
			.trim()
			.replace(/\s+/gu, "-")
			.replace(/-+/gu, "-");
		if (anchor) anchors.add(anchor);
	}
	return anchors;
}

async function main() {
	const result = await verifyReleaseCompatibility();
	process.stdout.write(`${JSON.stringify({ status: "completed", ...result })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : "release_compatibility_failed"}\n`);
		process.exitCode = 1;
	});
}
