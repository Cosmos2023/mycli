import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const TEST_SUITE_NAMES = Object.freeze([
	"unit",
	"contract",
	"integration",
	"platform",
	"release",
]);

export const CI_TEST_SUITE_ORDER = Object.freeze([
	"unit",
	"contract",
	"integration",
	"platform",
	"release",
]);

export const TEST_TARGETS = Object.freeze([
	{
		id: "core",
		label: "@mycli/core",
		root: "backend/packages/core",
		testRoot: "test",
		defaultSuite: "unit",
	},
	{
		id: "config",
		label: "@mycli/config",
		root: "backend/packages/config",
		testRoot: "test",
		defaultSuite: "unit",
	},
	{
		id: "contracts",
		label: "@mycli/contracts",
		root: "backend/packages/contracts",
		testRoot: "test",
		defaultSuite: "contract",
	},
	{
		id: "tools",
		label: "@mycli/tools",
		root: "backend/packages/tools",
		testRoot: "test",
		defaultSuite: "unit",
		platformTestConcurrency: 1,
	},
	{
		id: "gateway",
		label: "@mycli/gateway",
		root: "backend/packages/gateway",
		testRoot: "test",
		defaultSuite: "unit",
	},
	{
		id: "providers",
		label: "@mycli/providers",
		root: "backend/packages/providers",
		testRoot: "test",
		defaultSuite: "unit",
	},
	{
		id: "storage",
		label: "@mycli/storage",
		root: "backend/packages/storage",
		testRoot: "test",
		defaultSuite: "unit",
	},
	{
		id: "integrations",
		label: "@mycli/integrations",
		root: "backend/packages/integrations",
		testRoot: "test",
		defaultSuite: "unit",
	},
	{
		id: "runtime",
		label: "@mycli/runtime",
		root: "backend/packages/runtime",
		testRoot: "test",
		defaultSuite: "unit",
		// Worker lease tests poll real Worker processes with bounded waits; keep the
		// parallel fan-out below the default to avoid load-dependent flakes.
		testConcurrency: 4,
	},
	{
		id: "tui",
		label: "mycli-shell-tui",
		root: "tui/mycli-shell",
		testRoot: "test",
		defaultSuite: "unit",
		// Rendering tests flush with fixed short delays; the default fan-out starves
		// them on machines with many cores.
		testConcurrency: 4,
	},
	{
		id: "app",
		label: "@cosmos2023/mycli",
		root: "backend/apps/mycli",
		testRoot: "test",
		defaultSuite: "unit",
		testConcurrency: 1,
	},
	{
		id: "repository",
		label: "repository",
		root: ".",
		testRoot: "scripts/test",
		defaultSuite: "contract",
		sourceCondition: false,
		typescript: false,
	},
]);

// Overrides bridge mixed legacy filenames until those files can be split or renamed by domain.
export const TEST_SUITE_OVERRIDES = Object.freeze({
	"backend/apps/mycli/test/m6-persistent-shell.integration.test.ts": "platform",
	"backend/apps/mycli/test/node-runtime-m8-capability-audit.test.ts": "contract",
	"backend/apps/mycli/test/package.test.ts": "contract",
	"backend/apps/mycli/test/ux-contract-baseline.test.ts": "contract",
	"backend/packages/config/test/configuration/config-reference.test.ts": "contract",
	"backend/packages/core/test/parity-fixtures.test.ts": "contract",
	"backend/packages/providers/test/pi-ai/pi-ai-module-loading.test.ts": "integration",
	"backend/packages/runtime/test/workers/worker-provider-step-executor.test.ts": "integration",
	"backend/packages/storage/test/artifacts/session-content-blob-repository.test.ts": "integration",
	"backend/packages/storage/test/migrations/v10/v10-content-blob-migration-cutover-resilience.test.ts":
		"integration",
	"backend/packages/storage/test/migrations/v10/v10-content-blob-migration-staging-resilience.test.ts":
		"integration",
	"backend/packages/storage/test/migrations/v9/v9-normalization-staging-resilience.test.ts": "integration",
	"backend/packages/tools/test/shell/node-pty-transport.integration.test.ts": "platform",
	"backend/packages/tools/test/shell/pipe-transport.integration.test.ts": "platform",
	"backend/packages/tools/test/shell/shell-environment.integration.test.ts": "platform",
	"scripts/test/release-scripts.test.mjs": "release",
	"scripts/test/windows-sandbox-release.test.mjs": "release",
});

const TEST_FILE_PATTERN = /\.test\.(?:[cm]?[jt]sx?)$/u;
const SPECIAL_SUITE_PATTERN = /\.(contract|integration|platform)\.test\.(?:[cm]?[jt]sx?)$/u;

