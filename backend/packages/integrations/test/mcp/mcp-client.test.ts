import assert from "node:assert/strict";
import test from "node:test";
import {
	McpClient,
	type McpProtocolClient,
	type McpServerConfig,
} from "../../src/index.ts";

test("resource discovery follows native cursors and rejects repeated cursors", async () => {
	for (const repeat of [false, true]) {
		const cursors: (string | undefined)[] = [];
		const protocol: McpProtocolClient = {
			connect: async () => undefined, close: async () => undefined,
			listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), readResource: async () => ({ contents: [] }),
			listResources: async (_signal, cursor) => {
				cursors.push(cursor);
				return { resources: [{ uri: cursor ? "data:///second" : "data:///first" }], ...(!cursor || repeat ? { nextCursor: "page-two" } : {}) };
			},
		};
		const client = new McpClient({ config: config(), protocol });
		if (repeat) await assert.rejects(client.listResources(new AbortController().signal), /invalid_mcp_resource_pagination/u);
		else assert.deepEqual((await client.listResources(new AbortController().signal)).map((resource) => resource.uri), ["data:///first", "data:///second"]);
		assert.deepEqual(cursors, [undefined, "page-two"]);
		await client.close();
	}
});

test("MCP client keeps native pages separate and discovers resource templates", async (t) => {
	const seen: (string | undefined)[] = [];
	const protocol: McpProtocolClient = {
		connect: async () => undefined, close: async () => undefined,
		listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), readResource: async () => ({ contents: [] }),
		listResources: async (_signal, cursor) => { seen.push(cursor); return { resources: [], nextCursor: "second" }; },
		listResourceTemplates: async (_signal, cursor) => {
			seen.push(cursor);
			return { resourceTemplates: [{ uriTemplate: "data:///{id}", name: "item" }], nextCursor: "next" };
		},
	};
	const client = new McpClient({ config: config(), protocol });
	t.after(() => client.close());
	const signal = new AbortController().signal;
	assert.equal((await client.listResourcesPage(signal)).nextCursor, "second");
	const templates = await client.listResourceTemplates(signal);
	assert.equal(templates.resourceTemplates[0]?.uriTemplate, "data:///{id}");
	assert.equal(templates.nextCursor, "next");
	assert.deepEqual(seen, [undefined, undefined]);
	await assert.rejects(client.listResourceTemplates(signal, "next"), /invalid_mcp_resource_pagination/u);
});

test("initializes one MCP protocol client and normalizes tools and resources", async () => {
	const calls: string[] = [];
	const protocol: McpProtocolClient = {
		connect: async () => { calls.push("connect"); },
		getInstructions: () => "  Browse project files and repository documentation.  ",
		listTools: async () => {
			calls.push("listTools");
			return { tools: [{
				name: "read_file",
				description: "Read a file",
				inputSchema: {
					type: "object",
					properties: { path: { type: "string" } },
					required: ["path"],
					additionalProperties: false,
				},
				annotations: { readOnlyHint: true },
			}] };
		},
		callTool: async (name, argumentsValue) => {
			calls.push(`callTool:${name}:${String(argumentsValue.path)}`);
			return { content: [{ type: "text", text: "contents" }], isError: false };
		},
		listResources: async () => {
			calls.push("listResources");
			return { resources: [{ uri: "file:///README.md", name: "README", mimeType: "text/markdown" }] };
		},
		readResource: async (uri) => {
			calls.push(`readResource:${uri}`);
			return { contents: [{ uri, text: "resource", mimeType: "text/plain" }] };
		},
		close: async () => { calls.push("close"); },
	};
	const client = new McpClient({ config: config(), protocol });

	const tools = await client.listTools(new AbortController().signal);
	const result = await client.callTool("read_file", { path: "README.md" }, new AbortController().signal);
	const resources = await client.listResources(new AbortController().signal);
	const contents = await client.readResource("file:///README.md", new AbortController().signal);
	await Promise.all([client.close(), client.close()]);

	assert.equal(tools[0]?.name, "read_file");
	assert.equal(tools[0]?.serverInstructions, "Browse project files and repository documentation.");
	assert.equal(tools[0]?.supportsParallelToolCalls, true);
	assert.deepEqual(tools[0]?.inputSchema.required, ["path"]);
	assert.equal(result.content[0]?.type, "text");
	assert.equal(resources[0]?.uri, "file:///README.md");
	assert.equal(contents[0]?.text, "resource");
	assert.deepEqual(calls, [
		"connect",
		"listTools",
		"callTool:read_file:README.md",
		"listResources",
		"readResource:file:///README.md",
		"close",
	]);
});

