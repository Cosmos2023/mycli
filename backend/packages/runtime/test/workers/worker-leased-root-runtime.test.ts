import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import type { RuntimeEvent } from "@mycli/core";
import type { TurnReservation } from "@mycli/storage";
import {
	AgentWorkerPool,
	WorkerLeasedRootTurnRuntime,
	type ProviderStepExecutor,
} from "../../src/index.ts";
import type {
	ForceInterruptInput,
	ResolveApprovalInput,
	ResolveClarificationInput,
	SubmitTurnOptions,
	TurnSubmission,
} from "../../src/turns/node-turn-runtime.ts";

test("leases root submit as interactive work and releases the Worker", async (t) => {
	const fixture = rootRuntimeFixture(t);
	const turn = runningTurn("client-root", "turn-root");
	fixture.delegate.reservation = { kind: "reserved", turn };
	fixture.delegate.submit = async () => completedTurn("client-root", "turn-root");

	assert.deepEqual(await fixture.runtime.submit(
		submission("client-root", "turn-root"),
		() => undefined,
		{ signal: new AbortController().signal, reservation: fixture.delegate.reservation },
	), completedTurn("client-root", "turn-root"));
	assert.deepEqual(fixture.acquireInputs, [{
		priority: "interactive",
		source: "root",
		sessionId: "root-session",
		turnId: "turn-root",
	}]);
	assert.equal(fixture.delegate.boundExecutors.at(0) !== undefined, true);
	assert.equal(fixture.delegate.boundExecutors.at(-1), undefined);
	assert.equal(fixture.pool.snapshot().activeLeaseCount, 0);
});

test("reuses the durable continuation turn identity for approval and clarification", async (t) => {
	const fixture = rootRuntimeFixture(t);
	fixture.delegate.continuation = "turn-continuation";
	fixture.delegate.resolveApproval = async () => runningTurn("client-root", "turn-continuation");
	fixture.delegate.resolveClarification = async () => completedTurn(
		"client-root",
		"turn-continuation",
	);
	const signal = new AbortController().signal;

	await fixture.runtime.resolveApproval(
		{ decisionId: "decision-1", choice: "approve_once" },
		() => undefined,
		{ signal },
	);
	await fixture.runtime.resolveClarification(
		{ requestId: "request-1", response: "answer" },
		() => undefined,
		{ signal },
	);
	assert.deepEqual(fixture.acquireInputs.map((input) => input.turnId), [
		"turn-continuation",
		"turn-continuation",
	]);
	assert.equal(fixture.pool.snapshot().activeLeaseCount, 0);
});

test("live approval responses reuse the active root Worker lease", async (t) => {
	const fixture = rootRuntimeFixture(t);
	const completion = deferred<RuntimeTurnRecord>();
	fixture.delegate.submit = async () => completion.promise;
	const decisions: string[] = [];
	fixture.delegate.hasActiveApproval = (id) => !decisions.includes(id);
	fixture.delegate.respondActiveApproval = ({ decisionId }) => { decisions.push(decisionId); };
	const running = fixture.runtime.submit(submission("client-root", "turn-root"), () => undefined, {
		signal: new AbortController().signal, reservation: fixture.delegate.reservation,
	});
	await waitFor(() => fixture.pool.snapshot().activeLeaseCount === 1);
	for (const decisionId of ["call-first", "call-second"]) {
		assert.equal(fixture.runtime.hasActiveApproval(decisionId), true);
		fixture.runtime.respondActiveApproval({ decisionId, choice: "approve_once" });
		assert.equal(fixture.runtime.hasActiveApproval(decisionId), false);
	}
	assert.equal(fixture.acquireInputs.length, 1);
	assert.equal(fixture.pool.snapshot().activeLeaseCount, 1);
	assert.deepEqual(decisions, ["call-first", "call-second"]);
	completion.resolve(completedTurn("client-root", "turn-root"));
	await running;
	assert.equal(fixture.pool.snapshot().activeLeaseCount, 0);
});

