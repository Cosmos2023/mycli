import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import test, { type TestContext } from "node:test";
import { createProxyCertificates } from "../../src/network/proxy-certificates.ts";
import type { NetworkProxyLease } from "../../src/network/network-proxy.ts";
import { lease, listen, client, readUntil, socksDomain, connectTunnel, request, LIMITED_PROXY } from "../support/network-proxy.ts";

async function secureClient(t: TestContext, proxy: NetworkProxyLease, socks = false, servername = "api.example.com"): Promise<Socket> {
	const socket = await client(t, proxy);
	if (socks) {
		socket.write(Buffer.concat([Buffer.from([5, 1, 0]), socksDomain("api.example.com")]));
		assert.equal((await readUntil(socket, () => 12))[3], 0);
	} else await connectTunnel(socket);
	const secure = tlsConnect({ socket, servername, ca: await readFile(proxy.env.NODE_EXTRA_CA_CERTS!), ALPNProtocols: ["http/1.1"] });
	t.after(() => secure.destroy());
	await once(secure, "secureConnect", { signal: AbortSignal.timeout(5000) });
	return secure;
}

test("limited HTTPS asks for the decrypted request only, never for forbidden methods or tunnel setup", async (t) => {
	const certificates = await createProxyCertificates(); t.after(() => certificates.close());
	const context = await certificates.context("api.example.com");
	const port = await listen(t, https.createServer({ SNICallback: (_name, callback) => callback(null, context) }, (_req, res) => res.end("ok")));
	const methods: string[] = [];
	let dials = 0;
	const proxy = await lease(t, { policy: { ...LIMITED_PROXY, approvalDomains: ["api.example.com"] },
		originCa: await readFile(certificates.bundlePath),
		connect: () => { dials++; return createConnection({ host: "127.0.0.1", port }); },
		requestApproval: async (details) => { methods.push(details.method!); return "approve_once"; } });
	for (const socks of [false, true]) {
		const socket = await secureClient(t, proxy, socks);
		assert.equal(methods.length, socks ? 1 : 0);
		assert.equal((await request(proxy, "GET", socket)).status, 200);
		assert.equal((await request(proxy, "POST", await secureClient(t, proxy, socks))).status, 403);
	}
	assert.deepEqual(methods, ["GET", "GET"]); assert.equal(dials, 2);
});

test("limited HTTP forwards GET/HEAD/OPTIONS and rejects writes before origin contact", async (t) => {
	const received: string[] = [];
	const port = await listen(t, http.createServer((req, res) => { received.push(req.method!); res.end("ok"); }));
	const proxy = await lease(t, { policy: LIMITED_PROXY, connect: () => createConnection({ host: "127.0.0.1", port }) });
	for (const method of ["GET", "HEAD", "OPTIONS"]) assert.equal((await request(proxy, method)).status, 200);
	for (const method of ["POST", "PUT", "DELETE", "PATCH", "TRACE"]) assert.equal((await request(proxy, method)).status, 403);
	assert.deepEqual(received, ["GET", "HEAD", "OPTIONS"]);
});

test("limited HTTPS actually inspects methods for CONNECT and SOCKS and verifies origin TLS", async (t) => {
	const certificates = await createProxyCertificates(); t.after(() => certificates.close());
	let context = await certificates.context("api.example.com");
	const received: string[] = [];
	const port = await listen(t, https.createServer({ SNICallback: (_name, callback) => callback(null, context) }, (req, res) => {
		received.push(`${req.method} ${req.headers.host} ${req.url}`); res.end("secure origin");
	}));
	let dials = 0;
	const options = { policy: LIMITED_PROXY, originCa: await readFile(certificates.bundlePath),
		connect: () => { dials += 1; return createConnection({ host: "127.0.0.1", port }); } };
	const proxy = await lease(t, options);
	for (const socks of [false, true]) {
		for (const method of ["GET", "HEAD", "OPTIONS", "POST", "DELETE"]) {
			const socket = await secureClient(t, proxy, socks);
			const response = await request(proxy, method, socket);
			assert.equal(response.status, ["POST", "DELETE"].includes(method) ? 403 : 200);
		}
	}
	assert.equal(dials, 6);
	assert.deepEqual(received, Array.from({ length: 2 }, () => ["GET", "HEAD", "OPTIONS"].map((method) => `${method} api.example.com /resource?q=1`)).flat());
	const untrusted = await lease(t, { ...options, originCa: undefined });
	assert.equal((await request(untrusted, "GET", await secureClient(t, untrusted))).status, 502);
	assert.equal(received.length, 6);
	context = await certificates.context("outside.test");
	assert.equal((await request(proxy, "GET", await secureClient(t, proxy))).status, 502);
	assert.equal(received.length, 6);
});

