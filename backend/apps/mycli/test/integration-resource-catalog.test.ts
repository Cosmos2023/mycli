import assert from "node:assert/strict";
import test from "node:test";
import type { McpManagerDiscovery, McpServerConfig } from "@mycli/integrations";
import { mcpCatalogResources } from "../src/node-runtime/integration-resource-catalog.ts";
import { integrationInspectionResult } from "../src/node-runtime/node-integration-command-results.ts";
import { resolveSlashCommand } from "../src/node-runtime/node-slash-command-registry.ts";

function config(id: string, enabled = true): McpServerConfig {
	return { id, enabled, transport: "stdio", command: "private-command", args: ["private-argument"],
		env: { TOKEN: "private-token" }, headers: { Authorization: "private-header" },
		timeoutMs: 30_000, supportsParallelToolCalls: false };
}

test("MCP inventory includes loading, disabled, failed and tool-only servers without config secrets", () => {
	const configs = [config("tools"), config("broken"), config("off", false)];
	const loading = mcpCatalogResources(configs, undefined, "loading");
	assert.deepEqual(loading.map((item) => [item.name, item.type, item.status]), [
		["tools", "mcp", "loading"], ["broken", "mcp", "loading"], ["off", "mcp", "disabled"],
	]);
	const discovery: McpManagerDiscovery = { registrations: [], resources: [], servers: configs.map((item) => ({
		serverId: item.id, transport: item.transport, enabled: item.enabled, timeoutMs: item.timeoutMs,
		status: !item.enabled ? "disabled" : item.id === "broken" ? "failed" : "ok",
		toolCount: item.id === "tools" ? 2 : 0, resourceCount: 0,
		...(item.id === "broken" ? { failureCategory: "timeout" } : {}),
	})) };
	const resources = mcpCatalogResources(configs, discovery, "ready");
	assert.deepEqual(resources.map((item) => item.status), ["ready", "failed", "disabled"]);
	assert.equal(resources[0]?.tool_count, 2);
	assert.match(resources[1]!.inspection_detail, /timeout/u);
	assert.doesNotMatch(JSON.stringify([...loading, ...resources]), /private-/u);
	assert.deepEqual(mcpCatalogResources(configs, undefined, "failed").map((item) => item.status), ["failed", "failed", "disabled"]);
	assert.equal(mcpCatalogResources(configs, discovery, "cached")[0]?.status, "cached");
	assert.equal(mcpCatalogResources(configs, discovery, "failed")[0]?.status, "cached");
});

test("inspection groups package capabilities and scopes MCP verbose details", () => {
	const resources = [
		{ id: "mcp:docs", type: "mcp", name: "docs", enabled: true, status: "failed", tool_count: 1,
			tool_names: ["SearchDocs"], detail: "connection_closed", inspection_detail: "Transport: stdio\nResources: README" },
		{ id: "plugin:demo", type: "plugin", name: "demo", status: "partial", source: "user",
			inspection_detail: "Skills: review\nMCP servers: docs\nHooks: stop\nCommands: /plugin:demo:status" },
	];
	const run = (text: string): { title: string; rows: { label: string; status: string; detail: string }[] } => {
		const invocation = resolveSlashCommand({ text, surface: "tui", turnRunning: true });
		return integrationInspectionResult(invocation, { resources }).display as ReturnType<typeof run>;
	};
	const plugins = run("/plugins");
	assert.deepEqual(plugins.rows.map((row) => row.label), ["demo"]);
	assert.equal(plugins.rows[0]?.status, "partial");
	assert.match(plugins.rows[0]!.detail, /MCP servers: docs/u);
	const mcp = run("/mcp");
	assert.deepEqual(mcp.rows.map((row) => row.label), ["docs"]);
	assert.equal(mcp.rows[0]?.status, "failed");
	assert.match(mcp.rows[0]!.detail, /SearchDocs/u);
	assert.doesNotMatch(mcp.rows[0]!.detail, /README|Transport/u);
	assert.match(run("/mcp\tverbose").rows[0]!.detail, /Transport: stdio\nResources: README/u);
	assert.deepEqual(run("/hooks").rows, []);
});
