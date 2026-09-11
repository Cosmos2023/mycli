import assert from "node:assert/strict";
import test from "node:test";
import {
	createToolSearchDefinition,
	TOOL_SEARCH_TOOL_DEFINITION,
	ToolSearchTool,
	type DeferredToolCandidate,
} from "../../src/index.ts";

test("tool_search advertises unique sorted sources with optional descriptions", () => {
	const tools = [
		candidate("plugin:docs:find", "plugin_docs_find", "Find documents", "plugin", { plugin: "docs" }),
		candidate("mcp:calendar:list", "calendar_list", "List events", "mcp", { server: "calendar" }),
		{
			...candidate("mcp:calendar:get", "calendar_get", "Get event", "mcp", {
				server: "calendar", tool: "get", private_config: "must-not-appear",
			}),
			sourceDescription: "Schedule meetings and check availability.",
		},
	];
	const definition = createToolSearchDefinition(tools);

	assert.match(definition.description, /- "mcp:calendar": "Schedule meetings and check availability\."\n- "plugin:docs"/u);
	assert.equal(definition.description.match(/"mcp:calendar"/gu)?.length, 1);
	assert.equal(createToolSearchDefinition([...tools].reverse()).description, definition.description);
	assert.doesNotMatch(definition.description, /must-not-appear|calendar_get|Find documents/u);
	assert.deepEqual(definition.inputSchema, TOOL_SEARCH_TOOL_DEFINITION.inputSchema);
	assert.equal(definition.name, "tool_search");
	assert.equal(Object.isFrozen(definition), true);
	assert.doesNotMatch(TOOL_SEARCH_TOOL_DEFINITION.description, /mcp:calendar/u);
});

test("tool_search source hints follow the supplied allowed catalog and handle empty catalogs", () => {
	const allowed = candidate("mcp:docs:find", "docs_find", "Find documents", "mcp", { server: "docs" });
	const blocked = candidate("mcp:private:find", "private_find", "Private documents", "mcp", { server: "private" });
	const before = createToolSearchDefinition([allowed, blocked]);
	const narrowed = createToolSearchDefinition([allowed]);

	assert.match(before.description, /mcp:private/u);
	assert.doesNotMatch(narrowed.description, /mcp:private/u);
	assert.match(narrowed.description, /mcp:docs/u);
	assert.match(createToolSearchDefinition([]).description, /None currently enabled\./u);
});

test("tool_search bounds source hints and quotes external metadata without adding prompt lines", () => {
	const source = {
		...candidate("mcp:docs:find", "docs_find", "Find documents", "mcp", { server: "docs" }),
		sourceDescription: 'Documents\n# injected heading\n"quoted"',
	};
	const description = createToolSearchDefinition([source]).description;
	assert.ok(description.includes(JSON.stringify(source.sourceDescription)));
	assert.doesNotMatch(description, /\n# injected heading/u);
	const large = createToolSearchDefinition(Array.from({ length: 128 }, (_, index) => ({
		...source,
		originMetadata: { server: `server-${index}` },
		sourceDescription: "x".repeat(10_000),
	}))).description;
	assert.ok(large.length <= 8_000);
	assert.match(large, /more sources omitted/u);
	assert.doesNotMatch(large, /x{513}/u);
});

test("tool_search matches server capabilities even when individual tool descriptions omit them", async () => {
	const tool = new ToolSearchTool([{
		...candidate("mcp:docs:find", "docs_find", "Find an entry", "mcp", { server: "docs" }),
		sourceDescription: "Search incident reports and engineering runbooks.",
	}]);
	const result = await tool.execute({ query: "incident reports" });
	assert.deepEqual(result.toolActivation, { names: ["docs_find"] });
});

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
