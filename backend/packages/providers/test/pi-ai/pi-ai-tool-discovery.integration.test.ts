import assert from "node:assert/strict";
import test from "node:test";
import { toolDiscovery, type ProviderRequest, type ToolDefinition } from "@mycli/core";
import { PiAiProvider } from "../../src/pi-ai/pi-ai-provider.ts";
import { toPiAiContext } from "../../src/pi-ai/pi-ai-context.ts";
import { startProviderMockServer } from "../support/provider-mock-server.ts";

const search: ToolDefinition = { id: "builtin:tool_search", name: "tool_search", description: "Find tools", inputSchema: { type: "object", properties: { query: { type: "string" } } } };
const found: ToolDefinition = { id: "mcp:docs:search", name: "mcp_docs_search", description: "Search documents", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } };

function request(protocol: ProviderRequest["protocol"] = "responses"): ProviderRequest {
	return { provider: protocol === "anthropic_messages" ? "anthropic" : "compatible", protocol,
		model: "test-model", instructions: "Test", messages: [], tools: [search, found], items: [
			{ type: "user", text: "Find documentation" },
			{ type: "assistant_tool_calls", text: "", calls: [{ callId: "discovery", name: "tool_search", argumentsJson: '{"query":"docs"}' }] },
			{ type: "tool_result", callId: "discovery", toolName: "tool_search", output: "Found", success: true, toolDiscoveries: [toolDiscovery(found)] },
		] };
}

for (const mode of ["supportsToolSearch", "supportsAdditionalTools", "fallback"] as const) {
	test(`pi-ai owns Responses schema-bearing discovery (${mode})`, async (t) => {
		const server = await startProviderMockServer({ protocol: "responses" });
		t.after(server.close);
		const provider = new PiAiProvider({ config: { provider: "compatible", protocol: "responses", model: "test-model",
			apiBaseUrl: `${server.baseUrl}/v1`, apiKey: "fixture", supportsImages: false,
			compat: { supportsToolSearch: false, supportsAdditionalTools: false, ...(mode === "fallback" ? {} : { [mode]: true }) } } });
		for await (const event of provider.stream(request(), { signal: new AbortController().signal })) void event;
		const body = server.requests[0]!.body;
		const tools = body.tools as { name: string }[];
		const input = body.input as Record<string, unknown>[];
		assert.deepEqual(tools.map((tool) => tool.name), mode === "fallback" ? [search.name, found.name] : [search.name]);
		const loaded = input.find((item) => item.type === (mode === "supportsAdditionalTools" ? "additional_tools" : "tool_search_output"));
		if (mode === "fallback") assert.equal(loaded, undefined);
		else {
			assert.ok(loaded);
			assert.ok(input.indexOf(loaded) > input.findIndex((item) => item.type === "function_call_output"));
			assert.deepEqual((loaded.tools as { name: string; parameters: unknown }[]).map((tool) => [tool.name, tool.parameters]), [[found.name, found.inputSchema]]);
		}
	});
}

test("Anthropic emits native references; generic Chat keeps ordinary function schemas", async (t) => {
	for (const protocol of ["anthropic_messages", "chat_completions"] as const) {
		const server = await startProviderMockServer({ protocol });
		t.after(server.close);
		const req = request(protocol);
		const provider = new PiAiProvider({ config: { provider: req.provider, protocol, model: req.model,
			apiBaseUrl: protocol === "anthropic_messages" ? server.baseUrl : `${server.baseUrl}/v1`, apiKey: "fixture",
			supportsImages: false, ...(protocol === "anthropic_messages" ? { compat: { supportsToolReferences: true } } : {}) } });
		for await (const event of provider.stream(req, { signal: new AbortController().signal })) void event;
		const body = server.requests[0]!.body;
		if (protocol === "anthropic_messages") {
			assert.match(JSON.stringify(body.messages), /tool_reference/u);
			assert.equal((body.tools as { name: string; defer_loading?: boolean }[]).find((tool) => tool.name === found.name)?.defer_loading, true);
		} else {
			assert.equal((body.tools as unknown[]).length, 2);
			assert.doesNotMatch(JSON.stringify(body.messages), /tool_reference|tool_search_output|additional_tools/u);
		}
	}
});

test("discovery replay rejects changed, removed, failed and spoofed definitions", () => {
	const req = request();
	const result = req.items![2]!;
	assert.equal(result.type, "tool_result");
	for (const changed of [
		{ ...req, tools: [search] },
		{ ...req, tools: [search, { ...found, description: "Changed" }] },
		{ ...req, items: [...req.items!.slice(0, 2), { ...result, success: false }] },
		{ ...req, items: [...req.items!.slice(0, 2), { ...result, toolName: "other" }] },
	]) {
		const context = toPiAiContext(changed, "openai-responses").context;
		const output = context.messages.find((item) => item.role === "toolResult");
		assert.equal(output?.addedToolNames, undefined);
	}
});
