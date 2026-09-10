import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	CI_TEST_SUITE_ORDER,
	discoverTestCatalog,
	discoverWorkspaceTestRoots,
	findStaleTestSuiteOverrides,
	selectTestCatalog,
	summarizeTestCatalog,
	TEST_SUITE_NAMES,
	TEST_TARGETS,
} from "../test-suite-catalog.mjs";
import { expandSuiteSelectors, parseArguments } from "../run-test-suite.mjs";

test("test catalog assigns every discovered file to exactly one executable suite", async () => {
	const catalog = await discoverTestCatalog();
	const paths = catalog.map(({ file }) => file);
	assert.ok(catalog.length > 250);
	assert.equal(new Set(paths).size, paths.length);
	assert.deepEqual(Object.keys(summarizeTestCatalog(catalog)), TEST_SUITE_NAMES);
	for (const suite of TEST_SUITE_NAMES) {
		assert.ok(catalog.some((row) => row.suite === suite), suite);
	}
	assert.equal(selectTestCatalog(catalog, CI_TEST_SUITE_ORDER).length, catalog.length);
});

test("test catalog covers npm workspaces and rejects stale overrides", async () => {
	const workspaceRoots = await discoverWorkspaceTestRoots();
	const targetRoots = TEST_TARGETS
		.filter(({ id }) => id !== "repository")
		.map(({ root }) => root)
		.sort();
	assert.deepEqual(workspaceRoots, targetRoots);
	assert.deepEqual(findStaleTestSuiteOverrides(new Set(["present.test.ts"]), {
		"present.test.ts": "unit",
		"removed.test.ts": "integration",
	}), ["removed.test.ts"]);
});

test("test catalog separates contracts integrations platforms and release checks", async () => {
	const byPath = new Map((await discoverTestCatalog()).map((row) => [row.file, row.suite]));
	assert.equal(byPath.get("backend/apps/mycli/test/node-gateway.test.ts"), "unit");
	assert.equal(byPath.get("backend/packages/contracts/test/catalog.test.ts"), "contract");
	assert.equal(
		byPath.get("backend/apps/mycli/test/node-backend.integration.test.ts"),
		"integration",
	);
	assert.equal(
		byPath.get("backend/packages/runtime/test/workers/worker-provider-step-executor.test.ts"),
		"integration",
	);
	assert.equal(
		byPath.get("backend/apps/mycli/test/m6-persistent-shell.integration.test.ts"),
		"platform",
	);
	assert.equal(
		byPath.get("backend/packages/tools/test/shell/node-pty-transport.integration.test.ts"),
		"platform",
	);
	assert.equal(byPath.get("scripts/test/release-scripts.test.mjs"), "release");
});

test("test runner expands CI once and forwards node test options", () => {
	assert.deepEqual(expandSuiteSelectors(["unit", "ci", "unit"]), CI_TEST_SUITE_ORDER);
	assert.deepEqual(parseArguments([
		"--suite", "integration",
		"--suite=platform",
		"--",
		"--test-name-pattern=worker",
	]), {
		suites: ["integration", "platform"],
		forwarded: ["--test-name-pattern=worker"],
		list: false,
		json: false,
		help: false,
	});
	assert.throws(() => parseArguments(["--suite", "unknown"]), /unknown_test_suite/u);
});

test("root scripts expose the canonical test taxonomy", async () => {
	const manifest = JSON.parse(await readFile(
		new URL("../../package.json", import.meta.url),
		"utf8",
	));
	assert.equal(manifest.scripts.test, "node scripts/run-test-suite.mjs --suite ci");
	assert.equal(manifest.scripts["test:ci"], "npm test");
	for (const suite of TEST_SUITE_NAMES) {
		assert.equal(
			manifest.scripts[`test:${suite}`],
			`node scripts/run-test-suite.mjs --suite ${suite}`,
		);
	}
	assert.equal(manifest.scripts["test:list"], "node scripts/run-test-suite.mjs --list");
});

test("quality workflows use the canonical CI suite without rerunning milestone tests", async () => {
	for (const relativePath of [
		"../../.github/workflows/cross-platform.yml",
		"../../.github/workflows/release.yml",
	]) {
		const workflow = await readFile(new URL(relativePath, import.meta.url), "utf8");
		assert.match(workflow, /run: npm run test:ci/u, relativePath);
		assert.doesNotMatch(workflow, /run: npm run test:m8/u, relativePath);
	}
});
