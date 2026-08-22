import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import type { ShellLifecycleEvent } from "@mycli/core";
import {
	ShellSessionManager,
	type ShellStartRequest,
	type ShellTransport,
	type ShellTransportFactory,
} from "../src/index.ts";
import {
	FakeShellTransport,
	FakeShellTransportFactory,
} from "./support/fake-shell-transport.ts";

test("unfinished foreground process yields without a second spawn", async () => {
	const factory = new FakeShellTransportFactory();
	const manager = new ShellSessionManager({
		transportFactory: factory.create,
		createShellId: () => "a1b2c3d4",
	});

	const result = await manager.start(shellStart({ yieldTimeMs: 5 }));

	assert.equal(result.processState, "running_background");
	assert.equal(result.yielded, true);
	assert.equal(factory.started, 1);
	assert.equal(manager.list("session-a").length, 1);
});

test("keeps the display description in active snapshots and lifecycle events", async () => {
	const events: ShellLifecycleEvent[] = [];
	const manager = new ShellSessionManager({
		transportFactory: new FakeShellTransportFactory().create,
		createShellId: () => "a1b2c3d4",
	});

	const result = await manager.start(shellStart({
		background: true,
		description: "Start the development server",
		publishLifecycle: (event) => events.push(event),
	}));

	assert.equal(result.description, "Start the development server");
	assert.equal(manager.list("session-a")[0]?.description, "Start the development server");
	assert.equal(events[0]?.description, "Start the development server");
});

test("completion before the yield deadline returns final output", async () => {
	const factory = new FakeShellTransportFactory();
	const manager = new ShellSessionManager({
		transportFactory: factory.create,
		createShellId: () => "a1b2c3d4",
	});
	const pending = manager.start(shellStart({ yieldTimeMs: 100 }));
	await eventually(() => factory.transports.length === 1);
	const transport = factory.transports[0];
	assert.ok(transport);
	transport.emitOutput({ sequence: 1, stream: "stdout", data: "done" });
	transport.emitExit({ exitCode: 0, signal: null });

	const result = await pending;
	assert.equal(result.processState, "completed");
	assert.equal(result.terminalState, "completed");
	assert.equal(result.exitCode, 0);
	assert.equal(result.output, "done");
	assert.equal(result.yielded, false);
});

test("model and lifecycle cursors consume output independently", async () => {
	const events: ShellLifecycleEvent[] = [];
	const factory = new FakeShellTransportFactory();
	const manager = new ShellSessionManager({
		transportFactory: factory.create,
		createShellId: () => "a1b2c3d4",
		outputEventIntervalMs: 0,
	});
	await manager.start(shellStart({
		background: true,
		publishLifecycle: (event) => events.push(event),
	}));
	const transport = factory.transports[0];
	assert.ok(transport);

	transport.emitOutput({ sequence: 1, stream: "stdout", data: "abc" });
	const first = await manager.interact(shellInteraction({ yieldTimeMs: 0 }));
	transport.emitOutput({ sequence: 2, stream: "stderr", data: "def" });
	const second = await manager.interact(shellInteraction({ yieldTimeMs: 0 }));
	await eventually(() => lifecycleOutput(events) === "abcdef");

	assert.equal(first.output, "abc");
	assert.equal(second.output, "def");
	assert.equal(lifecycleOutput(events), "abcdef");
});

test("large lifecycle output is split without discarding retained characters", async () => {
	const events: ShellLifecycleEvent[] = [];
	const factory = new FakeShellTransportFactory();
	const manager = new ShellSessionManager({
		transportFactory: factory.create,
		createShellId: () => "a1b2c3d4",
		outputEventIntervalMs: 0,
		outputEventMaxChars: 4,
	});
	await manager.start(shellStart({
		background: true,
		publishLifecycle: (event) => events.push(event),
	}));
	const transport = factory.transports[0];
	assert.ok(transport);

	transport.emitOutput({ sequence: 1, stream: "stdout", data: "abcdefghij" });
	await eventually(() => lifecycleOutput(events) === "abcdefghij");

	const outputEvents = events.filter((event) => event.kind === "shell.output");
	assert.deepEqual(outputEvents.map((event) => event.outputDelta), ["abcd", "efgh", "ij"]);
	assert.deepEqual(outputEvents.map((event) => event.nextCursor), [4, 8, 10]);
	assert.deepEqual(outputEvents.map((event) => event.omittedOutputChars), [0, 0, 0]);
});

