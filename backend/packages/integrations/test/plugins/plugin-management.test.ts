import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	PluginManagementService,
	type PluginRuntimeOptions,
} from "../../src/index.ts";

const GOOD_FIXTURE = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"plugins",
	"good",
);

test("plugin management lists, inspects, and runs commands without provider construction", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-plugin-management-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const workspaceRoot = join(root, "workspace");
	const homeDir = join(root, "home");
	const pluginRoot = join(workspaceRoot, ".mycli", "plugins", "good");
	await mkdir(join(workspaceRoot, ".mycli"), { recursive: true });
	await cp(GOOD_FIXTURE, pluginRoot, { recursive: true });
	await writeFile(join(workspaceRoot, ".mycli", "config.toml"), [
		"[plugins]",
		'enabled = ["good"]',
		"disabled = []",
	].join("\n"), "utf8");
	const runtimeOptions: PluginRuntimeOptions = {
		workspaceRoot,
		homeDir,
		env: {},
		sandboxProfile: (manifest) => fullAccessSandbox(manifest.pluginRoot),
	};
	const service = new PluginManagementService({ runtimeOptions });

	const list = await service.list(new AbortController().signal);
	const inspect = await service.inspect("good", new AbortController().signal);
	const run = await service.run("good", "status", {}, new AbortController().signal);
	const missing = await service.run("good", "missing", {}, new AbortController().signal);
	const usage = service.usage();

	assert.equal(list.ok, true);
	assert.deepEqual(list.plugins.map((plugin) => [plugin.pluginId, plugin.status]), [["good", "loaded"]]);
	assert.deepEqual(inspect.plugins[0]?.commands, ["late", "status"]);
	assert.equal(run.commandResult?.ok, true);
	assert.equal(run.commandResult?.summary, "ready");
	assert.equal(missing.ok, false);
	assert.equal(missing.commandResult?.error, "command_not_found");
	assert.equal(usage.action, "usage");
	assert.deepEqual(usage.plugins, []);
});

test("plugin management bounds invalid identifiers without exposing input", async () => {
	const service = new PluginManagementService({
		runtimeOptions: {
			workspaceRoot: "/missing-workspace",
			homeDir: "/missing-home",
			env: {},
			sandboxProfile: () => fullAccessSandbox("/missing-workspace"),
		},
	});
	const response = await service.inspect("sk-private-secret-value/", new AbortController().signal);

	assert.equal(response.ok, false);
	assert.equal(JSON.stringify(response).includes("private-secret-value"), false);
});

test("plugin management preserves the requested action when runtime construction fails", async () => {
	const service = new PluginManagementService({
		runtimeOptions: {
			workspaceRoot: "/missing-workspace",
			homeDir: "/missing-home",
			env: {},
			maxPlugins: 0,
			sandboxProfile: () => fullAccessSandbox("/missing-workspace"),
		},
	});

	const response = await service.inspect("demo", new AbortController().signal);

	assert.equal(response.ok, false);
	assert.equal(response.action, "inspect");
	assert.deepEqual(response.issues, ["plugin_management_failed"]);
});

test("plugin management reports migration and config diagnostics even when a plugin is disabled", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-plugin-migration-management-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const workspaceRoot = join(root, "workspace");
	const homeDir = join(root, "home");
	const pluginRoot = join(workspaceRoot, ".mycli", "plugins", "python-demo");
	await mkdir(pluginRoot, { recursive: true });
	await writeFile(join(pluginRoot, "plugin.yaml"), "name: Python Demo\n", "utf8");
	await writeFile(join(pluginRoot, "__init__.py"), "raise RuntimeError('must not import')\n", "utf8");
	await writeFile(join(workspaceRoot, ".mycli", "config.toml"), "[plugins\nprivate='value'", "utf8");
	const service = new PluginManagementService({
		runtimeOptions: {
			workspaceRoot,
			homeDir,
			env: {},
			sandboxProfile: () => fullAccessSandbox(workspaceRoot),
		},
	});

	const response = await service.list(new AbortController().signal);

	assert.equal(response.ok, false);
	assert.equal(response.plugins[0]?.status, "migration_required");
	assert.equal(response.plugins[0]?.enabled, false);
	assert.equal(response.issues.some((issue) => issue.includes("invalid_toml")), true);
	assert.equal(response.issues.some((issue) => issue.includes("Plugin API v2 migration")), true);
});

test("invalid plugin ids cannot alias a real plugin during inspection", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-plugin-id-management-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const workspaceRoot = join(root, "workspace");
	const homeDir = join(root, "home");
	const pluginRoot = join(workspaceRoot, ".mycli", "plugins", "plugin");
	await mkdir(join(workspaceRoot, ".mycli"), { recursive: true });
	await cp(GOOD_FIXTURE, pluginRoot, { recursive: true });
	await writeFile(join(pluginRoot, "plugin.yaml"), [
		"api_version: 2",
		"id: plugin",
		"name: Alias Target",
		"entry: dist/index.js",
		"provides:",
		"  tools: [echo]",
		"  hooks: [pre_tool_use]",
		"  commands: [status, late]",
		"requires_env: []",
		"capabilities: []",
	].join("\n"), "utf8");
	await writeFile(join(workspaceRoot, ".mycli", "config.toml"), [
		"[plugins]",
		'enabled = ["plugin"]',
		"disabled = []",
	].join("\n"), "utf8");
	const service = new PluginManagementService({
		runtimeOptions: {
			workspaceRoot,
			homeDir,
			env: {},
			sandboxProfile: (manifest) => fullAccessSandbox(manifest.pluginRoot),
		},
	});

	const response = await service.inspect("plugin/", new AbortController().signal);

	assert.equal(response.ok, false);
	assert.deepEqual(response.plugins, []);
});

function fullAccessSandbox(root: string) {
	return {
		mode: "danger-full-access" as const,
		filesystem: "unrestricted" as const,
		network: "enabled" as const,
		writableRoots: [root],
		workspaceRoot: root,
		cwd: root,
	};
}
