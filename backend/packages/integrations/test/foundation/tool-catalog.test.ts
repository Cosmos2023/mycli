import assert from "node:assert/strict";
import test from "node:test";
import { normalizeIntegrationToolNames } from "../../src/index.ts";
import { createMcpToolRegistration } from "../../src/mcp/index.ts";
import { ToolRouter } from "@mycli/tools";

test("normalized aliases remain distinct and route to raw tools regardless of discovery order", async () => {
	const calls: string[] = [];
	const registrations = ["foo-bar", "foo_bar", "ordinary"].map((name) => createMcpToolRegistration({
		callTool: async (rawName) => { calls.push(rawName); return { content: [], isError: false }; },
	}, { serverId: "docs", name, description: "", inputSchema: { type: "object" }, supportsParallelToolCalls: true }));
	const normalized = normalizeIntegrationToolNames(registrations);
	assert.equal(new Set(normalized.map((entry) => entry.definition.name)).size, 3);
	assert.equal(normalized[2]?.definition.name, "mcp_docs_ordinary");
	assert.notEqual(normalizeIntegrationToolNames([registrations[2]!], ["mcp_docs_ordinary"])[0]?.definition.name, "mcp_docs_ordinary");
	assert.deepEqual(normalizeIntegrationToolNames([...registrations].reverse()).map((entry) => entry.definition.name).reverse(), normalized.map((entry) => entry.definition.name));
	assert.deepEqual(normalizeIntegrationToolNames(normalized), normalized);
	const router = new ToolRouter({ adapters: [], exposure: [] });
	router.replaceDynamicAdapters(normalized.map((entry) => entry.adapter));
	for (const entry of normalized) {
		const result = await router.execute({ callId: entry.id, name: entry.definition.name, argumentsJson: "{}" }, {
			ownerSessionId: "session", callId: entry.id, publishLifecycle: () => undefined, signal: new AbortController().signal,
		});
		assert.equal(result.success, true);
	}
	assert.deepEqual(calls, ["foo-bar", "foo_bar", "ordinary"]);
	assert.throws(() => normalizeIntegrationToolNames([registrations[0]!, registrations[0]!]), /duplicate_integration_tool/u);
});
