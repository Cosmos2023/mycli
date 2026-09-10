import assert from "node:assert/strict";
import test from "node:test";
import { ToolRouter, TOOL_SEARCH_TOOL_DEFINITION, type ToolExecutionOptions } from "@mycli/tools";
import { ListMcpResourcesTool, ListMcpResourceTemplatesTool, ReadMcpResourceTool, type McpResourceService } from "../../src/index.ts";

const OPTIONS: ToolExecutionOptions = { signal: new AbortController().signal, ownerSessionId: "session", callId: "resource", publishLifecycle: () => undefined };
const IMAGE = "aW1hZ2U=";

test("Codex resource tools preserve server-scoped native cursors and template URIs", async () => {
	const seen: (string | undefined)[] = [];
	const service: McpResourceService = {
		listResources: async () => ({ resources: [], failures: [] }), readResource: async () => [],
		listResourcesPage: async (server, _signal, cursor) => {
			assert.equal(server, "files"); seen.push(cursor);
			return { resources: [{ serverId: server, uri: "data:///readme", name: "readme", description: "" }],
				...(cursor === undefined ? { nextCursor: "opaque+/=" } : {}) };
		},
		listResourceTemplates: async (_signal, server, cursor) => {
			assert.equal(server, "files"); seen.push(cursor);
			return { resourceTemplates: [{ serverId: server, uriTemplate: "data:///notes/{name}", name: "note", description: "" }],
				failures: [], ...(cursor === undefined ? { nextCursor: "opaque+/=" } : {}) };
		},
	};
	for (const tool of [new ListMcpResourcesTool(service), new ListMcpResourceTemplatesTool(service)]) {
		assert.deepEqual(Object.keys(tool.definition.inputSchema.properties as object), ["server", "cursor"]);
		for (const cursor of [undefined, "opaque+/="]) {
			const result = await tool.execute({ server: "files", cursor }, OPTIONS);
			assert.equal(result.success, true);
			const output = JSON.parse(result.modelOutput) as Record<string, unknown>;
			assert.equal(output.server, "files");
			assert.equal(output.nextCursor, cursor === undefined ? "opaque+/=" : undefined);
			assert.equal(output.next_offset, undefined);
			if (tool.definition.name === "list_mcp_resource_templates") assert.ok(result.modelOutput.includes("data:///notes/{name}"));
		}
		assert.equal((await tool.execute({ cursor: "opaque+/=" }, OPTIONS)).errorKind, "invalid_arguments");
		await assert.rejects(tool.execute({}, { ...OPTIONS, signal: AbortSignal.abort() }), { name: "AbortError" });
	}
	assert.deepEqual(seen, [undefined, "opaque+/=", undefined, "opaque+/="]);
	assert.deepEqual(Object.keys(new ReadMcpResourceTool(service).definition.inputSchema.properties as object), ["server", "uri"]);
});

test("resource listing paginates valid JSON without losing exact URIs", async () => {
	const resources = Array.from({ length: 120 }, (_, index) => ({ serverId: "files", uri: `data:///${index}`, name: `Resource ${index}`, description: "detail".repeat(200) }));
	const service: McpResourceService = { listResources: async () => ({ resources, failures: [] }), readResource: async () => [] };
	const tool = new ListMcpResourcesTool(service);
	const router = new ToolRouter({ adapters: [tool], exposure: [tool.definition, TOOL_SEARCH_TOOL_DEFINITION] });
	const seen: string[] = [];
	let offset: number | undefined;
	do {
		const result = await router.execute({ name: tool.definition.name, callId: "resource", argumentsJson: JSON.stringify({ server: "files", offset }) }, OPTIONS);
		assert.equal(result.success, true);
		assert.ok(result.modelOutput.length <= 8_000);
		const page = JSON.parse(result.modelOutput) as { resources: { uri: string }[]; next_offset?: number };
		seen.push(...page.resources.map((resource) => resource.uri));
		offset = page.next_offset;
	} while (offset !== undefined);
	assert.deepEqual(seen, resources.map((resource) => resource.uri));
});