test("limited HTTPS composes with an HTTP upstream proxy without direct fallback", async (t) => {
	const certificates = await createProxyCertificates(); t.after(() => certificates.close());
	const context = await certificates.context("api.example.com");
	const port = await listen(t, https.createServer({ SNICallback: (_name, callback) => callback(null, context) }, (_req, res) => res.end("proxied TLS")));
	const upstream = http.createServer();
	let tunnels = 0;
	upstream.on("connect", (req, socket, head) => {
		assert.equal(req.url, "93.184.216.34:443"); tunnels += 1;
		const remote = createConnection({ host: "127.0.0.1", port });
		remote.on("error", () => socket.destroy());
		socket.once("close", () => remote.destroy()); remote.once("close", () => socket.destroy());
		remote.once("connect", () => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) remote.write(head);
			socket.pipe(remote); remote.pipe(socket);
		});
	});
	const upstreamPort = await listen(t, upstream);
	const proxy = await lease(t, { policy: { ...LIMITED_PROXY, allowUpstreamProxy: true },
		sourceEnv: { HTTPS_PROXY: `http://127.0.0.1:${upstreamPort}` }, originCa: await readFile(certificates.bundlePath),
		connect: () => { throw new Error("Direct fallback is forbidden"); } });
	assert.deepEqual(await request(proxy, "GET", await secureClient(t, proxy)), { status: 200, body: "proxied TLS" });
	assert.equal((await request(proxy, "POST", await secureClient(t, proxy))).status, 403);
	assert.equal(tunnels, 1);
});

test("limited HTTPS rejects mismatched SNI/Host, nested tunnels, upgrades and non-origin request targets", async (t) => {
	let dials = 0;
	const proxy = await lease(t, { policy: LIMITED_PROXY, connect: () => { dials += 1; throw new Error("Forbidden dial"); } });
	await assert.rejects(secureClient(t, proxy, false, "outside.test"));
	assert.equal((await request(proxy, "GET", await secureClient(t, proxy), "outside.test")).status, 400);
	for (const raw of [
		"CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com\r\n\r\n",
		"GET / HTTP/1.1\r\nHost: api.example.com\r\nConnection: upgrade\r\nUpgrade: websocket\r\n\r\n",
		"GET https://api.example.com/ HTTP/1.1\r\nHost: api.example.com\r\n\r\n",
		"GET //outside.test/ HTTP/1.1\r\nHost: outside.test\r\n\r\n",
	]) {
		const socket = await secureClient(t, proxy); socket.write(raw);
		assert.match((await readUntil(socket, (bytes) => bytes.indexOf("\r\n\r\n") + 4)).toString(), /^HTTP\/1.1 40[03]/u);
	}
	assert.equal(dials, 0);
});

test("each limited lease owns a public-only trust bundle removed on close", async (t) => {
	const first = await lease(t, { policy: LIMITED_PROXY });
	const second = await lease(t, { policy: LIMITED_PROXY });
	const path = first.env.NODE_EXTRA_CA_CERTS!;
	assert.notEqual(path, second.env.NODE_EXTRA_CA_CERTS);
	assert.deepEqual(first.readableRoots, [path]);
	assert.equal(first.env.CURL_CA_BUNDLE, path);
	assert.equal(first.env.REQUESTS_CA_BUNDLE, path);
	assert.doesNotMatch(await readFile(path, "utf8"), /PRIVATE KEY/u);
	await first.close(); await first.close();
	await assert.rejects(stat(path), { code: "ENOENT" });
	await stat(second.env.NODE_EXTRA_CA_CERTS!);
	const socket = await secureClient(t, second);
	const closed = once(socket, "close"); socket.resume();
	await second.close(); await closed;
});
