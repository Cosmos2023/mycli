import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { NetworkAccessDetails } from "@mycli/contracts";
import { createProxyCertificates } from "../../src/network/proxy-certificates.ts";
import { startNetworkProxy, type NetworkProxyLease } from "../../src/network/network-proxy.ts";
import { executionPolicy, type ExecutionPolicy } from "../../src/policy/execution-policy.ts";
import { inspectSandboxReadiness } from "../../src/sandbox/sandbox-readiness.ts";
import { startPipeTransport } from "../../src/shell/pipe-transport.ts";
import { ShellSessionManager } from "../../src/shell/shell-session-manager.ts";
import { ShellTool, type ShellToolOptions } from "../../src/shell/shell-tool.ts";
import { resolveShellProfile } from "../../src/shell/shell-profile.ts";
import type { ToolAdapterResult } from "../../src/types.ts";

const readiness = process.platform === "win32" ? await inspectSandboxReadiness() : undefined;
const windows = { skip: process.platform !== "win32", timeout: 90_000 };
// Limited mode needs PSEC public-CA read grants and the per-port loopback option is PSEC-only;
// the legacy backend rejects both by design.
const psec = { ...windows, skip: readiness?.isolation !== "windows_psec" };
const OWNER = "windows-network-session";
const FULL = { mode: "full" as const, enableSocks5: true, allowUpstreamProxy: false };
const LIMITED = { mode: "limited" as const, enableSocks5: true, allowUpstreamProxy: false };

test("a real sandboxed Windows Shell waits for one network approval after yield and stop revokes pending access", windows, async (t) => {
	const fixture = await windowsShellFixture(t, { approval: true });
	const policy = { ...fixture.policy, networkDomains: ["api.example.com"],
		networkProxy: { ...FULL, approvalDomains: ["api.example.com"] } };
	const first = await fixture.run(["proxy", "http://api.example.com/"], { policy, yieldTimeMs: 1_000 });
	assert.equal(first.success, true, first.modelOutput);
	await fixture.prompted.promise;
	assert.equal(fixture.hits(), 0, "the origin must not be reached while approval is pending");
	assert.equal(runningShells(fixture).length, 1, "the Shell keeps running while it waits for approval");
	fixture.gate.resolve("approve_once");
	await until(() => runningShells(fixture).length === 0);
	assert.equal(fixture.hits(), 1);

	fixture.reset();
	await fixture.run(["proxy", "http://api.example.com/"], { policy, yieldTimeMs: 1_000 });
	const signal = await fixture.prompted.promise;
	const running = runningShells(fixture)[0];
	assert.ok(running, "expected the second request to wait for approval");
	await fixture.manager.terminate(fixture.owner, running.shellId);
	assert.equal(signal.aborted, true, "stopping the Shell must cancel the pending decision");
	fixture.gate.resolve("approve_once");
	await delay(200);
	assert.equal(fixture.hits(), 1, "a decision arriving after cancellation must not reach the origin");
});

test("a real sandboxed Windows Shell reaches an allowed host over SOCKS5 and refuses a denied host", windows, async (t) => {
	const fixture = await windowsShellFixture(t);
	const policy = { ...fixture.policy, networkDomains: ["api.example.com"], networkProxy: FULL };
	const allowed = await fixture.run(["proxy-socks", "http://api.example.com/"], { policy });
	assert.equal(allowed.success, true, allowed.modelOutput);
	assert.match(allowed.modelOutput, /proxy:200:windows-network-fixture/u);
	assert.equal(fixture.hits(), 1);
	const denied = await fixture.run(["proxy-socks", "http://denied.example.com/"], { policy });
	assert.equal(denied.success, false, denied.modelOutput);
	assert.equal(fixture.hits(), 1, "a denied host must never reach the origin");
});

test("a real sandboxed Windows Shell takes upstream proxy settings from host authority", windows, async (t) => {
	const fixtures = await upstreamFixture(t);
	const fixture = await windowsShellFixture(t, { upstream: fixtures.upstreamUrl, defaultProxyFactory: true });
	const environment = await fixture.run(["proxy-env"]);
	assert.equal(environment.success, true, environment.modelOutput);
	assert.doesNotMatch(environment.modelOutput, /example-user|example-password|untrusted-child/u,
		"the child environment must not carry host upstream settings");
	const policy = { ...fixture.policy, networkDomains: ["93.184.216.34"],
		networkProxy: { ...FULL, allowUpstreamProxy: true } };
	const result = await fixture.run(["proxy", "http://93.184.216.34/"], { policy });
	assert.equal(result.success, true, result.modelOutput);
	assert.match(result.modelOutput, /proxy:200:upstream-origin/u);
	assert.equal(fixtures.tunnels(), 1);
});

