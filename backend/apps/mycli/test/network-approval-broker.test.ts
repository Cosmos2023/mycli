import assert from "node:assert/strict";
import test from "node:test";
import { parseGatewayEvent, type NetworkAccessDetails } from "@mycli/contracts";
import { NetworkApprovalBroker } from "../src/node-runtime/network-approval-broker.ts";

const details: NetworkAccessDetails = { host: "api.example.com", port: 443, protocol: "https", method: "CONNECT", reason: "approval_required" };

test("live network decisions reject stale, cross-owner and persistent grants without consuming the responder", async () => {
	const broker = new NetworkApprovalBroker();
	const events: { method: string; params: Record<string, unknown> }[] = [];
	const unsubscribe = broker.subscribe((event) => { parseGatewayEvent({ jsonrpc: "2.0", ...event }); events.push(event); });
	const interaction = broker.interaction({ sessionId: "root", turnId: "turn", callId: "call" });
	const pending = interaction.requestApproval!(details, new AbortController().signal);
	const id = events[0]!.params.decision_id;
	assert.throws(() => broker.respond({ decision_id: id, session_id: "child", choice: "approve_once" }), { code: "approval_not_pending" });
	assert.throws(() => broker.respond({ decision_id: id, session_id: "root", choice: "always_allow" }), { code: "invalid_params" });
	assert.equal(broker.hasPending("root"), true);
	assert.equal(broker.respond({ decision_id: "ordinary", choice: "approve_once" }), undefined);
	broker.respond({ decision_id: id, session_id: "root", choice: "approve_once" });
	assert.equal(await pending, "approve_once"); assert.equal(broker.hasPending(), false);
	assert.throws(() => broker.respond({ decision_id: id, session_id: "root", choice: "approve_once" }), { code: "approval_not_pending" });
	const aborted = new AbortController();
	const next = interaction.requestApproval!(details, aborted.signal);
	assert.notEqual(events.at(-1)?.params.decision_id, id);
	aborted.abort(); assert.equal(await next, "unavailable");
	assert.equal(events.at(-1)?.method, "interactive.cancelled");
	unsubscribe();
});

test("headless, disconnect, session transition and shutdown cannot retain or revive network approvals", async () => {
	const broker = new NetworkApprovalBroker();
	const interaction = broker.interaction({ sessionId: "root", callId: "call" });
	const signal = new AbortController().signal;
	assert.equal(await interaction.requestApproval!(details, signal), "unavailable");
	let diagnostics = 0;
	const unsubscribe = broker.subscribe((event) => { if (event.method === "network.blocked") diagnostics++; });
	const first = interaction.requestApproval!(details, signal);
	const second = interaction.requestApproval!(details, signal);
	for (let count = 0; count < 40; count++) interaction.onBlocked!(details);
	assert.equal(diagnostics, 32);
	unsubscribe(); assert.deepEqual(await Promise.all([first, second]), ["unavailable", "unavailable"]);
	broker.subscribe(() => undefined);
	const old = interaction.requestApproval!(details, signal);
	broker.revoke(); assert.equal(await old, "unavailable");
	assert.equal(await interaction.requestApproval!(details, signal), "unavailable");
	const fresh = broker.interaction({ sessionId: "new", callId: "new-call" }).requestApproval!(details, signal);
	broker.close(); assert.equal(await fresh, "unavailable");
});

test("losing the controller cancels live requests even while observers remain subscribed", async () => {
	const broker = new NetworkApprovalBroker();
	const events: { method: string; params: Record<string, unknown> }[] = [];
	broker.subscribe((event) => events.push(event));
	const interaction = broker.interaction({ sessionId: "root", callId: "background" });
	const signal = new AbortController().signal;
	const first = interaction.requestApproval!(details, signal);
	const id = events[0]!.params.decision_id;
	broker.setAvailability(false);
	assert.equal(await first, "unavailable");
	assert.equal(events.at(-1)?.method, "interactive.cancelled");
	assert.equal(await interaction.requestApproval!(details, signal), "unavailable");
	assert.equal(broker.hasPending(), false);
	broker.setAvailability(true);
	assert.throws(() => broker.respond({ decision_id: id, session_id: "root", choice: "approve_once" }), { code: "approval_not_pending" });
	const next = interaction.requestApproval!(details, signal);
	const nextId = events.at(-1)!.params.decision_id;
	assert.notEqual(nextId, id);
	broker.respond({ decision_id: nextId, session_id: "root", choice: "reject" });
	assert.equal(await next, "reject");
	broker.close();
});
