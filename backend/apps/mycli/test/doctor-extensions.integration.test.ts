import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	McpManagedClient,
	PluginHostContract,
	PluginHostStatus,
} from "@mycli/integrations";
import { collectExtensionChecks } from "../src/management/doctor/check-extensions.ts";

test("extension doctor isolates malformed trees, reports migration, and closes probes", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-doctor-extensions-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const workspaceRoot = join(root, "workspace");
	const homeDir = join(root, "home");
	const builtinSkillRoot = join(root, "builtin-skills");
	const mycliRoot = join(workspaceRoot, ".mycli");
	await mkdir(join(mycliRoot, "skills"), { recursive: true });
	await mkdir(join(mycliRoot, "plugins", "legacy"), { recursive: true });
	await mkdir(join(mycliRoot, "plugins", "healthy", "dist"), { recursive: true });
	await mkdir(builtinSkillRoot, { recursive: true });

	await writeFile(join(mycliRoot, "hooks.json"), "{secret: hook-test-secret", "utf8");
	await writeFile(join(mycliRoot, "skills", "broken.md"), [
		"---",
		'name = "../unsafe"',
		'description = "skill-test-secret"',
		"---",
		"private skill prompt",
	].join("\n"), "utf8");
	await writeFile(join(mycliRoot, "plugins", "legacy", "__init__.py"), "TOKEN='python-test-secret'\n", "utf8");
	await writeFile(join(mycliRoot, "plugins", "legacy", "plugin.yaml"), "name: Legacy\n", "utf8");
	await writeFile(join(mycliRoot, "plugins", "healthy", "dist", "index.js"), "export const unused = true;\n", "utf8");
	await writeFile(join(mycliRoot, "plugins", "healthy", "plugin.yaml"), [
		"api_version: 2",
		"id: healthy",
		"name: Healthy",
		"entry: dist/index.js",
		"provides:",
		"  tools: []",
		"  hooks: []",
		"  commands: []",
		"requires_env: []",
		"capabilities: []",
	].join("\n"), "utf8");
	await writeFile(join(mycliRoot, "config.toml"), [
		"[plugins]",
		'enabled = ["healthy", "legacy"]',
		"disabled = []",
	].join("\n"), "utf8");
	await writeFile(join(mycliRoot, "mcp_servers.toml"), [
		"[servers.files]",
		'transport = "stdio"',
		`command = ${JSON.stringify(process.execPath)}`,
	].join("\n"), "utf8");

	let pluginStatus: PluginHostStatus = "idle";
	let pluginCloseCount = 0;
	let mcpCloseCount = 0;
	const pluginHost: PluginHostContract = {
		get status() { return pluginStatus; },
		registrations: [],
		start: async () => {
			pluginStatus = "ready";
			return [];
		},
		invoke: async () => ({ ok: true, resultType: "command_result", value: {} }),
		close: async () => {
			pluginStatus = "closed";
			pluginCloseCount += 1;
		},
	};
	const mcpClient: McpManagedClient = {
		listTools: async () => [],
		callTool: async () => ({ content: [], isError: false }),
		listResources: async () => [],
		readResource: async () => [],
		close: async () => { mcpCloseCount += 1; },
	};

	const checks = await collectExtensionChecks({
		workspaceRoot,
		homeDir,
		env: {},
		builtinSkillRoot,
		createPluginHost: () => pluginHost,
		createMcpClient: () => mcpClient,
	}, new AbortController().signal);
	const byName = new Map(checks.map((check) => [check.name, check]));

	assert.deepEqual(checks.map((check) => check.name), [
		"hooks",
		"plugins",
		"plugin_migration",
		"skills",
		"subagents",
		"mcp",
	]);
	assert.equal(byName.get("hooks")?.status, "failed");
	assert.equal(byName.get("plugins")?.status, "ok");
	assert.equal(byName.get("plugin_migration")?.status, "warning");
	assert.match(byName.get("plugin_migration")?.message ?? "", /migration_required/u);
	assert.equal(byName.get("skills")?.status, "warning");
	assert.equal(byName.get("subagents")?.status, "ok");
	assert.equal(byName.get("subagents")?.message, "mode=prompt_driven profiles=disabled");
	assert.equal(byName.get("mcp")?.status, "ok");
	assert.equal(pluginCloseCount, 1);
	assert.equal(mcpCloseCount, 1);
	assert.doesNotMatch(
		JSON.stringify(checks),
		/hook-test-secret|skill-test-secret|python-test-secret|private.*prompt/u,
	);
});
