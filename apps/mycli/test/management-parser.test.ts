import assert from "node:assert/strict";
import test from "node:test";
import { parseCliMode } from "../src/management/parser.ts";

test("parser recognizes provider-free management commands before interactive flags", () => {
	assert.deepEqual(parseCliMode(["doctor", "--json"]), {
		kind: "management",
		command: { kind: "doctor", json: true },
	});
	assert.deepEqual(parseCliMode(["setup"]), {
		kind: "management",
		command: { kind: "setup", json: false },
	});
	assert.deepEqual(parseCliMode(["hooks", "approve", "repo:audit:post_tool_use", "--json"]), {
		kind: "management",
		command: {
			kind: "hooks",
			action: "approve",
			identity: "repo:audit:post_tool_use",
			json: true,
		},
	});
	assert.deepEqual(parseCliMode(["mcp", "inspect", "files"]), {
		kind: "management",
		command: { kind: "mcp", action: "inspect", serverId: "files", json: false },
	});
	assert.deepEqual(parseCliMode(["subagents", "list", "--json"]), {
		kind: "management",
		command: { kind: "subagents", action: "list", json: true },
	});
});

test("parser decodes plugin command arguments as one JSON object", () => {
	assert.deepEqual(parseCliMode([
		"plugins",
		"run",
		"demo",
		"status",
		"--json-args",
		'{"verbose":true}',
		"--json",
	]), {
		kind: "management",
		command: {
			kind: "plugins",
			action: "run",
			pluginId: "demo",
			commandName: "status",
			arguments: { verbose: true },
			json: true,
		},
	});
});

test("parser retains validated interactive arguments", () => {
	assert.deepEqual(parseCliMode([
		"--runtime-backend=node",
		"--session",
		"demo",
		"--model=gpt-5",
	]), {
		kind: "interactive",
		runtimeArgs: ["--runtime-backend=node", "--session", "demo", "--model=gpt-5"],
	});
});

test("parser rejects invalid management usage and JSON arguments", () => {
	for (const argv of [
		["hooks", "inspect"],
		["hooks", "list", "extra"],
		["plugins", "run", "demo", "status", "--json-args", "[]"],
		["plugins", "run", "demo", "status", "--json-args", "{broken"],
		["mcp", "inspect"],
		["subagents", "unknown"],
		["setup", "--json"],
	] as const) {
		assert.throws(
			() => parseCliMode(argv),
			/(?:invalid_arguments|invalid_json_arguments):/,
		);
	}
});
