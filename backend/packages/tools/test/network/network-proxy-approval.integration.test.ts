import assert from "node:assert/strict";
import * as http from "node:http";
import { createConnection } from "node:net";
import { once } from "node:events";
import test from "node:test";
import type { NetworkAccessDetails } from "@mycli/contracts";
import { lease, listen, request, client, readUntil, socksDomain, FULL_PROXY, LIMITED_PROXY } from "../support/network-proxy.ts";

const policy = { ...FULL_PROXY, approvalDomains: ["api.example.com"] };

test("approval holds the original HTTP request before dialing, preserves its body and never grants the next request", async (t) => {
	const received: string[] = [];
	const port = await listen(t, http.createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		received.push(`${req.method} ${body}`); res.end("sent");
	}));
	let dials = 0;
	let gate = Promise.withResolvers<"approve_once" | "reject">();
	let prompted = Promise.withResolvers<NetworkAccessDetails>();
	const proxy = await lease(t, { policy, connect: () => { dials++; return createConnection({ host: "127.0.0.1", port }); },
		requestApproval: async (details) => { prompted.resolve(details); return gate.promise; } });
	const response = new Promise<string>((resolve, reject) => {
		const req = http.request({ hostname: "127.0.0.1", port: proxy.port, method: "POST", path: "http://api.example.com/private?token=secret",
			headers: { host: "api.example.com", authorization: "Bearer secret" } }, (res) => {
			let body = ""; res.on("data", (chunk) => { body += chunk; }); res.on("end", () => resolve(body));
		});
		req.on("error", reject); req.end("body-secret");
	});
	assert.deepEqual(await prompted.promise, { reason: "approval_required", host: "api.example.com", port: 80, protocol: "http", method: "POST" });
	assert.equal(dials, 0); assert.deepEqual(received, []);
	gate.resolve("approve_once");
	assert.equal(await response, "sent"); assert.deepEqual(received, ["POST body-secret"]);
	gate = Promise.withResolvers(); prompted = Promise.withResolvers();
	const second = request(proxy);
	await prompted.promise; assert.equal(dials, 1);
	gate.resolve("reject");
	assert.equal((await second).status, 403); assert.equal(dials, 1);
});

test("hard domain, method and private-address blocks never offer approval and publish only safe details", async (t) => {
	let approvals = 0;
	const blocked: NetworkAccessDetails[] = [];
	const proxy = await lease(t, { policy: { ...LIMITED_PROXY, approvalDomains: ["api.example.com", "outside.test"] },
		lookup: async () => [{ address: "127.0.0.1", family: 4 }],
		requestApproval: async () => { approvals++; return "approve_once"; }, onBlocked: (details) => blocked.push(details),
		connect: () => { throw new Error("must not dial"); } });
	assert.equal((await request(proxy, "GET", undefined, "outside.test")).status, 403);
	assert.equal((await request(proxy, "POST")).status, 403);
	assert.equal((await request(proxy)).status, 403);
	assert.equal(approvals, 0);
	assert.deepEqual(blocked.map((details) => details.reason), ["domain_denied", "method_denied", "private_address"]);
	assert.doesNotMatch(JSON.stringify(blocked), /resource|q=1|127\.0\.0\.1/u);
});

test("no responder fails closed and closing a lease cancels even an uncooperative approval handler", async (t) => {
	const reasons: string[] = [];
	const noUi = await lease(t, { policy, onBlocked: (details) => reasons.push(details.reason) });
	assert.equal((await request(noUi)).status, 403);
	assert.deepEqual(reasons, ["approval_unavailable"]);
	const prompted = Promise.withResolvers<AbortSignal>();
	const proxy = await lease(t, { policy, requestApproval: async (_details, signal) => {
		prompted.resolve(signal); return new Promise(() => undefined);
	} });
	const response = request(proxy).catch(() => undefined);
	const signal = await prompted.promise;
	await proxy.close(); await response;
	assert.equal(signal.aborted, true);
});

test("CONNECT and SOCKS approvals authorize only their exact tunnel and abort on client disconnect", async (t) => {
	for (const socks of [false, true]) {
		const prompted = Promise.withResolvers<NetworkAccessDetails>();
		const gate = Promise.withResolvers<"approve_once">();
		let dials = 0;
		const server = http.createServer();
		const port = await listen(t, server);
		const proxy = await lease(t, { policy, requestApproval: async (details) => { prompted.resolve(details); return gate.promise; },
			connect: () => { dials++; return createConnection({ host: "127.0.0.1", port }); } });
		const socket = await client(t, proxy);
		socket.write(socks ? Buffer.concat([Buffer.from([5, 1, 0]), socksDomain("api.example.com", 8443)])
			: "CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n");
		const details = await prompted.promise;
		assert.equal(details.host, "api.example.com"); assert.equal(details.port, socks ? 8443 : 443); assert.equal(dials, 0);
		gate.resolve("approve_once");
		if (socks) assert.equal((await readUntil(socket, () => 12))[3], 0);
		else assert.match((await readUntil(socket, (bytes) => bytes.indexOf("\r\n\r\n") + 4)).toString(), /200 Connection Established/u);
		assert.equal(dials, 1); socket.destroy();
	}
	const prompted = Promise.withResolvers<AbortSignal>();
	const proxy = await lease(t, { policy, requestApproval: async (_details, signal) => {
		prompted.resolve(signal); return new Promise(() => undefined);
	} });
	const socket = await client(t, proxy);
	socket.write("GET http://api.example.com/ HTTP/1.1\r\nHost: api.example.com\r\n\r\n");
	const signal = await prompted.promise;
	const aborted = once(signal, "abort"); socket.destroy(); await aborted;
});
