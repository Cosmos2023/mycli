import assert from "node:assert/strict";
import test from "node:test";
import {
	ShellTransportError,
	startNodePtyTransport,
	type ShellExit,
	type ShellOutputChunk,
} from "../../src/index.ts";

test("node-pty maps launch input and preserves terminal IO and one exit", async () => {
	const fake = new FakePtyProcess();
	let spawnInput: Readonly<Record<string, unknown>> | undefined;
	const transport = await startNodePtyTransport(request("linux"), {
		loadNodePty: async () => ({
			spawn: (executable, args, options) => {
				spawnInput = { executable, args, options };
				return fake;
			},
		}),
		processController: {
			isProcessTreeAlive: () => false,
		},
	});

	assert.deepEqual(spawnInput, {
		executable: "/bin/sh",
		args: ["-i"],
		options: {
			name: "xterm-test",
			cols: 80,
			rows: 24,
			cwd: "/workspace",
			env: { LANG: "en_US.UTF-8", TERM: "xterm-test" },
		},
	});
	assert.equal(transport.kind, "unix_pty");
	assert.equal(transport.tty, true);
	assert.equal(transport.pid, 4321);

	fake.emitData("before-");
	const output: ShellOutputChunk[] = [];
	transport.onOutput((chunk) => output.push(chunk));
	await Promise.resolve();
	fake.emitData("after");
	assert.deepEqual(output, [
		{ sequence: 1, stream: "terminal", data: "before-" },
		{ sequence: 2, stream: "terminal", data: "after" },
	]);

	await transport.write("\u4e2d\n");
	await transport.resize(40, 100);
	assert.deepEqual(fake.writes, ["\u4e2d\n"]);
	assert.deepEqual(fake.resizes, [[100, 40]]);

	const exits: ShellExit[] = [];
	transport.onExit((exit) => exits.push(exit));
	fake.emitExit({ exitCode: 0, signal: 0 });
	fake.emitExit({ exitCode: 9, signal: 15 });
	assert.deepEqual(exits, [{ exitCode: 0, signal: null }]);

	await transport.close();
	await transport.close();
	assert.equal(fake.disposedDataListeners, 1);
	assert.equal(fake.disposedExitListeners, 1);
});

test("node-pty classifies load and spawn failures by platform without raw details", async () => {
	for (const [platform, kind] of [
		["linux", "pty_unavailable"],
		["win32", "conpty_unavailable"],
	] as const) {
		await assert.rejects(
			startNodePtyTransport(request(platform), {
				loadNodePty: async () => { throw new Error("private native load path"); },
			}),
			(error: unknown) => unavailable(error, kind),
		);
		await assert.rejects(
			startNodePtyTransport(request(platform), {
				loadNodePty: async () => ({
					spawn: () => { throw new Error("private native spawn path"); },
				}),
			}),
			(error: unknown) => unavailable(error, kind),
		);
	}
});

test("node-pty marks a successful Windows transport as ConPTY", async () => {
	const transport = await startNodePtyTransport(request("win32"), {
		loadNodePty: async () => ({ spawn: () => new FakePtyProcess() }),
		processController: { isProcessTreeAlive: () => false },
	});

	assert.equal(transport.kind, "windows_conpty");
	assert.equal(transport.tty, true);
	await transport.close();
});

test("ConPTY waits for an asynchronous pid and preserves early output and exit", async () => {
	for (const earlyOutput of ["", "fast-command\r\n"]) {
		const fake = new FakePtyProcess();
		fake.pid = 0;
		const transport = await startNodePtyTransport(request("win32"), {
			loadNodePty: async () => ({ spawn: () => {
				setImmediate(() => {
					fake.pid = 4321;
					if (earlyOutput) fake.emitData(earlyOutput);
					fake.emitExit({ exitCode: 7 });
				});
				return fake;
			} }),
			processController: { isProcessTreeAlive: () => false },
		});
		const output: ShellOutputChunk[] = [];
		const exits: ShellExit[] = [];
		transport.onOutput((chunk) => output.push(chunk));
		transport.onExit((exit) => exits.push(exit));
		await Promise.resolve();
		assert.equal(transport.pid, 4321);
		assert.deepEqual(output.map((chunk) => chunk.data), earlyOutput ? [earlyOutput] : []);
		assert.deepEqual(exits, [{ exitCode: 7, signal: null }]);
		await transport.close();
	}
});

