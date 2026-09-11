import assert from "node:assert/strict";
import test from "node:test";
import { parseCliMode } from "../src/management/parser.ts";

test("plugin package and marketplace commands parse with bounded option combinations", () => {
	const cases = [
		{ args: ["add", "demo@personal"], command: { action: "add", source: "demo@personal" } },
		{ args: ["add", "owner/repo", "--ref", "stable"], command: { action: "add", source: "owner/repo", ref: "stable" } },
		{ args: ["list", "--available", "--marketplace", "personal"], command: { action: "available", marketplace: "personal" } },
		{ args: ["disable", "demo@personal"], command: { action: "disable", pluginId: "demo@personal" } },
		{ args: ["update", "demo"], command: { action: "update", pluginId: "demo" } },
		{ args: ["marketplace", "add", "./market"], command: { action: "marketplace", operation: "add", target: "./market" } },
		{ args: ["marketplace", "upgrade", "personal"], command: { action: "marketplace", operation: "upgrade", target: "personal" } },
		{ args: ["marketplace", "list"], command: { action: "marketplace", operation: "list" } },
	];
	for (const { args, command } of cases) assert.deepEqual(parseCliMode(["plugins", ...args, "--json"]), {
		kind: "management", command: { kind: "plugins", ...command, json: true },
	});
	for (const args of [["add"], ["remove"], ["add", "demo", "--ref"], ["list", "--available", "extra"],
		["marketplace", "remove"], ["marketplace", "list", "extra"], ["add", "demo", "--marketplace", "one", "--ref", "main"]]) {
		assert.throws(() => parseCliMode(["plugins", ...args]));
	}
});

test("OAuth login parses independently of API-key stdin login", () => {
	assert.deepEqual(parseCliMode(["login", "--oauth", "--provider", "anthropic", "--auth-ref", "work", "--json"]), {
		kind: "management", command: { kind: "login", action: "oauth", provider: "anthropic", authRef: "work", json: true },
	});
	for (const argv of [
		["login", "--oauth", "--with-api-key"], ["login", "--oauth", "--oauth"],
		["login", "status", "--oauth"], ["logout", "--oauth"],
	]) assert.throws(() => parseCliMode(argv));
});