test("a real sandboxed Windows Shell uses scoped CA trust for limited HTTPS and blocks writes", psec, async (t) => {
	const fixture = await windowsShellFixture(t, { tls: true, limited: true });
	const policy = { ...fixture.policy, networkDomains: ["api.example.com"], networkProxy: LIMITED };
	const get = await fixture.run(["proxy-https", "https://api.example.com/"], { policy });
	assert.equal(get.success, true, get.modelOutput);
	assert.match(get.modelOutput, /proxy:200:windows-network-fixture/u);
	assert.equal(fixture.hits(), 1);
	const bundle = fixture.proxy().readableRoots?.[0];
	assert.ok(bundle, "limited mode must declare the public bundle as a readable root");
	assert.equal(bundle, fixture.proxy().env.NODE_EXTRA_CA_CERTS);
	const post = await fixture.run(["proxy-post", "https://api.example.com/"], { policy });
	assert.equal(post.success, false, post.modelOutput);
	assert.match(post.modelOutput, /proxy:403/u);
	assert.equal(fixture.hits(), 1, "a blocked method must never reach the origin");
	await fixture.proxy().close();
	await assert.rejects(readFile(bundle), { code: "ENOENT" }, "closing the lease removes the bundle");
});

test("a real sandboxed Windows Shell reaches only the loopback ports its policy lists", psec, async (t) => {
	const fixture = await windowsShellFixture(t);
	let listedConnections = 0;
	let unlistedConnections = 0;
	const listed = createServer((socket) => { listedConnections += 1; socket.end(); });
	const unlisted = createServer((socket) => { unlistedConnections += 1; socket.end(); });
	listed.listen(0, "127.0.0.1");
	unlisted.listen(0, "127.0.0.1");
	await Promise.all([once(listed, "listening"), once(unlisted, "listening")]);
	t.after(() => new Promise<void>((resolve) => { listed.close(); unlisted.close(() => resolve()); }));
	const listedPort = portOf(listed);
	const unlistedPort = portOf(unlisted);
	const policy = { ...fixture.policy, networkDomains: ["api.example.com"],
		networkProxy: FULL, loopbackPorts: [listedPort] };
	assertExit(await fixture.run(["connect", "127.0.0.1", String(listedPort)], { policy }), 0);
	assert.equal(listedConnections, 1, "a listed loopback port must accept the sandboxed connection");
	assertExit(await fixture.run(["connect", "127.0.0.1", String(unlistedPort)], { policy }), 37);
	assert.equal(unlistedConnections, 0, "an unlisted loopback port must stay blocked");
});

interface WindowsShellFixture {
	readonly root: string;
	readonly owner: string;
	readonly policy: ExecutionPolicy;
	readonly manager: ShellSessionManager;
	gate: PromiseWithResolvers<"approve_once">;
	prompted: PromiseWithResolvers<AbortSignal>;
	readonly hits: () => number;
	readonly proxy: () => NetworkProxyLease;
	readonly reset: () => void;
	readonly run: (args: readonly string[], options?: { readonly policy?: ExecutionPolicy;
		readonly yieldTimeMs?: number }) => Promise<ToolAdapterResult>;
}

