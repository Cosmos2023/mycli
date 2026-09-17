import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalToolCall } from "@mycli/core";
import { ToolRouter } from "@mycli/tools";
import { McpHttpError, McpRequestError } from "../../src/mcp/diagnostics.ts";
import {
	createMcpToolRegistration,
	type McpClientContract,
	type McpToolCallResult,
	type McpToolDescriptor,
} from "../../src/index.ts";

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
	const registration = createMcpToolRegistration(client, {
		...descriptor(),
		serverInstructions: "Browse project files and repository documentation.",
	});
	const router = new ToolRouter({
		adapters: [registration.adapter],
		exposure: [registration.definition],
	});

	const invalid = await router.execute(call("{}"), executionOptions());
	const valid = await router.execute(call('{"path":"README.md"}'), executionOptions());

	assert.equal(registration.id, "mcp:files:read_file");
	assert.equal(registration.definition.name, "mcp_files_read_file");
	assert.equal(registration.source, "mcp");
	assert.equal(registration.sourceDescription, "Browse project files and repository documentation.");
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

test("validates standard MCP URI formats before calling the server", async () => {
	const calls: Readonly<Record<string, unknown>>[] = [];
	const registration = createMcpToolRegistration({
		callTool: async (_name, argumentsValue): Promise<McpToolCallResult> => {
			calls.push(argumentsValue);
			return { content: [{ type: "text", text: "page" }], isError: false };
		},
	}, {
		...descriptor(),
		inputSchema: {
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: { url: { type: "string", format: "uri" } },
			required: ["url"],
			additionalProperties: false,
		},
	});
	const router = new ToolRouter({ adapters: [], exposure: [] });
	router.replaceDynamicAdapters([registration.adapter]);

	const invalid = await router.execute(call('{"url":"not a URI"}'), executionOptions());
	assert.equal(invalid.errorKind, "invalid_arguments");
	assert.deepEqual(calls, []);
	const valid = await router.execute(call('{"url":"https://example.com/weather"}'), executionOptions());
	assert.equal(valid.success, true);
	assert.deepEqual(calls, [{ url: "https://example.com/weather" }]);
});

test("rejects uncompileable MCP schemas before advertising their tools", () => {
	assert.throws(() => createMcpToolRegistration({
		callTool: async () => assert.fail("invalid schemas must never be executed"),
	}, {
		...descriptor(),
		inputSchema: {
			type: "object",
			properties: { url: { type: "string", format: "private-custom-format" } },
		},
	}), /^Error: invalid_integration_tool_schema$/u);
});

test("independent MCP tools can reuse a schema id across catalog refreshes", async () => {
	const registrations = ["first", "second"].map((serverId) => createMcpToolRegistration({
		callTool: async (): Promise<McpToolCallResult> => ({ content: [{ type: "text", text: serverId }], isError: false }),
	}, {
		...descriptor(), serverId,
		inputSchema: {
			...descriptor().inputSchema,
			$id: "https://example.com/shared-tool-schema",
		},
	}));
	const router = new ToolRouter({ adapters: [], exposure: [] });
	for (let refresh = 0; refresh < 2; refresh += 1) {
		router.replaceDynamicAdapters(registrations.map((registration) => registration.adapter));
		for (const registration of registrations) {
			const result = await router.execute({
				...call('{"path":"README.md"}'), name: registration.definition.name,
			}, executionOptions());
			assert.equal(result.success, true);
			assert.equal(result.modelOutput, registration.originMetadata.server);
		}
	}
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
	assert.deepEqual(success.images, [{ mediaType: "image/png", data: "aW1hZ2U=" }]);
	assert.equal(JSON.stringify(success.metadata).includes("aW1hZ2U="), false);
	assert.ok(success.modelOutput.length <= 4_000);
	assert.equal(success.metadata.server, "files");
	assert.equal(success.metadata.tool, "read_file");
	assert.equal(success.metadata.rawTruncated, false);
	assert.equal(JSON.stringify(success.metadata).length <= 12_000, true);
	assert.equal(failure.success, false);
	assert.equal(failure.errorKind, "mcp_tool_error");
});

test("MCP images use standard MIME fields and invalid image payloads fail without raw data", async () => {
	for (const image of [
		{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
		{ type: "image", mimeType: "image/svg+xml", data: "private-data" },
		{ type: "image", mimeType: "image/png", data: "A".repeat(20_000_004) },
	]) {
		const adapter = createMcpToolRegistration({ callTool: async () => ({ content: [{ type: "text", text: "Image follows" }, image], isError: false }) }, descriptor()).adapter;
		const result = await adapter.execute({ path: "image" }, executionOptions());
		assert.equal(result.success, image.data === "aW1hZ2U=");
		assert.match(result.modelOutput, /Image follows/u);
		assert.equal(result.modelOutput.includes(image.data), false);
		assert.equal(JSON.stringify(result.metadata).includes(image.data), false);
	}
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

test("MCP error context survives the router and downgrades for legacy sessions", async () => {
	const registration = createMcpToolRegistration({ callTool: async () => {
		throw new McpRequestError(new McpHttpError(503), { operation: "tools/call", phase: "request" });
	} }, descriptor());
	const router = new ToolRouter({ adapters: [registration.adapter], exposure: [registration.definition] });
	for (const version of [1, undefined] as const) {
		const result = await router.execute(call('{"path":"README.md"}'), { ...executionOptions(), errorContextVersion: version });
		assert.equal(result.errorKind, "mcp_transport_error");
		assert.match(result.modelOutput, /HTTP status: 503/u);
		assert.match(result.modelOutput, /outcome is unknown/u);
		if (version === 1) {
			assert.equal(result.errorContext?.reason, "integration.unavailable");
			assert.deepEqual(result.errorContext?.details, { integration: "files", legacy_kind: "mcp_transport_error", operation: "tools/call", phase: "request", http_status: 503 });
			assert.deepEqual(result.errorContext?.outcome, { state: "unknown", effects: "possible" });
			assert.deepEqual(result.metadata.error_context, result.errorContext);
		} else {
			assert.equal(result.errorContext, undefined);
			assert.equal(result.metadata.error_context, undefined);
		}
	}
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
