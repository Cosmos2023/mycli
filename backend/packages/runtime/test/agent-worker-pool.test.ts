import assert from "node:assert/strict";
import test from "node:test";
import {
	AGENT_WORKER_TRANSPORT_MAX_BYTES,
	DEFAULT_AGENT_WORKER_RESOURCE_LIMITS,
	AgentWorkerMessageSizeError,
	AgentWorkerPool,
	AgentWorkerPoolCapacityError,
	AgentWorkerPoolClosedError,
	AgentWorkerPoolMemoryPressureError,
	AgentWorkerStartupError,
} from "../src/index.ts";

test("applies measured V8 limits and exposes redacted Worker resource metrics", async (t) => {
	const pool = new AgentWorkerPool({
		maxWorkers: 1,
		maxQueue: 1,
		warmWorkers: 1,
		idleTimeoutMs: 5_000,
		clock: () => "2026-08-13T00:00:00.000Z",
	});
	t.after(async () => pool.close());
	await pool.start();
	const lease = await pool.acquire({
		priority: "interactive",
		source: "root",
		sessionId: "private-session-content",
		turnId: "private-turn-content",
	});
	const metrics = await pool.metrics();

	assert.equal(metrics.capturedAt, "2026-08-13T00:00:00.000Z");
	assert.equal(metrics.workerCount, 1);
	assert.equal(metrics.activeLeaseCount, 1);
	assert.deepEqual(metrics.workers[0]?.resourceLimits, DEFAULT_AGENT_WORKER_RESOURCE_LIMITS);
	assert.ok((metrics.workers[0]?.heap?.usedBytes ?? 0) > 0);
	assert.ok((metrics.workers[0]?.heap?.limitBytes ?? 0) > 0);
	assert.ok((metrics.workers[0]?.eventLoop.utilization ?? -1) >= 0);
	assert.ok((metrics.workers[0]?.eventLoop.utilization ?? 2) <= 1);
	const serialized = JSON.stringify(metrics);
	assert.equal(serialized.includes("private-session-content"), false);
	assert.equal(serialized.includes("private-turn-content"), false);
	assert.equal(serialized.includes(lease.leaseId), false);
	assert.equal(serialized.includes(lease.jobId), false);
	await lease.release();
});

test("rejects oversized coordinator messages before structured clone", async (t) => {
	const pool = new AgentWorkerPool({
		maxWorkers: 1,
		maxQueue: 1,
		maxMessageBytes: 1_024,
		idleTimeoutMs: 5_000,
	});
	t.after(async () => pool.close());
	const lease = await pool.acquire(leaseInput("bounded-message", "interactive", "root"));

	assert.throws(
		() => lease.postMessage({ type: "oversized", content: "x".repeat(1_024) }),
		AgentWorkerMessageSizeError,
	);
	assert.equal(pool.snapshot().workers[0]?.state, "leased");
	await lease.release();
	assert.equal(pool.snapshot().workers[0]?.state, "idle");
	assert.throws(
		() => new AgentWorkerPool({ maxMessageBytes: AGENT_WORKER_TRANSPORT_MAX_BYTES + 1 }),
		/maxMessageBytes/u,
	);
});

test("clears lease message listeners during normal release", async (t) => {
	const pool = new AgentWorkerPool({
		maxWorkers: 1,
		maxQueue: 1,
		idleTimeoutMs: 5_000,
	});
	t.after(async () => pool.close());
	const lease = await pool.acquire(leaseInput("listener-release", "interactive", "root"));
	lease.onMessage(() => undefined);

	assert.equal((await pool.metrics()).workers[0]?.messageListenerCount, 1);
	await lease.release();
	assert.equal((await pool.metrics()).workers[0]?.messageListenerCount, 0);
});