async function windowsShellFixture(t: TestContext, options: {
	readonly approval?: boolean;
	readonly tls?: boolean;
	readonly limited?: boolean;
	readonly upstream?: string;
	readonly defaultProxyFactory?: boolean;
} = {}): Promise<WindowsShellFixture> {
	assert.equal((await inspectSandboxReadiness()).state, "ready",
		"Run mycli sandbox setup --confirm before the Windows network platform tests.");
	const root = await mkdtemp(join(tmpdir(), "mycli windows network "));
	const child = join(root, "child.mjs");
	await copyFile(new URL("../fixtures/windows-sandbox-child.mjs", import.meta.url), child);
	let hits = 0;
	const certificates = options.tls ? await createProxyCertificates() : undefined;
	if (certificates) t.after(() => certificates.close());
	const respond = (_request: unknown, response: { end(value: string): void }): void => {
		hits += 1;
		response.end("windows-network-fixture");
	};
	const origin = options.tls
		? createHttpsServer({ SNICallback: (_name, callback) => { void certificates!.context("api.example.com").then((context) => callback(null, context)); } }, respond)
		: createHttpServer(respond);
	origin.listen(0, "127.0.0.1");
	await once(origin, "listening");
	t.after(() => new Promise<void>((resolve) => { origin.closeAllConnections(); origin.close(() => resolve()); }));
	const address = origin.address();
	assert.ok(address && typeof address !== "string");
	const leases: NetworkProxyLease[] = [];
	t.after(async () => { await Promise.all(leases.map((proxy) => proxy.close())); });
	const manager = new ShellSessionManager({ transportFactory: startPipeTransport });
	t.after(async () => {
		await manager.close();
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	});
	const networkProxyFactory: NonNullable<ShellToolOptions["networkProxyFactory"]> = async (domains, policy, interaction) => {
		const proxy = await startNetworkProxy({ domains, policy, ...interaction,
			...(options.limited && certificates ? { originCa: await readFile(certificates.bundlePath) } : {}),
			lookup: async () => [{ address: "93.184.216.34", family: 4 }],
			connect: () => createConnection({ host: "127.0.0.1", port: address.port }) });
		leases.push(proxy);
		return proxy;
	};
	const tool = new ShellTool({ workspaceRoot: root, manager, timeoutSeconds: 30,
		profile: resolveShellProfile({ platform: "win32", shellPath: "powershell.exe" }),
		env: { ...process.env, LANG: "mycli-network-test",
			...(options.upstream ? { HTTP_PROXY: "http://untrusted-child.invalid" } : {}) },
		...(options.upstream ? { networkProxySourceEnv: { HTTP_PROXY: options.upstream } } : {}),
		...(options.approval ? { networkProxyInteraction: () => ({
			requestApproval: async (details: NetworkAccessDetails, signal: AbortSignal) => {
				assert.equal(details.host, "api.example.com");
				fixture.prompted.resolve(signal);
				return fixture.gate.promise;
			} }) } : {}),
		...(options.defaultProxyFactory ? {} : { networkProxyFactory }) });
	const owner = OWNER;
	const policy = executionPolicy("workspace", root);
	let sequence = 0;
	const fixture: WindowsShellFixture = {
		root, owner, policy, manager,
		gate: Promise.withResolvers<"approve_once">(),
		prompted: Promise.withResolvers<AbortSignal>(),
		hits: () => hits,
		proxy: () => { const proxy = leases.at(-1); assert.ok(proxy); return proxy; },
		reset: () => { fixture.gate = Promise.withResolvers<"approve_once">(); fixture.prompted = Promise.withResolvers<AbortSignal>(); },
		run: (args, runOptions = {}) => tool.execute({
			command: `& ${[process.execPath, child, ...args].map(psQuote).join(" ")}; exit $LASTEXITCODE`,
			yield_time_ms: runOptions.yieldTimeMs ?? 30_000,
		}, { signal: t.signal, ownerSessionId: owner, callId: `windows-network-${sequence++}`,
			publishLifecycle: () => undefined, executionPolicy: runOptions.policy ?? policy }),
	};
	return fixture;
}

async function upstreamFixture(t: TestContext): Promise<{ readonly upstreamUrl: string; readonly tunnels: () => number }> {
	let tunnels = 0;
	const origin = createHttpServer((_request, response) => response.end("upstream-origin"));
	const upstream = createHttpServer();
	upstream.on("connect", (request, socket) => {
		tunnels += 1;
		assert.equal(request.url, "93.184.216.34:80");
		assert.equal(request.headers["proxy-authorization"], `Basic ${Buffer.from("example-user:example-password").toString("base64")}`);
		socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		origin.emit("connection", socket);
	});
	origin.listen(0, "127.0.0.1");
	await once(origin, "listening");
	upstream.listen(0, "127.0.0.1");
	await once(upstream, "listening");
	t.after(() => new Promise<void>((resolve) => { origin.closeAllConnections(); origin.close(); upstream.close(() => resolve()); }));
	const address = upstream.address();
	assert.ok(address && typeof address !== "string");
	return { upstreamUrl: `http://example-user:example-password@127.0.0.1:${address.port}`, tunnels: () => tunnels };
}

function runningShells(fixture: WindowsShellFixture): ReturnType<ShellSessionManager["list"]> {
	return fixture.manager.list(fixture.owner).filter((entry) => entry.status === "running");
}

async function until(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, "the sandboxed Shell did not exit before the deadline");
		await delay(50);
	}
}

function psQuote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

function portOf(server: Server): number {
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return address.port;
}

function assertExit(result: ToolAdapterResult, code: number): void {
	assert.equal(result.metadata?.exit_code, code, result.modelOutput);
}
