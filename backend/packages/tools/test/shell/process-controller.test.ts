import assert from "node:assert/strict";
import test from "node:test";
import {
	createProcessController,
	type ManagedProcess,
	type WindowsTaskkillRequest,
} from "../../src/index.ts";

test("process controller reports an already exited process without signaling", async () => {
	const process = fakeProcess({ exitCode: 0 });
	const signals: Array<readonly [number, NodeJS.Signals]> = [];
	const controller = createProcessController(process, {
		platform: "linux",
		isProcessTreeAlive: () => false,
		sendSignal: (pid, signal) => signals.push([pid, signal]),
	});

	assert.deepEqual(await controller.interrupt(), {
		state: "already_exited",
		exitCode: 0,
	});
	assert.deepEqual(signals, []);
});

test("POSIX interrupt targets the detached process group", async () => {
	const process = fakeProcess();
	const signals: Array<readonly [number, NodeJS.Signals]> = [];
	const controller = createProcessController(process, {
		platform: "darwin",
		isProcessTreeAlive: () => true,
		sendSignal: (pid, signal) => signals.push([pid, signal]),
		waitForTreeExit: async () => true,
	});

	assert.deepEqual(await controller.interrupt(), {
		state: "interrupted",
		signal: "SIGINT",
	});
	assert.deepEqual(signals, [[-1234, "SIGINT"]]);
});

test("POSIX termination escalates to SIGKILL and can remain inconclusive", async () => {
	const signals: Array<readonly [number, NodeJS.Signals]> = [];
	let waitCalls = 0;
	const controller = createProcessController(fakeProcess(), {
		platform: "linux",
		isProcessTreeAlive: () => true,
		sendSignal: (pid, signal) => signals.push([pid, signal]),
		waitForTreeExit: async () => {
			waitCalls += 1;
			return false;
		},
	});

	assert.deepEqual(await controller.terminate(), {
		state: "inconclusive",
		signal: "SIGKILL",
	});
	assert.deepEqual(signals, [
		[-1234, "SIGTERM"],
		[-1234, "SIGKILL"],
	]);
	assert.equal(waitCalls, 2);
});

test("Windows cleanup invokes fixed taskkill arguments without a shell", async () => {
	const requests: WindowsTaskkillRequest[] = [];
	const controller = createProcessController(fakeProcess(), {
		platform: "win32",
		isProcessTreeAlive: () => true,
		runTaskkill: async (request) => {
			requests.push(request);
			return 0;
		},
		waitForTreeExit: async () => true,
	});

	assert.deepEqual(await controller.terminate(), {
		state: "terminated",
		signal: "SIGKILL",
	});
	assert.deepEqual(requests, [{
		executable: "taskkill.exe",
		args: ["/PID", "1234", "/T", "/F"],
		shell: false,
		windowsHide: true,
	}]);
});

test("Windows unsupported interrupt goes directly to owned process-tree termination", async () => {
	const requests: WindowsTaskkillRequest[] = [];
	const waits: number[] = [];
	const controller = createProcessController({ ...fakeProcess(), kill: () => false }, {
		platform: "win32",
		isProcessTreeAlive: () => true,
		waitForTreeExit: async (milliseconds) => { waits.push(milliseconds); return true; },
		runTaskkill: async (request) => { requests.push(request); return 0; },
	});
	assert.deepEqual(await controller.interrupt(), { state: "terminated", signal: "SIGKILL" });
	assert.equal(requests.length, 1);
	assert.deepEqual(requests[0]?.args, ["/PID", "1234", "/T", "/F"]);
	assert.equal(waits.length, 1);
});

function fakeProcess(options: {
	readonly exitCode?: number | null;
	readonly signalCode?: NodeJS.Signals | null;
} = {}): ManagedProcess {
	return {
		pid: 1234,
		exitCode: options.exitCode ?? null,
		signalCode: options.signalCode ?? null,
		kill: () => true,
	};
}