test("recycles by job count only after the lease becomes idle", async (t) => {
	const pool = new AgentWorkerPool({
		maxWorkers: 1,
		maxQueue: 1,
		warmWorkers: 1,
		maxJobsPerWorker: 2,
		idleTimeoutMs: 5_000,
	});
	t.after(async () => pool.close());
	await pool.start();
	const first = await pool.acquire(leaseInput("job-one", "interactive", "root"));
	const identity = { workerId: first.workerId, generation: first.workerGeneration };
	await first.release();
	const second = await pool.acquire(leaseInput("job-two", "interactive", "root"));
	assert.equal(second.workerId, identity.workerId);
	assert.equal(second.workerGeneration, identity.generation);
	assert.equal(pool.snapshot().workers[0]?.state, "leased");
	await second.release();
	await waitFor(() => pool.snapshot().workers.some((worker) => (
		worker.workerId === identity.workerId
		&& worker.workerGeneration > identity.generation
		&& worker.state === "idle"
	)));
});

test("recycles by age after release without reclaiming an active lease", async (t) => {
	let now = 0;
	const pool = new AgentWorkerPool({
		maxWorkers: 1,
		maxQueue: 1,
		warmWorkers: 1,
		maxWorkerAgeMs: 100,
		idleTimeoutMs: 5_000,
		now: () => now,
	});
	t.after(async () => pool.close());
	await pool.start();
	const lease = await pool.acquire(leaseInput("aged", "interactive", "root"));
	now = 1_000;
	await new Promise<void>((resolve) => setTimeout(resolve, 20));
	assert.equal(pool.snapshot().workers[0]?.workerGeneration, lease.workerGeneration);
	assert.equal(pool.snapshot().workers[0]?.state, "leased");
	await lease.release();
	await waitFor(() => pool.snapshot().workers.some((worker) => (
		worker.workerId === lease.workerId
		&& worker.workerGeneration > lease.workerGeneration
		&& worker.state === "idle"
	)));
});

test("recycles a large-context Worker after release", async (t) => {
	const pool = new AgentWorkerPool({
		maxWorkers: 1,
		maxQueue: 1,
		warmWorkers: 1,
		maxMessageBytes: 4_096,
		largeContextBytes: 1_024,
		idleTimeoutMs: 5_000,
		workerUrl: new URL("./fixtures/agent-worker-late-message.mjs", import.meta.url),
	});
	t.after(async () => pool.close());
	await pool.start();
	const lease = await pool.acquire(leaseInput("large", "interactive", "root"));
	lease.postMessage({ type: "job_payload", content: "x".repeat(1_024) });
	assert.equal(pool.snapshot().workers[0]?.state, "leased");
	await lease.release();
	await waitFor(() => pool.snapshot().workers.some((worker) => (
		worker.workerId === lease.workerId
		&& worker.workerGeneration > lease.workerGeneration
		&& worker.state === "idle"
	)));
});

test("recycles retained heap growth after release", async (t) => {
	const pool = new AgentWorkerPool({
		maxWorkers: 1,
		maxQueue: 1,
		warmWorkers: 1,
		maxHeapGrowthBytes: 1024 * 1024,
		idleTimeoutMs: 5_000,
		workerUrl: new URL("./fixtures/agent-worker-heap-growth.mjs", import.meta.url),
	});
	t.after(async () => pool.close());
	await pool.start();
	const lease = await pool.acquire(leaseInput("heap", "interactive", "root"));
	lease.postMessage({ type: "grow_heap" });
	assert.equal(pool.snapshot().workers[0]?.state, "leased");
	await lease.release();
	await waitFor(() => pool.snapshot().workers.some((worker) => (
		worker.workerId === lease.workerId
		&& worker.workerGeneration > lease.workerGeneration
		&& worker.state === "idle"
	)), 5_000);
});