test("cooperative root interruption releases without replacing its Worker", async (t) => {
	const fixture = rootRuntimeFixture(t, { cooperativeInterruptTimeoutMs: 100 });
	const pending = deferred<RuntimeTurnRecord>();
	fixture.delegate.reservation = {
		kind: "reserved",
		turn: runningTurn("client-root", "turn-root-cooperative"),
	};
	fixture.delegate.submit = async () => await pending.promise;
	fixture.delegate.forceInterrupt = async () => interruptedTurn(
		"client-root",
		"turn-root-cooperative",
	);
	const running = fixture.runtime.submit(
		submission("client-root", "turn-root-cooperative"),
		() => undefined,
		{
			signal: new AbortController().signal,
			reservation: fixture.delegate.reservation,
		},
	);
	await waitFor(() => fixture.pool.snapshot().workers.some((worker) => worker.state === "leased"));
	const before = fixture.pool.snapshot().workers[0];
	assert.ok(before);
	setTimeout(() => pending.resolve(interruptedTurn(
		"client-root",
		"turn-root-cooperative",
	)), 20);

	const interrupted = await fixture.runtime.forceInterrupt({
		clientTurnId: "client-root",
		turnId: "turn-root-cooperative",
	}, () => undefined);
	assert.equal(interrupted.status, "interrupted");
	assert.equal((await running).status, "interrupted");
	const after = fixture.pool.snapshot().workers[0];
	assert.equal(after?.workerId, before.workerId);
	assert.equal(after?.workerGeneration, before.workerGeneration);
	assert.equal(after?.state, "idle");
});

test("hard interruption fences and replaces only the active root Worker", async (t) => {
	const fixture = rootRuntimeFixture(t, {
		cooperativeInterruptTimeoutMs: 10,
		coordinatorCleanupTimeoutMs: 100,
	});
	const childOne = await fixture.pool.acquire({
		priority: "background",
		source: "subagent",
		sessionId: "child-one",
		turnId: "turn-child-one",
	});
	const childTwo = await fixture.pool.acquire({
		priority: "background",
		source: "subagent",
		sessionId: "child-two",
		turnId: "turn-child-two",
	});
	const pending = deferred<RuntimeTurnRecord>();
	fixture.delegate.reservation = {
		kind: "reserved",
		turn: runningTurn("client-root", "turn-root-interrupt"),
	};
	fixture.delegate.submit = async () => await pending.promise;
	fixture.delegate.forceInterrupt = async () => {
		const snapshot = fixture.pool.snapshot();
		const rootWorker = snapshot.workers.find((worker) => (
			worker.leaseId !== childOne.leaseId && worker.leaseId !== childTwo.leaseId
		));
		assert.equal(rootWorker?.state, "fenced");
		assert.equal(snapshot.workers.some((worker) => sameActiveLease(worker, childOne)), true);
		assert.equal(snapshot.workers.some((worker) => sameActiveLease(worker, childTwo)), true);
		pending.resolve(interruptedTurn("client-root", "turn-root-interrupt"));
		return interruptedTurn("client-root", "turn-root-interrupt");
	};
	const running = fixture.runtime.submit(
		submission("client-root", "turn-root-interrupt"),
		() => undefined,
		{
			signal: new AbortController().signal,
			reservation: fixture.delegate.reservation,
		},
	);
	await waitFor(() => fixture.pool.snapshot().workers.filter(
		(worker) => worker.state === "leased",
	).length === 3);
	const before = fixture.pool.snapshot().workers.find((worker) => (
		worker.leaseId !== childOne.leaseId && worker.leaseId !== childTwo.leaseId
	));
	assert.ok(before);

	const interrupted = await fixture.runtime.forceInterrupt({
		clientTurnId: "client-root",
		turnId: "turn-root-interrupt",
	}, () => undefined);
	assert.equal(interrupted.status, "interrupted");
	assert.equal((await running).status, "interrupted");
	await waitFor(() => {
		const snapshot = fixture.pool.snapshot();
		return snapshot.activeLeaseCount === 2
			&& snapshot.workers.some((worker) => worker.state === "idle")
			&& !snapshot.workers.some((worker) => (
				worker.workerId === before.workerId
				&& worker.workerGeneration === before.workerGeneration
			))
			&& snapshot.workers.some((worker) => sameActiveLease(worker, childOne))
			&& snapshot.workers.some((worker) => sameActiveLease(worker, childTwo));
	});
	await Promise.all([childOne.release(), childTwo.release()]);
});

