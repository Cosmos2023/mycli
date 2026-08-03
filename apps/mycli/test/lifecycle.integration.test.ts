import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { GatewayTransport } from "mycli-shell-tui/gateway-transport";
import { runCli } from "../src/cli.ts";
import { startPythonSidecar, type StartPythonSidecarOptions } from "../src/sidecar/python-sidecar.ts";

const stallingFixture = fileURLToPath(new URL("./fixtures/stalling-sidecar.mjs", import.meta.url));
const crashingFixture = fileURLToPath(new URL("./fixtures/crashing-sidecar.mjs", import.meta.url));
const normalFixture = fileURLToPath(new URL("./fixtures/fake-sidecar.mjs", import.meta.url));
const parentHarness = fileURLToPath(new URL("./fixtures/parent-exit-harness.mjs", import.meta.url));

test("readiness timeout exits nonzero and removes the sidecar", async () => {
	await withTempDirectory(async (directory) => {
		const pidFile = join(directory, "sidecar.pid");
		let transport: GatewayTransport | null = null;
		const result = await runFixture(stallingFixture, {
			env: { MYCLI_FIXTURE_PID_FILE: pidFile },
			configureTransport: (value) => { transport = value; },
			importTui: async () => ({ gatewayStartup: waitForReady(() => transport, 50) }),
		});

		assert.equal(result.code, 1);
		assert.match(result.stderr, /\[REDACTED\]/);
		assert.doesNotMatch(result.stderr, /stalling-secret/);
		assert.ok(Buffer.byteLength(result.stderr) < 9 * 1024);
		await assertPidStops(await readPid(pidFile));
	});
});

test("crash before handshake exits one with bounded diagnostics", async () => {
	await withTempDirectory(async (directory) => {
		const pidFile = join(directory, "sidecar.pid");
		let transport: GatewayTransport | null = null;
		const result = await runFixture(crashingFixture, {
			env: { MYCLI_FIXTURE_PID_FILE: pidFile },
			configureTransport: (value) => { transport = value; },
			importTui: async () => ({ gatewayStartup: waitForReady(() => transport, 1_000) }),
		});

		assert.equal(result.code, 1);
		assert.match(result.stderr, /\[REDACTED\]/);
		assert.doesNotMatch(result.stderr, /crashing-secret/);
		assert.ok(Buffer.byteLength(result.stderr) < 9 * 1024);
		await assertPidStops(await readPid(pidFile));
	});
});

test("crash after handshake closes the runtime and exits one", async () => {
	let transport: GatewayTransport | null = null;
	const result = await runFixture(crashingFixture, {
		env: { MYCLI_FIXTURE_CRASH_PHASE: "after-ready" },
		configureTransport: (value) => { transport = value; },
		importTui: async () => ({ gatewayStartup: waitForReady(() => transport, 1_000) }),
	});

	assert.equal(result.code, 1);
	assert.doesNotMatch(result.stdout, /crashing-secret|Authorization|Bearer/);
});

test("normal shutdown returns zero without mixing stderr into protocol stdout", async () => {
	let transport: GatewayTransport | null = null;
	const result = await runFixture(normalFixture, {
		configureTransport: (value) => { transport = value; },
		importTui: async () => ({
			gatewayStartup: (async () => {
				await waitForReady(() => transport, 1_000);
				transport?.output.write('{"jsonrpc":"2.0","id":"1","method":"shutdown","params":{}}\n');
				await transport?.close?.();
			})(),
		}),
	});

	assert.equal(result.code, 0);
	assert.doesNotMatch(result.stdout, /stderr|api_key|Bearer/);
});

