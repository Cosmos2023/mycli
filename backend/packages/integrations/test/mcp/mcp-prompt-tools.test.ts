import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_RESULT_OUTPUT_MAX_CHARS } from "@mycli/core";
import type { ToolExecutionOptions } from "@mycli/tools";
import type { McpPromptService, McpProtocolClient } from "../../src/index.ts";
import { GetMcpPromptTool, ListMcpPromptsTool } from "../../src/mcp/index.ts";
import { McpClient } from "../../src/mcp/client.ts";
import { parseMcpServerConfig } from "../../src/mcp/config.ts";

const OPTIONS: ToolExecutionOptions = { signal: new AbortController().signal, ownerSessionId: "session",
	callId: "prompt", publishLifecycle: () => undefined };

test("prompt tools preserve server-scoped cursors and render text messages", async () => {
	const seen: (string | undefined)[] = [];
	const service: McpPromptService = {
		listPrompts: async () => ({ prompts: [], failures: [] }),
		listPromptsPage: async (server, _signal, cursor) => {
			assert.equal(server, "docs");
			seen.push(cursor);
			return { prompts: [{ serverId: server, name: "review", description: "Review a change",
				arguments: [{ name: "topic", required: true }, { name: "tone", description: "Tone", required: false }] }],
				...(cursor === undefined ? { nextCursor: "opaque+/=" } : {}) };
		},
		getPrompt: async (server, name, argumentsValue) => ({
			description: `${server}/${name}`,
			messages: [{ role: "user", text: `topic=${argumentsValue.topic ?? ""}` },
				{ role: "assistant", text: "acknowledged" }],
		}),
	};
	const list = new ListMcpPromptsTool(service);
	assert.deepEqual(Object.keys(list.definition.inputSchema.properties as object), ["server", "cursor"]);
	for (const cursor of [undefined, "opaque+/="]) {
		const result = await list.execute({ server: "docs", cursor }, OPTIONS);
		assert.equal(result.success, true);
		const output = JSON.parse(result.modelOutput) as Record<string, unknown>;
		assert.equal(output.server, "docs");
		assert.equal(output.nextCursor, cursor === undefined ? "opaque+/=" : undefined);
		assert.match(result.modelOutput, /"name":"topic"/u);
		assert.match(result.modelOutput, /"required":true/u);
	}
	assert.equal((await list.execute({ cursor: "opaque+/=" }, OPTIONS)).errorKind, "invalid_arguments");
	assert.equal((await list.execute({ server: 5 }, OPTIONS)).errorKind, "invalid_arguments");
	await assert.rejects(list.execute({}, { ...OPTIONS, signal: AbortSignal.abort() }), { name: "AbortError" });
	assert.deepEqual(seen, [undefined, "opaque+/="]);

	const get = new GetMcpPromptTool(service);
	assert.deepEqual(Object.keys(get.definition.inputSchema.properties as object), ["server", "name", "arguments"]);
	const rendered = await get.execute({ server: "docs", name: "review", arguments: { topic: "auth" } }, OPTIONS);
	assert.equal(rendered.success, true);
	assert.deepEqual(JSON.parse(rendered.modelOutput), {
		server: "docs", name: "review", description: "docs/review",
		messages: [{ role: "user", text: "topic=auth" }, { role: "assistant", text: "acknowledged" }],
	});
	assert.equal((await get.execute({ server: "docs", name: "review", arguments: { topic: 1 } }, OPTIONS)).errorKind, "invalid_arguments");
	assert.equal((await get.execute({ server: "docs", name: "review", arguments: { topic: "x".repeat(4_097) } }, OPTIONS)).errorKind, "invalid_arguments");
	assert.equal((await get.execute({ server: "docs", name: "review", arguments: Object.fromEntries(
		Array.from({ length: 65 }, (_, index) => [`k${index}`, "v"])) }, OPTIONS)).errorKind, "invalid_arguments");
	assert.equal((await get.execute({ server: "docs", name: "review" }, OPTIONS)).success, true);
});

