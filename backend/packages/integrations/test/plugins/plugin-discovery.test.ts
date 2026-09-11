import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { discoverPlugins } from "../../src/index.ts";

test("discovers plugins deterministically with user precedence and disabled override", async (t) => {
	const fixture = await discoveryFixture(t);
	await writeV2Plugin(fixture.repoPlugins, "demo", "Repository Demo");
	await writeV2Plugin(fixture.repoPlugins, "repo-only", "Repository Only");
	await writeV2Plugin(fixture.userPlugins, "demo", "User Demo");
	await writeV2Plugin(fixture.userPlugins, "user-only", "User Only");
	await writeConfig(join(fixture.workspaceRoot, ".mycli", "config.toml"), [
		"demo",
		"repo-only",
	], ["demo"]);
	await writeConfig(join(fixture.homeDir, ".mycli", "config.toml"), ["user-only"]);
	await writeConfig(
		join(fixture.homeDir, ".config", "mycli", "config.toml"),
		["legacy-ignored"],
	);

	const discovery = await discoverPlugins(fixture);

	assert.deepEqual(discovery.candidates.map((candidate) => [candidate.pluginId, candidate.source]), [
		["demo", "repo"],
		["repo-only", "repo"],
		["demo", "user"],
		["user-only", "user"],
	]);
	assert.deepEqual(discovery.selected.map((candidate) => candidate.pluginId), [
		"demo",
		"repo-only",
		"user-only",
	]);
	assert.equal(discovery.get("demo")?.source, "user");
	assert.equal(discovery.plugins.find((plugin) => plugin.pluginId === "demo")?.manifest.name, "User Demo");
	assert.equal(discovery.plugins.find((plugin) => plugin.pluginId === "demo")?.enabled, false);
	assert.equal(discovery.plugins.find((plugin) => plugin.pluginId === "repo-only")?.enabled, true);
	assert.equal(discovery.plugins.find((plugin) => plugin.pluginId === "user-only")?.enabled, true);
	assert.equal(discovery.enablement.isEnabled("legacy-ignored"), false);
	assert.equal(discovery.diagnostics.some((issue) => issue.errorClass === "duplicate_plugin_id"), true);
});

test("uses legacy user config only when the modern user config is absent", async (t) => {
	const fixture = await discoveryFixture(t);
	await writeV2Plugin(fixture.repoPlugins, "legacy", "Legacy Enabled");
	await writeConfig(
		join(fixture.homeDir, ".config", "mycli", "config.toml"),
		["legacy"],
	);

	const discovery = await discoverPlugins(fixture);

	assert.equal(discovery.enablement.isEnabled("legacy"), true);
	assert.equal(discovery.plugins[0]?.enabled, true);
});

test("does not read repository plugins or enablement when project configuration is disabled", async (t) => {
	const fixture = await discoveryFixture(t);
	await writeV2Plugin(fixture.repoPlugins, "repo-only", "Repository Only");
	await writeV2Plugin(fixture.userPlugins, "user-only", "User Only");
	await writeConfig(join(fixture.homeDir, ".mycli", "config.toml"), ["user-only"]);
	await mkdir(join(fixture.workspaceRoot, ".mycli"), { recursive: true });
	await writeFile(
		join(fixture.workspaceRoot, ".mycli", "config.toml"),
		"[plugins\nsecret = 'must-not-leak'",
		"utf8",
	);

	const discovery = await discoverPlugins({
		...fixture,
		includeRepository: false,
	});

	assert.deepEqual(discovery.candidates.map((candidate) => candidate.pluginId), ["user-only"]);
	assert.deepEqual(discovery.plugins.map((plugin) => plugin.pluginId), ["user-only"]);
	assert.deepEqual(discovery.diagnostics, []);
});

test("attributes invalid plugin table diagnostics to the owning config source", async (t) => {
	const fixture = await discoveryFixture(t);
	await mkdir(join(fixture.homeDir, ".mycli"), { recursive: true });
	await writeFile(
		join(fixture.homeDir, ".mycli", "config.toml"),
		'plugins = "not-a-table"',
		"utf8",
	);

	const discovery = await discoverPlugins(fixture);
	const issue = discovery.diagnostics.find((item) => item.errorClass === "invalid_plugins_table");

	assert.equal(issue?.source, "user");
	assert.equal(issue?.fileLabel, "config.toml");
});

