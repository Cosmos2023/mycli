import assert from "node:assert/strict";
import test from "node:test";
import {
	McpManager,
	type McpManagedClient,
	type McpServerConfig,
} from "../src/index.ts";

test("discovers enabled MCP servers lazily, isolates failures, and closes clients once", async () => {
	const created: string[] = [];
	const closed: string[] = [];
	const clients = new Map<string, McpManagedClient>([
		["alpha", client("alpha", closed)],
		["broken", client("broken", closed, new Error("transport failed Bearer private-server-output"))],
	]);
	const manager = new McpManager({
		configs: [config("disabled", false), config("broken"), config("alpha")],
		createClient: (server) => {
			created.push(server.id);
			return clients.get(server.id)!;
		},
	});
	const signal = new AbortController().signal;

	const first = await manager.discover(signal);
	const second = await manager.discover(signal);

	assert.equal(first, second);
	assert.deepEqual(created, ["alpha", "broken"]);
	assert.deepEqual(first.registrations.map((item) => item.id), ["mcp:alpha:read_file"]);
	assert.deepEqual(first.resources.map((item) => item.serverId), ["alpha"]);
	assert.deepEqual(first.servers.map((item) => [item.serverId, item.status]), [
		["alpha", "ok"],
		["broken", "failed"],
		["disabled", "disabled"],
	]);
	assert.equal(first.servers[0]?.toolCount, 1);
	assert.equal(first.servers[1]?.failureCategory, "transport_error");
	assert.equal(JSON.stringify(first).includes("private-server-output"), false);
	assert.deepEqual(closed, ["broken"]);

	await Promise.all([manager.close(), manager.close()]);
	assert.deepEqual(closed, ["broken", "alpha"]);
});

function client(id: string, closed: string[], failure?: Error): McpManagedClient {
	return {
		listTools: async () => {
			if (failure) throw failure;
			return [{
				serverId: id,
				name: "read_file",
				description: "Read a file",
				inputSchema: { type: "object", properties: {} },
			}];
		},
		callTool: async () => ({ content: [], isError: false }),
		listResources: async () => [{
			serverId: id,
			uri: `file:///${id}.txt`,
			name: id,
			description: "",
		}],
		readResource: async (uri) => [{ serverId: id, uri, text: id }],
		close: async () => { closed.push(id); },
	};
}

function config(id: string, enabled = true): McpServerConfig {
	return {
		id,
		transport: "stdio",
		command: process.execPath,
		args: [],
		env: {},
		headers: {},
		enabled,
		timeoutMs: 1_000,
	};
}
