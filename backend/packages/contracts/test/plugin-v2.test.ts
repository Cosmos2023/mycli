import assert from "node:assert/strict";
import test from "node:test";
import {
	ContractValidationError,
	parsePluginV2Manifest,
	parsePluginV2ProtocolMessage,
} from "../src/index.ts";

const VALID_MANIFEST = Object.freeze({
	api_version: 2,
	id: "demo",
	name: "Demo",
	version: "1.0.0",
	entry: "dist/index.js",
	provides: {
		tools: ["echo"],
		hooks: ["pre_tool_use"],
		commands: ["status"],
	},
	requires_env: ["DEMO_TOKEN"],
	capabilities: ["filesystem_read"],
});

test("plugin v2 manifest accepts the minimum contract and forward-compatible fields", () => {
	const parsed = parsePluginV2Manifest({
		...VALID_MANIFEST,
		description: "Demo plugin",
		x_future: { enabled: true },
	});

	assert.equal(parsed.api_version, 2);
	assert.equal(parsed.id, "demo");
	assert.deepEqual(parsed.provides.tools, ["echo"]);
	assert.deepEqual(parsed.x_future, { enabled: true });
});

test("plugin v2 manifest rejects unsupported, unsafe, duplicate, and oversized declarations", () => {
	const invalid: readonly unknown[] = [
		{ ...VALID_MANIFEST, api_version: 1 },
		without(VALID_MANIFEST, "id"),
		without(VALID_MANIFEST, "name"),
		without(VALID_MANIFEST, "entry"),
		{ ...VALID_MANIFEST, entry: "/private/plugin.js" },
		{ ...VALID_MANIFEST, entry: "C:\\private\\plugin.js" },
		{ ...VALID_MANIFEST, entry: "../outside.js" },
		{ ...VALID_MANIFEST, entry: "dist/plugin.ts" },
		{ ...VALID_MANIFEST, entry: "plugin.py" },
		{ ...VALID_MANIFEST, provides: { ...VALID_MANIFEST.provides, tools: ["echo", "echo"] } },
		{ ...VALID_MANIFEST, provides: { ...VALID_MANIFEST.provides, hooks: ["unknown_hook"] } },
		{ ...VALID_MANIFEST, capabilities: ["host_full_access"] },
		{ ...VALID_MANIFEST, name: "x".repeat(129) },
		{ ...VALID_MANIFEST, description: "x".repeat(2_001) },
		{ ...VALID_MANIFEST, requires_env: ["NOT-AN-ENV-NAME"] },
	];

	for (const value of invalid) {
		assert.throws(() => parsePluginV2Manifest(value), ContractValidationError);
	}
});

test("plugin v2 protocol validates every closed host and worker message variant", () => {
	const inputSchema = {
		type: "object",
		properties: { text: { type: "string" } },
		additionalProperties: false,
	};
	const messages = [
		{
			version: 2,
			type: "initialize",
			request_id: "init-1",
			plugin_id: "demo",
			declared: { tools: ["echo"], hooks: ["pre_tool_use"], commands: ["status"] },
			capabilities: ["filesystem_read"],
			requires_env: ["DEMO_TOKEN"],
		},
		{
			version: 2,
			type: "registered",
			request_id: "init-1",
			registrations: [
				{
					kind: "tool",
					token: "tool:echo",
					name: "echo",
					description: "Echo text",
					input_schema: inputSchema,
				},
				{
					kind: "hook",
					token: "hook:guard",
					name: "guard",
					hook_point: "pre_tool_use",
					input_schema: inputSchema,
				},
				{
					kind: "command",
					token: "command:status",
					name: "status",
					description: "Show status",
					input_schema: inputSchema,
				},
			],
		},
		{
			version: 2,
			type: "invoke",
			request_id: "call-1",
			target: "tool:echo",
			input: { text: "hello" },
		},
		{ version: 2, type: "result", request_id: "call-1", value: { ok: true } },
		{
			version: 2,
			type: "error",
			request_id: "call-2",
			error: { code: "handler_failed", message: "Plugin handler failed." },
		},
		{ version: 2, type: "shutdown", request_id: "shutdown-1" },
		{ version: 2, type: "shutdown_complete", request_id: "shutdown-1" },
	] as const;

	for (const message of messages) {
		assert.equal(parsePluginV2ProtocolMessage(message).type, message.type);
	}
});

test("plugin v2 protocol rejects incomplete, open, and malformed registration messages", () => {
	const valid = {
		version: 2,
		type: "invoke",
		request_id: "call-1",
		target: "tool:echo",
		input: {},
	};
	const invalid: readonly unknown[] = [
		without(valid, "version"),
		without(valid, "type"),
		without(valid, "request_id"),
		{ ...valid, version: 1 },
		{ ...valid, type: "unknown" },
		{ ...valid, unexpected: true },
		{
			version: 2,
			type: "registered",
			request_id: "init-1",
			registrations: [{
				kind: "tool",
				token: "tool:echo",
				name: "echo",
				description: "Echo",
				input_schema: { type: "string" },
			}],
		},
		{
			version: 2,
			type: "registered",
			request_id: "init-1",
			registrations: [{
				kind: "hook",
				token: "hook:guard",
				name: "guard",
				hook_point: "unsupported",
				input_schema: { type: "object", properties: {} },
			}],
		},
		{
			version: 2,
			type: "registered",
			request_id: "init-1",
			registrations: [{
				kind: "tool",
				token: "command:echo",
				name: "echo",
				description: "Echo",
				input_schema: { type: "object", properties: {} },
			}],
		},
		{
			version: 2,
			type: "registered",
			request_id: "init-1",
			registrations: [{
				kind: "tool",
				token: "tool:echo",
				name: "echo",
				description: "Echo",
				input_schema: {
					type: "object",
					properties: { text: { type: "not-a-json-schema-type" } },
				},
			}],
		},
	];

	for (const value of invalid) {
		assert.throws(() => parsePluginV2ProtocolMessage(value), ContractValidationError);
	}
});

function without(
	value: Readonly<Record<string, unknown>>,
	key: string,
): Readonly<Record<string, unknown>> {
	return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}