test("soft RSS pressure retires idle Workers and queues background work", async (t) => {
	let rssBytes = 0;
	const pool = new AgentWorkerPool({
		maxWorkers: 2,
		maxQueue: 2,
		warmWorkers: 2,
		idleTimeoutMs: 5_000,
		rssSoftLimitBytes: 100,
		rssHardLimitBytes: 200,
		rssPollIntervalMs: 10,
		readProcessRssBytes: () => rssBytes,
	});
	t.after(async () => pool.close());
	await pool.start();
	assert.equal(pool.snapshot().workerCount, 2);

	rssBytes = 150;
	await waitFor(() => pool.snapshot().workerCount === 0);
	const backgroundPromise = pool.acquire(leaseInput("soft-background", "background", "subagent"));
	await waitFor(() => pool.snapshot().queuedCount === 1);
	const interactive = await pool.acquire(leaseInput("soft-root", "interactive", "root"));
	assert.equal(pool.snapshot().queuedCount, 1);
	assert.equal(pool.snapshot().workers[0]?.state, "leased");
	await interactive.release();
	await waitFor(() => pool.snapshot().workerCount === 0);

	const pressuredMetrics = await pool.metrics();
	assert.deepEqual(pressuredMetrics.memoryPressure, {
		state: "soft",
		rssBytes: 150,
		softLimitBytes: 100,
		hardLimitBytes: 200,
		speculativeWarmingEnabled: false,
		retiredIdleWorkerCount: 3,
		rejectedLeaseCount: 0,
		rejectedBackgroundLeaseCount: 0,
	});
	rssBytes = 0;
	const background = await backgroundPromise;
	assert.equal(background.source, "subagent");
	assert.equal((await pool.metrics()).memoryPressure.state, "normal");
	await background.release();
});

test("hard RSS pressure preserves active leases and returns explicit capacity outcomes", async (t) => {
	let rssBytes = 0;
	const pool = new AgentWorkerPool({
		maxWorkers: 1,
		maxQueue: 3,
		warmWorkers: 1,
		idleTimeoutMs: 5_000,
		rssSoftLimitBytes: 100,
		rssHardLimitBytes: 200,
		rssPollIntervalMs: 10,
		readProcessRssBytes: () => rssBytes,
	});
	t.after(async () => pool.close());
	await pool.start();
	const active = await pool.acquire(leaseInput("hard-active", "interactive", "root"));
	const activeGeneration = active.workerGeneration;

	rssBytes = 150;
	const queuedBackground = pool.acquire(
		leaseInput("hard-queued", "background", "subagent"),
	);
	await waitFor(() => pool.snapshot().queuedCount === 1);
	rssBytes = 250;
	await assert.rejects(queuedBackground, AgentWorkerPoolMemoryPressureError);
	await assert.rejects(
		pool.acquire(leaseInput("hard-new", "background", "subagent")),
		(error: unknown) => error instanceof AgentWorkerPoolMemoryPressureError
			&& error.code === "agent_worker_pool_memory_pressure"
			&& error.pressure === "hard"
			&& error.outcome === "hard_capacity"
			&& error.rssBytes === 250
			&& error.limitBytes === 200,
	);
	await assert.rejects(
		pool.acquire(leaseInput("hard-root", "interactive", "root")),
		AgentWorkerPoolMemoryPressureError,
	);
	assert.equal(pool.snapshot().workers[0]?.workerGeneration, activeGeneration);
	assert.equal(pool.snapshot().workers[0]?.state, "leased");
	const pressuredMetrics = await pool.metrics();
	assert.equal(pressuredMetrics.memoryPressure.state, "hard");
	assert.equal(pressuredMetrics.memoryPressure.rejectedLeaseCount, 3);
	assert.equal(pressuredMetrics.memoryPressure.rejectedBackgroundLeaseCount, 2);
	assert.equal(pressuredMetrics.memoryPressure.speculativeWarmingEnabled, false);

	await active.release();
	await waitFor(() => pool.snapshot().workerCount === 0);
	rssBytes = 0;
	const recovered = await pool.acquire(leaseInput("hard-recovered", "interactive", "root"));
	assert.ok(recovered.workerGeneration > activeGeneration);
	await recovered.release();
});

