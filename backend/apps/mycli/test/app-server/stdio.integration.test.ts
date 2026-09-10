import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DEFAULT_GATEWAY_LIMITS, GatewayClient } from "@mycli/gateway";
import { runCli } from "../../src/cli.ts";
import { runStdioAppServer } from "../../src/app-server/stdio.ts";
import { startSupervisedNodeBackend } from "../../src/node-runtime/node-backend-supervisor.ts";
import { fakeHeadlessBackend } from "../support/headless-backend.ts";

test("stdio app-server serves the real supervised backend and shuts down over RPC", { timeout: 20_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-app-server-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(join(home, ".mycli"), { recursive: true });
	await mkdir(workspace);
	await writeFile(join(home, ".mycli", "config.toml"), "[updates]\ncheck_on_startup = false\n");
	const input = new PassThrough();
	const output = new PassThrough();
	const errors: string[] = [];
	const hooks = new EventEmitter();
	const running = runCli({
		argv: ["app-server", "--session", "stdio-session"], cwd: workspace,
		env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH },
		stdin: input, stdout: output, stderr: { write: (text) => errors.push(text) }, processHooks: hooks,
		importTui: async () => assert.fail("app-server must not start the TUI"),
	});
	const client = new GatewayClient({ input: output, output: input });
	t.after(async () => { client.stop(); input.end(); await running; });
	client.start();
	await client.waitForEvent("runtime.ready");
	const bootstrap = await client.request("session.bootstrap", { protocol_version: 1 });
	assert.equal(bootstrap.session_id, "stdio-session");
	assert.equal(bootstrap.workspace, workspace);
	const history = await client.request("transcript.load", {});
	assert.deepEqual(history.items, []);
	await assert.rejects(client.send("permissions.update", { profile: "invalid" }), (error: unknown) => (
		typeof error === "object" && error !== null && "code" in error && error.code === "invalid_params"
	));
	client.expectClose();
	assert.deepEqual(await client.request("shutdown", {}), { ok: true });
	assert.equal(await running, 0, errors.join(""));
	assert.equal(hooks.listenerCount("SIGINT"), 0);
});

test("real coordinator drains replies after a paused consumer resumes and preserves shutdown", { timeout: 20_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-gateway-slow-consumer-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(join(home, ".mycli"), { recursive: true });
	await mkdir(workspace);
	await writeFile(join(home, ".mycli", "config.toml"), "[updates]\ncheck_on_startup = false\n");
	const backend = await startSupervisedNodeBackend({
		cwd: workspace, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH }, args: ["--session", "slow-session"],
	});
	const client = new GatewayClient(backend.transport);
	t.after(async () => { client.stop(); await backend.close(); await rm(root, { recursive: true, force: true }); });
	let replies = 0;
	const pending = Array.from({ length: 32 }, () => client.request("session.bootstrap", { protocol_version: 1 }).then((result) => {
		replies++; return result;
	}));
	await delay(100);
	assert.equal(replies, 0);
	const buffered = backend.transport.input as PassThrough;
	assert.ok(buffered.readableLength > 0);
	client.start();
	const results = await Promise.all(pending);
	assert.equal(results.length, 32);
	assert.ok(results.every((result) => result.session_id === "slow-session"));
	client.expectClose();
	assert.deepEqual(await client.request("shutdown", {}), { ok: true });
	assert.equal(await backend.completion, 0);
});

test("stdio EOF waits for the final destination write before detaching the pipe", async () => {
	const fake = fakeHeadlessBackend();
	const input = new PassThrough();
	let unblock!: () => void;
	let firstWrite!: () => void;
	const writing = new Promise<void>((resolve) => { firstWrite = resolve; });
	const chunks: string[] = [];
	const output = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, callback): void {
		chunks.push(chunk.toString());
		if (chunks.length === 1) { unblock = callback; firstWrite(); }
		else callback();
	} });
	let exited = false;
	const running = runStdioAppServer({
		cwd: "/repo", env: {}, args: [], input, output, processHooks: new EventEmitter(),
		stderr: { write: assert.fail }, startBackend: () => fake.backend,
	}).then((code) => { exited = true; return code; });
	await writing;
	input.end(`${JSON.stringify({ jsonrpc: "2.0", id: "last", method: "probe", params: {} })}\n`);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(exited, false);
	unblock();
	assert.equal(await running, 0);
	assert.ok(chunks.some((chunk) => chunk.includes('"id":"last"')));
	assert.equal(output.writableEnded, false);
	output.destroy();
});