test("surfaces Python and non-v2 directories as migration-required without executing them", async (t) => {
	const fixture = await discoveryFixture(t);
	const marker = join(fixture.root, "python-imported.txt");
	const pythonRoot = join(fixture.repoPlugins, "python-demo");
	await mkdir(pythonRoot, { recursive: true });
	await writeFile(join(pythonRoot, "plugin.yaml"), "name: Python Demo\n", "utf8");
	await writeFile(
		join(pythonRoot, "__init__.py"),
		`from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("ran")\n`,
		"utf8",
	);
	const oldRoot = join(fixture.userPlugins, "old-api");
	await mkdir(oldRoot, { recursive: true });
	await writeFile(join(oldRoot, "plugin.yaml"), [
		"api_version: 1",
		"id: old-api",
		"name: Old API",
		"entry: dist/index.js",
	].join("\n"), "utf8");

	const discovery = await discoverPlugins(fixture);

	assert.deepEqual(discovery.migrations.map((migration) => ({
		kind: migration.kind,
		pluginId: migration.pluginId,
		message: migration.message,
	})), [
		{
			kind: "migration_required",
			pluginId: "python-demo",
			message: "Python plugin requires Plugin API v2 migration",
		},
		{
			kind: "migration_required",
			pluginId: "old-api",
			message: "Python plugin requires Plugin API v2 migration",
		},
	]);
	assert.deepEqual(discovery.plugins, []);
	await assert.rejects(() => access(marker));
});

test("isolates invalid plugins and config while reporting duplicate names safely", async (t) => {
	const fixture = await discoveryFixture(t);
	await writeV2Plugin(fixture.repoPlugins, "alpha", "Duplicate Name");
	await writeV2Plugin(fixture.repoPlugins, "bravo", "Duplicate Name");
	const brokenRoot = join(fixture.userPlugins, "broken");
	await mkdir(brokenRoot, { recursive: true });
	await writeFile(
		join(brokenRoot, "plugin.yaml"),
		"api_version: [token=private-value\nentry: /Users/private/plugin.js",
		"utf8",
	);
	await mkdir(join(fixture.workspaceRoot, ".mycli"), { recursive: true });
	await writeFile(
		join(fixture.workspaceRoot, ".mycli", "config.toml"),
		"[plugins\nsecret = 'private-value'",
		"utf8",
	);

	const discovery = await discoverPlugins(fixture);
	const serialized = JSON.stringify(discovery.diagnostics);

	assert.deepEqual(discovery.plugins.map((plugin) => plugin.pluginId), ["alpha", "bravo"]);
	assert.equal(discovery.diagnostics.some((issue) => issue.errorClass === "duplicate_plugin_name"), true);
	assert.equal(discovery.diagnostics.some((issue) => issue.errorClass === "invalid_yaml"), true);
	assert.equal(discovery.diagnostics.some((issue) => issue.errorClass === "invalid_toml"), true);
	assert.equal(serialized.includes("private-value"), false);
	assert.equal(serialized.includes("/Users/private"), false);
	assert.equal(serialized.includes(fixture.root), false);
	for (const issue of discovery.diagnostics) {
		assert.deepEqual(Object.keys(issue).sort(), [
			"errorClass",
			"fileLabel",
			"pluginId",
			"source",
		]);
	}
});

async function discoveryFixture(t: TestContext): Promise<{
	readonly root: string;
	readonly workspaceRoot: string;
	readonly homeDir: string;
	readonly repoPlugins: string;
	readonly userPlugins: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-plugin-discovery-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const workspaceRoot = join(root, "workspace");
	const homeDir = join(root, "home");
	const repoPlugins = join(workspaceRoot, ".mycli", "plugins");
	const userPlugins = join(homeDir, ".mycli", "plugins");
	await mkdir(repoPlugins, { recursive: true });
	await mkdir(userPlugins, { recursive: true });
	return { root, workspaceRoot, homeDir, repoPlugins, userPlugins };
}

async function writeV2Plugin(root: string, id: string, name: string): Promise<void> {
	const pluginRoot = join(root, id);
	await mkdir(join(pluginRoot, "dist"), { recursive: true });
	await writeFile(join(pluginRoot, "plugin.yaml"), [
		"api_version: 2",
		`id: ${id}`,
		`name: ${JSON.stringify(name)}`,
		"version: 1.0.0",
		"entry: dist/index.js",
		"provides:",
		"  tools: []",
		"  hooks: []",
		"  commands: []",
		"requires_env: []",
		"capabilities: []",
	].join("\n"), "utf8");
	await writeFile(join(pluginRoot, "dist", "index.js"), "export {};", "utf8");
}

async function writeConfig(
	path: string,
	enabled: readonly string[],
	disabled: readonly string[] = [],
): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, [
		"[plugins]",
		`enabled = ${JSON.stringify(enabled)}`,
		`disabled = ${JSON.stringify(disabled)}`,
	].join("\n"), "utf8");
}