test("soft RSS pressure bounds background queue waiting with an explicit outcome", async (t) => {
	let now = 0;
	const pool = new AgentWorkerPool({
		maxWorkers: 1,
		maxQueue: 1,
		idleTimeoutMs: 5_000,
		rssSoftLimitBytes: 100,
		rssHardLimitBytes: 200,
		rssPollIntervalMs: 10,
		softPressureQueueTimeoutMs: 50,
		readProcessRssBytes: () => 150,
		now: () => now,
	});
	t.after(async () => pool.close());
	const queued = pool.acquire(leaseInput("soft-timeout", "background", "subagent"));
	await waitFor(() => pool.snapshot().queuedCount === 1);
	now = 50;
	await assert.rejects(
		queued,
		(error: unknown) => error instanceof AgentWorkerPoolMemoryPressureError
			&& error.pressure === "soft"
			&& error.outcome === "soft_queue_timeout"
			&& error.rssBytes === 150
			&& error.limitBytes === 100,
	);
	const metrics = await pool.metrics();
	assert.equal(metrics.memoryPressure.rejectedLeaseCount, 1);
	assert.equal(metrics.memoryPressure.rejectedBackgroundLeaseCount, 1);
});

test("hard RSS pressure permits interactive reuse without Worker expansion", async (t) => {
	let rssBytes = 0;
	const pool = new AgentWorkerPool({
		maxWorkers: 2,
		maxQueue: 2,
		warmWorkers: 1,
		idleTimeoutMs: 5_000,
		rssSoftLimitBytes: 100,
		rssHardLimitBytes: 200,
		readProcessRssBytes: () => rssBytes,
	});
	t.after(async () => pool.close());
	await pool.start();
	assert.equal(pool.snapshot().workerCount, 1);

	rssBytes = 250;
	const lease = await pool.acquire(leaseInput("hard-idle-root", "interactive", "root"));
	assert.equal(pool.snapshot().workerCount, 1);
	assert.equal(pool.snapshot().workers[0]?.workerGeneration, lease.workerGeneration);
	assert.equal((await pool.metrics()).memoryPressure.state, "hard");
	await lease.release();
	await waitFor(() => pool.snapshot().workerCount === 0);
});

test("leases four distinct Workers to one root and three children", async (t) => {
	const pool = new AgentWorkerPool({ maxWorkers: 4, maxQueue: 4, idleTimeoutMs: 50 });
	t.after(async () => pool.close());
	assert.equal(pool.snapshot().workerCount, 0);

	const leases = await Promise.all([
		pool.acquire(leaseInput("root", "interactive", "root")),
		pool.acquire(leaseInput("child-1", "background", "subagent")),
		pool.acquire(leaseInput("child-2", "background", "subagent")),
		pool.acquire(leaseInput("child-3", "background", "subagent")),
	]);

	assert.equal(new Set(leases.map((lease) => lease.workerId)).size, 4);
	assert.equal(new Set(leases.map((lease) => lease.threadId)).size, 4);
	assert.equal(new Set(leases.map((lease) => lease.leaseId)).size, 4);
	assert.equal(pool.snapshot().activeLeaseCount, 4);

	await Promise.all(leases.map(async (lease) => lease.release()));
	await waitFor(() => pool.snapshot().workerCount === 0);
	assert.equal(pool.snapshot().activeLeaseCount, 0);
});

test("prioritizes interactive root work and preserves FIFO within a priority", async (t) => {
	const pool = new AgentWorkerPool({ maxWorkers: 1, maxQueue: 4, idleTimeoutMs: 5_000 });
	t.after(async () => pool.close());
	const active = await pool.acquire(leaseInput("active", "background", "subagent"));
	const order: string[] = [];
	const childOnePromise = pool.acquire(leaseInput("child-1", "background", "subagent"))
		.then((lease) => { order.push("child-1"); return lease; });
	const childTwoPromise = pool.acquire(leaseInput("child-2", "background", "subagent"))
		.then((lease) => { order.push("child-2"); return lease; });
	const rootPromise = pool.acquire(leaseInput("root", "interactive", "root"))
		.then((lease) => { order.push("root"); return lease; });

	await active.release();
	const root = await rootPromise;
	assert.deepEqual(order, ["root"]);
	await root.release();
	const childOne = await childOnePromise;
	assert.deepEqual(order, ["root", "child-1"]);
	await childOne.release();
	const childTwo = await childTwoPromise;
	assert.deepEqual(order, ["root", "child-1", "child-2"]);
	await childTwo.release();
});

