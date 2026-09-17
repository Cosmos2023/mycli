import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { parseGatewayResult, type GatewayMethod, type GatewayParams, type GatewayResult, type PluginOperation } from "@mycli/contracts";
import { createPluginManagerClient } from "../../src/application/plugin-manager-client.ts";

const result = (operation_id: string, state: PluginOperation["state"]): PluginOperation => ({ operation_id, state, message: state, issues: [] });

test("plugin client keeps polling and cancellation bound to the original session without replaying mutation", async () => {
	const calls: { method: GatewayMethod; params: unknown }[] = [];
	let current = { session_id: "original", generation: 1 };
	let running = true;
	const client = createPluginManagerClient({ context: () => current, pollMs: 1,
		request: async <M extends GatewayMethod>(method: M, params: GatewayParams<M>): Promise<GatewayResult<M>> => {
			calls.push({ method, params });
			const scoped = params as GatewayParams<"plugin.operation.get">;
			if (method === "plugin.operation.cancel") running = false;
			return parseGatewayResult(method, result(scoped.operation_id, running ? "running" : "cancelled"));
		},
	});
	const controller = new AbortController();
	const pending = client.change({ action: "install_source", source: "/tmp/plugin" }, controller.signal);
	const outcome = pending.catch((error: unknown) => error);
	await delay(5); current = { session_id: "other", generation: 2 }; controller.abort();
	await outcome; await setImmediate();
	assert.equal(calls.filter((call) => call.method === "plugin.operation.start").length, 1);
	assert.equal(calls.filter((call) => call.method === "plugin.operation.cancel").length, 1);
	assert.ok(calls.length >= 2);
	assert.ok(calls.every((call) => (call.params as typeof current).session_id === "original"));
	const count = calls.length; await delay(5); assert.equal(calls.length, count);
});

test("plugin client does not retry a start with unknown transport outcome", async () => {
	let requests = 0;
	const client = createPluginManagerClient({ context: () => ({ session_id: "s", generation: 1 }), request: async () => {
		requests++; throw new Error("Gateway disconnected");
	} });
	await assert.rejects(client.change({ action: "marketplace_add", source: "/tmp/market" }, new AbortController().signal), /disconnected/);
	assert.equal(requests, 1);
});
