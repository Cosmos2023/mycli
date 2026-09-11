import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpManager, type McpManagerDiscovery } from "@mycli/integrations";
import { builtinToolManifest } from "@mycli/tools";
import { createRuntimeIntegrationComposition } from "../src/node-runtime/integration-composition.ts";

test("MCP catalog publishes connection results and fences refreshes after workspace reload", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-catalog-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const workspaceRoot = join(root, "workspace");
	const homeDir = join(root, "home");
	await mkdir(join(workspaceRoot, ".mycli"), { recursive: true });
	await mkdir(homeDir);
	await writeFile(join(workspaceRoot, ".mycli/mcp_servers.toml"), [
		'[servers.docs]', 'command = "never-spawn"',
		'[servers.broken]', 'command = "never-spawn"',
		'[servers.off]', 'command = "never-spawn"', 'enabled = false',
	].join("\n"));
	const refreshes: { complete: (discovery: McpManagerDiscovery) => void }[] = [];
	t.mock.method(McpManager.prototype, "loadCached", async () => undefined);
	t.mock.method(McpManager.prototype, "refresh", () => new Promise<McpManagerDiscovery>((resolve) => {
		refreshes.push({ complete: resolve });
	}));
	const composition = await createRuntimeIntegrationComposition({
		builtinManifest: builtinToolManifest(), workspaceRoot, homeDir, env: {},
		parentSessionId: "catalog", parentTurnId: () => "turn", parentTools: () => [],
		createSubagentSupervisor: () => ({
			spawn: async () => assert.fail("inspection must not spawn an agent"), output: () => assert.fail("no agent output expected"),
			send: async () => assert.fail("inspection must not send input"), interrupt: async () => false,
			waitFor: async () => undefined, unload: async () => false, list: () => [], recoverLegacyAbandoned: () => 0,
			close: async () => undefined,
		}),
		resolveSubagentSpawnContext: () => assert.fail("inspection must not spawn an agent"),
	});
	t.after(() => composition.close());
	assert.deepEqual(composition.resources.filter((row) => row.type === "mcp").map((row) => [row.name, row.status]), [
		["broken", "loading"], ["docs", "loading"], ["off", "disabled"],
	]);
	const discovery: McpManagerDiscovery = { registrations: [], resources: [], servers: [
		{ serverId: "docs", transport: "stdio", enabled: true, status: "ok", toolCount: 1, resourceCount: 0, timeoutMs: 30_000 },
		{ serverId: "broken", transport: "stdio", enabled: true, status: "failed", toolCount: 0, resourceCount: 0, timeoutMs: 30_000,
			failureCategory: "connection_closed" },
		{ serverId: "off", transport: "stdio", enabled: false, status: "disabled", toolCount: 0, resourceCount: 0, timeoutMs: 30_000 },
	] };
	refreshes[0]!.complete(discovery);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(composition.resources.filter((row) => row.type === "mcp").map((row) => [row.name, row.status]), [
		["broken", "failed"], ["docs", "ready"], ["off", "disabled"],
	]);
	assert.equal(composition.resources.some((row) => row.type === "plugin"), false);
	await composition.reloadProjectConfiguration({ workspaceRoot, enabled: false });
	await composition.reloadProjectConfiguration({ workspaceRoot, enabled: true });
	assert.equal(refreshes.length, 3);
	const stale = refreshes.at(-1)!;
	await composition.reloadProjectConfiguration({ workspaceRoot, enabled: false });
	const version = composition.version;
	stale.complete(discovery);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(composition.version, version);
	assert.equal(composition.resources.some((row) => row.type === "mcp"), false);
	await composition.close();
	for (const refresh of refreshes) refresh.complete(discovery);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(composition.version, version);
});