test("SIGTERM requests shutdown and escalates within the lifecycle bound", async () => {
	await withTempDirectory(async (directory) => {
		const pidFile = join(directory, "sidecar.pid");
		const hooks = new EventEmitter();
		let transport: GatewayTransport | null = null;
		const startedAt = Date.now();
		const running = runFixture(stallingFixture, {
			hooks,
			env: {
				MYCLI_FIXTURE_PID_FILE: pidFile,
				MYCLI_FIXTURE_IGNORE_SIGTERM: "1",
				MYCLI_FIXTURE_FAILSAFE_MS: "7000",
			},
			configureTransport: (value) => { transport = value; },
			importTui: async () => ({
				gatewayStartup: Promise.resolve(),
				gatewayShutdown: async () => { await transport?.close?.(); },
			}),
		});
		await waitForFile(pidFile, 1_000);
		hooks.emit("SIGTERM");
		const result = await running;

		assert.equal(result.code, 0);
		assert.ok(Date.now() - startedAt < 6_500);
		await assertPidStops(await readPid(pidFile));
	});
});

test("abnormal parent exit leaves no probeable sidecar PID", async () => {
	await withTempDirectory(async (directory) => {
		const pidFile = join(directory, "sidecar.pid");
		const parent = spawn(process.execPath, ["--import", "tsx", parentHarness], {
			cwd: process.cwd(),
			env: {
				...process.env,
				MYCLI_FIXTURE_PATH: stallingFixture,
				MYCLI_FIXTURE_PID_FILE: pidFile,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		const [code] = await once(parent, "exit");

		assert.equal(code, 17);
		await assertPidStops(await readPid(pidFile));
	});
});

type FixtureRunOptions = {
	env?: NodeJS.ProcessEnv;
	hooks?: EventEmitter;
	configureTransport: (transport: GatewayTransport) => void;
	importTui: () => Promise<unknown>;
};

async function runFixture(fixture: string, options: FixtureRunOptions): Promise<{
	code: number;
	stderr: string;
	stdout: string;
}> {
	const stderr: string[] = [];
	const stdout: string[] = [];
	const hooks = options.hooks ?? new EventEmitter();
	const protocolOutput: string[] = [];
	const code = await runCli({
		argv: [],
		env: { ...process.env, ...options.env },
		cwd: process.cwd(),
		stdin: { isTTY: true },
		stdout: { isTTY: true, write: (value) => { stdout.push(value); } },
		stderr: { write: (value) => { stderr.push(value); } },
		processHooks: hooks,
		startSidecar: (sidecarOptions) => {
			const sidecar = startFixtureSidecar(fixture, sidecarOptions);
			sidecar.transport.input.on("data", (chunk) => protocolOutput.push(chunk.toString()));
			return sidecar;
		},
		configureTransport: options.configureTransport,
		importTui: options.importTui,
	});
	return {
		code,
		stderr: stderr.join(""),
		stdout: stdout.join("") + protocolOutput.join(""),
	};
}

function startFixtureSidecar(fixture: string, options: StartPythonSidecarOptions) {
	return startPythonSidecar({
		...options,
		spawn: (_command, _args, spawnOptions) => spawn(process.execPath, [fixture], spawnOptions),
	});
}

async function waitForReady(
	transport: () => GatewayTransport | null,
	timeoutMs: number,
): Promise<void> {
	const input = transport()?.input;
	if (!input) {
		throw new Error("startup_transport_missing");
	}
	return new Promise((resolve, reject) => {
		let buffered = "";
		const timeout = setTimeout(() => finish(new Error("startup_timeout")), timeoutMs);
		input.on("data", onData);
		input.once("close", onClose);

		function onData(chunk: Buffer | string): void {
			buffered += chunk.toString();
			for (const line of buffered.split("\n")) {
				if (!line.trim()) continue;
				const message = JSON.parse(line) as { method?: string };
				if (message.method === "runtime.ready") {
					finish();
					return;
				}
			}
		}

		function onClose(): void {
			finish(new Error("startup_pipe_closed"));
		}

		function finish(error?: Error): void {
			clearTimeout(timeout);
			input?.off("data", onData);
			input?.off("close", onClose);
			if (error) reject(error);
			else resolve();
		}
	});
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "mycli-sidecar-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function readPid(path: string): Promise<number> {
	return Number(await readFile(path, "utf8"));
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await readFile(path);
			return;
		} catch {
			await delay(10);
		}
	}
	throw new Error(`Timed out waiting for ${path}`);
}

async function assertPidStops(pid: number): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (!pidIsAlive(pid)) return;
		await delay(20);
	}
	assert.fail(`child process ${pid} is still alive`);
}

function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
