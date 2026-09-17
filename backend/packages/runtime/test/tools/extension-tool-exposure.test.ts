import assert from "node:assert/strict";
import test from "node:test";
import { toolDiscovery, type ToolDefinition } from "@mycli/core";
import { planExtensionToolExposure } from "../../src/tools/extension-tool-exposure.ts";

test("small catalogs expose stable direct schemas without a discovery call", () => {
	const tools = catalog(14);
	const first = planExtensionToolExposure(tools, []);
	assert.equal(first.direct.length, 14);
	assert.deepEqual(first.deferred, []);
	assert.deepEqual(planExtensionToolExposure([...tools].reverse(), []), first);
});

test("large catalogs reuse stable discoveries and reconcile identity, schema, and removal", () => {
	const tools = catalog(101);
	const selected = [tools[50]!, tools[1]!];
	const discoveries = selected.map(toolDiscovery);
	const first = planExtensionToolExposure(tools, discoveries);
	assert.deepEqual(first.direct, [selected[1], selected[0]]);
	assert.equal(first.deferred.length, 99);
	assert.deepEqual(planExtensionToolExposure([...tools].reverse(), discoveries), first);
	const changed = tools.map((tool) => tool === selected[0] ? { ...tool, inputSchema: { type: "object", required: ["changed"] } } : tool);
	assert.deepEqual(planExtensionToolExposure(changed, discoveries).direct, [selected[1]]);
	assert.deepEqual(planExtensionToolExposure(tools.filter((tool) => tool !== selected[1]), discoveries).direct, [selected[0]]);
	assert.deepEqual(planExtensionToolExposure(tools, discoveries.map((discovery) => ({ ...discovery, id: `other:${discovery.id}` }))).direct, []);
});

test("generic retention is bounded and a large schema keeps a small catalog deferred", () => {
	const tools = catalog(101);
	assert.equal(planExtensionToolExposure(tools, tools.map(toolDiscovery)).direct.length, 64);
	const huge = { ...tools[0]!, inputSchema: { type: "object", description: "x".repeat(129 * 1024) } };
	assert.deepEqual(planExtensionToolExposure([huge], [toolDiscovery(huge)]).direct, []);
});

function catalog(count: number): readonly ToolDefinition[] {
	return Array.from({ length: count }, (_, index) => ({ id: `mcp:docs:find${index}`, name: `mcp_docs_find${index}`,
		description: "Find documents", inputSchema: { type: "object", properties: { query: { type: "string" } } } }));
}
