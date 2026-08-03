import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
	startPythonSidecar,
	type SidecarTimers,
	type SpawnedSidecar,
} from "../src/sidecar/python-sidecar.ts";

type SpawnCall = {
	command: string;
	args: readonly string[];
	options: Record<string, unknown>;
};

class FakeSidecarProcess extends EventEmitter implements SpawnedSidecar {
	stdin: PassThrough | null = new PassThrough();
	stdout: PassThrough | null = new PassThrough();
	stderr: PassThrough | null = new PassThrough();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly kills: Array<NodeJS.Signals | number | undefined> = [];

	kill(signal?: NodeJS.Signals | number): boolean {
		this.kills.push(signal);
		return true;
	}

	exit(code: number | null, signal: NodeJS.Signals | null = null): void {
		this.exitCode = code;
		this.signalCode = signal;
		this.emit("exit", code, signal);
	}
}

class FakeTimers implements SidecarTimers {
	readonly pending: Array<{ callback: () => void; active: boolean }> = [];

	setTimeout(callback: () => void): object {
		const timer = { callback, active: true };
		this.pending.push(timer);
		return timer;
	}

	clearTimeout(handle: object): void {
		const timer = handle as { active: boolean };
		timer.active = false;
	}

	runNext(): void {
		const timer = this.pending.find((candidate) => candidate.active);
		assert.ok(timer, "expected a pending timer");
		timer.active = false;
		timer.callback();
	}
}

function spawnRecorder(child: FakeSidecarProcess): {
	spawn: (command: string, args: readonly string[], options: Record<string, unknown>) => SpawnedSidecar;
	calls: SpawnCall[];
} {
	const calls: SpawnCall[] = [];
	return {
		calls,
		spawn(command, args, options) {
			calls.push({ command, args, options });
			return child;
		},
	};
}

test("python sidecar builds the POSIX command with an executable override", () => {
	const child = new FakeSidecarProcess();
	const recorder = spawnRecorder(child);
	const env = { MYCLI_PYTHON: "/opt/my python" };

	startPythonSidecar({
		spawn: recorder.spawn,
		platform: "darwin",
		env,
		cwd: "/repo",
		args: ["--session", "demo", "--model", "gpt-test"],
	});

	assert.deepEqual(recorder.calls, [{
		command: "/opt/my python",
		args: ["-m", "mycli.cli.sidecar", "--session", "demo", "--model", "gpt-test"],
		options: {
			cwd: "/repo",
			env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			shell: false,
		},
	}]);
});

test("python sidecar defaults to python on Windows", () => {
	const child = new FakeSidecarProcess();
	const recorder = spawnRecorder(child);

	startPythonSidecar({
		spawn: recorder.spawn,
		platform: "win32",
		env: {},
		cwd: "C:\\repo",
		args: [],
	});

	assert.equal(recorder.calls[0]?.command, "python");
	assert.deepEqual(recorder.calls[0]?.args, ["-m", "mycli.cli.sidecar"]);
});

test("python sidecar uses dedicated pipes for the gateway transport", () => {
	const child = new FakeSidecarProcess();
	const recorder = spawnRecorder(child);

	const sidecar = startPythonSidecar({
		spawn: recorder.spawn,
		platform: "linux",
		env: {},
		cwd: "/repo",
		args: [],
	});

	assert.equal(recorder.calls[0]?.command, "python3");
	assert.deepEqual(recorder.calls[0]?.options.stdio, ["pipe", "pipe", "pipe"]);
	assert.equal(sidecar.transport.input, child.stdout);
	assert.equal(sidecar.transport.output, child.stdin);
	assert.notEqual(sidecar.transport.input, child.stderr);
});

test("python sidecar rejects missing protocol streams with a stable error", () => {
	const child = new FakeSidecarProcess();
	child.stdout = null;
	const recorder = spawnRecorder(child);

	assert.throws(
		() => startPythonSidecar({
			spawn: recorder.spawn,
			platform: "linux",
			env: {},
			cwd: "/repo",
			args: [],
		}),
		/sidecar_spawn_failed/,
	);
	assert.deepEqual(child.kills, ["SIGKILL"]);
});