test("lifecycle output event bounds cannot exceed the persistence chunk contract", () => {
	assert.throws(() => new ShellSessionManager({
		outputEventMaxChars: 16_385,
	}), /outputEventMaxChars must be at most 16384/u);
});

test("empty polling wakes as soon as new output arrives", async () => {
	const factory = new FakeShellTransportFactory();
	const manager = new ShellSessionManager({
		transportFactory: factory.create,
		createShellId: () => "a1b2c3d4",
	});
	await manager.start(shellStart({ background: true }));
	const transport = factory.transports[0];
	assert.ok(transport);
	const pending = manager.interact(shellInteraction({ yieldTimeMs: 2_000 }));
	setTimeout(() => {
		transport.emitOutput({ sequence: 1, stream: "stdout", data: "awake" });
	}, 5);

	const result = await pending;
	assert.equal(result.output, "awake");
});

test("non-empty PTY input is forwarded once", async () => {
	const factory = new FakeShellTransportFactory();
	const manager = new ShellSessionManager({
		transportFactory: factory.create,
		createShellId: () => "a1b2c3d4",
	});
	await manager.start(shellStart({ background: true, tty: true }));
	const result = await manager.interact(shellInteraction({ chars: "hello\n", yieldTimeMs: 0 }));
	const transport = factory.transports[0];
	assert.ok(transport);

	assert.deepEqual(transport.writes, ["hello\n"]);
	assert.equal(result.processState, "running_background");
});

test("interactions for one shell are serialized", async () => {
	const transport = new BlockingWriteTransport();
	const manager = new ShellSessionManager({
		transportFactory: async () => transport,
		createShellId: () => "a1b2c3d4",
	});
	await manager.start(shellStart({ background: true, tty: true }));

	const first = manager.interact(shellInteraction({ chars: "first", yieldTimeMs: 0 }));
	await eventually(() => transport.startedWrites.length === 1);
	const second = manager.interact(shellInteraction({ chars: "second", yieldTimeMs: 0 }));
	await delay(5);
	assert.deepEqual(transport.startedWrites, ["first"]);
	transport.releaseFirstWrite();
	await Promise.all([first, second]);

	assert.deepEqual(transport.startedWrites, ["first", "second"]);
});

test("termination is serialized behind an active shell write", async () => {
	const transport = new BlockingWriteTransport();
	const manager = new ShellSessionManager({
		transportFactory: async () => transport,
		createShellId: () => "a1b2c3d4",
	});
	await manager.start(shellStart({ background: true, tty: true }));
	const writing = manager.interact(shellInteraction({ chars: "first", yieldTimeMs: 0 }));
	await eventually(() => transport.startedWrites.length === 1);
	const terminating = manager.terminate("session-a", "a1b2c3d4");
	await delay(5);
	assert.equal(transport.terminateCalls, 0);

	transport.releaseFirstWrite();
	await Promise.all([writing, terminating]);
	assert.equal(transport.terminateCalls, 1);
});

test("absolute timeout terminates and completes a background shell", async () => {
	const events: ShellLifecycleEvent[] = [];
	const factory = new FakeShellTransportFactory();
	const manager = new ShellSessionManager({
		transportFactory: factory.create,
		createShellId: () => "a1b2c3d4",
	});
	await manager.start(shellStart({
		background: true,
		timeoutSeconds: 0.01,
		publishLifecycle: (event) => events.push(event),
	}));
	await eventually(() => manager.list("session-a")[0]?.terminalState === "timed_out");
	const snapshot = manager.list("session-a")[0];
	const transport = factory.transports[0];
	assert.ok(snapshot);
	assert.ok(transport);

	assert.equal(snapshot.cleanupResult, "terminated");
	assert.equal(transport.terminateCalls, 1);
	assert.equal(events.filter((event) => event.kind === "shell.completed").length, 1);
});

