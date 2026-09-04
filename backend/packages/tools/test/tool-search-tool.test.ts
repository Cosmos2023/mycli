import assert from "node:assert/strict";
import test from "node:test";
import {
	ToolSearchTool,
	type DeferredToolCandidate,
} from "../src/index.ts";

test("tool_search ranks route description and origin matches deterministically", async () => {
	const tool = new ToolSearchTool([
		candidate("mcp:calendar:list", "mcp_calendar_list_events", "List upcoming meetings", "mcp", {
			server: "calendar",
			tool: "list_events",
		}),
		candidate("plugin:docs:search", "docs_search", "Search internal documents", "plugin", {
			plugin: "company_docs",
			tool: "search",
		}),
		candidate("mcp:calendar:create", "mcp_calendar_create_event", "Create a meeting", "mcp", {
			server: "calendar",
			tool: "create_event",
		}),
	]);

	const exact = await tool.execute({ query: "docs search" });
	const origin = await tool.execute({ query: "calendar", limit: 1 });

	assert.equal(exact.success, true);
	assert.deepEqual(exact.toolActivation, { names: ["docs_search"] });
	assert.equal(exact.modelOutput.includes("inputSchema"), false);
	assert.equal(exact.modelOutput.includes("Search internal documents"), true);
	assert.deepEqual(origin.toolActivation, { names: ["mcp_calendar_create_event"] });
});

test("tool_search returns an empty successful effect when no tools match", async () => {
	const result = await new ToolSearchTool([
		candidate("plugin:docs:search", "docs_search", "Search documents", "plugin", {
			plugin: "docs",
		}),
	]).execute({ query: "calendar" });

	assert.equal(result.success, true);
	assert.equal(result.summary, "No deferred tools matched");
	assert.deepEqual(result.toolActivation, { names: [] });
	assert.deepEqual(JSON.parse(result.modelOutput), { tools: [] });
});

test("tool_search validates direct adapter calls and caps the result limit", async () => {
	const tool = new ToolSearchTool([]);
	for (const input of [
		{},
		{ query: "  " },
		{ query: "docs", limit: 0 },
		{ query: "docs", limit: 17 },
		{ query: "docs", limit: 1.5 },
	]) {
		const result = await tool.execute(input);
		assert.equal(result.success, false);
		assert.equal(result.errorKind, "invalid_arguments");
		assert.equal(result.toolActivation, undefined);
	}
});

test("tool_search owns frozen copies of catalog definitions and metadata", async () => {
	const definition = {
		id: "plugin:docs:search",
		name: "docs_search",
		description: "Search documents",
		inputSchema: { type: "object", properties: { query: { type: "string" } } },
	};
	const originMetadata = { plugin: "docs" };
	const tool = new ToolSearchTool([{ definition, source: "plugin", originMetadata }]);
	definition.description = "mutated";
	originMetadata.plugin = "mutated";

	const result = await tool.execute({ query: "docs" });

	assert.equal(result.modelOutput.includes("Search documents"), true);
	assert.equal(result.modelOutput.includes("mutated"), false);
});

test("tool_search keeps a turn catalog stable across background replacement", async () => {
	const tool = new ToolSearchTool([
		candidate("mcp:docs:old", "docs_old", "Old docs", "mcp", { server: "docs" }),
	]);
	tool.beginTurn("turn-old");
	tool.replaceCandidates([
		candidate("mcp:docs:new", "docs_new", "New docs", "mcp", { server: "docs" }),
	]);
	const options = (turnId: string) => ({
		signal: new AbortController().signal,
		ownerSessionId: "session",
		ownerTurnId: turnId,
		callId: "call",
		publishLifecycle: () => undefined,
	});
	const oldTurn = await tool.execute({ query: "docs" }, options("turn-old"));
	tool.beginTurn("turn-new");
	const newTurn = await tool.execute({ query: "docs" }, options("turn-new"));

	assert.deepEqual(oldTurn.toolActivation, { names: ["docs_old"] });
	assert.deepEqual(newTurn.toolActivation, { names: ["docs_new"] });
	tool.finishTurn("turn-old");
	tool.finishTurn("turn-new");
});

test("tool_search cannot discover additions outside a restored run catalog", async () => {
	const old = candidate("mcp:docs:old", "docs_old", "Old docs", "mcp", { server: "docs" });
	const added = candidate("mcp:docs:new", "docs_new", "New docs", "mcp", { server: "docs" });
	const tool = new ToolSearchTool([old, added]);
	tool.beginTurn("turn-restored", { deferredTools: [old.definition] });

	const result = await tool.execute({ query: "docs" }, {
		signal: new AbortController().signal,
		ownerSessionId: "session",
		ownerTurnId: "turn-restored",
		callId: "call-search",
		publishLifecycle: () => undefined,
	});

	assert.deepEqual(result.toolActivation, { names: ["docs_old"] });
	assert.equal(result.modelOutput.includes("docs_new"), false);
	tool.finishTurn("turn-restored");
});

function candidate(
	id: string,
	name: string,
	description: string,
	source: DeferredToolCandidate["source"],
	originMetadata: Readonly<Record<string, string>>,
): DeferredToolCandidate {
	return {
		definition: {
			id,
			name,
			description,
			inputSchema: {
				type: "object",
				properties: { query: { type: "string" } },
				additionalProperties: false,
			},
		},
		source,
		originMetadata,
	};
}