test("stdio drain timeout reports failure and removes listeners from a stalled destination", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const fake = fakeHeadlessBackend();
	const input = new PassThrough();
	let firstWrite!: () => void;
	const writing = new Promise<void>((resolve) => { firstWrite = resolve; });
	const output = new Writable({ highWaterMark: 1, write(): void { firstWrite(); } });
	t.after(() => output.destroy());
	const running = runStdioAppServer({
		cwd: "/repo", env: {}, args: [], input, output, processHooks: new EventEmitter(),
		stderr: { write: assert.fail }, startBackend: () => fake.backend,
	});
	await writing;
	input.end();
	await new Promise<void>((resolve) => setImmediate(resolve));
	t.mock.timers.tick(DEFAULT_GATEWAY_LIMITS.writeStallTimeoutMs);
	assert.equal(await running, 1);
	assert.equal(fake.closed(), true);
	assert.equal(output.listenerCount("error"), 0);
	assert.equal(input.listenerCount("error"), 0);
});

test("stdio EOF and termination close the backend and release stream listeners", async (t) => {
	for (const scenario of ["eof", "SIGINT", "SIGTERM"] as const) {
		await t.test(scenario, async () => {
			const fake = fakeHeadlessBackend();
			const input = new PassThrough();
			const output = new PassThrough();
			const hooks = new EventEmitter();
			const running = runStdioAppServer({ cwd: "/repo", env: {}, args: [], input, output,
				stderr: { write: () => assert.fail("unexpected error") }, processHooks: hooks, startBackend: () => fake.backend });
			await new Promise<void>((resolve) => setImmediate(resolve));
			if (scenario === "eof") input.end();
			else hooks.emit(scenario);
			assert.equal(await running, { eof: 0, SIGINT: 130, SIGTERM: 143 }[scenario]);
			assert.equal(fake.closed(), true);
			assert.equal(input.listenerCount("error"), 0);
			assert.equal(output.listenerCount("error"), 0);
			assert.equal(hooks.listenerCount("SIGTERM"), 0);
		});
	}
});

test("stdio signal during startup terminates the owned Worker", { timeout: 5_000 }, async () => {
	const hooks = new EventEmitter();
	const running = runStdioAppServer({ cwd: process.cwd(), env: {}, args: [], input: new PassThrough(), output: new PassThrough(),
		stderr: { write: () => assert.fail("unexpected error") }, processHooks: hooks,
		startBackend: (options) => startSupervisedNodeBackend({ ...options,
			workerUrl: new URL("../fixtures/node-backend-stalled-start-worker.mjs", import.meta.url) }),
	});
	hooks.emit("SIGTERM");
	assert.equal(await running, 143);
});

test("stdio failure diagnostics are bounded and a broken output closes the backend", async () => {
	const errors: string[] = [];
	const failed = await runStdioAppServer({ cwd: "/repo", env: {}, args: [],
		input: new PassThrough(), output: new PassThrough(), processHooks: new EventEmitter(),
		stderr: { write: (text) => errors.push(text) }, startBackend: () => { throw new Error("private startup value"); } });
	assert.equal(failed, 1);
	assert.doesNotMatch(errors.join(""), /private/);
	const fake = fakeHeadlessBackend();
	const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("EPIPE")); } });
	const code = await runStdioAppServer({ cwd: "/repo", env: {}, args: [], input: new PassThrough(), output,
		processHooks: new EventEmitter(), stderr: { write: () => {} }, startBackend: () => fake.backend });
	assert.equal(code, 1);
	assert.equal(fake.closed(), true);
});

test("already closed stdio never starts a backend", async () => {
	const input = new PassThrough();
	input.destroy();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(await runStdioAppServer({ cwd: "/repo", env: {}, args: [], input, output: new PassThrough(),
		processHooks: new EventEmitter(), stderr: { write: () => {} }, startBackend: () => assert.fail("closed connection started") }), 0);
	const output = new PassThrough();
	output.end();
	assert.equal(await runStdioAppServer({ cwd: "/repo", env: {}, args: [], input: new PassThrough(), output,
		processHooks: new EventEmitter(), stderr: { write: () => {} }, startBackend: () => assert.fail("closed connection started") }), 1);
});
