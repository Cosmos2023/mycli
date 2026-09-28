import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import { createServer, type Socket } from "node:net";
import test from "node:test";
import { createProxyCertificates } from "../../src/network/proxy-certificates.ts";
import { upstreamProxyFromEnvironment } from "../../src/network/proxy-transport.ts";
import { lease, listen, client, connectTunnel, readUntil, request, socksDomain, PUBLIC_ADDRESS, FULL_PROXY } from "../support/network-proxy.ts";

const UPSTREAM = Object.freeze({ ...FULL_PROXY, allowUpstreamProxy: true });

test("HTTP upstream sees pinned targets and host-only credentials for HTTP, CONNECT and SOCKS", async (t) => {
	const targets: string[] = [];
	const authorizations: (string | undefined)[] = [];
	const originHeaders: http.IncomingHttpHeaders[] = [];
	const origin = http.createServer((req, res) => { originHeaders.push(req.headers); res.end("through upstream"); });
	t.after(() => { origin.close(); });
	const upstream = http.createServer();
	upstream.on("connect", (req, socket, head) => {
		targets.push(req.url!); authorizations.push(req.headers["proxy-authorization"]);
		socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (req.url!.endsWith(":80")) {
			if (head.length) socket.unshift(head);
			origin.emit("connection", socket);
		} else { if (head.length) socket.write(head); socket.pipe(socket); }
	});
	const port = await listen(t, upstream);
	let directDials = 0;
	const env = { HTTP_PROXY: `http://example-user:example-password@127.0.0.1:${port}`, NO_PROXY: "*" };
	const proxy = await lease(t, { policy: UPSTREAM, sourceEnv: env,
		connect: () => { directDials += 1; throw new Error("Must not dial directly"); } });
	env.HTTP_PROXY = "http://invalid.example";
	assert.deepEqual(await request(proxy), { status: 200, body: "through upstream" });
	const socket = await client(t, proxy); await connectTunnel(socket);
	socket.write("tunneled"); assert.equal((await readUntil(socket, () => 8)).toString(), "tunneled");
	const socks = await client(t, proxy);
	socks.write(Buffer.concat([Buffer.from([5, 1, 0]), socksDomain("api.example.com", 9418), Buffer.from("git")]));
	assert.equal((await readUntil(socks, () => 12))[3], 0);
	assert.equal((await readUntil(socks, () => 3)).toString(), "git");
	assert.deepEqual(targets, [80, 443, 9418].map((value) => `${PUBLIC_ADDRESS}:${value}`));
	assert.deepEqual(authorizations, Array(3).fill(`Basic ${Buffer.from("example-user:example-password").toString("base64")}`));
	assert.equal(originHeaders[0]?.["proxy-authorization"], undefined);
	assert.equal(originHeaders[0]?.host, "api.example.com");
	assert.equal(directDials, 0);
	assert.equal(proxy.env.NO_PROXY, "");
	assert.doesNotMatch(JSON.stringify(proxy.env), /example-user|example-password/u);
	assert.equal((await request(proxy, "GET", undefined, "outside.test")).status, 403);
	assert.equal(targets.length, 3);
});

test("TLS upstream validates its certificate and target credentials remain on the encrypted hop", async (t) => {
	const certificates = await createProxyCertificates(); t.after(() => certificates.close());
	let context = await certificates.context("localhost");
	let tunnels = 0;
	const upstream = https.createServer({ SNICallback: (_name, callback) => callback(null, context) });
	upstream.on("connect", (req, socket) => {
		assert.equal(req.url, `${PUBLIC_ADDRESS}:443`); tunnels += 1;
		socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); socket.pipe(socket);
	});
	const port = await listen(t, upstream);
	const sourceEnv = { HTTPS_PROXY: `https://localhost:${port}` };
	const trusted = await lease(t, { policy: UPSTREAM, sourceEnv, upstreamCa: await readFile(certificates.bundlePath) });
	const socket = await client(t, trusted); await connectTunnel(socket);
	socket.write("TLS"); assert.equal((await readUntil(socket, () => 3)).toString(), "TLS");
	const untrusted = await lease(t, { policy: UPSTREAM, sourceEnv });
	await assert.rejects(connectTunnel(await client(t, untrusted)), /HTTP/u);
	assert.equal(tunnels, 1);
	context = await certificates.context("outside.test");
	await assert.rejects(connectTunnel(await client(t, trusted)), /HTTP/u);
	assert.equal(tunnels, 1);
});

test("upstream refusal, oversized headers and disconnect never fall back or expose credentials", async (t) => {
	let directDials = 0;
	for (const response of ["HTTP/1.1 407 Authentication Required\r\n\r\n", "not HTTP\r\n\r\n", `HTTP/1.1 200 OK\r\nX: ${"a".repeat(16384)}\r\n\r\n`, ""]) {
		const port = await listen(t, createServer((socket) => socket.once("data", () => socket.end(response))));
		const proxy = await lease(t, { policy: UPSTREAM, sourceEnv: { HTTP_PROXY: `http://example-user:example-password@127.0.0.1:${port}` },
			connect: () => { directDials += 1; throw new Error("Must not fallback"); } });
		const result = await request(proxy);
		assert.equal(result.status, 502); assert.doesNotMatch(result.body, /example-user|example-password|127\.0\.0\.1/u);
	}
	assert.equal(directDials, 0);
});

test("closing during an upstream handshake cancels pending work", async (t) => {
	let accepted!: (socket: Socket) => void;
	const ready = new Promise<Socket>((resolve) => { accepted = resolve; });
	const port = await listen(t, createServer((socket) => socket.once("data", () => accepted(socket))));
	const proxy = await lease(t, { policy: UPSTREAM, sourceEnv: { HTTP_PROXY: `http://127.0.0.1:${port}` } });
	const pending = request(proxy).catch(() => undefined);
	const upstream = await ready;
	const closed = new Promise<void>((resolve) => upstream.once("close", () => resolve())); upstream.resume();
	await proxy.close(); await pending; await closed;
});

test("upstream configuration is opt-in, sanitized, and protocol-specific", async (t) => {
	for (const raw of ["socks5://localhost:8080", "http://localhost:0/invalid", "http://user:%0Asecret@localhost", "broken"]) {
		assert.throws(() => upstreamProxyFromEnvironment({ HTTP_PROXY: raw }, false), /^NetworkProxyError: Invalid upstream proxy configuration\.$/u);
	}
	assert.equal(upstreamProxyFromEnvironment({ http_proxy: "http://first.test", HTTP_PROXY: "http://second.test" }, false)?.hostname, "first.test");
	assert.equal(upstreamProxyFromEnvironment({ HTTPS_PROXY: "https://secure.test", HTTP_PROXY: "http://plain.test" }, true)?.hostname, "secure.test");
	await lease(t, { sourceEnv: { HTTP_PROXY: "broken" } });
});