test("parser recognizes provider-free management commands before interactive flags", () => {
	assert.deepEqual(parseCliMode(["doctor", "--json"]), {
		kind: "management",
		command: { kind: "doctor", operation: "check", json: true, verbose: false },
	});
	assert.deepEqual(parseCliMode(["doctor", "--verbose"]), {
		kind: "management",
		command: { kind: "doctor", operation: "check", json: false, verbose: true },
	});
	assert.deepEqual(parseCliMode(["doctor", "--fix", "--json"]), {
		kind: "management",
		command: { kind: "doctor", operation: "fix", json: true, verbose: false },
	});
	const planId = `doctor-plan-v1-${"a".repeat(64)}`;
	assert.deepEqual(parseCliMode(["doctor", "--fix", "--confirm", planId]), {
		kind: "management",
		command: {
			kind: "doctor",
			operation: "fix",
			expectedPlanId: planId,
			json: false,
			verbose: false,
		},
	});
	assert.deepEqual(parseCliMode(["doctor", "--support-bundle", "--verbose"]), {
		kind: "management",
		command: { kind: "doctor", operation: "support", json: false, verbose: true },
	});
	assert.deepEqual(parseCliMode(["setup"]), {
		kind: "management",
		command: { kind: "setup", json: false },
	});
	assert.deepEqual(parseCliMode([
		"setup",
		"--non-interactive",
		"--provider",
		"openai",
		"--model",
		"gpt-5",
		"--base-url",
		"https://api.openai.com/v1",
		"--with-api-key",
		"--json",
	]), {
		kind: "management",
		command: {
			kind: "setup",
			json: true,
			nonInteractive: true,
			provider: "openai",
			model: "gpt-5",
			apiBaseUrl: "https://api.openai.com/v1",
			withApiKey: true,
		},
	});
	assert.deepEqual(parseCliMode(["login", "status", "--provider", "openai", "--json"]), {
		kind: "management",
		command: {
			kind: "login",
			action: "status",
			provider: "openai",
			json: true,
		},
	});
	assert.deepEqual(parseCliMode([
		"login",
		"--with-api-key",
		"--provider",
		"openai",
		"--auth-ref",
		"openai-work",
	]), {
		kind: "management",
		command: {
			kind: "login",
			action: "api_key",
			provider: "openai",
			authRef: "openai-work",
			json: false,
		},
	});
	assert.deepEqual(parseCliMode(["logout", "--auth-ref", "openai-work", "--json"]), {
		kind: "management",
		command: {
			kind: "logout",
			action: "logout",
			authRef: "openai-work",
			json: true,
		},
	});
	assert.deepEqual(parseCliMode(["sandbox", "status", "--json"]), {
		kind: "management",
		command: { kind: "sandbox", action: "status", json: true },
	});
	assert.deepEqual(parseCliMode(["sandbox", "setup"]), {
		kind: "management",
		command: { kind: "sandbox", action: "setup", confirmed: false, json: false },
	});
	assert.deepEqual(parseCliMode(["sandbox", "reset", "--confirm", "--json"]), {
		kind: "management",
		command: { kind: "sandbox", action: "reset", confirmed: true, json: true },
	});
	assert.deepEqual(parseCliMode(["config", "validate", "--json"]), {
		kind: "management",
		command: { kind: "config", action: "validate", json: true },
	});
	assert.deepEqual(parseCliMode(["config", "validate", "--strict", "--json"]), {
		kind: "management",
		command: { kind: "config", action: "validate", strict: true, json: true },
	});
	assert.deepEqual(parseCliMode(["config", "show"]), {
		kind: "management",
		command: { kind: "config", action: "show", json: false },
	});
	assert.deepEqual(parseCliMode(["config", "path"]), {
		kind: "management",
		command: { kind: "config", action: "path", scope: "user", json: false },
	});
	assert.deepEqual(parseCliMode(["config", "path", "project", "--json"]), {
		kind: "management",
		command: { kind: "config", action: "path", scope: "project", json: true },
	});
	assert.deepEqual(parseCliMode(["config", "path", "profile", "--profile", "work"]), {
		kind: "management",
		command: {
			kind: "config",
			action: "path",
			scope: "profile",
			profile: "work",
			json: false,
		},
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
	assert.deepEqual(parseCliMode(["config", "migrate", "--dry-run", "--json"]), {
		kind: "management",
		command: { kind: "config", action: "migrate", operation: "preview", json: true },
	});
	assert.deepEqual(parseCliMode([
		"config",
		"migrate",
		"--apply",
		"--expected-version",
		"migration-v1-example",
	]), {
		kind: "management",
		command: {
			kind: "config",
			action: "migrate",
			operation: "apply",
			expectedVersion: "migration-v1-example",
			json: false,
		},
	});
	assert.deepEqual(parseCliMode(["config", "migrate", "--rollback", "backup-example"]), {
		kind: "management",
		command: {
			kind: "config",
			action: "migrate",
			operation: "rollback",
			backupId: "backup-example",
			json: false,
		},
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

test("parser recognizes every supported local completion shell", () => {
	for (const shell of ["bash", "zsh", "fish", "powershell"] as const) {
		assert.deepEqual(parseCliMode(["completion", shell]), {
			kind: "completion",
			shell,
		});
	}
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
		["config", "validate", "--strict", "--strict"],
		["config", "validate", "--json", "--json"],
		["config", "path", "unknown"],
		["config", "path", "profile"],
		["config", "path", "profile", "--profile"],
		["config", "path", "profile", "--profile", "work", "--profile", "other"],
		["config", "path", "user", "--profile", "work"],
		["config", "path", "user", "project"],
		["config", "migrate"],
		["config", "migrate", "--apply"],
		["config", "migrate", "--apply", "--expected-version"],
		["config", "migrate", "--expected-version", "version", "--apply"],
		["config", "migrate", "--rollback"],
		["config", "migrate", "--dry-run", "extra"],
		["hooks", "inspect"],
		["hooks", "list", "extra"],
		["plugins", "run", "demo", "status", "--json-args", "[]"],
		["plugins", "run", "demo", "status", "--json-args", "{broken"],
		["mcp", "inspect"],
		["subagents", "unknown"],
		["setup", "--json"],
		["setup", "--non-interactive", "--provider", "openai"],
		["setup", "--with-api-key", "--provider", "openai"],
		["setup", "--non-interactive", "--with-api-key"],
		["login"],
		["login", "status", "extra"],
		["login", "--with-api-key", "--provider"],
		["login", "--with-api-key", "--provider", "openai", "--provider", "deepseek"],
		["logout", "extra"],
		["sandbox"],
		["sandbox", "status", "extra"],
		["sandbox", "setup", "--confirm", "--confirm"],
		["doctor", "--confirm", `doctor-plan-v1-${"a".repeat(64)}`],
		["doctor", "--fix", "--confirm"],
		["doctor", "--fix", "--confirm", "invalid"],
		["doctor", "--fix", "--support-bundle"],
		["doctor", "--support-bundle", "extra"],
		["update", "dismiss"],
		["update", "unknown"],
		["session", "resume"],
		["session", "list", "--mode", "broken"],
		["session", "list", "--limit", "many"],
		["session", "delete", "id", "--force", "--force"],
		["completion"],
		["completion", "unknown"],
		["completion", "bash", "extra"],
		["--runtime-backend=node"],
	] as const) {
		assert.throws(
			() => parseCliMode(argv),
			/(?:invalid_arguments|invalid_json_arguments):/,
		);
	}
});

test("parser rejects API key argv values without repeating the submitted secret", () => {
	for (const argv of [
		["login", "--api-key", "private-argv-sentinel"],
		["login", "--api-key=private-argv-sentinel"],
	] as const) {
		assert.throws(
			() => parseCliMode(argv),
			(error: unknown) => error instanceof Error
				&& /--api-key is not supported/u.test(error.message)
				&& !error.message.includes("private-argv-sentinel"),
		);
	}
});
