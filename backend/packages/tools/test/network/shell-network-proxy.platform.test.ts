import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { executionPolicy, resolveShellProfile, ShellSessionManager, ShellTool } from "../../src/index.ts";
import { startNetworkProxy, type NetworkProxyLease } from "../../src/network/network-proxy.ts";
import type { ToolAdapterResult } from "../../src/types.ts";

const macOS = { skip: process.platform !== "darwin", timeout: 15_000 };

test("macOS Shell reaches allowed HTTP through its owned proxy and rejects denied hosts", macOS, async (t) => {
	const fixture = await shellFixture(t);
	const result = await fixture.run("/usr/bin/curl --fail --silent --show-error --max-time 3 http://api.example.com/");
	assert.equal(result.success, true, result.modelOutput);
	assert.match(result.modelOutput, /proxy-fixture/u);
	assert.equal(fixture.hits(), 1);
	await assertClosed(fixture.proxy());
	const denied = await fixture.run("/usr/bin/curl --fail --silent --show-error --max-time 3 http://denied.example.com/");
	assert.equal(denied.success, false);
	assert.equal(fixture.hits(), 1);
});

test("macOS Shell carries HTTPS through CONNECT with client-side certificate validation", macOS, async (t) => {
	const fixture = await shellFixture(t, true);
	const result = await fixture.run(`/usr/bin/curl --fail --silent --show-error --max-time 3 --cacert ${quote(join(fixture.root, "fixture.crt"))} https://api.example.com/`);
	assert.equal(result.success, true, result.modelOutput);
	assert.match(result.modelOutput, /proxy-fixture/u);
	assert.equal(fixture.hits(), 1);
	await assertClosed(fixture.proxy());
});

test("macOS denies proxy bypass, foreign proxy ports, UDP and Unix socket egress", macOS, async (t) => {
	const fixture = await shellFixture(t);
	const ignored = await fixture.run(`/usr/bin/curl --noproxy '*' --silent --show-error --max-time 3 http://127.0.0.1:${fixture.originPort}/`);
	assert.equal(ignored.success, false);
	assert.equal(fixture.hits(), 0);
	const foreign = await startNetworkProxy({ domains: ["foreign.example.com"] });
	t.after(() => foreign.close());
	const other = await fixture.run(`/usr/bin/curl --proxy http://127.0.0.1:${foreign.port} --silent --show-error --max-time 3 http://foreign.example.com/`);
	assert.equal(other.success, false);
	const socketPath = join(fixture.root, "bypass.sock");
	let unixConnections = 0;
	const local = createServer((socket) => { unixConnections += 1; socket.end(); });
	local.listen(socketPath);
	await once(local, "listening");
	t.after(() => new Promise<void>((resolve) => local.close(() => resolve())));
	for (const code of [
		`const s = require("node:net").createConnection({ host: "93.184.216.34", port: 443 }); s.on("connect", () => process.exit(1)); s.on("error", e => { console.log(e.code); process.exit(e.code === "EPERM" ? 0 : 2); });`,
		`const s = require("node:net").createConnection({ path: ${JSON.stringify(socketPath)} }); s.on("connect", () => process.exit(1)); s.on("error", e => { console.log(e.code); process.exit(e.code === "EPERM" ? 0 : 2); });`,
		`const s = require("node:dgram").createSocket("udp4"); const done = e => { console.log(e?.code); process.exit(e?.code === "EPERM" ? 0 : 1); }; s.on("error", done); s.send("probe", ${fixture.originPort}, "127.0.0.1", done);`,
	]) {
		const denied = await fixture.run(`${quote(process.execPath)} -e ${quote(code)}`);
		assert.equal(denied.success, true, denied.modelOutput);
		assert.match(denied.modelOutput, /EPERM/u);
	}
	assert.equal(unixConnections, 0);
	assert.equal(fixture.hits(), 0);
});

