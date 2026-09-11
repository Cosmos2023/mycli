import assert from "node:assert/strict";
import { setImmediate as nextImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { GatewayClient, type GatewayEvent } from "@mycli/gateway";
import { BackendService, BackendServiceError, type BackendClientAttachment } from "../../src/backend.ts";
import {
	NodeGatewayRpcTransport, type NodeGatewayRpcRequest,
} from "../../src/node-runtime/node-gateway-rpc-transport.ts";

test("service correlates equal client request ids and broadcasts events independently", async (t) => {
	const fixture = serviceFixture(t, async (request) => ({ marker: request.params.marker }));
	const first = connect(t, fixture.service.attach());
	const second = connect(t, fixture.service.attach());
	const results = await Promise.all([
		first.client.send("status.get", { marker: "first" }),
		second.client.send("status.get", { marker: "second" }),
	]);
	assert.deepEqual(results, [{ marker: "first" }, { marker: "second" }]);
	assert.equal(new Set(fixture.requests.map((request) => request.id)).size, 2);
	fixture.emit(delta("shared event"));
	for (const { client } of [first, second]) {
		const event = await client.waitForEvent("message.delta");
		assert.ok(event.method === "message.delta");
		assert.equal(event.params.text, "shared event");
	}
	assert.equal(fixture.closeCount(), 0);
});

test("observer access is read-only even with forged roles and denies control aliases", async (t) => {
	const fixture = serviceFixture(t, () => ({}));
	const observer = connect(t, fixture.service.attach());
	for (const [method, params] of [
		["session.new", {}], ["permissions.update", { profile: "full-access" }],
		["workspace.trust.set", { state: "trusted" }], ["command.run", { command: "/new" }],
		["turn.submit", { message: "do work", client_turn_id: "turn" }],
		["shutdown", {}], ["future.mutation", { role: "controller" }],
	] as const) {
		await assert.rejects(observer.client.send(method, { ...params, role: "controller" }), {
			code: "read_only_client", data: { dispatched: false },
		});
	}
	assert.equal(fixture.requests.length, 0);
	assert.equal(fixture.closeCount(), 0);
});

test("controller handoff waits for accepted mutations after disconnect and does not replay them", async (t) => {
	let finish!: (value: Record<string, unknown>) => void;
	const fixture = serviceFixture(t, (request) => request.method === "session.new"
		? new Promise((resolve) => { finish = resolve; }) : {});
	const firstAttachment = fixture.service.attach({ role: "controller" });
	const first = connect(t, firstAttachment);
	assert.throws(() => fixture.service.attach({ role: "controller" }), { code: "controller_attached" });
	const pending = first.client.request("session.new", {});
	const disconnected = assert.rejects(pending);
	await until(() => fixture.requests.length === 1);
	await firstAttachment.close();
	await disconnected;
	assert.equal(fixture.closeCount(), 0);
	assert.deepEqual(fixture.service.snapshot().controller, {
		id: firstAttachment.id, detached: true, pendingMutations: 1,
	});
	assert.throws(() => fixture.service.attach({ role: "controller" }), { code: "controller_draining" });
	finish({ session_id: "new-session", generation: 2, read_only: false, lines: [], background_shells: [] });
	await until(() => fixture.service.snapshot().controller === undefined);
	const replacement = connect(t, fixture.service.attach({ role: "controller" }));
	assert.deepEqual(await replacement.client.request("status.get", {}), {});
	assert.equal(fixture.requests.filter((request) => request.method === "session.new").length, 1);
	await firstAttachment.close();
	assert.equal(fixture.service.snapshot().controller?.id, replacement.attachment.id);
});

test("a disconnected observer's late response cannot reach a replacement client", async (t) => {
	let finish!: (value: Record<string, unknown>) => void;
	const fixture = serviceFixture(t, (request) => request.params.marker === "old"
		? new Promise((resolve) => { finish = resolve; }) : { marker: "new" });
	const old = connect(t, fixture.service.attach());
	const pending = old.client.send("status.get", { marker: "old" });
	const disconnected = assert.rejects(pending);
	await until(() => fixture.requests.length === 1);
	await old.attachment.close();
	await disconnected;
	const replacement = connect(t, fixture.service.attach());
	finish({ marker: "old result" });
	assert.deepEqual(await replacement.client.send("status.get", { marker: "new" }), { marker: "new" });
	assert.equal(fixture.closeCount(), 0);
});

test("client EOF and oversized frames detach only the affected connection", async (t) => {
	const fixture = serviceFixture(t, () => ({}));
	const healthy = connect(t, fixture.service.attach({ role: "controller" }));
	const eof = fixture.service.attach();
	eof.transport.output.end();
	await eof.completion;
	const invalid = fixture.service.attach({ limits: { maxFrameBytes: 128 } });
	invalid.transport.output.write("x".repeat(129));
	await invalid.completion;
	assert.equal(fixture.service.snapshot().clients.length, 1);
	assert.equal(fixture.closeCount(), 0);
	assert.deepEqual(await healthy.client.request("status.get", {}), {});
});

test("a stalled observer cannot stop healthy event delivery or close the backend", async (t) => {
	const fixture = serviceFixture(t, () => ({}));
	const healthy = connect(t, fixture.service.attach({ role: "controller" }));
	const stalled = fixture.service.attach({ limits: { maxQueuedMessages: 1 } });
	fixture.emit(delta("x".repeat(128 * 1024)));
	fixture.emit(delta("final marker"));
	await stalled.completion;
	await healthy.client.waitForEvent("message.delta", (event) => event.method === "message.delta" && event.params.text === "final marker");
	assert.equal(fixture.service.snapshot().clients.length, 1);
	assert.equal(fixture.closeCount(), 0);
});

test("controller shutdown responds before exactly-once service and backend cleanup", async (t) => {
	const fixture = serviceFixture(t, () => ({}));
	const controller = connect(t, fixture.service.attach({ role: "controller" }));
	const observer = connect(t, fixture.service.attach());
	controller.client.expectClose();
	observer.client.expectClose();
	assert.deepEqual(await controller.client.request("shutdown", {}), { ok: true });
	assert.equal(await fixture.service.completion, 0);
	assert.equal(fixture.closeCount(), 1);
	assert.deepEqual(fixture.service.snapshot(), { state: "closed", clients: [] });
	assert.equal(fixture.service.close(), fixture.service.close());
	await fixture.service.close();
	assert.equal(fixture.closeCount(), 1);
	assert.throws(() => fixture.service.attach(), BackendServiceError);
});

test("service replays readiness for late clients but not old approval or tool events", async (t) => {
	const fixture = serviceFixture(t, () => ({}));
	fixture.emit({ jsonrpc: "2.0", method: "runtime.ready", params: { session_id: "initial" } });
	fixture.emit(delta("old event"));
	await nextImmediate();
	const late = connect(t, fixture.service.attach());
	const ready = await late.client.waitForEvent("runtime.ready");
	assert.ok(ready.method === "runtime.ready");
	assert.equal(ready.params.session_id, "initial");
	await nextImmediate();
	assert.deepEqual(late.events.map((event) => event.method), ["runtime.ready"]);
});

test("accepted shutdown fences new attachments and survives its controller disconnecting before the reply", async (t) => {
	const fixture = serviceFixture(t, () => ({}));
	const controller = fixture.service.attach({ role: "controller" });
	controller.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id: "shutdown", method: "shutdown", params: {} })}\n`);
	const detached = controller.close();
	assert.equal(fixture.service.snapshot().state, "closing");
	assert.throws(() => fixture.service.attach({ role: "controller" }), { code: "service_closed" });
	await detached;
	assert.equal(await fixture.service.completion, 0);
	assert.equal(fixture.closeCount(), 1);
});

test("service bounds attachments and releases capacity without changing roles", async (t) => {
	const fixture = serviceFixture(t, () => ({}), 2);
	const controller = fixture.service.attach({ role: "controller" });
	const observer = fixture.service.attach();
	assert.throws(() => fixture.service.attach(), { code: "client_limit_exceeded" });
	await observer.close();
	const next = fixture.service.attach();
	assert.equal(next.role, "observer");
	assert.equal(fixture.service.snapshot().controller?.id, controller.id);
});

test("backend completion closes every attachment and preserves failure status", async (t) => {
	const fixture = serviceFixture(t, () => ({}));
	const controller = connect(t, fixture.service.attach({ role: "controller" }));
	const observer = connect(t, fixture.service.attach());
	fixture.exit(7);
	assert.equal(await fixture.service.completion, 7);
	await Promise.all([controller.attachment.completion, observer.attachment.completion]);
	assert.equal(fixture.closeCount(), 1);
});

test("backend cleanup failure still closes attachments, invokes the fallback once, and reports failure", async (t) => {
	let finish!: (code: number) => void;
	const completion = new Promise<number>((resolve) => { finish = resolve; });
	const rpc = new NodeGatewayRpcTransport({
		dispatch: () => ({}), mapFailure: () => ({ code: "fixture_error", message: "Fixture failed." }), close: () => {},
	});
	let closeCount = 0;
	let killCount = 0;
	const service = new BackendService({
		transport: rpc.transport, completion, diagnostic: () => "",
		close: async () => { closeCount += 1; throw new Error("private cleanup detail"); },
		kill: () => { killCount += 1; rpc.dispose(); finish(0); },
	});
	t.after(() => service.close().catch(() => undefined));
	const controller = connect(t, service.attach({ role: "controller" }));
	const observer = connect(t, service.attach());
	await assert.rejects(service.close(), { message: "Backend service cleanup failed." });
	await Promise.all([controller.attachment.completion, observer.attachment.completion]);
	assert.equal(await service.completion, 1);
	assert.equal(closeCount, 1);
	assert.equal(killCount, 1);
	assert.deepEqual(service.snapshot(), { state: "closed", clients: [] });
});

function serviceFixture(
	t: TestContext,
	dispatch: (request: NodeGatewayRpcRequest) => Record<string, unknown> | Promise<Record<string, unknown>>,
	maxClients = 16,
): {
	readonly service: BackendService;
	readonly requests: NodeGatewayRpcRequest[];
	readonly emit: (event: GatewayEvent) => void;
	readonly closeCount: () => number;
	readonly exit: (code: number) => void;
} {
	const requests: NodeGatewayRpcRequest[] = [];
	let resolveCompletion!: (code: number) => void;
	let closeCount = 0;
	let closePromise: Promise<void> | undefined;
	const completion = new Promise<number>((resolve) => { resolveCompletion = resolve; });
	const rpc = new NodeGatewayRpcTransport({
		dispatch: (request) => { requests.push(request); return dispatch(request); },
		mapFailure: () => ({ code: "fixture_failure", message: "Fixture request failed." }),
		close: () => {},
	});
	const close = (): Promise<void> => {
		if (closePromise) return closePromise;
		closeCount += 1;
		resolveCompletion(0);
		closePromise = rpc.close().then(() => undefined);
		return closePromise;
	};
	const service = new BackendService({
		transport: rpc.transport, completion, close, kill: () => { rpc.dispose(); resolveCompletion(1); }, diagnostic: () => "",
	}, { maxClients });
	t.after(() => service.close());
	return { service, requests, emit: (event) => rpc.writeNotification(event), closeCount: () => closeCount, exit: resolveCompletion };
}

function connect(t: TestContext, attachment: BackendClientAttachment): {
	readonly attachment: BackendClientAttachment;
	readonly client: GatewayClient;
	readonly events: GatewayEvent[];
} {
	const events: GatewayEvent[] = [];
	const client = new GatewayClient({ ...attachment.transport, log: (event) => events.push(event) });
	client.start();
	t.after(async () => { client.stop(); await attachment.close(); });
	return { attachment, client, events };
}

function delta(text: string): GatewayEvent {
	return { jsonrpc: "2.0", method: "message.delta", params: { client_turn_id: "turn", text } };
}

async function until(condition: () => boolean): Promise<void> {
	for (let attempts = 0; attempts < 100; attempts += 1) {
		if (condition()) return;
		await nextImmediate();
	}
	assert.fail("Service condition did not settle");
}
