import assert from "node:assert/strict";
import { once } from "node:events";
import * as http from "node:http";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import test, { type TestContext } from "node:test";
import {
	startNetworkProxy,
	type NetworkProxyLease,
	type NetworkProxyOptions,
	type NetworkProxyTarget,
} from "../../src/network/network-proxy.ts";

const PUBLIC_ADDRESS = "93.184.216.34";

test("proxy forwards HTTP bodies to pinned addresses and strips hop and proxy headers", async (t) => {
	const received: { url?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
	const upstream = http.createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += String(chunk);
		received.push({ url: request.url, headers: request.headers, body });
		response.writeHead(201, { connection: "x-hop", "x-hop": "remove", "x-result": "kept" });
		response.end("uploaded");
	});
	const port = await listen(t, upstream);
	const targets: NetworkProxyTarget[] = [];
	const domains = ["api.example.com"];
	const proxy = await lease(t, {
		domains,
		connect: (target) => { targets.push(target); return createConnection({ host: "127.0.0.1", port }); },
	});
	domains.push("denied.example.com");
	const result = await request(proxy, "http://api.example.com/upload?q=1", {
		method: "POST", body: "content", headers: {
			connection: "x-hop", "x-hop": "remove", "proxy-authorization": "private-proxy-value",
			authorization: "resource-authorization", "content-length": "7",
		},
	});
	assert.equal(result.status, 201);
	assert.equal(result.body, "uploaded");
	assert.equal(result.headers["x-hop"], undefined);
	assert.equal(result.headers["x-result"], "kept");
	assert.deepEqual(targets, [{ address: PUBLIC_ADDRESS, family: 4, port: 80 }]);
	assert.equal(received[0]?.url, "/upload?q=1");
	assert.equal(received[0]?.body, "content");
	assert.equal(received[0]?.headers.host, "api.example.com");
	assert.equal(received[0]?.headers["proxy-authorization"], undefined);
	assert.equal(received[0]?.headers["x-hop"], undefined);
	assert.equal(received[0]?.headers.authorization, "resource-authorization");
	assert.equal((await request(proxy, "http://denied.example.com/")).status, 403);
	assert.equal(targets.length, 1);
});

test("proxy checks wildcard hosts and redirected destinations on every request", async (t) => {
	let hits = 0;
	const upstream = http.createServer((_request, response) => {
		hits += 1;
		response.writeHead(302, { location: "http://outside.test/target" });
		response.end();
	});
	const port = await listen(t, upstream);
	const proxy = await lease(t, {
		domains: ["*.example.com"],
		connect: () => createConnection({ host: "127.0.0.1", port }),
	});
	const redirect = await request(proxy, "http://deep.api.example.com/");
	assert.equal(redirect.status, 302);
	assert.equal((await request(proxy, redirect.headers.location!)).status, 403);
	assert.equal((await request(proxy, "http://example.com/")).status, 403);
	assert.equal((await request(proxy, "http://example.com.evil.test/")).status, 403);
	assert.equal(hits, 1);
});

test("proxy rejects unsafe DNS answers and never dials unchecked targets", async (t) => {
	let dials = 0;
	for (const addresses of [
		[{ address: "127.0.0.1", family: 4 }],
		[{ address: PUBLIC_ADDRESS, family: 4 }, { address: "10.0.0.1", family: 4 }],
		[{ address: "169.254.169.254", family: 4 }],
		[{ address: "::ffff:7f00:1", family: 6 }],
		[{ address: "fc00::1", family: 6 }],
	]) {
		const proxy = await lease(t, {
			domains: ["api.example.com"], lookup: async () => addresses,
			connect: () => { dials += 1; throw new Error("unexpected dial"); },
		});
		assert.equal((await request(proxy, "http://api.example.com/")).status, 403);
		await proxy.close();
	}
	assert.equal(dials, 0);
});

test("proxy denies malformed targets, credentials, host disagreement, private literals and unsupported ports", async (t) => {
	let lookups = 0;
	const proxy = await lease(t, {
		domains: ["api.example.com", "127.0.0.1", "localhost", "service.local"],
		lookup: async () => { lookups += 1; return [{ address: PUBLIC_ADDRESS, family: 4 }]; },
		connect: () => { throw new Error("unexpected dial"); },
	});
	for (const url of [
		"http://outside.test/", "http://user:password@api.example.com/", "http://api.example.com:8080/",
		"https://api.example.com/", "ftp://api.example.com/", "http://127.0.0.1/",
		"http://2130706433/", "http://localhost/", "http://service.local/", "http://api.example.com/#fragment",
	]) {
		const result = await request(proxy, url);
		assert.ok(result.status >= 400, `${url}: ${result.status}`);
		assert.doesNotMatch(result.body, /password/u);
	}
	assert.equal((await request(proxy, "http://api.example.com/", { headers: { host: "outside.test" } })).status, 400);
	assert.equal((await request(proxy, "http://api.example.com/", { headers: { expect: "100-continue" } })).status, 417);
	assert.equal(lookups, 0);
	const malformed = await rawRequest(t, proxy, "GET http://api.example.com/ HTTP/1.1\r\nHost: api.example.com\r\nHost: outside.test\r\n\r\n");
	assert.match(malformed, /^HTTP\/1.1 400/u);
	const empty = await lease(t, { domains: [] });
	assert.equal((await request(empty, "http://api.example.com/")).status, 403);
});

