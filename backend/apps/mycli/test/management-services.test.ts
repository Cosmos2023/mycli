import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceTrustStore } from "@mycli/config";
import {
	createDefaultManagementServices,
	ManagementServices,
} from "../src/management/services.ts";

test("default management services expose repository sources only after trust", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-management-trust-"));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	await Promise.all([
		mkdir(homeDir),
		mkdir(join(workspaceRoot, ".mycli"), { recursive: true }),
	]);
	await writeFile(join(workspaceRoot, ".mycli", "hooks.json"), JSON.stringify({
		hooks: [{
			id: "repo-hook",
			hook_point: "stop",
			command: [process.execPath, "repo-hook.mjs"],
		}],
	}), "utf8");
	t.after(() => rm(root, { recursive: true, force: true }));
	const command = { kind: "hooks", action: "list", json: true } as const;

	const untrusted = await createDefaultManagementServices({
		workspaceRoot,
		homeDir,
		env: {},
	});
	const hidden = await untrusted.execute(command);
	assert.deepEqual(managementHooks(hidden), []);

	await new WorkspaceTrustStore({ homeDir }).save(workspaceRoot, "trusted");
	const trusted = await createDefaultManagementServices({
		workspaceRoot,
		homeDir,
		env: {},
	});
	const visible = await trusted.execute(command);
	assert.equal(managementHooks(visible).length, 1);
});

