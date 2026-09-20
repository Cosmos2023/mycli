import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalPolicy } from "@mycli/tools";
import { parseMcpServerConfig, type McpManagedClient, type McpToolDescriptor } from "../../src/index.ts";
import { createMcpToolRegistration, McpManager } from "../../src/mcp/index.ts";

const tools: readonly McpToolDescriptor[] = ["read", "write", "hidden"].map((name) => ({ serverId: "docs", name, description: "fixture tool",
	inputSchema: { type: "object", properties: {} }, supportsParallelToolCalls: true, annotations: { readOnlyHint: true, destructiveHint: false } }));
const client: McpManagedClient = { listTools: async () => tools, listResources: async () => [],
	callTool: async () => ({ content: [], isError: false }), readResource: async () => [], close: async () => undefined };

test("raw tool filters and annotation hints survive cached and live registration with identical approval scopes", async (t) => {
	const config = parseMcpServerConfig("docs", { command: "node", enabled_tools: ["read", "write"], disabled_tools: ["write"],
		default_tools_approval_mode: "prompt" }, {});
	const manager = new McpManager({ configs: [config], createClient: () => client,
		catalogCache: { load: async () => [{ serverId: "docs", tools, resourceCount: 0 }], save: async () => undefined } });
	t.after(() => manager.close());
	const cached = await manager.loadCached(new AbortController().signal);
	const live = await manager.refresh(new AbortController().signal);
	assert.deepEqual(cached?.registrations.map((tool) => tool.definition.name), ["mcp_docs_read"]);
	assert.deepEqual(live.registrations.map((tool) => tool.approvalScope), cached?.registrations.map((tool) => tool.approvalScope));
	assert.equal(live.registrations[0]?.approvalPolicy, "always_request");
	assert.equal(live.servers[0]?.toolCount, 1);
});

test("server and tool approval modes, scoped session grants and changed configuration remain independent of Shell rules", () => {
	const config = parseMcpServerConfig("docs", { command: "node", default_tools_approval_mode: "prompt",
		tools: { write: { approval_mode: "approve" }, hidden: { approval_mode: "auto" } } }, {});
	const registrations = tools.map((tool) => createMcpToolRegistration(client, tool, config));
	const policies = registrations.map((tool) => ({ name: tool.definition.name, approvalPolicy: tool.approvalPolicy!, approvalScope: tool.approvalScope! }));
	const policy = new ApprovalPolicy({ workspaceRoot: process.cwd(), permissionProfile: "full-access", extensionTools: policies });
	const call = (name: string) => ({ callId: name, name, argumentsJson: "{}" });
	assert.equal(policy.evaluate(call("mcp_docs_read")).kind, "request");
	assert.equal(policy.evaluate(call("mcp_docs_write")).kind, "allow");
	assert.equal(policy.evaluate(call("mcp_docs_hidden")).kind, "allow");
	policy.configurePermissionProfile("workspace");
	const request = policy.evaluate(call("mcp_docs_read"));
	assert.equal(request.kind, "request");
	if (request.kind !== "request") assert.fail("expected approval");
	assert.deepEqual(request.options, ["approve_once", "reject", "allow_session", "always_allow"]);
	policy.allowExtensionSession(request.extensionApproval!);
	assert.equal(policy.evaluate(call("mcp_docs_read")).kind, "allow");
	assert.deepEqual(policy.listSessionAllowances(), []);
	const changed = createMcpToolRegistration(client, tools[0]!, { ...config, args: ["different-server.mjs"] });
	assert.notDeepEqual(changed.approvalScope, registrations[0]!.approvalScope);
	policy.beginTurn("frozen");
	policy.replaceExtensionTools([{ name: changed.definition.name, approvalPolicy: changed.approvalPolicy!, approvalScope: changed.approvalScope! }]);
	assert.equal(policy.evaluate(call("mcp_docs_read"), undefined, "frozen").kind, "allow");
	assert.equal(policy.evaluate(call("mcp_docs_read")).kind, "request");
	policy.replaceRememberedExtensions([changed.approvalScope!]);
	assert.equal(policy.evaluate(call("mcp_docs_read")).kind, "allow");
	policy.replaceRememberedExtensions([]);
	assert.equal(policy.evaluate(call("mcp_docs_read")).kind, "request");
	assert.equal(policy.matchesExtensionApproval(registrations[0]!.approvalScope!, "mcp_docs_read", "new-turn"), false);
	const changedSchema = createMcpToolRegistration(client, { ...tools[0]!, inputSchema: { type: "object", properties: { path: { type: "string" } } } }, config);
	assert.notDeepEqual(changedSchema.approvalScope, registrations[0]!.approvalScope);
});

test("required servers demand live tools discovery without starting optional servers", async (t) => {
	const required = parseMcpServerConfig("docs", { command: "node", required: true }, {});
	const calls: string[] = [];
	const manager = new McpManager({ configs: [required, { ...required, id: "optional", required: false }],
		createClient: (config) => ({ ...client, listTools: async () => { calls.push(config.id); return tools; } }),
		catalogCache: { load: async () => ["docs", "optional"].map((serverId) => ({ serverId, tools: [], resourceCount: 0 })), save: async () => undefined } });
	t.after(() => manager.close());
	assert.deepEqual((await manager.discoverRequired(new AbortController().signal)).servers.map((server) => server.serverId), ["docs"]);
	assert.deepEqual(calls, ["docs"]);
	const broken = new McpManager({ configs: [required], createClient: () => ({ ...client, listTools: async () => { throw new Error("private-startup-failure"); } }),
		catalogCache: { load: async () => [{ serverId: "docs", tools, resourceCount: 0 }], save: async () => undefined } });
	t.after(() => broken.close());
	assert.equal((await broken.loadCached(new AbortController().signal))?.registrations.length, 3);
	await assert.rejects(broken.discoverRequired(new AbortController().signal), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.match(error.message, /Required MCP servers could not start: docs/u);
		assert.doesNotMatch(error.message, /private/u);
		return true;
	});
});
