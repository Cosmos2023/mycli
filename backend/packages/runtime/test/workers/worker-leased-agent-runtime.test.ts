import assert from "node:assert/strict";
import test from "node:test";
import {
	AgentWorkerPool,
	WorkerLeasedAgentThreadRuntimeFactory,
	type AgentThreadRuntimeCreateInput,
	type AgentThreadRuntimeEvent,
	type AgentThreadRuntimeHandle,
	type AgentThreadRuntimeResult,
	type ProviderStepExecutor,
} from "../../src/index.ts";

test("acquires a Worker only for an active run and releases it at idle", async (t) => {
	const fixture = runtimeFixture(t);
	const handle = await fixture.factory.create(createInput());
	assert.equal(fixture.pool.snapshot().workerCount, 0);

	let releaseRun!: () => void;
	fixture.delegate.run = async () => {
		await new Promise<void>((resolve) => { releaseRun = resolve; });
		return completed("run");
	};
	const running = handle.run(
		"hello",
		new AbortController().signal,
		() => undefined,
		"turn-run-1",
	);
	await waitFor(() => fixture.pool.snapshot().activeLeaseCount === 1);
	await waitFor(() => releaseRun !== undefined);
	releaseRun();
	assert.deepEqual(await running, completed("run"));
	await waitFor(() => fixture.pool.snapshot().activeLeaseCount === 0);
	assert.equal(fixture.delegate.runCalls, 1);
	assert.deepEqual(fixture.delegate.turnIds, ["turn-run-1"]);
	assert.equal(fixture.delegate.boundExecutors.at(0) !== undefined, true);
	assert.equal(fixture.delegate.boundExecutors.at(-1), undefined);
});

test("leases runMailbox independently and preserves event delivery", async (t) => {
	const fixture = runtimeFixture(t);
	const handle = await fixture.factory.create(createInput());
	const events: AgentThreadRuntimeEvent[] = [];
	handle.bindParentTurn?.("turn-mailbox-1", "parent-follow-up");
	assert.deepEqual(fixture.delegate.parentTurns, [["turn-mailbox-1", "parent-follow-up"]]);
	assert.equal(fixture.pool.snapshot().workerCount, 0);
	fixture.delegate.mailbox = async (emit) => {
		emit({ type: "progress", summary: "mail received" });
		return completed("mailbox");
	};

	assert.deepEqual(await handle.runMailbox?.(
		new AbortController().signal,
		(event) => events.push(event),
		"turn-mailbox-1",
	), completed("mailbox"));
	assert.deepEqual(events, [{ type: "progress", summary: "mail received" }]);
	assert.equal(fixture.delegate.mailboxCalls, 1);
	assert.deepEqual(fixture.delegate.turnIds, ["turn-mailbox-1"]);
	assert.equal(fixture.pool.snapshot().activeLeaseCount, 0);
});

test("delegates send and markIdle without retaining a Worker", async (t) => {
	const fixture = runtimeFixture(t);
	const handle = await fixture.factory.create(createInput());
	await handle.send("steer");
	await handle.markIdle?.();
	assert.deepEqual(fixture.delegate.messages, ["steer"]);
	assert.equal(fixture.delegate.idleCalls, 1);
	assert.equal(fixture.pool.snapshot().workerCount, 0);
});

test("cooperative interruption releases the lease without replacing its Worker", async (t) => {
	const fixture = runtimeFixture(t, { cooperativeInterruptTimeoutMs: 50 });
	const handle = await fixture.factory.create(createInput());
	const pending = deferred<AgentThreadRuntimeResult>();
	fixture.delegate.run = async () => await pending.promise;
	fixture.delegate.onInterrupt = () => { pending.resolve(completed("cooperative")); };
	const running = handle.run(
		"cooperate",
		new AbortController().signal,
		() => undefined,
		"turn-cooperative",
	);
	await waitFor(() => fixture.delegate.runCalls === 1);
	const before = fixture.pool.snapshot().workers[0];
	assert.ok(before);

	await handle.interrupt("cooperative");
	assert.deepEqual(await running, completed("cooperative"));
	assert.deepEqual(fixture.delegate.interrupts, ["cooperative"]);
	assert.deepEqual(fixture.delegate.forceInterrupts, []);
	assert.deepEqual(fixture.delegate.recoverInterrupts, ["cooperative"]);
	assert.deepEqual(fixture.delegate.recoveredTurnIds, ["turn-cooperative"]);
	const after = fixture.pool.snapshot().workers[0];
	assert.equal(after?.workerId, before.workerId);
	assert.equal(after?.workerGeneration, before.workerGeneration);
	assert.equal(after?.state, "idle");
});