test("durable completion wins after fencing while the fenced Worker is still replaced", async (t) => {
	const fixture = rootRuntimeFixture(t, {
		cooperativeInterruptTimeoutMs: 10,
		coordinatorCleanupTimeoutMs: 100,
	});
	const pending = deferred<RuntimeTurnRecord>();
	fixture.delegate.reservation = {
		kind: "reserved",
		turn: runningTurn("client-root", "turn-root-completed"),
	};
	fixture.delegate.submit = async () => await pending.promise;
	fixture.delegate.forceInterrupt = async () => {
		const completed = completedTurn("client-root", "turn-root-completed");
		pending.resolve(completed);
		return completed;
	};
	const running = fixture.runtime.submit(
		submission("client-root", "turn-root-completed"),
		() => undefined,
		{
			signal: new AbortController().signal,
			reservation: fixture.delegate.reservation,
		},
	);
	await waitFor(() => fixture.pool.snapshot().workers.some((worker) => worker.state === "leased"));
	const before = fixture.pool.snapshot().workers[0];
	assert.ok(before);

	const completed = await fixture.runtime.forceInterrupt({
		clientTurnId: "client-root",
		turnId: "turn-root-completed",
	}, () => undefined);
	assert.equal(completed.status, "completed");
	assert.equal((await running).status, "completed");
	await waitFor(() => {
		const snapshot = fixture.pool.snapshot();
		return snapshot.activeLeaseCount === 0
			&& snapshot.workers.some((worker) => worker.state === "idle")
			&& !snapshot.workers.some((worker) => (
				worker.workerId === before.workerId
				&& worker.workerGeneration === before.workerGeneration
			));
	});
});

test("hard interruption permits a new root turn before the old operation settles", async (t) => {
	const fixture = rootRuntimeFixture(t, {
		cooperativeInterruptTimeoutMs: 10,
		coordinatorCleanupTimeoutMs: 100,
	});
	const oldOperation = deferred<RuntimeTurnRecord>();
	const newOperation = deferred<RuntimeTurnRecord>();
	const oldSubmission = submission("client-old", "turn-old");
	const newSubmission = submission("client-new", "turn-new");
	fixture.delegate.submit = async (input) => input.turnId === "turn-old"
		? await oldOperation.promise
		: await newOperation.promise;
	const oldRun = fixture.runtime.submit(oldSubmission, () => undefined, {
		signal: new AbortController().signal,
		reservation: { kind: "reserved", turn: runningTurn("client-old", "turn-old") },
	});
	t.after(async () => {
		oldOperation.resolve(interruptedTurn("client-old", "turn-old"));
		newOperation.resolve(completedTurn("client-new", "turn-new"));
		await oldRun;
	});
	await waitFor(() => fixture.delegate.boundExecutors.length === 1);
	const interrupted = await fixture.runtime.forceInterrupt({
		clientTurnId: "client-old", turnId: "turn-old",
	}, () => undefined);
	assert.equal(interrupted.status, "interrupted");
	assert.equal((await oldRun).status, "interrupted");

	const newRun = fixture.runtime.submit(newSubmission, () => undefined, {
		signal: new AbortController().signal,
		reservation: { kind: "reserved", turn: runningTurn("client-new", "turn-new") },
	});
	const started = await Promise.race([
		newRun.then(() => "completed", (error: unknown) => error),
		waitFor(() => fixture.acquireInputs.length === 2).then(() => "started"),
	]);
	assert.equal(started, "started");
	await waitFor(() => fixture.delegate.boundExecutors.at(-1) !== undefined);
	const newExecutor = fixture.delegate.boundExecutors.at(-1);
	oldOperation.resolve(interruptedTurn("client-old", "turn-old"));
	await oldRun;
	await new Promise<void>((resolve) => { setImmediate(resolve); });
	assert.equal(fixture.delegate.boundExecutors.at(-1), newExecutor);
	newOperation.resolve(completedTurn("client-new", "turn-new"));
	assert.equal((await newRun).status, "completed");
	assert.equal(fixture.pool.snapshot().activeLeaseCount, 0);
});

test("Worker startup rejection delegates terminalization of the exact reserved turn", async () => {
	const delegate = new RootRuntimeDelegate();
	const controller = new AbortController();
	const failure = new Error("private worker startup detail");
	const reservation = delegate.reservation;
	const runtime = new WorkerLeasedRootTurnRuntime({
		sessionId: "root-session",
		runtime: delegate,
		pool: { acquire: async () => { throw failure; } },
	});
	let finalized = 0;
	delegate.submit = async () => { assert.fail("startup failure must not dispatch the turn"); };
	delegate.failReservedTurn = async (accepted, error, _emit, signal) => {
		finalized += 1;
		assert.equal(accepted, reservation);
		assert.equal(error, failure);
		assert.equal(signal, controller.signal);
		return interruptedTurn("client-root", "turn-root");
	};
	await runtime.submit(submission("client-root", "turn-root"), () => undefined, {
		signal: controller.signal, reservation,
	});
	assert.equal(finalized, 1);
	assert.equal(delegate.boundExecutors.length, 0);
});

