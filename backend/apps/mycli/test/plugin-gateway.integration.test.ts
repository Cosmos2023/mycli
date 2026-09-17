import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "@mycli/gateway";
import { PluginCatalogService } from "@mycli/integrations";
import { SessionCoordinator, type PreparedSession } from "@mycli/runtime";
import type { PluginOperation } from "@mycli/contracts";
import { createNodeGateway, type CreateNodeGatewayOptions, type NodeGatewayRuntime } from "../src/node-runtime/node-gateway.ts";
import { isObserverMethod } from "../src/app-server/client-access.ts";

const scope = { session_id: "plugins-session", generation: 1 };
const runtime: NodeGatewayRuntime = {
	reserve: () => assert.fail("no model turn should be reserved"),
	resolveApproval: async () => assert.fail("no approval should run"),
	resolveClarification: async () => assert.fail("no clarification should run"),
	submit: async () => assert.fail("no model should run"), forceInterrupt: async () => assert.fail("no turn should be interrupted"),
};
function harness(t: test.TestContext, pluginCatalog: NonNullable<CreateNodeGatewayOptions["pluginCatalog"]>, sessionCoordinator?: SessionCoordinator<NodeGatewayRuntime>) {
	const gateway = createNodeGateway({ ...{ sessionId: scope.session_id, workspaceRoot: "/workspace", provider: "openai", model: "test", runtime },
		pluginCatalog, ...(sessionCoordinator ? { sessionCoordinator } : {}), loadConversation: () => [], close() {} });
	const client = new GatewayClient(gateway.transport); client.start();
	t.after(async () => { await gateway.close(); client.stop(); });
	return { gateway, client };
}
async function terminalOperation(client: GatewayClient, operation_id: string): Promise<PluginOperation> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const result = await client.request("plugin.operation.get", { ...scope, operation_id });
		if (result.state !== "running") return result;
		await delay(5);
	}
	assert.fail("plugin operation did not finish");
}

test("typed plugin RPCs install into a temporary home and remain separate from headless inspection", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-plugin-gateway-")); t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, "source"); await mkdir(join(source, ".codex-plugin"), { recursive: true });
	await writeFile(join(source, ".codex-plugin/plugin.json"), JSON.stringify({ name: "test-plugin", description: "Local test plugin" }));
	const { client } = harness(t, async (workspaceRoot) => new PluginCatalogService({ workspaceRoot, homeDir: join(root, "home"), includeRepository: false }));
	assert.equal((await client.request("plugin.catalog", scope)).plugins.length, 0);
	const command = await client.request("command.run", { command: "/plugins", surface: "tui" });
	assert.equal(command.client_action, "open_plugins");
	const start = await client.request("plugin.operation.start", { ...scope, operation_id: "install", change: { action: "install_source", source } });
	assert.equal(start.state, "running");
	assert.equal((await terminalOperation(client, "install")).state, "completed");
	const installed = (await client.request("plugin.catalog", scope)).plugins[0]!;
	assert.equal(installed.id, "test-plugin");
	const detail = await client.request("plugin.inspect", { ...scope, target: installed.id, revision: installed.revision });
	assert.equal(detail.plugin.id, installed.id);
	assert.ok(detail.details.includes("Skills (0):"));
	assert.equal((await client.request("plugin.operation.cancel", { ...scope, operation_id: "install" })).state, "completed");
	await assert.rejects(client.request("plugin.operation.start", { ...scope, generation: 2, operation_id: "stale", change: { action: "install_source", source } }), /session changed/i);
	assert.equal(isObserverMethod("plugin.catalog"), true);
	assert.equal(isObserverMethod("plugin.operation.get"), true);
	assert.equal(isObserverMethod("plugin.operation.start"), false);
	assert.equal(isObserverMethod("plugin.operation.cancel"), false);
});