test("owners cannot observe or interact with another session", async () => {
	const factory = new FakeShellTransportFactory();
	const manager = new ShellSessionManager({
		transportFactory: factory.create,
		createShellId: () => "a1b2c3d4",
	});
	await manager.start(shellStart({ background: true }));

	assert.deepEqual(manager.list("session-b"), []);
	const denied = await manager.interact(shellInteraction({ ownerSessionId: "session-b" }));
	assert.equal(denied.errorKind, "shell_session_forbidden");
	assert.equal(factory.transports[0]?.writes.length, 0);
});

test("capacity is reserved before an asynchronous transport starts", async () => {
	let releaseTransport: ((transport: ShellTransport) => void) | undefined;
	const transportFactory: ShellTransportFactory = () => new Promise((resolve) => {
		releaseTransport = resolve;
	});
	let shellIndex = 0;
	const manager = new ShellSessionManager({
		maxSessions: 1,
		transportFactory,
		createShellId: () => `0000000${shellIndex += 1}`,
	});
	const first = manager.start(shellStart({ background: true }));
	await eventually(() => releaseTransport !== undefined);

	const rejected = await manager.start(shellStart({ background: true }));
	assert.equal(rejected.errorKind, "shell_capacity_exceeded");
	releaseTransport?.(new FakeShellTransport({ kind: "pipe" }));
	assert.equal((await first).errorKind, undefined);
});

test("terminal lifecycle flushes final output before one completion", async () => {
	const events: ShellLifecycleEvent[] = [];
	const factory = new FakeShellTransportFactory();
	const manager = new ShellSessionManager({
		transportFactory: factory.create,
		createShellId: () => "a1b2c3d4",
		outputEventIntervalMs: 10_000,
	});
	await manager.start(shellStart({
		background: true,
		publishLifecycle: (event) => events.push(event),
	}));
	const transport = factory.transports[0];
	assert.ok(transport);
	transport.emitOutput({ sequence: 1, stream: "stdout", data: "final" });
	transport.emitExit({ exitCode: 0, signal: null });
	await eventually(() => events.some((event) => event.kind === "shell.completed"));

	const terminalKinds = events
		.filter((event) => event.kind === "shell.output" || event.kind === "shell.completed")
		.map((event) => event.kind);
	assert.deepEqual(terminalKinds, ["shell.output", "shell.completed"]);
	assert.equal(events.filter((event) => event.kind === "shell.completed").length, 1);
});

test("evicted model cursors report omitted output while retaining the newest tail", async () => {
	const factory = new FakeShellTransportFactory();
	const manager = new ShellSessionManager({
		transportFactory: factory.create,
		createShellId: () => "a1b2c3d4",
		outputMaxChars: 5,
	});
	await manager.start(shellStart({ background: true }));
	const transport = factory.transports[0];
	assert.ok(transport);
	transport.emitOutput({ sequence: 1, stream: "stdout", data: "abcdef" });

	const result = await manager.interact(shellInteraction({ yieldTimeMs: 0 }));
	assert.equal(result.output, "bcdef");
	assert.equal(result.cursorWasEvicted, true);
	assert.equal(result.omittedOutputChars, 1);
});

test("close terminates and closes every live transport", async () => {
	const factory = new FakeShellTransportFactory();
	let shellIndex = 0;
	const manager = new ShellSessionManager({
		transportFactory: factory.create,
		createShellId: () => `0000000${shellIndex += 1}`,
	});
	await manager.start(shellStart({ ownerSessionId: "session-a", background: true }));
	await manager.start(shellStart({ ownerSessionId: "session-b", background: true }));

	const snapshots = await manager.close();
	assert.equal(snapshots.length, 2);
	assert.deepEqual(factory.transports.map((transport) => transport.terminateCalls), [1, 1]);
	assert.deepEqual(factory.transports.map((transport) => transport.closeCalls), [1, 1]);
});

