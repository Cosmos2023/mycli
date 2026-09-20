import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import {
	ShellTransportError,
	startPipeTransport,
	type ShellExit,
	type ShellOutputChunk,
	type ShellTransport,
} from "../../src/index.ts";

test("pipe publishes flushed partial output before process exit", async () => {
	const transport = await startNode([
		"process.stdout.write('ready');",
		"setTimeout(() => process.exit(0), 2_000);",
	].join(""));
	const started = Date.now();

	try {
		const chunk = await nextOutput(transport);
		assert.equal(Buffer.from(chunk.data).toString("utf8"), "ready");
		assert.equal(chunk.stream, "stdout");
		assert.equal(chunk.sequence, 1);
		assert.ok(Date.now() - started < 1_000);

		await assert.rejects(
			transport.write("input\n"),
			(error: unknown) => error instanceof ShellTransportError && error.kind === "stdin_closed",
		);
		await assert.rejects(
			transport.resize(30, 100),
			(error: unknown) => error instanceof ShellTransportError
				&& error.kind === "shell_resize_failed",
		);
	} finally {
		await transport.terminate();
		await transport.close();
		await transport.close();
	}
});

test("pipe labels both streams and exits only after output drains", async () => {
	const transport = await startNode([
		"process.stdout.write('out');",
		"process.stderr.write('err');",
		"process.exitCode = 7;",
	].join(""));
	const chunks: ShellOutputChunk[] = [];
	transport.onOutput((chunk) => chunks.push(chunk));

	try {
		const exit = await nextExit(transport);
		assert.deepEqual(exit, { exitCode: 7, signal: null });
		assert.deepEqual(new Set(chunks.map((chunk) => chunk.stream)), new Set(["stdout", "stderr"]));
		assert.deepEqual(chunks.map((chunk) => chunk.sequence), [1, 2]);
		assert.deepEqual(
			new Set(chunks.map((chunk) => Buffer.from(chunk.data).toString("utf8"))),
			new Set(["out", "err"]),
		);
	} finally {
		await transport.close();
	}
});

test("Windows cmd pipe preserves quoted executable and shell arguments", {
	skip: process.platform !== "win32",
}, async () => {
	const transport = await startPipeTransport({
		executable: process.env.ComSpec ?? "cmd.exe",
		args: ["/d", "/s", "/c",
			`"${process.execPath}" -e "process.stdout.write(process.argv[1])" "quoted & value"`],
		cwd: process.cwd(), env: { ...process.env }, platform: "win32",
		tty: false, rows: 24, columns: 80,
	});
	try {
		const output = nextOutput(transport);
		const exit = nextExit(transport);
		assert.equal(Buffer.from((await output).data).toString("utf8"), "quoted & value");
		assert.deepEqual(await exit, { exitCode: 0, signal: null });
	} finally {
		await transport.terminate();
		await transport.close();
	}
});

test("pipe interrupt uses POSIX signals or Windows process-tree termination", async () => {
	const interruptSignal = process.platform === "win32" ? "SIGBREAK" : "SIGINT";
	const transport = await startNode([
		`process.on('${interruptSignal}', () => process.exit(0));`,
		"process.stdout.write('ready');",
		"setTimeout(() => {}, 30_000);",
	].join(""));

	try {
		await nextOutput(transport);
		assert.deepEqual(await transport.interrupt(), process.platform === "win32"
			? { state: "terminated", signal: "SIGKILL" }
			: { state: "interrupted", signal: interruptSignal });
		const exit = await nextExit(transport);
		if (process.platform === "win32") assert.notEqual(exit.exitCode, 0);
		else assert.deepEqual(exit, { exitCode: 0, signal: null });
	} finally {
		await transport.terminate();
		await transport.close();
	}
});

test("pipe spawn failures are sanitized and do not emit an unhandled error", async () => {
	await assert.rejects(
		startPipeTransport({
			executable: `${process.cwd()}/__missing_mycli_executable__`,
			args: [],
			cwd: process.cwd(),
			env: {},
			platform: process.platform,
			tty: false,
			rows: 24,
			columns: 80,
		}),
		(error: unknown) => error instanceof Error
			&& error.message === "shell_spawn_failed: unable to start pipe process",
	);
});

test("pipe termination removes a spawned grandchild process tree", async () => {
	const parentScript = [
		"const { spawn } = require('node:child_process');",
		"const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });",
		"process.stdout.write(String(child.pid));",
		"setTimeout(() => {}, 30000);",
	].join("");
	const transport = await startNode(parentScript);
	let grandchildPid: number | undefined;

	try {
		grandchildPid = Number(Buffer.from((await nextOutput(transport)).data).toString("utf8"));
		assert.equal(Number.isSafeInteger(grandchildPid), true);
		assert.equal(isProcessAlive(grandchildPid), true);
		const cleanup = process.platform === "win32"
			? await transport.interrupt() : await transport.terminate();
		assert.equal(cleanup.state, "terminated");
		await nextExit(transport);
		assert.equal(await waitUntilAbsent(grandchildPid), true);
	} finally {
		if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) {
			try {
				process.kill(grandchildPid, "SIGKILL");
			} catch {
				// The process exited between the probe and cleanup.
			}
		}
		await transport.terminate();
		await transport.close();
	}
});

function startNode(script: string): Promise<ShellTransport> {
	return startPipeTransport({
		executable: process.execPath,
		args: ["-e", script],
		cwd: process.cwd(),
		env: { ...process.env },
		platform: process.platform,
		tty: false,
		rows: 24,
		columns: 80,
	});
}

function nextOutput(transport: ShellTransport): Promise<ShellOutputChunk> {
	return withTimeout(new Promise((resolve) => {
		const unsubscribe = transport.onOutput((chunk) => {
			unsubscribe();
			resolve(chunk);
		});
	}));
}

function nextExit(transport: ShellTransport): Promise<ShellExit> {
	return withTimeout(new Promise((resolve) => {
		const unsubscribe = transport.onExit((exit) => {
			unsubscribe();
			resolve(exit);
		});
	}));
}

async function withTimeout<T>(value: Promise<T>): Promise<T> {
	let handle: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			value,
			new Promise<never>((_resolve, reject) => {
				handle = setTimeout(() => reject(new Error("test timeout")), 5_000);
			}),
		]);
	} finally {
		if (handle !== undefined) clearTimeout(handle);
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntilAbsent(pid: number): Promise<boolean> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return !isProcessAlive(pid);
}