test("MCP parallel capability fails closed unless a read-only hint or server opt-in is true", async () => {
	const rawTools = [
		{ name: "missing", inputSchema: { type: "object" } },
		{ name: "false_hint", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
		{ name: "invalid_hint", inputSchema: { type: "object" }, annotations: { readOnlyHint: "true" } },
		{ name: "read_only", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
	];
	const protocol = (): McpProtocolClient => ({
		connect: async () => undefined,
		listTools: async () => ({ tools: rawTools }),
		callTool: async () => ({ content: [], isError: false }),
		listResources: async () => ({ resources: [] }),
		readResource: async () => ({ contents: [] }),
		close: async () => undefined,
	});
	const hinted = await new McpClient({ config: config(), protocol: protocol() })
		.listTools(new AbortController().signal);
	const optedIn = await new McpClient({ config: config(true), protocol: protocol() })
		.listTools(new AbortController().signal);

	assert.deepEqual(hinted.map((tool) => tool.supportsParallelToolCalls), [false, false, false, true]);
	assert.deepEqual(optedIn.map((tool) => tool.supportsParallelToolCalls), [true, true, true, true]);
});

test("propagates abort and closes an interrupted stdio client", async () => {
	const controller = new AbortController();
	let started!: () => void;
	const startedPromise = new Promise<void>((resolve) => { started = resolve; });
	let closeCount = 0;
	const protocol: McpProtocolClient = {
		connect: async () => undefined,
		listTools: async () => ({ tools: [] }),
		callTool: async (_name, _argumentsValue, signal) => {
			started();
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => {
					const error = new Error("raw secret output");
					error.name = "AbortError";
					reject(error);
				}, { once: true });
			});
			return { content: [], isError: false };
		},
		listResources: async () => ({ resources: [] }),
		readResource: async () => ({ contents: [] }),
		close: async () => { closeCount += 1; },
	};
	const client = new McpClient({ config: config(), protocol });
	const request = client.callTool("wait", {}, controller.signal);
	await startedPromise;
	controller.abort();

	await assert.rejects(() => request, (error: unknown) => (
		error instanceof Error && error.name === "AbortError"
	));
	assert.equal(closeCount, 1);
});

test("preserves AbortError when interrupted stdio cleanup also fails", async () => {
	const controller = new AbortController();
	let closeCount = 0;
	const protocol: McpProtocolClient = {
		connect: async () => undefined,
		listTools: async () => ({ tools: [] }),
		callTool: async (_name, _argumentsValue, signal) => {
			controller.abort();
			const error = new Error(signal.aborted ? "interrupted" : "unexpected");
			error.name = "AbortError";
			throw error;
		},
		listResources: async () => ({ resources: [] }),
		readResource: async () => ({ contents: [] }),
		close: async () => {
			closeCount += 1;
			throw new Error("cleanup token=private-value");
		},
	};
	const client = new McpClient({ config: config(), protocol });

	await assert.rejects(
		() => client.callTool("wait", {}, controller.signal),
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
	assert.equal(closeCount, 1);
});

function config(supportsParallelToolCalls = false): McpServerConfig {
	return {
		id: "files",
		transport: "stdio",
		command: process.execPath,
		args: [],
		env: {},
		headers: {},
		enabled: true,
		supportsParallelToolCalls,
		timeoutMs: 1_000,
	};
}
