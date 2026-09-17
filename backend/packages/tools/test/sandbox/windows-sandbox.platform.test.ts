import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createSocket } from "node:dgram";
import { createConnection, createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { executionPolicy, type ExecutionPolicy } from "../../src/policy/execution-policy.ts";
import { inspectSandboxReadiness, packagedWindowsSandboxHelper } from "../../src/sandbox/sandbox-readiness.ts";
import { runSandboxRecovery } from "../../src/sandbox/sandbox-recovery.ts";
import { resolveShellProfile } from "../../src/shell/shell-profile.ts";
import { ShellSessionManager, type ShellSessionSnapshot } from "../../src/shell/shell-session-manager.ts";
import { ShellTool } from "../../src/shell/shell-tool.ts";
import { startNodePtyTransport } from "../../src/shell/node-pty-transport.ts";
import { startPipeTransport } from "../../src/shell/pipe-transport.ts";
import type { ToolAdapterResult } from "../../src/types.ts";
import { startNetworkProxy, type NetworkProxyLease } from "../../src/network/network-proxy.ts";

const windows = { skip: process.platform !== "win32", timeout: 60_000 };
const runFile = promisify(execFile);

test("Windows real Shell preserves stdio, environment and Unicode paths", windows, async (t) => {
	const fixture = await createFixture(t);
	const result = await fixture.run(["stdio"]);
	assertExit(result, 0);
	assert.match(result.modelOutput, /env:mycli-sandbox-test/u);
	assert.match(result.modelOutput, /stderr:ok/u);
	const target = join(fixture.root, "中文 filename.txt");
	assertExit(await fixture.run(["write", target]), 0);
	assertExit(await fixture.run(["read", target]), 0);
	assert.equal(await readFile(target, "utf8"), "sandbox-write");
});

test("Windows private parents permit path resolution without exposing sibling contents", windows, async (t) => {
	const parent = await mkdtemp(join(tmpdir(), "mycli-private-parent-"));
	t.after(() => rm(parent, { force: true, recursive: true }));
	const owner = await runFile("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
	const sid = owner.stdout.match(/S-1-5-[\d-]+/u)?.[0];
	assert.ok(sid);
	await runFile("icacls.exe", [parent, "/inheritance:r", "/grant:r",
		`*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"]);
	const sibling = join(parent, "private-sibling.txt");
	await writeFile(sibling, "private");
	const fixture = await createFixture(t, { parent });
	assertExit(await fixture.run(["stdio"]), 0);
	assertExit(await fixture.run(["read", sibling]), 23);
	assertExit(await fixture.run(["list", parent]), 23);
});

test("Windows real Shell enforces read-only, empty and narrowed write allowlists", windows, async (t) => {
	const fixture = await createFixture(t);
	const allowed = join(fixture.root, "allowed");
	await mkdir(allowed);
	assertExit(await fixture.run(["write", join(allowed, "positive.txt")]), 0);
	const target = join(fixture.root, "denied.txt");
	for (const policy of [
		executionPolicy("read-only", fixture.root),
		{ ...executionPolicy("read-only", fixture.root), network: "enabled" as const },
		{ ...fixture.policy, writableRoots: [] },
		{ ...fixture.policy, writableRoots: [allowed] },
	]) {
		assertExit(await fixture.run(["write", target], { policy }), 23);
	}
	assertExit(await fixture.run(["write", join(allowed, "narrow.txt")], {
		policy: { ...fixture.policy, writableRoots: [allowed] },
	}), 0);
	await assert.rejects(readFile(target), { code: "ENOENT" });
});

test("Windows real Shell blocks outside writes, junction escapes and protected metadata", windows, async (t) => {
	const fixture = await createFixture(t);
	const outside = await mkdtemp(join(tmpdir(), "mycli-sandbox-outside-"));
	t.after(() => rm(outside, { force: true, recursive: true }));
	await symlink(outside, join(fixture.root, "escape"), "junction");
	assertExit(await fixture.run(["write", join(outside, "blocked.txt")]), 23);
	assertExit(await fixture.run(["write", join(fixture.root, "escape", "blocked.txt")]), 23);
	for (const name of [".git", ".agents", ".codex"]) {
		const directory = join(fixture.root, name);
		await mkdir(directory);
		const existing = join(directory, "readable-metadata");
		await writeFile(existing, "metadata");
		assertExit(await fixture.run(["write", join(directory, "config")]), 23);
		assertExit(await fixture.run(["read", existing]), 0);
	}
	await assert.rejects(readFile(join(outside, "blocked.txt")), { code: "ENOENT" });
});

test("Windows online and offline Shells keep independent IPv4, IPv6 and UDP policies", windows, async (t) => {
	const fixture = await createFixture(t);
	for (const host of ["127.0.0.1", "::1"]) {
		let connections = 0;
		const server = createServer((socket) => { connections += 1; socket.end(); });
		server.listen(0, host);
		await once(server, "listening");
		t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const args = ["connect", host, String(address.port)];
		assertExit(await fixture.run(args), 0);
		const results = await Promise.all([
			fixture.run(args),
			fixture.run(args, { policy: { ...fixture.policy, network: "disabled" } }),
		]);
		assertExit(results[0]!, 0);
		assertExit(results[1]!, 37);
		assertExit(await fixture.run(args), 0);
		assert.equal(connections, 3);

		const udp = createSocket(host.includes(":") ? "udp6" : "udp4");
		udp.bind(0, host);
		await once(udp, "listening");
		t.after(() => new Promise<void>((resolve) => udp.close(() => resolve())));
		const received = once(udp, "message");
		const datagram = ["udp", host, String(udp.address().port)];
		assertExit(await fixture.run(datagram), 0);
		await received;
		assertExit(await fixture.run(datagram, { policy: { ...fixture.policy, network: "disabled" } }), 37);
	}
});

test("Windows sandbox ConPTY supports input, resize and completion", windows, async (t) => {
	const fixture = await createFixture(t);
	const result = await fixture.run(["echo"], { tty: true, yieldTimeMs: 500 });
	assert.equal(result.success, true, result.modelOutput);
	const id = result.metadata?.shell_id;
	assert.equal(typeof id, "string");
	if (typeof id !== "string") throw new Error("missing shell id");
	assert.equal((await fixture.manager.resize(fixture.owner, id, 30, 100)).success, true);
	let output = result.modelOutput;
	let snapshot = await fixture.manager.interact({ ownerSessionId: fixture.owner, shellId: id,
		chars: "hello-sandbox\r\n", yieldTimeMs: 5_000, signal: t.signal });
	output += snapshot.output;
	while (snapshot.terminalState === undefined) {
		snapshot = await fixture.manager.interact({ ownerSessionId: fixture.owner, shellId: id,
			chars: "", yieldTimeMs: 5_000, signal: t.signal });
		output += snapshot.output;
	}
	assert.equal(snapshot.exitCode, 0, output);
	assert.match(output, /input:hello-sandbox/u);
});

test("Windows domain proxy blocks direct egress and other running Shells' proxy ports", windows, async (t) => {
	let hits = 0;
	const origin = createHttpServer((_request, response) => { hits += 1; response.end("allowed"); });
	origin.listen(0, "127.0.0.1");
	await once(origin, "listening");
	t.after(() => new Promise<void>((resolve) => { origin.closeAllConnections(); origin.close(() => resolve()); }));
	const address = origin.address();
	assert.ok(address && typeof address !== "string");
	const proxies: NetworkProxyLease[] = [];
	const fixture = await createFixture(t, { networkProxyFactory: async (domains) => {
		const proxy = await startNetworkProxy({ domains,
			lookup: async () => [{ address: "93.184.216.34", family: 4 }],
			connect: () => createConnection({ host: "127.0.0.1", port: address.port }),
		});
		proxies.push(proxy);
		return proxy;
	} });
	t.after(async () => { await Promise.all(proxies.map((proxy) => proxy.close())); });
	const policy = { ...fixture.policy, networkDomains: ["api.example.com"] };
	assertExit(await fixture.run(["proxy", "http://api.example.com/"], { policy }), 0);
	assert.equal(hits, 1);
	assertExit(await fixture.run(["proxy", "http://denied.example.com/"], { policy }), 44);
	assert.equal(hits, 1);
	assertExit(await fixture.run(["connect", "127.0.0.1", String(address.port)], { policy }), 37);
	assertExit(await fixture.run(["udp", "127.0.0.1", String(address.port)], { policy }), 37);
	const held = await fixture.run(["proxy-hold", "http://api.example.com/"], { policy, yieldTimeMs: 500 });
	const firstProxy = proxies.at(-1);
	assert.ok(firstProxy);
	const id = held.metadata?.shell_id;
	assert.equal(typeof id, "string");
	if (typeof id !== "string") throw new Error("missing held shell id");
	let output = held.modelOutput;
	while (!output.includes("proxy:200:allowed")) {
		const snapshot = await fixture.manager.interact({ ownerSessionId: fixture.owner, shellId: id,
			chars: "", yieldTimeMs: 1_000, signal: t.signal });
		output += snapshot.output;
		assert.ok(snapshot.terminalState === undefined || output.includes("proxy:200:allowed"), output);
	}
	assertExit(await fixture.run(["connect", "127.0.0.1", String(firstProxy.port)], { policy }), 37);
	await fixture.manager.terminate(fixture.owner, id);
	const socket = createConnection({ host: "127.0.0.1", port: firstProxy.port });
	try { await assert.rejects(once(socket, "connect"), { code: "ECONNREFUSED" }); }
	finally { socket.destroy(); }
	assert.equal(hits, 2);
});

test("Windows sandbox kills descendants on exit, stop and owner shutdown", windows, async (t) => {
	const fixture = await createFixture(t);
	for (const action of ["exit", "stop", "shutdown"] as const) {
		const target = join(fixture.root, `${action}-leak.txt`);
		const result = await fixture.run([action === "exit" ? "tree-exit" : "tree", target], { yieldTimeMs: 500 });
		assert.equal(result.success, true, result.modelOutput);
		const id = result.metadata?.shell_id;
		assert.equal(typeof id, "string");
		if (typeof id !== "string") throw new Error("missing shell id");
		let output = result.modelOutput;
		while (!output.includes("descendant:")) {
			const snapshot = await fixture.manager.interact({ ownerSessionId: fixture.owner, shellId: id,
				chars: "", yieldTimeMs: 1_000, signal: t.signal });
			output += snapshot.output;
			assert.ok(snapshot.terminalState === undefined || output.includes("descendant:"), output);
		}
		if (action === "stop") await fixture.manager.terminate(fixture.owner, id);
		if (action === "shutdown") await fixture.manager.close();
		await delay(3_000, undefined, { signal: t.signal });
		await assert.rejects(readFile(target), { code: "ENOENT" });
	}
});

test("Windows denied reads block content and replacement, then reconcile a removed policy", windows, async (t) => {
	const fixture = await createFixture(t);
	const secret = join(fixture.root, ".env");
	await writeFile(secret, "private-sentinel");
	const policy = { ...fixture.policy, deniedReadGlobs: ["**/.env"] };
	for (const operation of ["read", "write", "replace"]) {
		const result = await fixture.run([operation, secret], { policy });
		assertExit(result, 23);
		assert.doesNotMatch(result.modelOutput, /private-sentinel/u);
	}
	assert.equal(await readFile(secret, "utf8"), "private-sentinel");
	assertExit(await fixture.run(["read", secret]), 0);
});

test("Windows active commands prevent a concurrent denied-read policy downgrade", windows, async (t) => {
	const fixture = await createFixture(t);
	const secret = join(fixture.root, "readable.txt");
	const policy = { ...fixture.policy, deniedReadRoots: [secret] };
	const held = await fixture.run(["hold"], { policy, yieldTimeMs: 500 });
	const id = held.metadata?.shell_id;
	assert.equal(typeof id, "string", held.modelOutput);
	if (typeof id !== "string") throw new Error("missing held shell id");
	let output = held.modelOutput;
	while (!output.includes("hold:ready")) {
		const snapshot = await fixture.manager.interact({ ownerSessionId: fixture.owner, shellId: id,
			chars: "", yieldTimeMs: 1_000, signal: t.signal });
		output += snapshot.output;
		assert.ok(snapshot.terminalState === undefined || output.includes("hold:ready"), output);
	}
	assertExit(await fixture.run(["read", secret], { policy }), 23);
	const downgrade = await fixture.run(["read", secret]);
	assertExit(downgrade, 1);
	assert.match(downgrade.modelOutput, /policy changed/u);
	await fixture.manager.terminate(fixture.owner, id);
	assertExit(await fixture.run(["read", secret]), 0);
});

test("Windows audit closes a public write grant outside the writable roots", windows, async (t) => {
	const parent = await mkdtemp(join(tmpdir(), "mycli-public-audit-"));
	t.after(() => rm(parent, { force: true, recursive: true }));
	const outside = join(parent, "public");
	await mkdir(outside);
	await runFile("icacls.exe", [outside, "/grant", "*S-1-1-0:(OI)(CI)M"]);
	const fixture = await createFixture(t, { parent, env: { TEMP: parent, TMP: parent } });
	assertExit(await fixture.run(["write", join(outside, "blocked.txt")]), 23);
	await assert.rejects(readFile(join(outside, "blocked.txt")), { code: "ENOENT" });
});

test("Windows setup reset safely rebuilds all identities on the next real Shell", {
	...windows, skip: process.platform !== "win32" || process.env.MYCLI_WINDOWS_SANDBOX_SETUP_TESTS !== "1",
	timeout: 180_000,
}, async (t) => {
	const reset = await runSandboxRecovery("reset", true);
	assert.equal(reset.code, "reset_completed");
	assert.equal((await inspectSandboxReadiness()).state, "setup_required");
	// Validation must fail before UAC/setup and before any requested command runs.
	await assert.rejects(runFile(packagedWindowsSandboxHelper(), ["--request-json", "{}"]));
	assert.equal((await inspectSandboxReadiness()).state, "setup_required");
	const fixture = await createFixture(t, { requireReady: false });
	assertExit(await fixture.run(["stdio"]), 0);
	assertExit(await fixture.run(["stdio"], { policy: { ...fixture.policy, network: "disabled" } }), 0);
	assert.equal((await inspectSandboxReadiness()).state, "ready");
});

test("Windows repair and uninstall verify account and state cleanup on disposable hosts", {
	...windows, skip: process.platform !== "win32" || process.env.MYCLI_WINDOWS_SANDBOX_MAINTENANCE_TESTS !== "1", timeout: 240_000,
}, async () => {
	assert.equal((await runSandboxRecovery("repair", false)).status, "confirmation_required");
	assert.equal((await runSandboxRecovery("repair", true)).code, "repair_completed");
	assert.equal((await runSandboxRecovery("uninstall", true)).code, "uninstall_completed");
	assert.equal((await inspectSandboxReadiness()).managedStatePresent, false);
	assert.equal((await runSandboxRecovery("uninstall", true)).code, "uninstall_completed");
	assert.equal((await runSandboxRecovery("setup", true)).code, "setup_completed");
});

interface Fixture {
	readonly root: string;
	readonly owner: string;
	readonly policy: ExecutionPolicy;
	readonly manager: ShellSessionManager;
	run(args: readonly string[], options?: { readonly policy?: ExecutionPolicy;
		readonly tty?: boolean; readonly yieldTimeMs?: number }): Promise<ToolAdapterResult>;
}

interface FixtureOptions {
	readonly requireReady?: boolean;
	readonly parent?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly networkProxyFactory?: (domains: readonly string[]) => Promise<NetworkProxyLease>;
}

async function createFixture(t: TestContext, options: FixtureOptions = {}): Promise<Fixture> {
	if (options.requireReady !== false) {
		assert.equal((await inspectSandboxReadiness()).state, "ready",
			"Build the Windows helper and run mycli sandbox setup --confirm before the platform tests.");
	}
	const root = await mkdtemp(join(options.parent ?? tmpdir(), "mycli sandbox 中文 "));
	const child = join(root, "child.mjs");
	await copyFile(new URL("../fixtures/windows-sandbox-child.mjs", import.meta.url), child);
	await writeFile(join(root, "readable.txt"), "fixture");
	const owner = root;
	const manager = new ShellSessionManager({
		transportFactory: (request) => request.tty ? startNodePtyTransport(request) : startPipeTransport(request),
	});
	t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
	const tool = new ShellTool({ workspaceRoot: root, manager, timeoutSeconds: 30,
		profile: resolveShellProfile({ platform: "win32", shellPath: "powershell.exe" }),
		env: { ...process.env, ...options.env, LANG: "mycli-sandbox-test" },
		...(options.networkProxyFactory ? { networkProxyFactory: options.networkProxyFactory } : {}),
	});
	const policy = executionPolicy("workspace", root);
	let sequence = 0;
	return { root, owner, policy, manager, run: async (args, options = {}) => {
		const result = await tool.execute({
			command: `& ${[process.execPath, child, ...args].map(psQuote).join(" ")}; exit $LASTEXITCODE`,
			tty: options.tty ?? false, yield_time_ms: options.yieldTimeMs ?? 30_000,
		}, { signal: t.signal, ownerSessionId: owner, callId: `windows-${sequence++}`,
			publishLifecycle: () => undefined, executionPolicy: options.policy ?? policy });
		return result;
	} };
}

function psQuote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

function assertExit(result: ToolAdapterResult | ShellSessionSnapshot, code: number): void {
	if ("modelOutput" in result) {
		assert.equal(result.metadata?.exit_code, code, result.modelOutput);
	} else {
		assert.equal(result.exitCode, code, result.output);
	}
}