test("CONNECT checks authority, preserves tunnel bytes and pins port 443", async (t) => {
	const echo = createServer((socket) => socket.pipe(socket));
	const port = await listen(t, echo);
	const targets: NetworkProxyTarget[] = [];
	const proxy = await lease(t, {
		domains: ["api.example.com"],
		connect: (target) => { targets.push(target); return createConnection({ host: "127.0.0.1", port }); },
	});
	const client = createConnection({ host: "127.0.0.1", port: proxy.port });
	t.after(() => client.destroy());
	await once(client, "connect");
	client.write("CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\ninitial-bytes");
	const first = await readUntil(client, (text) => text.endsWith("initial-bytes"));
	assert.equal(first, "HTTP/1.1 200 Connection Established\r\n\r\ninitial-bytes");
	client.write("more-bytes");
	assert.equal(await readUntil(client, (text) => text === "more-bytes"), "more-bytes");
	assert.deepEqual(targets, [{ address: PUBLIC_ADDRESS, family: 4, port: 443 }]);
	const closed = once(client, "close");
	await proxy.close();
	await closed;
	assert.equal(client.destroyed, true);
	await proxy.close();
});

test("CONNECT rejects forbidden domains, alternate ports, credentialed targets and upgrades", async (t) => {
	let dials = 0;
	const proxy = await lease(t, {
		domains: ["api.example.com"],
		connect: () => { dials += 1; throw new Error("unexpected dial"); },
	});
	for (const authority of ["outside.test:443", "api.example.com:22", "user@api.example.com:443", "api.example.com/path:443"]) {
		const text = await rawRequest(t, proxy, `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
		assert.match(text, /^HTTP\/1.1 40[03]/u);
	}
	const upgraded = await rawRequest(t, proxy,
		"GET http://api.example.com/ HTTP/1.1\r\nHost: api.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
	assert.match(upgraded, /^HTTP\/1.1 400/u);
	assert.equal(dials, 0);
});

test("closing a proxy cancels pending resolution and cannot open a late upstream connection", async (t) => {
	let resolveLookup: (value: { address: string; family: number }[]) => void = () => undefined;
	let started: () => void = () => undefined;
	const lookupStarted = new Promise<void>((resolve) => { started = resolve; });
	let dials = 0;
	const proxy = await lease(t, {
		domains: ["api.example.com"],
		lookup: () => { started(); return new Promise((resolve) => { resolveLookup = resolve; }); },
		connect: () => { dials += 1; throw new Error("unexpected dial"); },
	});
	const pending = request(proxy, "http://api.example.com/").catch(() => undefined);
	await lookupStarted;
	await proxy.close();
	resolveLookup([{ address: PUBLIC_ADDRESS, family: 4 }]);
	await pending;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(dials, 0);
});

test("independent proxy leases cannot broaden or revoke each other's authority", async (t) => {
	const upstream = http.createServer((_request, response) => response.end("ok"));
	const port = await listen(t, upstream);
	const connect = (): Socket => createConnection({ host: "127.0.0.1", port });
	const first = await lease(t, { domains: ["first.example.com"], connect });
	const second = await lease(t, { domains: ["second.example.com"], connect });
	assert.notEqual(first.port, second.port);
	assert.equal((await request(first, "http://second.example.com/")).status, 403);
	assert.equal((await request(second, "http://first.example.com/")).status, 403);
	await first.close();
	assert.equal((await request(second, "http://second.example.com/")).body, "ok");
});

async function lease(t: TestContext, options: NetworkProxyOptions): Promise<NetworkProxyLease> {
	const proxy = await startNetworkProxy({ lookup: async () => [{ address: PUBLIC_ADDRESS, family: 4 }], ...options });
	t.after(() => proxy.close());
	return proxy;
}

async function listen(t: TestContext, server: Server): Promise<number> {
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return address.port;
}

interface ProxyResponse {
	readonly status: number;
	readonly headers: http.IncomingHttpHeaders;
	readonly body: string;
}

async function request(proxy: NetworkProxyLease, url: string, options: {
	readonly method?: string;
	readonly body?: string;
	readonly headers?: http.OutgoingHttpHeaders;
} = {}): Promise<ProxyResponse> {
	return new Promise((resolve, reject) => {
		const req = http.request({
			host: "127.0.0.1", port: proxy.port, path: url, method: options.method ?? "GET",
			agent: false, headers: { host: new URL(url).host, ...options.headers },
			signal: AbortSignal.timeout(5_000),
		}, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => { body += chunk; });
			response.once("error", reject);
			response.once("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
		});
		req.once("error", reject);
		req.end(options.body);
	});
}

async function rawRequest(t: TestContext, proxy: NetworkProxyLease, raw: string): Promise<string> {
	const client = createConnection({ host: "127.0.0.1", port: proxy.port });
	t.after(() => client.destroy());
	await once(client, "connect");
	client.write(raw);
	return readUntil(client, (text) => text.includes("\r\n\r\n"));
}

async function readUntil(socket: Socket, complete: (text: string) => boolean): Promise<string> {
	return new Promise((resolve, reject) => {
		let text = "";
		const timer = setTimeout(() => { cleanup(); reject(new Error("Timed out reading proxy response")); }, 5_000);
		const cleanup = (): void => {
			clearTimeout(timer);
			socket.removeListener("data", onData);
			socket.removeListener("error", onError);
		};
		const onError = (error: Error): void => { cleanup(); reject(error); };
		const onData = (chunk: Buffer): void => {
			text += chunk.toString();
			if (complete(text)) { cleanup(); resolve(text); }
		};
		socket.on("data", onData);
		socket.once("error", onError);
	});
}