test("ConPTY cleans up failed and timed out asynchronous starts", async () => {
	for (const exitEarly of [false, true]) {
		const fake = new FakePtyProcess();
		fake.pid = 0;
		await assert.rejects(startNodePtyTransport(request("win32"), {
			startupTimeoutMs: 30,
			loadNodePty: async () => ({ spawn: () => {
				if (exitEarly) setImmediate(() => fake.emitExit({ exitCode: 1 }));
				return fake;
			} }),
		}), (error: unknown) => unavailable(error, "conpty_unavailable"));
		assert.equal(fake.kills, 1);
		assert.equal(fake.disposedDataListeners, 1);
		assert.equal(fake.disposedExitListeners, 1);
	}
});

test("node-pty maps write and resize failures to stable transport errors", async () => {
	const fake = new FakePtyProcess();
	fake.writeError = true;
	fake.resizeError = true;
	const transport = await startNodePtyTransport(request("linux"), {
		loadNodePty: async () => ({ spawn: () => fake }),
		processController: { isProcessTreeAlive: () => false },
	});

	await assert.rejects(
		transport.write("input"),
		(error: unknown) => transportError(error, "shell_write_failed"),
	);
	await assert.rejects(
		transport.resize(40, 100),
		(error: unknown) => transportError(error, "shell_resize_failed"),
	);
	await transport.close();
});

test("node-pty delegates interrupt and termination to process-tree control", async () => {
	const fake = new FakePtyProcess();
	const signals: Array<readonly [number, NodeJS.Signals]> = [];
	const transport = await startNodePtyTransport(request("darwin"), {
		loadNodePty: async () => ({ spawn: () => fake }),
		processController: {
			isProcessTreeAlive: () => true,
			sendSignal: (pid, signal) => signals.push([pid, signal]),
			waitForTreeExit: async () => true,
		},
	});

	assert.deepEqual(await transport.interrupt(), {
		state: "interrupted",
		signal: "SIGINT",
	});
	assert.deepEqual(await transport.terminate(), {
		state: "terminated",
		signal: "SIGTERM",
	});
	assert.deepEqual(signals, [
		[-4321, "SIGINT"],
		[-4321, "SIGTERM"],
	]);
	await transport.close();
});

function request(platform: NodeJS.Platform) {
	return {
		executable: platform === "win32" ? "cmd.exe" : "/bin/sh",
		args: platform === "win32" ? ["/q"] : ["-i"],
		cwd: "/workspace",
		env: { LANG: "en_US.UTF-8", TERM: "xterm-test" },
		platform,
		tty: true,
		name: "xterm-test",
		rows: 24,
		columns: 80,
	};
}

function unavailable(error: unknown, kind: "pty_unavailable" | "conpty_unavailable"): boolean {
	assert.equal(error instanceof ShellTransportError, true);
	assert.equal((error as ShellTransportError).kind, kind);
	assert.equal((error as Error).message.includes("private"), false);
	return true;
}

function transportError(error: unknown, kind: string): boolean {
	return error instanceof ShellTransportError && error.kind === kind;
}

class FakePtyProcess {
	pid = 4321;
	kills = 0;
	readonly writes: string[] = [];
	readonly resizes: Array<readonly [number, number]> = [];
	writeError = false;
	resizeError = false;
	disposedDataListeners = 0;
	disposedExitListeners = 0;
	#dataListeners = new Set<(data: string) => void>();
	#exitListeners = new Set<(event: { readonly exitCode: number; readonly signal?: number }) => void>();

	onData(listener: (data: string) => void): { dispose(): void } {
		this.#dataListeners.add(listener);
		return { dispose: () => {
			if (this.#dataListeners.delete(listener)) this.disposedDataListeners += 1;
		} };
	}

	onExit(listener: (event: { readonly exitCode: number; readonly signal?: number }) => void): {
		dispose(): void;
	} {
		this.#exitListeners.add(listener);
		return { dispose: () => {
			if (this.#exitListeners.delete(listener)) this.disposedExitListeners += 1;
		} };
	}

	write(text: string): void {
		if (this.writeError) throw new Error("native write detail");
		this.writes.push(text);
	}

	resize(columns: number, rows: number): void {
		if (this.resizeError) throw new Error("native resize detail");
		this.resizes.push([columns, rows]);
	}

	kill(): void { this.kills += 1; }

	emitData(data: string): void {
		for (const listener of this.#dataListeners) listener(data);
	}

	emitExit(event: { readonly exitCode: number; readonly signal?: number }): void {
		for (const listener of this.#exitListeners) listener(event);
	}
}