test("python sidecar reports normal, nonzero, and signaled completion codes", async (t) => {
	for (const scenario of [
		{ name: "normal", code: 0, signal: null, expected: 0 },
		{ name: "nonzero", code: 7, signal: null, expected: 7 },
		{ name: "signal", code: null, signal: "SIGTERM" as const, expected: 1 },
	]) {
		await t.test(scenario.name, async () => {
			const child = new FakeSidecarProcess();
			const recorder = spawnRecorder(child);
			const sidecar = startPythonSidecar({
				spawn: recorder.spawn,
				platform: "linux",
				env: {},
				cwd: "/repo",
				args: [],
			});

			child.exit(scenario.code, scenario.signal);

			assert.equal(await sidecar.completion, scenario.expected);
		});
	}
});

test("python sidecar converts spawn errors to a stable failure", async () => {
	assert.throws(
		() => startPythonSidecar({
			spawn: () => { throw new Error("ENOENT /private/path"); },
			platform: "linux",
			env: {},
			cwd: "/repo",
			args: [],
		}),
		(error) => error instanceof Error
			&& error.message === "sidecar_spawn_failed: unable to start Python sidecar",
	);

	const child = new FakeSidecarProcess();
	const recorder = spawnRecorder(child);
	const sidecar = startPythonSidecar({
		spawn: recorder.spawn,
		platform: "linux",
		env: {},
		cwd: "/repo",
		args: [],
	});
	child.emit("error", new Error("ENOENT /private/path"));

	await assert.rejects(sidecar.completion, /sidecar_spawn_failed/);
});

test("python sidecar bounds and redacts stderr diagnostics", () => {
	const child = new FakeSidecarProcess();
	const recorder = spawnRecorder(child);
	const sidecar = startPythonSidecar({
		spawn: recorder.spawn,
		platform: "linux",
		env: {},
		cwd: "/repo",
		args: [],
	});

	child.stderr?.write("api_key=sk-assignment-secret Authorization: Bearer bearer-secret-value ");
	child.stderr?.write("X-API-Key: key-secret-value standalone sk-standalone-secret ");
	child.stderr?.write("x".repeat(12_000));

	const diagnostic = sidecar.diagnostic();
	assert.ok(Buffer.byteLength(diagnostic) <= 8 * 1024);
	assert.doesNotMatch(diagnostic, /assignment-secret|bearer-secret|key-secret|standalone-secret/);
	assert.match(diagnostic, /\[REDACTED\]/);
});

test("python sidecar closes stdin and accepts graceful exit", async () => {
	const child = new FakeSidecarProcess();
	const recorder = spawnRecorder(child);
	const timers = new FakeTimers();
	const sidecar = startPythonSidecar({
		spawn: recorder.spawn,
		timers,
		platform: "linux",
		env: {},
		cwd: "/repo",
		args: [],
	});

	const closing = sidecar.close();
	assert.equal(child.stdin?.writableEnded, true);
	child.exit(0);
	await closing;

	assert.deepEqual(child.kills, []);
});

test("python sidecar escalates from termination to a final kill", async () => {
	const child = new FakeSidecarProcess();
	const recorder = spawnRecorder(child);
	const timers = new FakeTimers();
	const sidecar = startPythonSidecar({
		spawn: recorder.spawn,
		timers,
		platform: "linux",
		env: {},
		cwd: "/repo",
		args: [],
	});

	const closing = sidecar.close();
	timers.runNext();
	await Promise.resolve();
	assert.deepEqual(child.kills, ["SIGTERM"]);
	timers.runNext();
	await Promise.resolve();
	assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
	child.exit(null, "SIGKILL");
	await closing;
});

test("python sidecar cleanup is idempotent and shares one promise", async () => {
	const child = new FakeSidecarProcess();
	const recorder = spawnRecorder(child);
	const timers = new FakeTimers();
	const sidecar = startPythonSidecar({
		spawn: recorder.spawn,
		timers,
		platform: "linux",
		env: {},
		cwd: "/repo",
		args: [],
	});

	const first = sidecar.close();
	const second = sidecar.close();
	assert.equal(first, second);
	child.exit(0);
	await Promise.all([first, second]);

	assert.deepEqual(child.kills, []);
});
