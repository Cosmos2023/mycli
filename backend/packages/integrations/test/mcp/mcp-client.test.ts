import assert from "node:assert/strict";
import test from "node:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { McpRequestError } from "../../src/mcp/diagnostics.ts";
import {
	type McpProtocolClient,
	type McpServerConfig,
} from "../../src/index.ts";
import { McpClient } from "../../src/mcp/index.ts";

for (const phase of ["connect", "request"] as const) {
	test(`MCP ${phase} timeout uses its own budget and never replays a timed-out call`, async (t) => {
		let invocations = 0;
		const protocol: McpProtocolClient = {
			connect: async () => { await new Promise<void>((resolve) => setTimeout(resolve, 40)); },
			listTools: async () => ({ tools: [] }), listResources: async () => ({ resources: [] }), readResource: async () => ({ contents: [] }),
			callTool: async () => { invocations += 1; await new Promise<void>((resolve) => setTimeout(resolve, 80)); return { content: [] }; },
			close: async () => undefined,
		};
		const client = new McpClient({ config: { ...config(), timeoutMs: 1, startupTimeoutMs: phase === "connect" ? 10 : 500,
			toolTimeoutMs: phase === "request" ? 10 : 500 }, protocol });
		t.after(() => client.close());
		await assert.rejects(client.callTool("read", {}, new AbortController().signal), (error: unknown) => {
			assert.ok(error instanceof McpRequestError);
			assert.equal(error.failure.category, "timeout");
			assert.equal(error.failure.details.phase, phase);
			assert.equal(error.failure.details.timeout_ms, 10);
			assert.equal(error.failure.details.rpc_code, -32001);
			return true;
		});
		assert.equal(invocations, phase === "request" ? 1 : 0);
	});
}

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

test("tool discovery collects pages and rejects cursor cycles, duplicate identities, and excessive pages", async (t) => {
	for (const mode of ["complete", "cycle", "duplicate", "unbounded", "cancel", "count", "bytes"] as const) {
		await t.test(mode, async (t) => {
			const controller = new AbortController();
			let pages = 0;
			const client = new McpClient({ config: config(), protocol: {
				connect: async () => undefined, close: async () => undefined,
				callTool: async () => ({ content: [] }), listResources: async () => ({ resources: [] }), readResource: async () => ({ contents: [] }),
				listTools: async (_signal, cursor) => {
					pages += 1;
					if (mode === "count") return { tools: Array.from({ length: 10_001 }, () => ({ name: "large" })) };
					if (mode === "bytes") return { tools: [{ name: "large", description: "x".repeat(8 * 1024 * 1024) }] };
					if (mode === "cancel") controller.abort();
					return { tools: [{ name: mode === "duplicate" ? "same" : `tool${pages}`, inputSchema: { type: "object" } }],
						...(!cursor || mode === "cycle" || mode === "unbounded" ? { nextCursor: mode === "unbounded" ? `page${pages}` : "second" } : {}) };
				},
			} });
			t.after(() => client.close());
			if (mode === "complete") assert.deepEqual((await client.listTools(controller.signal)).map((tool) => tool.name), ["tool1", "tool2"]);
			else if (mode === "cancel") await assert.rejects(client.listTools(controller.signal), { name: "AbortError" });
			else await assert.rejects(client.listTools(controller.signal), /invalid_mcp_tool_pagination/u);
			assert.equal(pages, mode === "unbounded" ? 100 : (mode === "cancel" || mode === "count" || mode === "bytes") ? 1 : 2);
		});
	}
});

test("retiring stdio reports an unknown sibling outcome and permits a fresh explicit call", async (t) => {
	for (const mode of ["cancel", "timeout"] as const) {
		await t.test(mode, async (t) => {
			const started = Promise.withResolvers<void>();
			const fail = Promise.withResolvers<void>();
			const controller = new AbortController();
			let generations = 0;
			let calls = 0;
			let closed = 0;
			const client = new McpClient({ config: config(), createProtocol: () => {
				const generation = ++generations;
				return {
					connect: async () => undefined, close: async () => { closed += 1; },
					listTools: async () => ({ tools: [] }), listResources: async () => ({ resources: [] }), readResource: async () => ({ contents: [] }),
					callTool: async (name, _arguments, signal) => {
						calls += 1;
						if (generation > 1) return { content: [{ type: "text", text: "recovered" }] };
						if (name === "owner" && mode === "timeout") { await fail.promise; throw new McpError(ErrorCode.RequestTimeout, "timeout"); }
						if (name === "sibling") started.resolve();
						await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
						return { content: [] };
					},
				};
			} });
			t.after(() => client.close());
			const owner = assert.rejects(client.callTool("owner", {}, controller.signal), mode === "cancel" ? { name: "AbortError" } : /timeout/u);
			const sibling = assert.rejects(client.callTool("sibling", {}, new AbortController().signal), (error: unknown) => {
				assert.ok(error instanceof McpRequestError);
				assert.equal(error.failure.category, "transport_error");
				assert.deepEqual(error.failure.outcome, { state: "unknown", effects: "possible" });
				return true;
			});
			await started.promise;
			if (mode === "cancel") controller.abort(); else fail.resolve();
			await Promise.all([owner, sibling]);
			assert.equal(closed, 1);
			assert.equal((await client.callTool("next", {}, new AbortController().signal)).content[0]?.text, "recovered");
			assert.equal(generations, 2);
			assert.equal(calls, 3);
		});
	}
});