test("fences and cleans up a non-cooperative target before replacing only its Worker", async (t) => {
	const fixture = runtimeFixture(t, {
		cooperativeInterruptTimeoutMs: 10,
		coordinatorCleanupTimeoutMs: 100,
	});
	const handle = await fixture.factory.create(createInput());
	const pending = deferred<AgentThreadRuntimeResult>();
	fixture.delegate.run = async () => await pending.promise;
	const sibling = await fixture.pool.acquire({
		priority: "background",
		source: "subagent",
		sessionId: "child-sibling",
		turnId: "turn-sibling",
	});
	const root = await fixture.pool.acquire({
		priority: "interactive",
		source: "root",
		sessionId: "root-1",
		turnId: "turn-root",
	});
	const running = handle.run(
		"ignore abort",
		new AbortController().signal,
		() => undefined,
		"turn-target",
	);
	await waitFor(() => (
		fixture.delegate.runCalls === 1
		&& fixture.pool.snapshot().workers.filter((worker) => worker.state === "leased").length === 3
	));
	const targetBefore = fixture.pool.snapshot().workers.find((worker) => (
		worker.leaseId !== sibling.leaseId && worker.leaseId !== root.leaseId
	));
	assert.ok(targetBefore);
	fixture.delegate.onForceInterrupt = () => {
		const snapshot = fixture.pool.snapshot();
		const target = snapshot.workers.find((worker) => worker.workerId === targetBefore.workerId);
		assert.equal(target?.state, "fenced");
		assert.equal(target?.leaseId, targetBefore.leaseId);
		assert.equal(snapshot.workers.some((worker) => (
			worker.workerId === sibling.workerId
			&& worker.workerGeneration === sibling.workerGeneration
			&& worker.leaseId === sibling.leaseId
			&& worker.state === "leased"
		)), true);
		assert.equal(snapshot.workers.some((worker) => (
			worker.workerId === root.workerId
			&& worker.workerGeneration === root.workerGeneration
			&& worker.leaseId === root.leaseId
			&& worker.state === "leased"
		)), true);
		pending.resolve({ status: "interrupted", report: "", usage: {} });
	};

	await handle.interrupt("targeted");
	assert.equal((await running).status, "interrupted");
	assert.deepEqual(fixture.delegate.interrupts, ["targeted"]);
	assert.deepEqual(fixture.delegate.forceInterrupts, ["targeted"]);
	const after = fixture.pool.snapshot();
	assert.equal(after.workers.some((worker) => (
		worker.workerId === sibling.workerId
		&& worker.workerGeneration === sibling.workerGeneration
		&& worker.leaseId === sibling.leaseId
	)), true);
	assert.equal(after.workers.some((worker) => (
		worker.workerId === root.workerId
		&& worker.workerGeneration === root.workerGeneration
		&& worker.leaseId === root.leaseId
	)), true);
	assert.equal(after.workers.some((worker) => (
		worker.workerId === targetBefore.workerId
		&& worker.workerGeneration > targetBefore.workerGeneration
		&& worker.state === "idle"
	)), true);
	await Promise.all([sibling.release(), root.release()]);
});