test("resource reading preserves paged text and images without leaking binary into metadata", async () => {
	const text = "quoted \" text\n".repeat(2_000);
	const service: McpResourceService = {
		listResources: async () => ({ resources: [], failures: [] }),
		readResource: async (server, uri) => {
			assert.equal(server, "files");
			assert.equal(uri, "data:///exact?x=1");
			return [{ serverId: server, uri, text }, { serverId: server, uri: "data:///image", mimeType: "image/png", blob: IMAGE }, { serverId: server, uri: "data:///pdf", mimeType: "application/pdf", blob: "private-binary" }];
		},
	};
	const tool = new ReadMcpResourceTool(service);
	let offset: number | undefined;
	let combined = "";
	let pages = 0;
	do {
		const result = await tool.execute({ server: "files", uri: "data:///exact?x=1", offset }, OPTIONS);
		assert.equal(result.success, true);
		assert.ok(result.modelOutput.length <= 8_000);
		assert.equal(result.modelOutput.includes("private-binary"), false);
		assert.equal(JSON.stringify(result.metadata).includes(IMAGE), false);
		assert.deepEqual(result.images, pages === 0 ? [{ mediaType: "image/png", data: IMAGE }] : undefined);
		const page = JSON.parse(result.modelOutput) as { text: string; next_offset?: number };
		combined += page.text;
		offset = page.next_offset;
		pages += 1;
	} while (offset !== undefined);
	assert.ok(pages > 1);
	assert.equal(combined, `data:///exact?x=1\n${text}\n\ndata:///image\n[Binary resource: image/png]\n\ndata:///pdf\n[Binary resource: application/pdf]`);
});

test("resource tools validate arguments, retain partial failures, and propagate cancellation", async () => {
	const service: McpResourceService = {
		listResources: async () => ({ resources: [], failures: [{ server: "offline", errorKind: "transport_error" }] }),
		readResource: async () => { throw new Error("private upstream details"); },
	};
	const list = new ListMcpResourcesTool(service);
	const read = new ReadMcpResourceTool(service);
	assert.equal((await list.execute({}, OPTIONS)).success, false);
	assert.equal((await read.execute({ server: "files", uri: "data:///read", offset: -1 }, OPTIONS)).errorKind, "invalid_arguments");
	assert.equal(JSON.stringify(await read.execute({ server: "files", uri: "data:///read" }, OPTIONS)).includes("private upstream"), false);
	await assert.rejects(read.execute({ server: "files", uri: "data:///read" }, { ...OPTIONS, signal: AbortSignal.abort() }), { name: "AbortError" });
});

test("native resource reads return Codex contents and keep truncated JSON bounded", async () => {
	const service: McpResourceService = {
		listResources: async () => ({ resources: [], failures: [] }),
		readResource: async (_server, uri) => [{ serverId: "files", uri, mimeType: "text/plain", text: "long\"text\n".repeat(2_000) }],
	};
	const tool = new ReadMcpResourceTool(service);
	const router = new ToolRouter({ adapters: [tool], exposure: [tool.definition] });
	const result = await router.execute({ name: tool.definition.name, callId: "read", argumentsJson: JSON.stringify({ server: "files", uri: "data:///readme" }) }, OPTIONS);
	assert.equal(result.success, true);
	assert.ok(result.modelOutput.length <= 8_000);
	const output = JSON.parse(result.modelOutput) as Record<string, unknown>;
	assert.equal(output.server, "files");
	assert.equal(output.uri, "data:///readme");
	assert.equal(output.truncated, true);
	assert.equal(Array.isArray(output.contents), true);
	assert.equal(output.next_offset, undefined);
	assert.equal((await router.execute({ name: tool.definition.name, callId: "invalid", argumentsJson: JSON.stringify({ server: "files", uri: "data:///readme", offset: -1 }) }, OPTIONS)).errorKind, "invalid_arguments");
});