test("management facade dispatches every extension command to its provider-free service", async () => {
	const calls: string[] = [];
	const result = (action: string) => ({ ok: true, action, message: action });
	const services = new ManagementServices({
		config: {
			validate: async (strict) => { calls.push(`config:validate:${strict}`); return result("validate"); },
			show: async () => { calls.push("config:show"); return result("show"); },
			path: async (scope, profile) => {
				calls.push(`config:path:${scope}:${profile ?? "none"}`);
				return result("path");
			},
			get: async (key) => { calls.push(`config:get:${key}`); return result("get"); },
			set: async (key, value) => {
				calls.push(`config:set:${key}:${value}`);
				return result("set");
			},
			unset: async (key) => { calls.push(`config:unset:${key}`); return result("unset"); },
			previewMigration: async () => { calls.push("config:migrate:preview"); return result("migrate"); },
			applyMigration: async (version) => {
				calls.push(`config:migrate:apply:${version}`);
				return result("migrate");
			},
			rollbackMigration: async (backupId) => {
				calls.push(`config:migrate:rollback:${backupId}`);
				return result("migrate");
			},
		},
		hooks: {
			list: async () => { calls.push("hooks:list"); return result("list"); },
			inspect: async (id) => { calls.push(`hooks:inspect:${id}`); return result("inspect"); },
			approve: async (id) => { calls.push(`hooks:approve:${id}`); return result("approve"); },
			revoke: async (id) => { calls.push(`hooks:revoke:${id}`); return result("revoke"); },
		},
		plugins: {
			list: async () => { calls.push("plugins:list"); return result("list"); },
			inspect: async (id) => { calls.push(`plugins:inspect:${id}`); return result("inspect"); },
			run: async (id, command, args) => {
				calls.push(`plugins:run:${id}:${command}:${JSON.stringify(args)}`);
				return result("run");
			},
		},
		mcp: {
			list: async () => { calls.push("mcp:list"); return result("list"); },
			inspect: async (id) => { calls.push(`mcp:inspect:${id}`); return result("inspect"); },
		},
		update: {
			status: async () => { calls.push("update:status"); return result("status"); },
			check: async () => { calls.push("update:check"); return result("check"); },
			dismiss: async (version) => { calls.push(`update:dismiss:${version}`); return result("dismiss"); },
		},
		doctor: async () => { calls.push("doctor"); return result("doctor"); },
		sandbox: async () => { calls.push("sandbox:status"); return result("status"); },
		setup: async () => { calls.push("setup"); return result("setup"); },
		auth: {
			execute: async (command) => {
				calls.push(`auth:${command.kind}:${command.action}`);
				return result(command.action);
			},
		},
	});
	const signal = new AbortController().signal;

	for (const command of [
		{ kind: "config", action: "validate", strict: true, json: false },
		{ kind: "config", action: "show", json: false },
		{ kind: "config", action: "path", scope: "profile", profile: "work", json: false },
		{ kind: "config", action: "get", key: "model.name", json: false },
		{ kind: "config", action: "set", key: "memory.enabled", value: "true", json: false },
		{ kind: "config", action: "unset", key: "model.name", json: false },
		{ kind: "config", action: "migrate", operation: "preview", json: false },
		{
			kind: "config",
			action: "migrate",
			operation: "apply",
			expectedVersion: "migration-v1-test",
			json: false,
		},
		{
			kind: "config",
			action: "migrate",
			operation: "rollback",
			backupId: "backup",
			json: false,
		},
		{ kind: "hooks", action: "list", json: false },
		{ kind: "hooks", action: "inspect", identity: "hook", json: false },
		{ kind: "hooks", action: "approve", identity: "hook", json: false },
		{ kind: "hooks", action: "revoke", identity: "hook", json: false },
		{ kind: "plugins", action: "list", json: false },
		{ kind: "plugins", action: "inspect", pluginId: "demo", json: false },
		{
			kind: "plugins",
			action: "run",
			pluginId: "demo",
			commandName: "status",
			arguments: { verbose: true },
			json: false,
		},
		{ kind: "mcp", action: "list", json: false },
		{ kind: "mcp", action: "inspect", serverId: "files", json: false },
		{ kind: "update", action: "status", json: false },
		{ kind: "update", action: "check", json: false },
		{ kind: "update", action: "dismiss", version: "1.2.3", json: false },
		{ kind: "doctor", json: false, verbose: false },
		{ kind: "sandbox", action: "status", json: false },
		{ kind: "setup", json: false },
		{ kind: "login", action: "status", json: false },
		{ kind: "login", action: "api_key", provider: "openai", json: false },
		{ kind: "logout", action: "logout", json: false },
	] as const) {
		assert.equal((await services.execute(command, signal)).ok, true);
	}

	assert.deepEqual(calls, [
		"config:validate:true",
		"config:show",
		"config:path:profile:work",
		"config:get:model.name",
		"config:set:memory.enabled:true",
		"config:unset:model.name",
		"config:migrate:preview",
		"config:migrate:apply:migration-v1-test",
		"config:migrate:rollback:backup",
		"hooks:list",
		"hooks:inspect:hook",
		"hooks:approve:hook",
		"hooks:revoke:hook",
		"plugins:list",
		"plugins:inspect:demo",
		'plugins:run:demo:status:{"verbose":true}',
		"mcp:list",
		"mcp:inspect:files",
		"update:status",
		"update:check",
		"update:dismiss:1.2.3",
		"doctor",
		"sandbox:status",
		"setup",
		"auth:login:status",
		"auth:login:api_key",
		"auth:logout:logout",
	]);
});

test("management facade converts service exceptions to one redacted failure", async () => {
	const services = new ManagementServices({
		config: unusedService(),
		hooks: {
			list: async () => { throw new Error("sk-private-secret-value"); },
			inspect: async () => { throw new Error("unused"); },
			approve: async () => { throw new Error("unused"); },
			revoke: async () => { throw new Error("unused"); },
		},
		plugins: unusedService(),
		mcp: unusedService(),
		update: unusedService(),
		doctor: async () => never(),
		sandbox: async () => never(),
		setup: async () => never(),
	});

	const response = await services.execute(
		{ kind: "hooks", action: "list", json: false },
		new AbortController().signal,
	);

	assert.deepEqual(response, {
		ok: false,
		action: "list",
		message: "management command failed",
		issues: ["management_command_failed"],
	});
	assert.equal(JSON.stringify(response).includes("private-secret-value"), false);
});

function unusedService(): never {
	return new Proxy({}, {
		get: () => () => never(),
	}) as never;
}

function never(): never {
	throw new Error("must not call unrelated management service");
}

function managementHooks(value: unknown): readonly unknown[] {
	if (typeof value !== "object" || value === null || !("hooks" in value)) return [];
	return Array.isArray(value.hooks) ? value.hooks : [];
}