export async function discoverTestCatalog(root = REPOSITORY_ROOT) {
	await validateWorkspaceTargets(root);
	const rows = [];
	const discoveredPaths = new Set();

	for (const target of TEST_TARGETS) {
		const directory = join(root, target.root, target.testRoot);
		for (const absolutePath of await discoverTestFiles(directory)) {
			const file = repositoryRelativePath(root, absolutePath);
			if (discoveredPaths.has(file)) {
				throw new Error(`duplicate_test_catalog_path: ${file}`);
			}
			discoveredPaths.add(file);
			rows.push(Object.freeze({
				file,
				suite: classifyTestFile(file, target.defaultSuite),
				targetId: target.id,
				targetLabel: target.label,
				targetRoot: target.root,
				testConcurrency: target.testConcurrency,
				typescript: target.typescript !== false,
			}));
		}
	}

	const staleOverrides = findStaleTestSuiteOverrides(discoveredPaths);
	if (staleOverrides.length > 0) {
		throw new Error(`stale_test_suite_override: ${staleOverrides.join(", ")}`);
	}

	return Object.freeze(rows.sort((left, right) => left.file.localeCompare(right.file)));
}

export function classifyTestFile(file, defaultSuite = "unit") {
	if (!TEST_SUITE_NAMES.includes(defaultSuite)) {
		throw new Error(`invalid_default_test_suite: ${defaultSuite}`);
	}
	const override = TEST_SUITE_OVERRIDES[file];
	if (override !== undefined) {
		if (!TEST_SUITE_NAMES.includes(override)) {
			throw new Error(`invalid_test_suite_override: ${file}`);
		}
		return override;
	}

	const namedSuite = file.match(SPECIAL_SUITE_PATTERN)?.[1];
	if (namedSuite !== undefined) return namedSuite;
	if (file.includes(".smoke.test.")) {
		throw new Error(`smoke_test_must_be_an_explicit_script: ${file}`);
	}
	return defaultSuite;
}

export function findStaleTestSuiteOverrides(
	discoveredPaths,
	overrides = TEST_SUITE_OVERRIDES,
) {
	return Object.keys(overrides).filter((file) => !discoveredPaths.has(file));
}

export async function discoverWorkspaceTestRoots(root = REPOSITORY_ROOT) {
	const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	if (!Array.isArray(manifest.workspaces)) throw new Error("workspace_catalog_missing");
	const workspaceRoots = [];
	for (const pattern of manifest.workspaces) {
		if (typeof pattern !== "string") throw new Error("workspace_pattern_invalid");
		if (pattern.endsWith("/*") && !pattern.slice(0, -2).includes("*")) {
			const parent = pattern.slice(0, -2);
			const entries = await readdir(join(root, parent), { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const workspaceRoot = `${parent}/${entry.name}`;
				const workspaceManifest = await readJsonIfExists(
					join(root, workspaceRoot, "package.json"),
				);
				if (workspaceManifest === undefined) continue;
				if (typeof workspaceManifest.scripts?.test === "string") {
					workspaceRoots.push(workspaceRoot);
				}
			}
			continue;
		}
		if (pattern.includes("*")) throw new Error(`workspace_pattern_unsupported: ${pattern}`);
		const workspaceManifest = JSON.parse(await readFile(
			join(root, pattern, "package.json"),
			"utf8",
		));
		if (typeof workspaceManifest.scripts?.test === "string") workspaceRoots.push(pattern);
	}
	return Object.freeze(workspaceRoots.sort());
}

export function selectTestCatalog(catalog, suites) {
	const requested = new Set(suites);
	for (const suite of requested) {
		if (!TEST_SUITE_NAMES.includes(suite)) {
			throw new Error(`unknown_test_suite: ${suite}`);
		}
	}
	return catalog.filter(({ suite }) => requested.has(suite));
}

export function summarizeTestCatalog(catalog) {
	return Object.fromEntries(TEST_SUITE_NAMES.map((suite) => [
		suite,
		catalog.filter((row) => row.suite === suite).length,
	]));
}

async function discoverTestFiles(directory) {
	const files = [];
	const entries = await readdir(directory, { withFileTypes: true });
	entries.sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...await discoverTestFiles(path));
		} else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
			files.push(path);
		}
	}
	return files;
}

async function readJsonIfExists(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error !== null && typeof error === "object" && error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

async function validateWorkspaceTargets(root) {
	const discovered = await discoverWorkspaceTestRoots(root);
	const registered = TEST_TARGETS
		.filter(({ id }) => id !== "repository")
		.map(({ root: targetRoot }) => targetRoot)
		.sort();
	const discoveredSet = new Set(discovered);
	const registeredSet = new Set(registered);
	const missing = discovered.filter((workspaceRoot) => !registeredSet.has(workspaceRoot));
	const stale = registered.filter((workspaceRoot) => !discoveredSet.has(workspaceRoot));
	if (missing.length > 0) {
		throw new Error(`unregistered_workspace_test_target: ${missing.join(", ")}`);
	}
	if (stale.length > 0) {
		throw new Error(`stale_workspace_test_target: ${stale.join(", ")}`);
	}
}

function repositoryRelativePath(root, path) {
	const value = relative(root, path);
	if (value === "" || value === ".." || value.startsWith(`..${sep}`)) {
		throw new Error(`test_path_outside_repository: ${path}`);
	}
	return value.split(sep).join("/");
}
