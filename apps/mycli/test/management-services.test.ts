import assert from "node:assert/strict";
import test from "node:test";
import { ManagementServices } from "../src/management/services.ts";

test("management facade dispatches every extension command to its provider-free service", async () => {
	const calls: string[] = [];
	const result = (action: string) => ({ ok: true, action, message: action });
	const services = new ManagementServices({
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
		subagents: {
			list: () => { calls.push("subagents:list"); return result("list"); },
			inspect: (id) => { calls.push(`subagents:inspect:${id}`); return result("inspect"); },
		},
		doctor: async () => { calls.push("doctor"); return result("doctor"); },
		setup: async () => { calls.push("setup"); return result("setup"); },
	});
	const signal = new AbortController().signal;

	for (const command of [
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
		{ kind: "subagents", action: "list", json: false },
		{ kind: "subagents", action: "inspect", profileId: "explore", json: false },
		{ kind: "doctor", json: false },
		{ kind: "setup", json: false },
	] as const) {
		assert.equal((await services.execute(command, signal)).ok, true);
	}

	assert.deepEqual(calls, [
		"hooks:list",
		"hooks:inspect:hook",
		"hooks:approve:hook",
		"hooks:revoke:hook",
		"plugins:list",
		"plugins:inspect:demo",
		'plugins:run:demo:status:{"verbose":true}',
		"mcp:list",
		"mcp:inspect:files",
		"subagents:list",
		"subagents:inspect:explore",
		"doctor",
		"setup",
	]);
});

test("management facade converts service exceptions to one redacted failure", async () => {
	const services = new ManagementServices({
		hooks: {
			list: async () => { throw new Error("sk-private-secret-value"); },
			inspect: async () => { throw new Error("unused"); },
			approve: async () => { throw new Error("unused"); },
			revoke: async () => { throw new Error("unused"); },
		},
		plugins: unusedService(),
		mcp: unusedService(),
		subagents: unusedService(),
		doctor: async () => never(),
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
