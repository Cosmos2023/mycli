import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import test from "node:test";
import type { NetworkProxyTarget } from "../../src/network/network-proxy.ts";
import { lease, listen, client, readUntil, socksDomain, PUBLIC_ADDRESS, LIMITED_PROXY } from "../support/network-proxy.ts";

test("SOCKS accepts fragmented negotiation and coalesced payload while pinning numeric destinations", async (t) => {
	const port = await listen(t, createServer((socket) => socket.pipe(socket)));
	const targets: NetworkProxyTarget[] = [];
	const proxy = await lease(t, { connect: (target) => { targets.push(target); return createConnection({ host: "127.0.0.1", port }); } });
	const socket = await client(t, proxy);
	socket.write(Buffer.from([5]));
	await new Promise<void>((resolve) => setImmediate(resolve));
	socket.write(Buffer.from([2, 2, 0]));
	assert.deepEqual(await readUntil(socket, () => 2), Buffer.from([5, 0]));
	socket.write(Buffer.concat([socksDomain("api.example.com", 9418), Buffer.from("payload")]));
	assert.equal((await readUntil(socket, () => 10))[1], 0);
	assert.equal((await readUntil(socket, () => 7)).toString(), "payload");
	assert.deepEqual(targets, [{ address: PUBLIC_ADDRESS, family: 4, port: 9418 }]);
	const closed = once(socket, "close"); socket.resume();
	await proxy.close(); await closed;
});

test("SOCKS rejects disabled protocol, unsupported authentication, BIND and UDP without duplicate replies", async (t) => {
	const disabled = await lease(t, { policy: undefined });
	const off = await client(t, disabled); off.write(Buffer.from([5, 1, 0]));
	assert.deepEqual(await readUntil(off, () => 2), Buffer.from([5, 255]));
	const proxy = await lease(t);
	for (const command of [0, 2, 3]) {
		const socket = await client(t, proxy);
		const parts: Buffer[] = []; socket.on("data", (chunk: Buffer) => parts.push(chunk));
		socket.write(command === 0 ? Buffer.from([5, 1, 2]) : Buffer.concat([Buffer.from([5, 1, 0]), socksDomain("api.example.com", 443, command)]));
		await once(socket, "end");
		const bytes = Buffer.concat(parts);
		assert.deepEqual(bytes, command === 0 ? Buffer.from([5, 255]) : Buffer.from([5, 0, 5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
	}
});

test("SOCKS domain, literal and DNS safety checks prevent forbidden dials", async (t) => {
	let dials = 0;
	for (const options of [
		{ host: "outside.test", domains: ["api.example.com"], addresses: [{ address: PUBLIC_ADDRESS, family: 4 }] },
		{ host: "127.0.0.1", domains: ["127.0.0.1"], addresses: [] },
		{ host: "api.example.com", domains: ["api.example.com"], addresses: [{ address: PUBLIC_ADDRESS, family: 4 }, { address: "10.0.0.1", family: 4 }] },
	]) {
		const proxy = await lease(t, { domains: options.domains, lookup: async () => options.addresses,
			connect: () => { dials += 1; throw new Error("Forbidden dial"); } });
		const socket = await client(t, proxy);
		socket.write(Buffer.concat([Buffer.from([5, 1, 0]), socksDomain(options.host)]));
		assert.equal((await readUntil(socket, () => 12))[3], 2);
	}
	assert.equal(dials, 0);
});

test("SOCKS handles public IPv4 and IPv6 literals without DNS and rejects non-HTTPS in limited mode", async (t) => {
	const port = await listen(t, createServer((socket) => socket.pipe(socket)));
	const targets: NetworkProxyTarget[] = [];
	const proxy = await lease(t, { domains: [PUBLIC_ADDRESS, "2606:4700:4700::1111"],
		lookup: async () => { throw new Error("Literal must not resolve"); },
		connect: (target) => { targets.push(target); return createConnection({ host: "127.0.0.1", port }); } });
	for (const address of [Buffer.from([1, 93, 184, 216, 34]), Buffer.from("0426064700470000000000000000001111", "hex")]) {
		const socket = await client(t, proxy);
		socket.write(Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0]), address, Buffer.from([1, 187])]));
		assert.equal((await readUntil(socket, () => 12))[3], 0);
	}
	assert.deepEqual(targets.map((value) => value.address), [PUBLIC_ADDRESS, "2606:4700:4700::1111"]);
	const limited = await lease(t, { policy: LIMITED_PROXY, connect: () => { throw new Error("Forbidden dial"); } });
	const socket = await client(t, limited);
	socket.write(Buffer.concat([Buffer.from([5, 1, 0]), socksDomain("api.example.com", 80)]));
	assert.equal((await readUntil(socket, () => 12))[3], 2);
});

test("closing during a partial SOCKS handshake releases the pending setup", async (t) => {
	const proxy = await lease(t);
	const socket = await client(t, proxy); socket.write(Buffer.from([5]));
	const closed = new Promise<void>((resolve) => socket.once("close", () => resolve())); socket.resume();
	await proxy.close(); await closed;
});

test("a slowly streamed partial HTTP header cannot extend the absolute setup deadline", { timeout: 15000 }, async (t) => {
	const proxy = await lease(t);
	const socket = await client(t, proxy);
	const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
	socket.write("GET http://api.example.com/");
	const timer = setInterval(() => socket.write("x"), 100);
	t.after(() => clearInterval(timer));
	socket.resume();
	await closed;
	clearInterval(timer);
	assert.equal(socket.destroyed, true);
});