test("a yielded macOS Shell keeps its proxy until actual exit and revokes it on stop", macOS, async (t) => {
	const fixture = await shellFixture(t);
	const result = await fixture.run("/usr/bin/curl --fail --silent --max-time 3 http://api.example.com/; /bin/sleep 0.8; /usr/bin/curl --fail --silent --max-time 3 http://api.example.com/", 250);
	assert.equal(result.success, true, result.modelOutput);
	assert.equal(fixture.manager.list("proxy-session")[0]?.status, "running");
	const firstProxy = fixture.proxy();
	await assertOpen(firstProxy);
	await until(() => fixture.manager.list("proxy-session")[0]?.status === "exited");
	assert.equal(fixture.hits(), 2);
	await assertClosed(firstProxy);
	const running = await fixture.run("/bin/sleep 30", 250);
	assert.equal(running.success, true);
	const session = fixture.manager.list("proxy-session").find((entry) => entry.status === "running");
	assert.ok(session);
	const secondProxy = fixture.proxy();
	await assertOpen(secondProxy);
	await fixture.manager.terminate("proxy-session", session.shellId);
	await assertClosed(secondProxy);
});

async function shellFixture(t: TestContext, tls = false): Promise<{
	readonly root: string;
	readonly originPort: number;
	readonly manager: ShellSessionManager;
	readonly proxy: () => NetworkProxyLease;
	readonly hits: () => number;
	readonly run: (command: string, yieldTimeMs?: number) => Promise<ToolAdapterResult>;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-network-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let hits = 0;
	const respond: http.RequestListener = (_request, response) => { hits += 1; response.end("proxy-fixture"); };
	let origin: http.Server | https.Server;
	if (tls) {
		await promisify(execFile)("/usr/bin/openssl", [
			"req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
			"-subj", "/CN=api.example.com", "-keyout", join(root, "fixture.key"), "-out", join(root, "fixture.crt"),
		], { timeout: 10_000 });
		origin = https.createServer({ key: await readFile(join(root, "fixture.key")), cert: await readFile(join(root, "fixture.crt")) }, respond);
	} else {
		origin = http.createServer(respond);
	}
	origin.listen(0, "127.0.0.1");
	await once(origin, "listening");
	t.after(() => new Promise<void>((resolve) => { origin.closeAllConnections(); origin.close(() => resolve()); }));
	const address = origin.address();
	assert.ok(address && typeof address !== "string");
	const manager = new ShellSessionManager();
	t.after(async () => { await manager.close(); });
	const leases: NetworkProxyLease[] = [];
	t.after(async () => { await Promise.all(leases.map((proxy) => proxy.close())); });
	const tool = new ShellTool({
		workspaceRoot: root, manager, timeoutSeconds: 5,
		profile: resolveShellProfile({ platform: "darwin", shellPath: "/bin/sh" }),
		env: { PATH: "/usr/bin:/bin", HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", NO_PROXY: "*" },
		networkProxyFactory: async (domains) => {
			const proxy = await startNetworkProxy({
				domains,
				lookup: async () => [{ address: "93.184.216.34", family: 4 }],
				connect: () => createConnection({ host: "127.0.0.1", port: address.port }),
			});
			leases.push(proxy);
			return proxy;
		},
	});
	let sequence = 0;
	return {
		root, originPort: address.port, manager,
		proxy: () => { const proxy = leases.at(-1); assert.ok(proxy); return proxy; },
		hits: () => hits,
		run: (command, yieldTimeMs = 5_000) => tool.execute({ command, yield_time_ms: yieldTimeMs }, {
			signal: new AbortController().signal, ownerSessionId: "proxy-session", callId: `proxy-${sequence++}`,
			publishLifecycle: () => undefined,
			executionPolicy: { ...executionPolicy("workspace", root), network: "enabled", networkDomains: ["api.example.com"] },
		}),
	};
}

async function assertOpen(proxy: NetworkProxyLease): Promise<void> {
	const socket = createConnection({ host: "127.0.0.1", port: proxy.port });
	try { await once(socket, "connect"); } finally { socket.destroy(); }
}

async function assertClosed(proxy: NetworkProxyLease): Promise<void> {
	const socket = createConnection({ host: "127.0.0.1", port: proxy.port });
	try {
		await assert.rejects(once(socket, "connect"), { code: "ECONNREFUSED" });
	} finally { socket.destroy(); }
}

async function until(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, "Shell did not exit before deadline");
		await delay(20);
	}
}

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
