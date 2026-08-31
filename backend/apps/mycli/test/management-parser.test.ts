import assert from "node:assert/strict";
import test from "node:test";
import { parseCliMode } from "../src/management/parser.ts";

test("parser recognizes provider-free management commands before interactive flags", () => {
	assert.deepEqual(parseCliMode(["doctor", "--json"]), {
		kind: "management",
		command: { kind: "doctor", json: true, verbose: false },
	});
	assert.deepEqual(parseCliMode(["doctor", "--verbose"]), {
		kind: "management",
		command: { kind: "doctor", json: false, verbose: true },
	});
	assert.deepEqual(parseCliMode(["setup"]), {
		kind: "management",
		command: { kind: "setup", json: false },
	});
	assert.deepEqual(parseCliMode(["sandbox", "status", "--json"]), {
		kind: "management",
		command: { kind: "sandbox", action: "status", json: true },
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
	assert.deepEqual(parseCliMode(["update", "--json"]), {
		kind: "management",
		command: { kind: "update", action: "status", json: true },
	});
	assert.deepEqual(parseCliMode(["update", "check"]), {
		kind: "management",
		command: { kind: "update", action: "check", json: false },
	});
	assert.deepEqual(parseCliMode(["update", "dismiss", "1.2.3"]), {
		kind: "management",
		command: { kind: "update", action: "dismiss", version: "1.2.3", json: false },
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
		"-p",
		"work",
	]), {
		kind: "interactive",
		runtimeArgs: ["--session", "demo", "--model=gpt-5", "-p", "work"],
	});
	assert.deepEqual(parseCliMode(["--profile=review"]), {
		kind: "interactive",
		runtimeArgs: ["--profile=review"],
	});
	assert.deepEqual(parseCliMode(["session", "resume", "release-session"]), {
		kind: "interactive",
		runtimeArgs: ["--session", "release-session"],
	});
});

test("parser exposes bounded session management filters and destructive confirmation", () => {
	assert.deepEqual(parseCliMode([
		"session",
		"list",
		"--all",
		"--last",
		"--workspace",
		"/workspace",
		"--search",
		"release",
		"--model",
		"gpt-5",
		"--mode",
		"plan",
		"--permission",
		"workspace",
		"--status",
		"interrupted",
		"--limit",
		"5",
		"--json",
	]), {
		kind: "management",
		command: {
			kind: "session",
			action: "list",
			json: true,
			all: true,
			last: true,
			workspaceRoot: "/workspace",
			search: "release",
			model: "gpt-5",
			collaborationMode: "plan",
			permissionProfile: "workspace",
			status: "interrupted",
			limit: 5,
		},
	});
	assert.deepEqual(parseCliMode(["session", "delete", "release", "--force"]), {
		kind: "management",
		command: {
			kind: "session",
			action: "delete",
			sessionId: "release",
			force: true,
			json: false,
		},
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
		["sandbox"],
		["sandbox", "setup"],
			["sandbox", "status", "extra"],
			["update", "dismiss"],
			["update", "unknown"],
		["session", "resume"],
		["session", "list", "--mode", "broken"],
		["session", "list", "--limit", "many"],
		["session", "delete", "id", "--force", "--force"],
		["--runtime-backend=node"],
	] as const) {
		assert.throws(
			() => parseCliMode(argv),
			/(?:invalid_arguments|invalid_json_arguments):/,
		);
	}
});