test("pending operations remain responsive, deduplicate IDs, reject overlap and honor cancellation", async (t) => {
	const called = Promise.withResolvers<AbortSignal>(); let calls = 0;
	const { client } = harness(t, async () => ({ inspect: async () => assert.fail("unused"), list: async () => ({ plugins: [], marketplaces: [], issues: [], truncated: false, repository_enabled: false }),
		change: async (_change, signal) => { calls++; called.resolve(signal); await delay(10_000, undefined, { signal }); return { ok: true, action: "add", message: "installed", issues: [] }; } }));
	const params = { ...scope, operation_id: "pending", change: { action: "install_source" as const, source: "/tmp/plugin" } };
	assert.equal((await client.request("plugin.operation.start", params)).state, "running");
	assert.equal((await client.request("plugin.operation.start", params)).state, "running");
	assert.equal(calls, 1);
	await assert.rejects(client.request("plugin.operation.start", { ...params, operation_id: "overlap" }), /still finishing/);
	await assert.rejects(client.request("plugin.operation.start", { ...params, change: { ...params.change, source: "/different" } }), /already in use/);
	await client.request("status.get", {});
	await client.request("plugin.operation.cancel", { ...scope, operation_id: "pending" });
	assert.equal((await called.promise).aborted, true);
	assert.equal((await terminalOperation(client, "pending")).state, "cancelled");
	await assert.rejects(client.request("plugin.operation.get", { ...scope, session_id: "other", operation_id: "pending" }), /not found/);
});

test("committed success wins a late cancel and backend close waits for cleanup", async (t) => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let signal: AbortSignal | undefined;
	let cleaned = false;
	const { gateway, client } = harness(t, async () => ({ inspect: async () => assert.fail("unused"), list: async () => assert.fail("unused"), change: async (_change, abort) => {
		signal = abort; started.resolve(); await release.promise; cleaned = true;
		return { ok: true, action: "add", message: "Committed", issues: [] };
	} }));
	await client.request("plugin.operation.start", { ...scope, operation_id: "commit", change: { action: "install_source", source: "/tmp/plugin" } });
	await started.promise;
	await client.request("plugin.operation.cancel", { ...scope, operation_id: "commit" });
	assert.equal(signal?.aborted, true);
	release.resolve(); assert.equal((await terminalOperation(client, "commit")).state, "completed");
	await gateway.close(); assert.equal(cleaned, true);
});

test("session transition cancels package staging before target preparation completes", async (t) => {
	const target = Promise.withResolvers<void>();
	const prepared = (sessionId: string): PreparedSession<NodeGatewayRuntime> => ({ sessionId, workspaceRoot: "/workspace", threadId: sessionId, binding: runtime, readOnly: false,
		transcript: [], suspendedTurn: false, queue: { sessionId, revision: 0, pendingSteers: [], rejectedSteers: [], followUps: [] } });
	const sessions = new SessionCoordinator({ initial: prepared(scope.session_id), prepare: async (id) => { await target.promise; return prepared(id); },
		create: () => prepared("new"), listSessions: () => [], loadSessionLineage: () => [] });
	const started = Promise.withResolvers<AbortSignal>();
	const { client } = harness(t, async () => ({ inspect: async () => assert.fail("unused"), list: async () => assert.fail("unused"), change: async (_change, signal) => {
		started.resolve(signal); await delay(10_000, undefined, { signal }); return { ok: true, action: "add", message: "installed", issues: [] };
	} }), sessions);
	await client.request("plugin.operation.start", { ...scope, operation_id: "switch", change: { action: "install_source", source: "/tmp/plugin" } });
	const signal = await started.promise;
	const resumed = client.request("session.resume", { session_id: "target" });
	try { await setImmediate(); assert.equal(signal.aborted, true); }
	finally { target.resolve(); }
	await resumed;
	assert.equal((await terminalOperation(client, "switch")).state, "cancelled");
});

test("backend shutdown cancels an unfinished operation and waits for its stage cleanup", async (t) => {
	const started = Promise.withResolvers<AbortSignal>();
	const release = Promise.withResolvers<void>();
	const { gateway, client } = harness(t, async () => ({ list: async () => assert.fail("unused"), inspect: async () => assert.fail("unused"),
		change: async (_change, signal) => {
			started.resolve(signal);
			try { await delay(10_000, undefined, { signal }); }
			finally { await release.promise; }
			return { ok: true, action: "add", message: "installed", issues: [] };
		} }));
	await client.request("plugin.operation.start", { ...scope, operation_id: "shutdown", change: { action: "install_source", source: "/tmp/plugin" } });
	const signal = await started.promise;
	let closed = false;
	const closing = gateway.close().then(() => { closed = true; });
	try { await setImmediate(); assert.equal(signal.aborted, true); assert.equal(closed, false); }
	finally { release.resolve(); await closing; }
	assert.equal(closed, true);
});
