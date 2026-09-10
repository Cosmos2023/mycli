import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	SQLiteSessionStore,
	StorageFailure,
	SUBAGENT_TASK_OUTPUT_REFERENCE_MAX_CHARS,
	SUBAGENT_TASK_REPORT_MAX_CHARS,
} from "../../src/index.ts";

const CREATED = "2026-08-06T00:00:00.000Z";
const UPDATED = "2026-08-06T00:00:01.000Z";
const COMPLETED = "2026-08-06T00:00:02.000Z";

test("subagent task store enforces queued running and terminal transitions", async (t) => {
	const { sessionStore } = await taskStoreFixture(t, [CREATED, UPDATED, COMPLETED]);
	const store = sessionStore.subagentTasks;
	const reservation = reserveInput("task-complete", "child-complete");
	const owner = {
		...reservation,
		mode: "background" as const,
		description: "Inspect repository",
	};

	assert.deepEqual(store.reserve(owner), {
		...reservation,
		status: "queued",
		progressSequence: 0,
		payload: { mode: "background", description: "Inspect repository" },
		createdAt: CREATED,
		updatedAt: CREATED,
	});
	assert.equal(store.markRunning(owner).status, "running");
	assert.equal(store.updateProgress({
		...ownership(owner),
		sequence: 1,
		summary: "Reading files",
		usage: { input_tokens: 10 },
	}).progressSequence, 1);
	assert.equal(store.updateProgress({
		...ownership(owner),
		sequence: 2,
		summary: "Preparing report",
	}).progressSequence, 2);
	const completed = store.complete({
		...ownership(owner),
		report: "Done",
		outputReference: "subagent://child-complete/output",
		usage: { input_tokens: 10, output_tokens: 3 },
	});

	assert.equal(completed.status, "completed");
	assert.equal(completed.completedAt, COMPLETED);
	assert.deepEqual(completed.payload, {
		mode: "background",
		description: "Inspect repository",
		progressSummary: "Preparing report",
		report: "Done",
		outputReference: "subagent://child-complete/output",
		usage: { input_tokens: 10, output_tokens: 3 },
	});

	const failed = reserveAndStart(store, reserveInput("task-failed", "child-failed"));
	assert.equal(store.fail({
		...ownership(failed),
		error: "provider failed",
	}).status, "failed");
	const interrupted = reserveAndStart(store, reserveInput("task-interrupted", "child-interrupted"));
	assert.equal(store.interrupt({
		...ownership(interrupted),
		reason: "parent shutdown",
	}).status, "interrupted");
});

test("subagent task store requires monotonic progress and exact ownership", async (t) => {
	const { sessionStore } = await taskStoreFixture(t);
	const store = sessionStore.subagentTasks;
	const input = reserveAndStart(store, reserveInput("task-owned", "child-owned"));

	store.updateProgress({ ...ownership(input), sequence: 1, summary: "one" });
	assert.throws(
		() => store.updateProgress({ ...ownership(input), sequence: 1, summary: "again" }),
		StorageFailure,
	);
	assert.throws(
		() => store.updateProgress({
			...ownership(input),
			parentSessionId: "other-parent",
			sequence: 2,
			summary: "wrong parent",
		}),
		StorageFailure,
	);
	assert.throws(
		() => store.complete({
			...ownership(input),
			childSessionId: "other-child",
			report: "wrong child",
		}),
		StorageFailure,
	);
});

test("subagent terminal writes are idempotent and bounded", async (t) => {
	const { sessionStore } = await taskStoreFixture(t);
	const store = sessionStore.subagentTasks;
	const input = reserveAndStart(store, reserveInput("task-terminal", "child-terminal"));
	const terminal = {
		...ownership(input),
		report: "Final report",
		outputReference: "subagent://child-terminal/output",
	};

	const first = store.complete(terminal);
	assert.deepEqual(store.complete(terminal), first);
	assert.throws(
		() => store.fail({ ...ownership(input), error: "late failure" }),
		StorageFailure,
	);

	const oversizedReport = reserveAndStart(store, reserveInput("task-report", "child-report"));
	assert.throws(() => store.complete({
		...ownership(oversizedReport),
		report: "x".repeat(SUBAGENT_TASK_REPORT_MAX_CHARS + 1),
	}), StorageFailure);
	assert.equal(store.get(oversizedReport.taskId)?.status, "running");

	const oversizedReference = reserveAndStart(store, reserveInput("task-ref", "child-ref"));
	assert.throws(() => store.complete({
		...ownership(oversizedReference),
		report: "ok",
		outputReference: "x".repeat(SUBAGENT_TASK_OUTPUT_REFERENCE_MAX_CHARS + 1),
	}), StorageFailure);
});

test("subagent task store interrupts only abandoned running tasks for the parent", async (t) => {
	const { sessionStore } = await taskStoreFixture(t);
	const store = sessionStore.subagentTasks;
	const abandoned = reserveAndStart(store, reserveInput("task-abandoned", "child-abandoned"));
	const other = reserveAndStart(store, {
		...reserveInput("task-other", "child-other"),
		parentSessionId: "other-parent",
	});
	const queued = store.reserve(reserveInput("task-queued", "child-queued"));

	assert.equal(store.interruptAbandoned(abandoned.parentSessionId, "restart"), 1);
	assert.equal(store.get(abandoned.taskId)?.status, "interrupted");
	assert.equal(store.get(other.taskId)?.status, "running");
	assert.equal(store.get(queued.taskId)?.status, "queued");
	assert.equal(store.interruptAbandoned(abandoned.parentSessionId, "restart"), 0);
});

test("subagent task payload parsing is bounded and fails closed", async (t) => {
	const fixture = await taskStoreFixture(t);
	const record = fixture.sessionStore.subagentTasks.reserve(
		reserveInput("task-corrupt", "child-corrupt"),
	);
	const database = new Database(fixture.dbPath);
	t.after(() => database.close());
	database.prepare("UPDATE subagent_tasks SET payload_json = ? WHERE task_id = ?")
		.run(JSON.stringify({ report: "x".repeat(SUBAGENT_TASK_REPORT_MAX_CHARS + 1) }), record.taskId);

	assert.throws(
		() => fixture.sessionStore.subagentTasks.get(record.taskId),
		StorageFailure,
	);
});

function reserveInput(taskId: string, childSessionId: string) {
	return {
		taskId,
		parentSessionId: "parent-session",
		parentTurnId: "parent-turn",
		childSessionId,
		profileId: "explore",
	};
}

function ownership(input: {
	readonly taskId: string;
	readonly parentSessionId: string;
	readonly childSessionId: string;
}) {
	return {
		taskId: input.taskId,
		parentSessionId: input.parentSessionId,
		childSessionId: input.childSessionId,
	};
}

function reserveAndStart(
	store: SQLiteSessionStore["subagentTasks"],
	input: ReturnType<typeof reserveInput>,
) {
	store.reserve(input);
	store.markRunning(input);
	return input;
}

async function taskStoreFixture(
	t: test.TestContext,
	timestamps: readonly string[] = [CREATED, UPDATED, COMPLETED],
) {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-subagent-tasks-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dbPath = join(root, "sessions.db");
	let index = 0;
	const sessionStore = new SQLiteSessionStore({
		dbPath,
		clock: () => timestamps[Math.min(index++, timestamps.length - 1)] ?? COMPLETED,
	});
	t.after(() => sessionStore.close());
	return { dbPath, sessionStore };
}
