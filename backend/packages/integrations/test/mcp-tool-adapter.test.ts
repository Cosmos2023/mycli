import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalToolCall } from "@mycli/core";
import { ToolRouter } from "@mycli/tools";
import {
	createMcpToolRegistration,
	type McpClientContract,
	type McpToolCallResult,
	type McpToolDescriptor,
} from "../src/index.ts";

test("creates stable MCP registrations and validates arguments through the shared router", async () => {
	let callCount = 0;
	const client: McpClientContract = {
		callTool: async (): Promise<McpToolCallResult> => {
			callCount += 1;
			return {
				content: [{ type: "text", text: "file contents" }],
				isError: false,
			};
		},
	};
	const registration = createMcpToolRegistration(client, descriptor());
	const router = new ToolRouter({
		adapters: [registration.adapter],
		exposure: [registration.definition],
	});

	const invalid = await router.execute(call("{}"), executionOptions());
	const valid = await router.execute(call('{"path":"README.md"}'), executionOptions());

	assert.equal(registration.id, "mcp:files:read_file");
	assert.equal(registration.definition.name, "mcp_files_read_file");
	assert.equal(registration.source, "mcp");
	assert.equal(registration.supportsParallelToolCalls, false);
	assert.deepEqual(registration.originMetadata, { server: "files", tool: "read_file" });
	assert.equal(invalid.errorKind, "invalid_arguments");
	assert.equal(valid.success, true);
	assert.equal(valid.modelOutput, "file contents");
	assert.equal(callCount, 1);
});

test("projects resolved MCP parallel capability through adapter router and manifest registration", () => {
	const client: McpClientContract = {
		callTool: async () => ({ content: [], isError: false }),
	};
	const registration = createMcpToolRegistration(client, descriptor(true));
	const router = new ToolRouter({
		adapters: [registration.adapter],
		exposure: [registration.definition],
	});

	assert.equal(registration.supportsParallelToolCalls, true);
	assert.equal(router.supportsParallelToolCalls(call("{}")), true);
});

test("adapts a Draft-07 MCP schema for the host AJV without mutating the descriptor", async () => {
	const client: McpClientContract = {
		callTool: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
	};
	const inputSchema = {
		$schema: "http://json-schema.org/draft-07/schema#",
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
		additionalProperties: false,
	} as const;
	const registration = createMcpToolRegistration(client, {
		...descriptor(),
		inputSchema,
	});
	const router = new ToolRouter({
		adapters: [registration.adapter],
		exposure: [registration.definition],
	});

	assert.equal("$schema" in registration.definition.inputSchema, false);
	assert.equal(inputSchema.$schema, "http://json-schema.org/draft-07/schema#");
	assert.equal((await router.execute(call("{}"), executionOptions())).errorKind, "invalid_arguments");
	assert.equal((await router.execute(call('{"path":"README.md"}'), executionOptions())).success, true);
});

test("bounds mixed MCP results and preserves server error semantics", async () => {
	const results: McpToolCallResult[] = [
		{
			content: [
				{ type: "text", text: "x".repeat(5_000) },
				{ type: "json", value: { matched: 2 } },
				{ type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
			],
			structuredContent: { total: 2 },
			isError: false,
		},
		{
			content: [{ type: "text", text: "server rejected the request" }],
			isError: true,
		},
	];
	const client: McpClientContract = {
		callTool: async () => results.shift()!,
	};
	const adapter = createMcpToolRegistration(client, descriptor()).adapter;

	const success = await adapter.execute({ path: "README.md" }, executionOptions());
	const failure = await adapter.execute({ path: "README.md" }, executionOptions());

	assert.equal(success.success, true);
	assert.ok(success.modelOutput.length <= 4_000);
	assert.equal(success.metadata.server, "files");
	assert.equal(success.metadata.tool, "read_file");
	assert.equal(success.metadata.rawTruncated, false);
	assert.equal(JSON.stringify(success.metadata).length <= 12_000, true);
	assert.equal(failure.success, false);
	assert.equal(failure.errorKind, "mcp_tool_error");
});

test("isolates MCP transport failures without returning raw server output", async () => {
	const client: McpClientContract = {
		callTool: async () => {
			throw new Error("connection failed authorization=private-value");
		},
	};
	const adapter = createMcpToolRegistration(client, descriptor()).adapter;

	const result = await adapter.execute({ path: "README.md" }, executionOptions());

	assert.equal(result.success, false);
	assert.equal(result.errorKind, "mcp_transport_error");
	assert.equal(result.metadata.failureCategory, "transport_error");
	assert.equal(JSON.stringify(result).includes("private-value"), false);
});

test("rejects malformed MCP input schemas before registration", () => {
	const client: McpClientContract = {
		callTool: async () => ({ content: [], isError: false }),
	};

	assert.throws(
		() => createMcpToolRegistration(client, {
			...descriptor(),
			inputSchema: { type: "array", items: { type: "string" } },
		}),
		/invalid_mcp_tool_schema/,
	);
	assert.throws(
		() => createMcpToolRegistration(client, {
			...descriptor(),
			inputSchema: { type: "object", properties: [], required: ["path"] },
		}),
		/invalid_mcp_tool_schema/,
	);
});

function descriptor(supportsParallelToolCalls = false): McpToolDescriptor {
	return {
		serverId: "files",
		name: "read_file",
		description: "Read one file.",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string", minLength: 1 } },
			required: ["path"],
			additionalProperties: false,
		},
		supportsParallelToolCalls,
	};
}

function call(argumentsJson: string): CanonicalToolCall {
	return { callId: "call-1", name: "mcp_files_read_file", argumentsJson };
}

function executionOptions() {
	return {
		signal: new AbortController().signal,
		ownerSessionId: "session-1",
		callId: "call-1",
		publishLifecycle: () => undefined,
	};
}