test("prompt tools report bounded failures and truncate oversized prompt text", async () => {
	const missing: McpPromptService = {
		listPrompts: async () => { throw new Error("unknown_mcp_server"); },
		getPrompt: async () => { throw new Error("mcp_prompts_unsupported"); },
	};
	assert.equal((await new ListMcpPromptsTool(missing).execute({ server: "gone" }, OPTIONS)).errorKind, "unknown_mcp_server");
	assert.equal((await new GetMcpPromptTool(missing).execute({ server: "gone", name: "x" }, OPTIONS)).errorKind, "mcp_prompts_unsupported");

	const huge: McpPromptService = {
		listPrompts: async () => ({ prompts: [], failures: [] }),
		getPrompt: async () => ({ messages: [{ role: "user", text: "y".repeat(200_000) }] }),
	};
	const result = await new GetMcpPromptTool(huge).execute({ server: "docs", name: "big" }, OPTIONS);
	assert.equal(result.success, true);
	assert.ok(result.modelOutput.length <= TOOL_RESULT_OUTPUT_MAX_CHARS, String(result.modelOutput.length));
	assert.equal((JSON.parse(result.modelOutput) as Record<string, unknown>).truncated, true);
});

test("prompt listing keeps failures per server without dropping healthy results", async () => {
	const service: McpPromptService = {
		listPrompts: async () => ({ prompts: [{ serverId: "ok", name: "p", description: "", arguments: [] }],
			failures: [{ server: "broken", errorKind: "integration_unavailable" }] }),
		getPrompt: async () => ({ messages: [] }),
	};
	const result = await new ListMcpPromptsTool(service).execute({}, OPTIONS);
	assert.equal(result.success, true);
	assert.deepEqual(JSON.parse(result.modelOutput), {
		failures: [{ server: "broken", errorKind: "integration_unavailable" }],
		prompts: [{ server: "ok", name: "p", description: "", arguments: [] }],
	});
});

test("MCP client normalizes prompt pages and text messages from the protocol", async () => {
	const calls: unknown[] = [];
	const protocol: McpProtocolClient = {
		connect: async () => undefined,
		listTools: async () => ({ tools: [] }),
		callTool: async () => ({}),
		listResources: async () => ({ resources: [] }),
		readResource: async () => ({ contents: [] }),
		listPrompts: async (_signal, cursor) => {
			calls.push(["list", cursor]);
			return { prompts: [{ name: "review", description: "Review", arguments: [
				{ name: "topic", description: "Topic", required: true }, { description: "ignored" }] }],
				...(cursor === undefined ? { nextCursor: "next" } : {}) };
		},
		getPrompt: async (name, argumentsValue) => {
			calls.push(["get", name, argumentsValue]);
			return { description: "Rendered", messages: [
				{ role: "user", content: { type: "text", text: "hello" } },
				{ role: "user", content: { type: "image", data: "aGk=", mimeType: "image/png" } },
				{ role: "tool", content: { type: "text", text: "ignored role" } },
			] };
		},
		close: async () => undefined,
	};
	const client = new McpClient({ config: parseMcpServerConfig("docs", { url: "https://example.invalid/mcp" }, {}), protocol });
	const first = await client.listPrompts(new AbortController().signal);
	assert.deepEqual(first, { prompts: [{ serverId: "docs", name: "review", description: "Review",
		arguments: [{ name: "topic", description: "Topic", required: true }] }], nextCursor: "next" });
	const second = await client.listPrompts(new AbortController().signal, "next");
	assert.equal(second.nextCursor, undefined);
	assert.equal((await client.getPrompt("review", { topic: "auth" }, new AbortController().signal)).messages.length, 1);
	assert.deepEqual(calls, [["list", undefined], ["list", "next"], ["get", "review", { topic: "auth" }]]);
	await client.close();
});
