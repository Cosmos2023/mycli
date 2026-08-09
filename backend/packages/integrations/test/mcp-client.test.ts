import assert from "node:assert/strict";
import test from "node:test";
import {
	McpClient,
	type McpProtocolClient,
	type McpServerConfig,
} from "../src/index.ts";

test("initializes one MCP protocol client and normalizes tools and resources", async () => {
	const calls: string[] = [];
	const protocol: McpProtocolClient = {
		connect: async () => { calls.push("connect"); },
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

function config(): McpServerConfig {
	return {
		id: "files",
		transport: "stdio",
		command: process.execPath,
		args: [],
		env: {},
		headers: {},
		enabled: true,
		timeoutMs: 1_000,
	};
}
