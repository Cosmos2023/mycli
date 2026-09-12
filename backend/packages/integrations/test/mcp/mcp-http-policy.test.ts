import assert from "node:assert/strict";
import test from "node:test";
import { McpClient, parseMcpServerConfig } from "../../src/index.ts";
import { policyMcpFetch } from "../../src/mcp/http-fetch.ts";
import { McpRequestError } from "../../src/mcp/diagnostics.ts";

test("MCP HTTP respects offline/domain bounds and never forwards requests across redirects", async () => {
	const requests: string[] = [];
	let cancelled = 0;
	const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
		requests.push(String(input));
		assert.equal(init?.redirect, "manual");
		return new Response(new ReadableStream({ cancel(): void { cancelled += 1; } }), { status: 307, headers: { location: "https://forbidden.example/secret" } });
	};
	const offline = policyMcpFetch({ network: "disabled" }, fetch);
	await assert.rejects(offline("https://allowed.example/mcp"), /network_access_denied/u);
	const restricted = policyMcpFetch({ network: "enabled", networkDomains: ["allowed.example"] }, fetch);
	await assert.rejects(restricted("https://forbidden.example/mcp"), /network_access_denied/u);
	assert.equal(requests.length, 0);
	await assert.rejects(restricted("https://allowed.example/mcp", { headers: { Authorization: "private" }, body: "private", method: "POST" }), /mcp_http_redirect_denied/u);
	assert.deepEqual(requests, ["https://allowed.example/mcp"]);
	assert.equal(cancelled, 1);
	const local = policyMcpFetch({ network: "enabled" }, async () => new Response("local"));
	assert.equal(await (await local("http://127.0.0.1:1234/mcp")).text(), "local");
});

for (const transport of ["http", "streamable_http"] as const) {
	test(`${transport} rejects explicit offline configuration before sending initialization`, async (t) => {
		const client = new McpClient({ config: parseMcpServerConfig("docs", { transport, url: "https://private.invalid/mcp", sandbox: { network: "disabled" } }, {}),
			fetch: async () => assert.fail("offline MCP must not send a request") });
		t.after(() => client.close());
		await assert.rejects(client.listTools(new AbortController().signal), (error: unknown) => {
			assert.ok(error instanceof McpRequestError);
			assert.equal(error.failure.details.transport_code, "network_access_denied");
			assert.deepEqual(error.failure.outcome, { state: "not_started", effects: "none" });
			return true;
		});
	});
}
