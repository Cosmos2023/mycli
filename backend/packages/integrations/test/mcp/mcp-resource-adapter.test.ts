import assert from "node:assert/strict";
import test from "node:test";
import {
	McpResourceAdapter,
	type McpResourceClientContract,
} from "../../src/index.ts";

test("aggregates MCP resources in server order and routes reads to the owning client", async () => {
	const calls: string[] = [];
	const alpha = resourceClient("alpha", calls);
	const zeta = resourceClient("zeta", calls);
	const adapter = new McpResourceAdapter(new Map([
		["zeta", zeta],
		["alpha", alpha],
	]));
	const signal = new AbortController().signal;

	const resources = await adapter.listResources(signal);
	const content = await adapter.readResource("zeta", "file:///zeta.txt", signal);

	assert.deepEqual(resources.map((resource) => resource.serverId), ["alpha", "zeta"]);
	assert.equal(content[0]?.text, "zeta content");
	assert.deepEqual(calls, [
		"list:alpha",
		"list:zeta",
		"read:zeta:file:///zeta.txt",
	]);
	await assert.rejects(
		() => adapter.readResource("missing", "file:///missing.txt", signal),
		/unknown_mcp_server/,
	);
});

function resourceClient(id: string, calls: string[]): McpResourceClientContract {
	return {
		listResources: async () => {
			calls.push(`list:${id}`);
			return [{
				serverId: id,
				uri: `file:///${id}.txt`,
				name: id,
				description: "",
			}];
		},
		readResource: async (uri) => {
			calls.push(`read:${id}:${uri}`);
			return [{ serverId: id, uri, text: `${id} content` }];
		},
	};
}
