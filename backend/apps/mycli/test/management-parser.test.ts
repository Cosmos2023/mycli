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
	assert.deepEqual(parseCliMode(["config", "validate", "--json"]), {
		kind: "management",
		command: { kind: "config", action: "validate", json: true },
	});
	assert.deepEqual(parseCliMode(["config", "show"]), {
		kind: "management",
		command: { kind: "config", action: "show", json: false },
	});
	assert.deepEqual(parseCliMode(["config", "get", "model.name", "--json"]), {
		kind: "management",
		command: { kind: "config", action: "get", key: "model.name", json: true },
	});
	assert.deepEqual(parseCliMode(["config", "set", "memory.enabled", "true"]), {
		kind: "management",
		command: {
			kind: "config",
			action: "set",
			key: "memory.enabled",
			value: "true",
			json: false,
		},
	});
	assert.deepEqual(parseCliMode(["config", "unset", "model.name"]), {
		kind: "management",
		command: { kind: "config", action: "unset", key: "model.name", json: false },
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
		"--session",
		"demo",
		"--model=gpt-5",
	]), {
		kind: "interactive",
		runtimeArgs: ["--session", "demo", "--model=gpt-5"],
	});
});

test("parser rejects invalid management usage and JSON arguments", () => {
	for (const argv of [
		["config"],
		["config", "unknown"],
		["config", "show", "extra"],
		["config", "get"],
		["config", "get", "model.name", "extra"],
		["config", "set", "model.name"],
		["config", "set", "model.name", "value", "extra"],
		["config", "unset"],
		["config", "unset", "model.name", "extra"],
		["config", "get", ""],
		["config", "validate", "--json", "--json"],
		["hooks", "inspect"],
		["hooks", "list", "extra"],
		["plugins", "run", "demo", "status", "--json-args", "[]"],
		["plugins", "run", "demo", "status", "--json-args", "{broken"],
		["mcp", "inspect"],
		["subagents", "unknown"],
		["setup", "--json"],
		["--runtime-backend=node"],
	] as const) {
		assert.throws(
			() => parseCliMode(argv),
			/(?:invalid_arguments|invalid_json_arguments):/,
		);
	}
});