test("cleanup timeout still terminates and replaces the targeted Worker", async (t) => {
	const fixture = runtimeFixture(t, {
		cooperativeInterruptTimeoutMs: 10,
		coordinatorCleanupTimeoutMs: 10,
	});
	const handle = await fixture.factory.create(createInput());
	fixture.delegate.run = async () => await new Promise(() => undefined);
	fixture.delegate.onForceInterrupt = async () => await new Promise(() => undefined);
	void handle.run(
		"ignore cleanup",
		new AbortController().signal,
		() => undefined,
		"turn-timeout",
	);
	await waitFor(() => fixture.delegate.runCalls === 1);
	const before = fixture.pool.snapshot().workers[0];
	assert.ok(before);

	await handle.interrupt("cleanup timeout");
	assert.deepEqual(fixture.delegate.forceInterrupts, ["cleanup timeout"]);
	assert.deepEqual(fixture.delegate.recoverInterrupts, ["cleanup timeout"]);
	assert.deepEqual(fixture.delegate.recoveredTurnIds, ["turn-timeout"]);
	assert.equal(fixture.pool.snapshot().workers.some((worker) => (
		worker.workerId === before.workerId
		&& worker.workerGeneration > before.workerGeneration
		&& worker.state === "idle"
	)), true);
});

test("cleanup rejection uses durable recovery after targeted replacement", async (t) => {
	const fixture = runtimeFixture(t, {
		cooperativeInterruptTimeoutMs: 10,
		coordinatorCleanupTimeoutMs: 50,
	});
	const handle = await fixture.factory.create(createInput());
	fixture.delegate.run = async () => await new Promise(() => undefined);
	fixture.delegate.onForceInterrupt = async () => {
		throw new Error("cleanup failed");
	};
	void handle.run(
		"reject cleanup",
		new AbortController().signal,
		() => undefined,
		"turn-rejection",
	);
	await waitFor(() => fixture.delegate.runCalls === 1);

	await handle.interrupt("cleanup rejection");
	assert.deepEqual(fixture.delegate.forceInterrupts, ["cleanup rejection"]);
	assert.deepEqual(fixture.delegate.recoverInterrupts, ["cleanup rejection"]);
	assert.deepEqual(fixture.delegate.recoveredTurnIds, ["turn-rejection"]);
});

test("non-cooperative interruption fails closed without a cleanup capability", async (t) => {
	const fixture = runtimeFixture(t, {
		cooperativeInterruptTimeoutMs: 10,
		coordinatorCleanupTimeoutMs: 10,
		includeCleanupCapabilities: false,
	});
	const handle = await fixture.factory.create(createInput());
	const pending = deferred<AgentThreadRuntimeResult>();
	fixture.delegate.run = async () => await pending.promise;
	const running = handle.run(
		"missing cleanup",
		new AbortController().signal,
		() => undefined,
		"turn-missing-cleanup",
	);
	await waitFor(() => fixture.delegate.runCalls === 1);

	await assert.rejects(
		handle.interrupt("missing cleanup"),
		/agent_runtime_interrupt_cleanup_unavailable/u,
	);
	pending.resolve({ status: "interrupted", report: "", usage: {} });
	assert.equal((await running).status, "interrupted");
});

class DelegateHandle implements AgentThreadRuntimeHandle {
	runCalls = 0;
	mailboxCalls = 0;
	idleCalls = 0;
	readonly messages: string[] = [];
	readonly interrupts: string[] = [];
	readonly forceInterrupts: string[] = [];
	readonly recoverInterrupts: string[] = [];
	readonly recoveredTurnIds: string[] = [];
	readonly turnIds: string[] = [];
	readonly parentTurns: [string, string][] = [];
	readonly boundExecutors: Array<ProviderStepExecutor | undefined> = [];
	onInterrupt: (() => void | Promise<void>) | undefined;
	onForceInterrupt: (() => void | Promise<void>) | undefined;
	recoveryConfirmed = true;
	run: (
		prompt: string,
		signal: AbortSignal,
		emit: (event: AgentThreadRuntimeEvent) => void,
		turnId: string,
	) => Promise<AgentThreadRuntimeResult> = async () => completed("default");
	mailbox: (
		emit: (event: AgentThreadRuntimeEvent) => void,
	) => Promise<ReturnType<typeof completed>> = async () => completed("mailbox");