test("rejects work beyond bounded active and queued capacity", async (t) => {
	const pool = new AgentWorkerPool({ maxWorkers: 1, maxQueue: 2, idleTimeoutMs: 5_000 });
	t.after(async () => pool.close());
	const active = await pool.acquire(leaseInput("active", "interactive", "root"));
	const firstQueued = pool.acquire(leaseInput("queued-1", "background", "subagent"));
	const secondQueued = pool.acquire(leaseInput("queued-2", "background", "subagent"));

	await assert.rejects(
		pool.acquire(leaseInput("rejected", "background", "subagent")),
		AgentWorkerPoolCapacityError,
	);
	assert.equal(pool.snapshot().queuedCount, 2);

	await active.release();
	const first = await firstQueued;
	await first.release();
	const second = await secondQueued;
	await second.release();
});

test("starts configured warm capacity and grows lazily", async (t) => {
	const pool = new AgentWorkerPool({
		maxWorkers: 3,
		maxQueue: 3,
		warmWorkers: 1,
		idleTimeoutMs: 50,
	});
	t.after(async () => pool.close());
	await pool.start();
	assert.equal(pool.snapshot().workerCount, 1);
	assert.equal(pool.snapshot().activeLeaseCount, 0);

	const leases = await Promise.all([
		pool.acquire(leaseInput("root", "interactive", "root")),
		pool.acquire(leaseInput("child-1", "background", "subagent")),
		pool.acquire(leaseInput("child-2", "background", "subagent")),
	]);
	assert.equal(pool.snapshot().workerCount, 3);
	await Promise.all(leases.map(async (lease) => lease.release()));
	await waitFor(() => pool.snapshot().workerCount === 1);
});

test("targeted termination fences one lease and replaces its Worker generation", async (t) => {
	const pool = new AgentWorkerPool({ maxWorkers: 2, maxQueue: 2, idleTimeoutMs: 5_000 });
	t.after(async () => pool.close());
	const target = await pool.acquire(leaseInput("target", "background", "subagent"));
	const sibling = await pool.acquire(leaseInput("sibling", "background", "subagent"));
	const targetIdentity = {
		workerId: target.workerId,
		workerGeneration: target.workerGeneration,
	};

	await target.terminate("non-cooperative turn");
	assert.deepEqual(await target.failure, {
		code: "worker_terminated",
		message: "non-cooperative turn",
	});
	assert.equal(pool.snapshot().workers.some((worker) => (
		worker.workerId === sibling.workerId && worker.leaseId === sibling.leaseId
	)), true);
	await waitFor(() => pool.snapshot().workers.some((worker) => (
		worker.workerId === targetIdentity.workerId
		&& worker.workerGeneration > targetIdentity.workerGeneration
		&& worker.state === "idle"
	)));

	const replacement = await pool.acquire(leaseInput("replacement", "background", "subagent"));
	assert.equal(replacement.workerId, targetIdentity.workerId);
	assert.ok(replacement.workerGeneration > targetIdentity.workerGeneration);
	await Promise.all([sibling.release(), replacement.release()]);
});

test("fenced leases discard malformed late Worker frames until targeted termination", async (t) => {
	const pool = new AgentWorkerPool({
		maxWorkers: 1,
		maxQueue: 1,
		idleTimeoutMs: 5_000,
		workerUrl: new URL("./fixtures/agent-worker-late-message.mjs", import.meta.url),
	});
	t.after(async () => pool.close());
	const lease = await pool.acquire(leaseInput("late", "background", "subagent"));
	let effects = 0;
	lease.onMessage(() => { effects += 1; });
	lease.postMessage({ type: "emit_late" });
	await lease.fence("late frame test");
	await new Promise<void>((resolve) => { setTimeout(resolve, 30); });

	assert.equal(effects, 0);
	assert.equal(pool.snapshot().workers.some((worker) => (
		worker.workerId === lease.workerId
		&& worker.workerGeneration === lease.workerGeneration
		&& worker.state === "fenced"
	)), true);
	await lease.terminate("late frame test");
	assert.equal(pool.snapshot().workers.some((worker) => (
		worker.workerId === lease.workerId
		&& worker.workerGeneration > lease.workerGeneration
		&& worker.state === "idle"
	)), true);
});

