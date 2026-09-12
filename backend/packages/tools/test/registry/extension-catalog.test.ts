import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalPolicy, ExtensionToolCatalog, ToolRouter, ToolSearchTool, type ExtensionCatalogTool } from "../../src/index.ts";

test("failed catalog publication retains routes, policy, search, and version while active turns keep old bindings", async () => {
	const router = new ToolRouter({ adapters: [], exposure: [] });
	const search = new ToolSearchTool([]);
	const policy = new ApprovalPolicy({ workspaceRoot: process.cwd() });
	const catalog = new ExtensionToolCatalog(router, search, policy);
	const first = tool("first");
	const next = tool("next");
	catalog.replace({ version: 1, tools: [first], skillCatalog: "first" }, [{ name: first.definition.name, approvalPolicy: "request" }]);
	router.beginTurn("active", { directTools: [first.definition], deferredTools: [] });
	policy.beginTurn("active");
	assert.throws(() => catalog.replace({ version: 2, tools: [next], skillCatalog: "next" }, [{ name: "next", approvalPolicy: "request" }, { name: "next", approvalPolicy: "request" }]));
	assert.equal(catalog.snapshot.version, 1);
	assert.deepEqual(router.dynamicDefinitions().map((definition) => definition.name), ["first"]);
	assert.deepEqual((await search.execute({ query: "first" })).toolActivation?.names, ["first"]);
	assert.deepEqual((await search.execute({ query: "next" })).toolActivation?.names, []);
	catalog.replace({ version: 3, tools: [next], skillCatalog: "next" }, [{ name: "next", approvalPolicy: "request" }]);
	const options = { ownerSessionId: "session", callId: "call", publishLifecycle: () => undefined, signal: new AbortController().signal };
	assert.equal((await router.execute({ callId: "call", name: "first", argumentsJson: "{}" }, { ...options, ownerTurnId: "active" })).success, true);
	assert.equal((await router.execute({ callId: "call", name: "first", argumentsJson: "{}" }, options)).errorKind, "unknown_tool");
	assert.equal((await router.execute({ callId: "call", name: "next", argumentsJson: "{}" }, options)).success, true);
	router.finishTurn("active");
	policy.finishTurn("active");
});

function tool(name: string): ExtensionCatalogTool {
	const definition = { id: `plugin:docs:${name}`, name, description: name, inputSchema: { type: "object" } };
	return { definition, source: "plugin", originMetadata: { plugin: "docs", tool: name },
		adapter: { definition, execute: async () => ({ success: true, modelOutput: name, summary: name, metadata: {} }) } };
}
