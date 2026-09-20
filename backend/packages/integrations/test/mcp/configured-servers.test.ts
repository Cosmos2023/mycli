import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverConfiguredMcpServers, mcpServerSelector, pluginMcpServerId } from "../../src/index.ts";
import { McpManagementService } from "../../src/mcp/index.ts";

test("configured MCP discovery shares plugin selectors, OAuth normalization, trust and override precedence", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-configured-mcp-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "repo");
	const bundle = join(workspaceRoot, ".mycli/plugins/docs@local");
	await mkdir(join(bundle, ".codex-plugin"), { recursive: true });
	await writeFile(join(workspaceRoot, ".mycli/config.toml"), '[plugins]\nenabled = ["docs@local"]\n');
	await writeFile(join(bundle, ".codex-plugin/plugin.json"), JSON.stringify({ name: "docs", mcpServers: {
		mcpServers: {
			search: { type: "http", url: "https://example.invalid/mcp", http_headers: { "X-Private": "${FIXTURE_TOKEN}" },
				oauth: { clientId: "bundle-client", callbackPort: 32100, scopes: ["read"] } },
			canonical: { url: "https://example.invalid/mcp", oauth: { clientId: "ignored", client_id: "preferred", callbackPort: 32100, callback_port: 32101 } },
			broken: { command: "must-not-run", env: false, required: true },
		},
	} }));
	const options = { homeDir, workspaceRoot, env: { FIXTURE_TOKEN: "private-fixture" } };
	const config = await discoverConfiguredMcpServers(options);
	const search = config.get("docs@local/search")!;
	assert.ok(search);
	assert.equal(config.get(search.id), search);
	assert.equal(mcpServerSelector(search), "docs@local/search");
	assert.deepEqual(search.plugin, { id: "docs@local", source: "repo", serverName: "search" });
	assert.equal(search.transport, "streamable_http");
	assert.deepEqual(search.oauth, { clientId: "bundle-client", callbackPort: 32100, scopes: ["read"] });
	assert.deepEqual(config.get("docs@local/canonical")?.oauth, { clientId: "preferred", callbackPort: 32101 });
	assert.deepEqual(config.requiredPluginFailures, [pluginMcpServerId("docs@local", "broken")]);
	assert.ok(config.pluginIssues.some((issue) => issue.errorClass === "plugin_mcp_env_invalid"));
	assert.equal((await discoverConfiguredMcpServers({ ...options, includeRepository: false })).servers.length, 0);

	const service = new McpManagementService({ ...options, createClient: (server) => ({
		listTools: async () => [{ serverId: server.id, name: "read", description: "Read docs", inputSchema: { type: "object" }, supportsParallelToolCalls: true }],
		listResources: async () => [], readResource: async () => [], callTool: async () => ({ content: [], isError: false }), close: async () => undefined,
	}) });
	const inspection = await service.inspect("docs@local/search", new AbortController().signal);
	assert.equal(inspection.message, "mcp server: docs@local/search");
	assert.equal(inspection.servers[0]?.selector, "docs@local/search");
	assert.equal(inspection.servers[0]?.source, "plugin");
	assert.equal(inspection.servers[0]?.authStatus, "not_logged_in");
	assert.doesNotMatch(JSON.stringify(inspection), /private-fixture|example\.invalid/u);

	await mkdir(join(homeDir, ".mycli"), { recursive: true });
	await writeFile(join(homeDir, ".mycli/mcp_servers.toml"), `[servers.${search.id}]\ncommand = "explicit-override"\n[servers.${config.requiredPluginFailures[0]}]\ncommand = "explicit-override"\n`);
	const overridden = await discoverConfiguredMcpServers(options);
	assert.equal(overridden.get(search.id)?.source, "user");
	assert.equal(overridden.get("docs@local/search"), undefined);
	assert.deepEqual(overridden.requiredPluginFailures, []);
	await writeFile(join(workspaceRoot, ".mycli/config.toml"), '[plugins]\ndisabled = ["docs@local"]\n');
	assert.equal((await discoverConfiguredMcpServers(options)).servers.some((server) => server.plugin), false);

	await writeFile(join(bundle, ".codex-plugin/plugin.json"), "invalid-json");
	assert.ok((await discoverConfiguredMcpServers(options)).pluginIssues.length, "plugin discovery failures remain diagnostic-visible");
});