test("protocol failure invalidates the active lease and replaces the Worker", async (t) => {
	const pool = new AgentWorkerPool({ maxWorkers: 1, maxQueue: 1, idleTimeoutMs: 5_000 });
	t.after(async () => pool.close());
	const lease = await pool.acquire(leaseInput("fault", "background", "subagent"));
	lease.postMessage({ type: "unsupported_control" });

	assert.deepEqual(await lease.failure, {
		code: "worker_failed",
		message: "worker protocol failure",
	});
	await waitFor(() => pool.snapshot().workers.some((worker) => (
		worker.workerId === lease.workerId
		&& worker.workerGeneration > lease.workerGeneration
		&& worker.state === "idle"
	)));
});

test("reuses a replacement generation after a leased Worker crashes", async (t) => {
	const pool = new AgentWorkerPool({
		maxWorkers: 1,
		maxQueue: 1,
		idleTimeoutMs: 5_000,
		workerUrl: new URL("./fixtures/agent-worker-crash.mjs", import.meta.url),
	});
	t.after(async () => pool.close());
	const crashed = await pool.acquire(leaseInput("crash", "background", "subagent"));
	crashed.postMessage({ type: "crash" });

	assert.deepEqual(await crashed.failure, {
		code: "worker_failed",
		message: "worker failed",
	});
	await waitFor(() => pool.snapshot().workers.some((worker) => (
		worker.workerId === crashed.workerId
		&& worker.workerGeneration > crashed.workerGeneration
		&& worker.state === "idle"
	)));

	const replacement = await pool.acquire(leaseInput("after-crash", "background", "subagent"));
	assert.equal(replacement.workerId, crashed.workerId);
	assert.ok(replacement.workerGeneration > crashed.workerGeneration);
	await replacement.release();
	assert.equal(pool.snapshot().workers[0]?.state, "idle");
});

test("bounds Worker startup and removes an unready instance", async (t) => {
	const pool = new AgentWorkerPool({
		maxWorkers: 1,
		maxQueue: 0,
		startupTimeoutMs: 20,
		shutdownTimeoutMs: 20,
		idleTimeoutMs: 5_000,
		workerUrl: new URL("./fixtures/agent-worker-never-ready.mjs", import.meta.url),
	});
	t.after(async () => pool.close());
	const startedAt = Date.now();
	await assert.rejects(
		pool.acquire(leaseInput("unready", "interactive", "root")),
		AgentWorkerStartupError,
	);
	assert.ok(Date.now() - startedAt < 1_000);
	assert.equal(pool.snapshot().workerCount, 0);
});

test("bounds release cleanup and replaces an unresponsive Worker", async (t) => {
	const pool = new AgentWorkerPool({
		maxWorkers: 1,
		maxQueue: 1,
		startupTimeoutMs: 100,
		shutdownTimeoutMs: 20,
		idleTimeoutMs: 5_000,
		workerUrl: new URL("./fixtures/agent-worker-stubborn-release.mjs", import.meta.url),
	});
	t.after(async () => pool.close());
	const lease = await pool.acquire(leaseInput("stubborn", "background", "subagent"));
	const startedAt = Date.now();
	await assert.rejects(lease.release(), AgentWorkerPoolClosedError);
	assert.ok(Date.now() - startedAt < 1_000);
	assert.deepEqual(await lease.failure, {
		code: "worker_failed",
		message: "worker release failed",
	});
	await waitFor(() => pool.snapshot().workers.some((worker) => (
		worker.workerId === lease.workerId
		&& worker.workerGeneration > lease.workerGeneration
		&& worker.state === "idle"
	)));
});

function leaseInput(
	id: string,
	priority: "interactive" | "background",
	source: "root" | "subagent",
) {
	return Object.freeze({
		priority,
		source,
		sessionId: `session-${id}`,
		turnId: `turn-${id}`,
	});
}

async function waitFor(read: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!read()) {
		if (Date.now() >= deadline) throw new Error("timed_out_waiting_for_agent_worker_pool");
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}
