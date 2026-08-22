import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import type { RuntimeEvent } from "@mycli/core";
import type { TurnReservation } from "@mycli/storage";
import {
	AgentWorkerPool,
	WorkerLeasedRootTurnRuntime,
	type ProviderStepExecutor,
} from "../src/index.ts";
import type {
	ForceInterruptInput,
	ResolveApprovalInput,
	ResolveClarificationInput,
	SubmitTurnOptions,
	TurnSubmission,
} from "../src/node-turn-runtime.ts";

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

class RootRuntimeDelegate {
	readonly queueCoordinator = undefined;
	readonly boundExecutors: Array<ProviderStepExecutor | undefined> = [];
	continuation: string | undefined;
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