	async runMailbox(
		_signal: AbortSignal,
		emit: (event: AgentThreadRuntimeEvent) => void,
		turnId: string,
	) {
		this.mailboxCalls += 1;
		this.turnIds.push(turnId);
		return await this.mailbox(emit);
	}

	bindProviderStepExecutor(executor: ProviderStepExecutor | undefined): void {
		this.boundExecutors.push(executor);
	}

	async markIdle(): Promise<void> {
		this.idleCalls += 1;
	}

	async send(message: string): Promise<void> {
		this.messages.push(message);
	}

	async interrupt(reason: string): Promise<void> {
		this.interrupts.push(reason);
		await this.onInterrupt?.();
	}

	async forceInterrupt(reason: string): Promise<boolean> {
		this.forceInterrupts.push(reason);
		await this.onForceInterrupt?.();
		return this.recoveryConfirmed;
	}

	async recoverInterrupt(reason: string, turnId: string): Promise<boolean> {
		this.recoverInterrupts.push(reason);
		this.recoveredTurnIds.push(turnId);
		return this.recoveryConfirmed;
	}

	async close(): Promise<void> {}
}

function runtimeFixture(
	t: test.TestContext,
	options: Readonly<{
		cooperativeInterruptTimeoutMs?: number;
		coordinatorCleanupTimeoutMs?: number;
		includeCleanupCapabilities?: boolean;
	}> = {},
) {
	const pool = new AgentWorkerPool({ maxWorkers: 4, maxQueue: 4, idleTimeoutMs: 5_000 });
	const delegate = new DelegateHandle();
	const wrappedDelegate: AgentThreadRuntimeHandle = {
		bindParentTurn: (turnId, parentTurnId) => { delegate.parentTurns.push([turnId, parentTurnId]); },
		run: async (...args) => {
			delegate.runCalls += 1;
			delegate.turnIds.push(args[3]);
			return await delegate.run(...args);
		},
		runMailbox: (...args) => delegate.runMailbox(...args),
		bindProviderStepExecutor: (executor) => delegate.bindProviderStepExecutor(executor),
		markIdle: () => delegate.markIdle(),
		send: (message) => delegate.send(message),
		interrupt: (reason) => delegate.interrupt(reason),
		...(options.includeCleanupCapabilities === false ? {} : {
			forceInterrupt: (reason: string) => delegate.forceInterrupt(reason),
			recoverInterrupt: (reason: string, turnId: string) => (
				delegate.recoverInterrupt(reason, turnId)
			),
		}),
		close: () => delegate.close(),
	};
	const factory = new WorkerLeasedAgentThreadRuntimeFactory({
		pool,
		delegate: { create: async () => wrappedDelegate },
		...options,
	});
	t.after(async () => pool.close());
	return { pool, delegate, factory };
}

function createInput(
	overrides: Partial<AgentThreadRuntimeCreateInput> = {},
): AgentThreadRuntimeCreateInput {
	return {
		parentSessionId: "parent-1",
		parentTurnId: "parent-turn-1",
		childSessionId: "child-1",
		threadId: "child-1",
		rootThreadId: "root-1",
		parentThreadId: "root-1",
		path: "/root/child" as AgentThreadRuntimeCreateInput["path"],
		config: {
			forkTurns: "none",
			tools: [],
			provider: {
				provider: "openai",
				protocol: "responses",
				model: "test-model",
			},
			instructions: { project: "test" },
			executionPolicy: {
				trusted: true,
				permission: "workspace",
				sandboxMode: "workspace-write",
				filesystem: "workspace_write",
				network: "disabled",
				writableRoots: [],
			},
			environment: {},
			workspaceRoot: "/workspace",
			cwd: "/workspace",
		},
		tools: [],
		...overrides,
	};
}

function completed(report: string) {
	return Object.freeze({ status: "completed" as const, report, usage: Object.freeze({}) });
}

function deferred<Value>() {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((settle) => { resolve = settle; });
	return { promise, resolve };
}

async function waitFor(read: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!read()) {
		if (Date.now() >= deadline) throw new Error("timed_out_waiting_for_leased_runtime");
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}