test("durable recovery releases the root run when coordinator cleanup times out", async (t) => {
	const oldOperation = deferred<RuntimeTurnRecord>();
	const cleanup = deferred<RuntimeTurnRecord>();
	const terminal = interruptedTurn("client-old", "turn-old");
	const fixture = rootRuntimeFixture(t, {
		cooperativeInterruptTimeoutMs: 10,
		coordinatorCleanupTimeoutMs: 10,
		recoverInterrupt: () => terminal,
	});
	fixture.delegate.submit = async (input) => input.turnId === "turn-old"
		? await oldOperation.promise
		: completedTurn("client-new", "turn-new");
	fixture.delegate.forceInterrupt = async () => cleanup.promise;
	const running = fixture.runtime.submit(submission("client-old", "turn-old"), () => undefined, {
		signal: new AbortController().signal,
		reservation: { kind: "reserved", turn: runningTurn("client-old", "turn-old") },
	});
	t.after(() => {
		oldOperation.resolve(terminal);
		cleanup.resolve(terminal);
	});
	await waitFor(() => fixture.delegate.boundExecutors.length === 1);
	assert.equal(await fixture.runtime.forceInterrupt({
		clientTurnId: "client-old", turnId: "turn-old",
	}, () => undefined), terminal);
	assert.equal(await running, terminal);
	const followUp = await fixture.runtime.submit(submission("client-new", "turn-new"), () => undefined, {
		signal: new AbortController().signal,
		reservation: { kind: "reserved", turn: runningTurn("client-new", "turn-new") },
	});
	assert.equal(followUp.status, "completed");
	assert.equal(fixture.pool.snapshot().activeLeaseCount, 0);
});

test("cancellation during lease assignment releases the late lease without starting the turn", async (t) => {
	const pool = new AgentWorkerPool({ maxWorkers: 1, maxQueue: 1 });
	t.after(() => pool.close());
	const lease = await pool.acquire({
		priority: "interactive", source: "root", sessionId: "root-session", turnId: "turn-root",
	});
	const assigned = deferred<typeof lease>();
	const delegate = new RootRuntimeDelegate();
	const runtime = new WorkerLeasedRootTurnRuntime({
		sessionId: "root-session", runtime: delegate,
		pool: { acquire: async () => assigned.promise },
	});
	delegate.submit = async () => { assert.fail("cancelled assignment must not start the turn"); };
	delegate.failReservedTurn = async () => interruptedTurn("client-root", "turn-root");
	const controller = new AbortController();
	const running = runtime.submit(submission("client-root", "turn-root"), () => undefined, {
		signal: controller.signal, reservation: delegate.reservation,
	});
	controller.abort();
	assigned.resolve(lease);
	assert.equal((await running).status, "interrupted");
	assert.equal(delegate.boundExecutors.length, 0);
	assert.equal(pool.snapshot().activeLeaseCount, 0);
});

class RootRuntimeDelegate {
	readonly queueCoordinator = undefined;
	readonly boundExecutors: Array<ProviderStepExecutor | undefined> = [];
	continuation: string | undefined;
	hasActiveApproval: (decisionId: string) => boolean = () => false;
	respondActiveApproval: (input: ResolveApprovalInput) => void = () => undefined;
	reservation: TurnReservation = {
		kind: "reserved",
		turn: runningTurn("client-root", "turn-root"),
	};
	submit: (
		submission: TurnSubmission,
		emit: (event: RuntimeEvent) => void,
		options: SubmitTurnOptions,
	) => Promise<RuntimeTurnRecord> = async () => completedTurn("client-root", "turn-root");
	resolveApproval: (
		input: ResolveApprovalInput,
		emit: (event: RuntimeEvent) => void,
		options: Pick<SubmitTurnOptions, "signal">,
	) => Promise<RuntimeTurnRecord> = async () => completedTurn("client-root", "turn-root");
	resolveClarification: (
		input: ResolveClarificationInput,
		emit: (event: RuntimeEvent) => void,
		options: Pick<SubmitTurnOptions, "signal">,
	) => Promise<RuntimeTurnRecord> = async () => completedTurn("client-root", "turn-root");
	forceInterrupt: (
		input: ForceInterruptInput,
		emit: (event: RuntimeEvent) => void,
	) => Promise<RuntimeTurnRecord> = async (input) => interruptedTurn(
		input.clientTurnId,
		input.turnId,
	);
	failReservedTurn: (
		reservation: TurnReservation,
		error: unknown,
		emit: (event: RuntimeEvent) => void,
		signal: AbortSignal,
	) => Promise<RuntimeTurnRecord> = async (_reservation, error) => { throw error; };

