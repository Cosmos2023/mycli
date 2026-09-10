import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import test from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
	McpClient,
	type McpServerConfig,
} from "../../src/index.ts";

test("MCP Streamable HTTP uses the SDK and configured headers", { timeout: 10_000 }, async (t) => {
	let headerCount = 0;
	const fixture = await startStreamableServer((request) => {
		if (request.headers["x-mcp-fixture"] === "allowed") headerCount += 1;
	});
	t.after(fixture.close);
	const client = new McpClient({
		config: remoteConfig("streamable_http", fixture.url, {
			"x-mcp-fixture": "allowed",
		}),
	});

	const tools = await client.listTools(new AbortController().signal);
	const result = await client.callTool("echo", { text: "remote" }, new AbortController().signal);
	const resources = await client.listResources(new AbortController().signal);
	const contents = await client.readResource("file:///remote.txt", new AbortController().signal);
	await client.close();

	assert.equal(tools[0]?.name, "echo");
	assert.equal(result.content[0]?.text, "echo:remote");
	assert.equal(resources[0]?.uri, "file:///remote.txt");
	assert.equal(contents[0]?.text, "remote resource");
	assert.ok(headerCount >= 4);
});

test("MCP legacy HTTP preserves JSON-RPC compatibility", {
	timeout: 10_000,
}, async (t) => {
	const fixture = await startLegacyServer();
	t.after(fixture.close);
	const client = new McpClient({ config: remoteConfig("http", fixture.url, {}) });

	const tools = await client.listTools(new AbortController().signal);
	const result = await client.callTool("echo", { text: "legacy" }, new AbortController().signal);
	await client.close();

	assert.equal(tools[0]?.name, "echo");
	assert.equal(result.content[0]?.text, "echo:legacy");
	assert.deepEqual(fixture.methods.slice(0, 4), [
		"initialize",
		"notifications/initialized",
		"tools/list",
		"tools/call",
	]);
});

test("MCP legacy HTTP aborts a timed out JSON-RPC POST", { timeout: 10_000 }, async (t) => {
	const fixture = await startLegacyServer();
	t.after(fixture.close);
	const client = new McpClient({
		config: { ...remoteConfig("http", fixture.url, {}), timeoutMs: 100 },
	});
	await client.listTools(new AbortController().signal);

	await assert.rejects(
		() => client.callTool("wait", {}, new AbortController().signal),
		/timeout|timed out/iu,
	);
	await eventually(() => fixture.abortedCount() === 1);
	await client.close();
});

function remoteConfig(
	transport: "http" | "streamable_http",
	url: string,
	headers: Readonly<Record<string, string>>,
): McpServerConfig {
	return {
		id: "remote",
		transport,
		url,
		args: [],
		env: {},
		headers,
		enabled: true,
		supportsParallelToolCalls: false,
		timeoutMs: 1_000,
	};
}

async function startStreamableServer(
	onRequest: (request: IncomingMessage) => void,
): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
	const active = new Set<{ server: Server; transport: StreamableHTTPServerTransport }>();
	const httpServer = createServer(async (request, response) => {
		onRequest(request);
		const server = fixtureSdkServer();
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		const handle = { server, transport };
		active.add(handle);
		response.once("close", () => {
			active.delete(handle);
			void transport.close();
			void server.close();
		});
		try {
			await server.connect(transport);
			await transport.handleRequest(request, response, await jsonBody(request));
		} catch {
			if (!response.headersSent) response.writeHead(500).end();
		}
	});
	await listen(httpServer);
	const address = httpServer.address();
	if (!address || typeof address === "string") throw new Error("fixture_address_unavailable");
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		close: async () => {
			await Promise.all([...active].map(async ({ server, transport }) => {
				await transport.close();
				await server.close();
			}));
			await closeServer(httpServer);
		},
	};
}

function fixtureSdkServer(): Server {
	const server = new Server(
		{ name: "mycli-test-http", version: "1.0.0" },
		{ capabilities: { tools: {}, resources: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [{
			name: "echo",
			description: "Echo text",
			inputSchema: {
				type: "object" as const,
				properties: { text: { type: "string" } },
				required: ["text"],
			},
		}],
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => ({
		content: [{
			type: "text" as const,
			text: `echo:${String(request.params.arguments?.text)}`,
		}],
	}));
	server.setRequestHandler(ListResourcesRequestSchema, async () => ({
		resources: [{ uri: "file:///remote.txt", name: "remote" }],
	}));
	server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
		contents: [{ uri: request.params.uri, text: "remote resource" }],
	}));
	return server;
}

async function startLegacyServer(): Promise<{
	readonly url: string;
	readonly methods: string[];
	readonly abortedCount: () => number;
	readonly close: () => Promise<void>;
}> {
	const methods: string[] = [];
	let abortedCount = 0;
	const server = createServer(async (request, response) => {
		const payload = await jsonBody(request) as {
			readonly id?: string | number;
			readonly method?: string;
			readonly params?: Readonly<Record<string, unknown>>;
		};
		methods.push(payload.method ?? "unknown");
		if (payload.method === "tools/call" && payload.params?.name === "wait") {
			await new Promise<void>((resolve) => {
				let settled = false;
				const finish = (): void => {
					if (settled) return;
					settled = true;
					resolve();
				};
				request.once("aborted", finish);
				response.once("close", finish);
			});
			abortedCount += 1;
			return;
		}
		if (payload.id === undefined) {
			response.writeHead(202).end();
			return;
		}
		const result = legacyResult(payload.method, payload.params);
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
	});
	await listen(server);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture_address_unavailable");
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		methods,
		abortedCount: () => abortedCount,
		close: () => closeServer(server),
	};
}

function legacyResult(
	method: string | undefined,
	params: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: "2025-03-26",
				capabilities: { tools: {}, resources: {} },
				serverInfo: { name: "legacy", version: "1.0.0" },
			};
		case "tools/list":
			return {
				tools: [{
					name: "echo",
					inputSchema: {
						type: "object",
						properties: { text: { type: "string" } },
						required: ["text"],
					},
				}],
			};
		case "tools/call": {
			const argumentsValue = params?.arguments as Readonly<Record<string, unknown>> | undefined;
			return { content: [{ type: "text", text: `echo:${String(argumentsValue?.text)}` }] };
		}
		case "resources/list":
			return { resources: [] };
		case "resources/read":
			return { contents: [] };
		default:
			return {};
	}
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
		server.closeAllConnections();
	});
}

async function eventually(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail("condition was not met before timeout");
}