test("close waits for an in-flight transport start and cleans it before returning", async () => {
	let releaseTransport: ((transport: ShellTransport) => void) | undefined;
	const manager = new ShellSessionManager({
		transportFactory: () => new Promise((resolve) => {
			releaseTransport = resolve;
		}),
		createShellId: () => "a1b2c3d4",
	});
	const starting = manager.start(shellStart({ background: true }));
	await eventually(() => releaseTransport !== undefined);
	let closeSettled = false;
	const closing = manager.close().then((snapshots) => {
		closeSettled = true;
		return snapshots;
	});
	await delay(5);
	assert.equal(closeSettled, false);

	const transport = new FakeShellTransport({ kind: "pipe" });
	releaseTransport?.(transport);
	const [startResult, closeResult] = await Promise.all([starting, closing]);
	assert.equal(startResult.errorKind, "shell_cleanup_failed");
	assert.deepEqual(closeResult, []);
	assert.equal(transport.terminateCalls, 1);
	assert.equal(transport.closeCalls, 1);
});

test("an observed exit makes an inconclusive cleanup terminal", async () => {
	const transport = new ExitDuringCleanupTransport();
	const manager = new ShellSessionManager({
		transportFactory: async () => transport,
		createShellId: () => "a1b2c3d4",
	});
	await manager.start(shellStart({ background: true }));

	const result = await manager.terminate("session-a", "a1b2c3d4");
	assert.equal(result.success, true);
	assert.equal(result.terminalState, "killed");
	assert.equal(result.cleanupResult, "already_exited");
});

function shellStart(overrides: Partial<ShellStartRequest> = {}): ShellStartRequest {
	return {
		ownerSessionId: "session-a",
		callId: "call-shell-1",
		command: "private command",
		executable: process.execPath,
		args: [],
		cwd: process.cwd(),
		env: {},
		platform: process.platform,
		tty: false,
		rows: 24,
		columns: 80,
		background: undefined,
		yieldTimeMs: 5,
		timeoutSeconds: 30,
		publishLifecycle: () => undefined,
		...overrides,
	};
}

function shellInteraction(overrides: {
	readonly ownerSessionId?: string;
	readonly shellId?: string;
	readonly chars?: string;
	readonly yieldTimeMs?: number;
} = {}) {
	return {
		ownerSessionId: overrides.ownerSessionId ?? "session-a",
		shellId: overrides.shellId ?? "a1b2c3d4",
		chars: overrides.chars ?? "",
		yieldTimeMs: overrides.yieldTimeMs ?? 0,
	};
}

function lifecycleOutput(events: readonly ShellLifecycleEvent[]): string {
	return events
		.filter((event) => event.kind === "shell.output")
		.map((event) => event.outputDelta ?? "")
		.join("");
}

async function eventually(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
		await delay(2);
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class BlockingWriteTransport extends FakeShellTransport {
	readonly startedWrites: string[] = [];
	#releaseFirst: (() => void) | undefined;

	constructor() {
		super({ kind: "unix_pty" });
	}

	override async write(text: string): Promise<void> {
		this.startedWrites.push(text);
		if (this.startedWrites.length === 1) {
			await new Promise<void>((resolve) => {
				this.#releaseFirst = resolve;
			});
		}
		await super.write(text);
	}

	releaseFirstWrite(): void {
		this.#releaseFirst?.();
	}
}

class ExitDuringCleanupTransport extends FakeShellTransport {
	constructor() {
		super({ kind: "pipe" });
	}

	override async terminate() {
		this.emitExit({ exitCode: 0, signal: null });
		return { state: "inconclusive" as const };
	}
}
