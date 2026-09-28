import assert from "node:assert/strict";
import { Socket } from "node:net";
import test from "node:test";
import { ProxyRequestSetup } from "../../src/network/proxy-approval.ts";

test("user wait pauses the setup timeout, has its own deadline and ignores late approval", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const socket = new Socket(); t.after(() => socket.destroy());
	const transport = new Socket(); t.after(() => transport.destroy()); transport.setTimeout(30_000);
	const setup = new ProxyRequestSetup(socket, new AbortController().signal, transport); t.after(() => setup.close());
	const gate = Promise.withResolvers<"approve_once">();
	let signal: AbortSignal | undefined;
	const pending = setup.approve({ requestApproval: async (_request, waiting) => { signal = waiting; return gate.promise; } });
	await Promise.resolve();
	t.mock.timers.tick(31_000);
	assert.equal(setup.signal.aborted, false); assert.equal(signal?.aborted, false);
	assert.equal(socket.timeout, 0); assert.equal(transport.timeout, 0);
	const failed = assert.rejects(pending, { reason: "approval_timeout" });
	t.mock.timers.tick(90_000);
	await failed;
	assert.equal(signal?.aborted, true);
	assert.equal(transport.timeout, 30_000);
	gate.resolve("approve_once");
});