	bindProviderStepExecutor(executor: ProviderStepExecutor | undefined): void {
		this.boundExecutors.push(executor);
	}

	continuationTurnId(): string | undefined {
		return this.continuation;
	}

	agentBudgetExhaustion(): undefined {
		return undefined;
	}

	configureExecutionPolicy(): void {}

	configureRuntimeContext(): void {}

	executionPolicySnapshot(): undefined {
		return undefined;
	}

	reserve(): TurnReservation {
		return this.reservation;
	}
}

function rootRuntimeFixture(
	t: test.TestContext,
	options: Readonly<{
		cooperativeInterruptTimeoutMs?: number;
		coordinatorCleanupTimeoutMs?: number;
		recoverInterrupt?: ConstructorParameters<typeof WorkerLeasedRootTurnRuntime>[0]["recoverInterrupt"];
	}> = {},
) {
	const pool = new AgentWorkerPool({ maxWorkers: 4, maxQueue: 4, idleTimeoutMs: 5_000 });
	const delegate = new RootRuntimeDelegate();
	const acquireInputs: Array<{
		readonly priority: "interactive" | "background";
		readonly source: "root" | "subagent";
		readonly sessionId: string;
		readonly turnId: string;
	}> = [];
	const runtime = new WorkerLeasedRootTurnRuntime({
		pool: {
			acquire: async (input) => {
				acquireInputs.push({
					priority: input.priority,
					source: input.source,
					sessionId: input.sessionId,
					turnId: input.turnId,
				});
				return await pool.acquire(input);
			},
		},
		runtime: delegate,
		sessionId: "root-session",
		...options,
	});
	t.after(async () => pool.close());
	return { pool, delegate, runtime, acquireInputs };
}

function submission(clientTurnId: string, turnId: string): TurnSubmission {
	return { clientTurnId, turnId, message: "root prompt" };
}

function runningTurn(clientTurnId: string, turnId: string): RuntimeTurnRecord {
	return turnRecord(clientTurnId, turnId, "in_progress");
}

function completedTurn(clientTurnId: string, turnId: string): RuntimeTurnRecord {
	return turnRecord(clientTurnId, turnId, "completed");
}

function interruptedTurn(clientTurnId: string, turnId: string): RuntimeTurnRecord {
	return turnRecord(clientTurnId, turnId, "interrupted");
}

function turnRecord(
	clientTurnId: string,
	turnId: string,
	status: RuntimeTurnRecord["status"],
): RuntimeTurnRecord {
	return {
		schema_version: 1,
		session_id: "root-session",
		client_turn_id: clientTurnId,
		turn_id: turnId,
		request_fingerprint: "root-request-fingerprint",
		status,
		error_code: status === "interrupted" ? "interrupted" : null,
		result: status === "completed"
			? { assistant_text: "root complete", usage: {} }
			: status === "interrupted" ? { message: "turn interrupted" } : null,
		started_at: "2026-08-13T00:00:00.000Z",
		completed_at: status === "in_progress" ? null : "2026-08-13T00:00:01.000Z",
	};
}

function deferred<Value>() {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((settle) => { resolve = settle; });
	return { promise, resolve };
}

function sameActiveLease(
	worker: ReturnType<AgentWorkerPool["snapshot"]>["workers"][number],
	lease: Awaited<ReturnType<AgentWorkerPool["acquire"]>>,
): boolean {
	return worker.workerId === lease.workerId
		&& worker.workerGeneration === lease.workerGeneration
		&& worker.leaseId === lease.leaseId
		&& worker.state === "leased";
}

async function waitFor(read: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!read()) {
		if (Date.now() >= deadline) throw new Error("timed_out_waiting_for_root_runtime");
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}
