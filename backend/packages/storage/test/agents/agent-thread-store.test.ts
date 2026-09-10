import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	parseAgentPath,
	parseProviderRouteId,
	PROVIDER_IDS,
	rootAgentPath,
	type AgentSpawnConfigSnapshot,
} from "@mycli/core";
import Database from "better-sqlite3";
import {
	type AgentLifecycleFailpoint,
	SQLiteSessionStore,
	StorageFailure,
} from "../../src/index.ts";

const CREATED = "2026-08-08T00:00:00.000Z";
const UPDATED = "2026-08-08T00:00:01.000Z";
const COMPLETED = "2026-08-08T00:00:02.000Z";

test("reserves canonical paths atomically and rejects sibling collisions", async (t) => {
	const fixture = await storeFixture(t);
	const first = fixture.store.agentThreads.reserve(reserveInput("child-1", "tests"));
	const duplicate = fixture.store.agentThreads.reserve(reserveInput("child-1", "tests"));

	assert.equal(first.path, "/root/tests");
	assert.deepEqual(duplicate, first);
	assert.throws(
		() => fixture.store.agentThreads.reserve(reserveInput("child-2", "tests")),
		StorageFailure,
	);
	assert.deepEqual(
		fixture.store.agentThreads.list({ rootThreadId: "root-thread" }).map((item) => item.threadId),
		["child-1"],
	);

	const database = new Database(fixture.dbPath, { readonly: true });
	t.after(() => database.close());
	assert.equal(count(database, "agent_threads"), 1);
	assert.equal(count(database, "agent_spawn_edges"), 1);
});

test("round trips every curated provider in durable agent spawn configuration", async (t) => {
	const fixture = await storeFixture(t);
	const providers = PROVIDER_IDS.filter((candidate) => ![
		"openai", "codex", "compatible", "qwen", "deepseek", "anthropic",
	].includes(candidate));
	for (const [index, provider] of providers.entries()) {
		const threadId = `provider-child-${index}`;
		const reserved = fixture.store.agentThreads.reserve({
			...reserveInput(threadId, `provider-${index}`),
			spawnConfig: {
				...spawnConfig(),
				provider: { provider, protocol: "chat_completions", model: `${provider}-model` },
			},
		});
		assert.equal(reserved.spawnConfig?.provider.provider, provider);
		assert.equal(fixture.store.agentThreads.get(threadId)?.spawnConfig?.provider.provider, provider);
	}
});

test("round trips dynamic provider routes and rejects malformed agent spawn identities", async (t) => {
	const fixture = await storeFixture(t);
	const provider = parseProviderRouteId("cloudflare-ai-gateway");
	const reserved = fixture.store.agentThreads.reserve({
		...reserveInput("dynamic-provider-child", "dynamic-provider"),
		spawnConfig: {
			...spawnConfig(),
			provider: { provider, protocol: "chat_completions", model: "dynamic-model" },
		},
	});
	assert.equal(reserved.spawnConfig?.provider.provider, provider);
	assert.equal(
		fixture.store.agentThreads.get("dynamic-provider-child")?.spawnConfig?.provider.provider,
		provider,
	);

	const malformed = {
		...reserveInput("malformed-provider-child", "malformed-provider"),
		spawnConfig: {
			...spawnConfig(),
			provider: { provider: "Cloudflare", protocol: "chat_completions", model: "bad" },
		},
	} as unknown as Parameters<typeof fixture.store.agentThreads.reserve>[0];
	assert.throws(() => fixture.store.agentThreads.reserve(malformed), StorageFailure);
	assert.equal(fixture.store.agentThreads.get("malformed-provider-child"), undefined);
});

test("rolls back the agent thread when the paired task reservation fails", async (t) => {
	const fixture = await storeFixture(t);
	fixture.store.subagentTasks.reserve({
		taskId: "conflicting-task",
		parentSessionId: "other-parent",
		parentTurnId: "other-turn",
		childSessionId: "other-child",
		profileId: "subagent",
	});

	assert.throws(() => fixture.store.agentSpawns.reserve({
		thread: reserveInput("atomic-child", "atomic"),
		task: {
			taskId: "conflicting-task",
			parentSessionId: "parent-session",
			parentTurnId: "parent-turn",
			childSessionId: "atomic-child",
			profileId: "subagent",
		},
	}), StorageFailure);

	assert.equal(fixture.store.agentThreads.get("atomic-child"), undefined);
	assert.equal(fixture.store.agentThreads.getByPath("root-thread", parseAgentPath("/root/atomic")), undefined);
	const database = new Database(fixture.dbPath, { readonly: true });
	t.after(() => database.close());
	assert.equal(count(database, "agent_spawn_edges"), 0);
});

test("rolls back every paired agent lifecycle transition after the task write", async (t) => {
	let armed: AgentLifecycleFailpoint | undefined;
	const fixture = await storeFixture(t, (name) => {
		if (name === armed) throw new Error(`injected ${name}`);
	});
	const reserve = (suffix: string) => fixture.store.agentLifecycle.reserve({
		thread: reserveInput(`child-${suffix}`, suffix),
		task: {
			taskId: `task-${suffix}`,
			parentSessionId: "parent-session",
			parentTurnId: "parent-turn",
			childSessionId: `child-${suffix}`,
			profileId: "subagent",
		},
	});
	const ownership = (suffix: string) => ({
		taskId: `task-${suffix}`,
		parentSessionId: "parent-session",
		childSessionId: `child-${suffix}`,
	});

	reserve("activate");
	armed = "activate_after_task";
	assert.throws(() => fixture.store.agentLifecycle.activate(ownership("activate")));
	assert.equal(fixture.store.subagentTasks.get("task-activate")?.status, "queued");
	assert.equal(fixture.store.agentThreads.get("child-activate")?.status, "queued");
	armed = "interrupt_after_task";
	assert.throws(() => fixture.store.agentLifecycle.interruptRun({
		...ownership("activate"),
		reason: "cancel before start",
	}));
	assert.equal(fixture.store.subagentTasks.get("task-activate")?.status, "queued");
	assert.equal(fixture.store.agentThreads.get("child-activate")?.status, "queued");

	for (const scenario of [
		{
			suffix: "complete",
			failpoint: "complete_after_task" as const,
			run: () => fixture.store.agentLifecycle.completeRun({
				...ownership("complete"),
				report: "done",
			}),
		},
		{
			suffix: "fail",
			failpoint: "fail_after_task" as const,
			run: () => fixture.store.agentLifecycle.failRun({
				...ownership("fail"),
				error: "failed",
			}),
		},
		{
			suffix: "interrupt",
			failpoint: "interrupt_after_task" as const,
			run: () => fixture.store.agentLifecycle.interruptRun({
				...ownership("interrupt"),
				reason: "stopped",
			}),
		},
	] as const) {
		armed = undefined;
		reserve(scenario.suffix);
		fixture.store.agentLifecycle.activate(ownership(scenario.suffix));
		armed = scenario.failpoint;
		assert.throws(scenario.run);
		assert.equal(
			fixture.store.subagentTasks.get(`task-${scenario.suffix}`)?.status,
			"running",
		);
		assert.equal(
			fixture.store.agentThreads.get(`child-${scenario.suffix}`)?.status,
			"running",
		);
	}
});

test("interrupts a queued task and thread as one lifecycle transition", async (t) => {
	const fixture = await storeFixture(t);
	fixture.store.agentLifecycle.reserve({
		thread: reserveInput("queued-child", "queued"),
		task: {
			taskId: "queued-task",
			parentSessionId: "parent-session",
			parentTurnId: "parent-turn",
			childSessionId: "queued-child",
			profileId: "subagent",
		},
	});

	const interrupted = fixture.store.agentLifecycle.interruptRun({
		taskId: "queued-task",
		parentSessionId: "parent-session",
		childSessionId: "queued-child",
		reason: "cancel before start",
	});

	assert.equal(interrupted.task.status, "interrupted");
	assert.equal(interrupted.thread.status, "interrupted");
	assert.equal(fixture.store.subagentTasks.get("queued-task")?.status, "interrupted");
	assert.equal(fixture.store.agentThreads.get("queued-child")?.status, "interrupted");
});

test("rolls back follow-up reservation and activation as one operation", async (t) => {
	const armed: AgentLifecycleFailpoint = "follow_up_after_task";
	const fixture = await storeFixture(t, (name) => {
		if (name === armed) throw new Error(`injected ${name}`);
	});
	const first = fixture.store.agentLifecycle.reserve({
		thread: reserveInput("follow-up-child", "follow-up"),
		task: {
			taskId: "follow-up-task-1",
			parentSessionId: "parent-session",
			parentTurnId: "parent-turn-1",
			childSessionId: "follow-up-child",
			profileId: "subagent",
		},
	});
	fixture.store.agentLifecycle.activate({
		taskId: first.task.taskId,
		parentSessionId: first.task.parentSessionId,
		childSessionId: first.task.childSessionId,
	});
	fixture.store.agentLifecycle.completeRun({
		taskId: first.task.taskId,
		parentSessionId: first.task.parentSessionId,
		childSessionId: first.task.childSessionId,
		report: "first run complete",
	});

	assert.throws(() => fixture.store.agentLifecycle.startFollowUp({
		taskId: "follow-up-task-2",
		parentSessionId: "parent-session",
		parentTurnId: "parent-turn-2",
		childSessionId: "follow-up-child",
		profileId: "subagent",
		description: "continue",
	}));

	assert.equal(fixture.store.subagentTasks.get("follow-up-task-2"), undefined);
	assert.equal(fixture.store.agentThreads.get("follow-up-child")?.status, "idle");
});

test("persists legal lifecycle transitions and terminal state", async (t) => {
	const fixture = await storeFixture(t);
	fixture.store.agentThreads.reserve(reserveInput("child-1", "tests"));
	assert.equal(fixture.store.agentThreads.transition({
		threadId: "child-1",
		status: "running",
	}).status, "running");
	assert.equal(fixture.store.agentThreads.transition({
		threadId: "child-1",
		status: "idle",
	}).status, "idle");
	assert.equal(fixture.store.agentThreads.transition({
		threadId: "child-1",
		status: "unloaded",
	}).status, "unloaded");
	assert.equal(fixture.store.agentThreads.transition({
		threadId: "child-1",
		status: "running",
	}).status, "running");
	const completed = fixture.store.agentThreads.transition({
		threadId: "child-1",
		status: "completed",
		terminalSummary: "tests passed",
	});
	assert.equal(completed.terminalSummary, "tests passed");
	assert.equal(completed.completedAt, COMPLETED);
	assert.throws(
		() => fixture.store.agentThreads.transition({ threadId: "child-1", status: "running" }),
		StorageFailure,
	);
	assert.equal(fixture.store.agentThreads.get("child-1")?.status, "completed");
});

test("stores generation leases and protects another owner", async (t) => {
	const fixture = await storeFixture(t);
	fixture.store.agentThreads.reserve(reserveInput("child-1", "tests"));
	fixture.store.agentThreads.transition({ threadId: "child-1", status: "running" });
	const lease = fixture.store.agentThreads.saveLease({
		threadId: "child-1",
		generation: "generation-1",
		ownerId: "owner-1",
		ownerPid: 123,
		checkpoint: { kind: "tool_call", committed: false, turnId: "turn-1", callId: "call-1", mutating: true },
	});
	assert.equal(lease.checkpoint.kind, "tool_call");
	assert.equal(lease.checkpoint.mutating, true);
	assert.throws(() => fixture.store.agentThreads.saveLease({
		threadId: "child-1",
		generation: "generation-2",
		ownerId: "owner-2",
		ownerPid: 456,
		checkpoint: { kind: "idle", committed: true },
	}), StorageFailure);
	assert.equal(fixture.store.agentThreads.clearLease("child-1", "owner-2"), false);
	assert.equal(fixture.store.agentThreads.clearLease("child-1", "owner-1"), true);
	assert.equal(fixture.store.agentThreads.loadLease("child-1"), undefined);
});

test("startup reconciliation interrupts a stale uncommitted mutation without replay", async (t) => {
	const fixture = await storeFixture(t);
	fixture.store.agentThreads.reserve(reserveInput("stale-child", "stale"));
	fixture.store.agentThreads.transition({ threadId: "stale-child", status: "running" });
	const ownership = reserveAndStart(fixture.store, "stale-task", "stale-child");
	fixture.store.agentThreads.saveLease({
		threadId: "stale-child",
		generation: "stale-generation",
		ownerId: "dead-owner",
		ownerPid: 424_242,
		checkpoint: {
			kind: "tool_call",
			committed: false,
			turnId: "turn-stale",
			callId: "call-stale",
			mutating: true,
		},
	});
	fixture.store.close();

	const reopened = new SQLiteSessionStore({
		dbPath: fixture.dbPath,
		clock: () => COMPLETED,
		isProcessAlive: () => false,
	});
	t.after(() => reopened.close());
	assert.equal(reopened.agentThreads.get("stale-child")?.status, "interrupted");
	assert.equal(reopened.subagentTasks.get(ownership.taskId)?.status, "interrupted");
	assert.match(
		reopened.subagentTasks.get(ownership.taskId)?.payload.interruptionReason ?? "",
		/owner unavailable/u,
	);
	assert.equal(reopened.agentThreads.loadLease("stale-child"), undefined);
});

test("startup reconciliation restores completed work to idle and preserves live owners", async (t) => {
	const fixture = await storeFixture(t);
	fixture.store.agentThreads.reserve(reserveInput("completed-child", "completed"));
	fixture.store.agentThreads.transition({ threadId: "completed-child", status: "running" });
	const completed = reserveAndStart(fixture.store, "completed-task", "completed-child");
	fixture.store.agentThreads.saveLease({
		threadId: "completed-child",
		generation: "completed-generation",
		ownerId: "dead-completed-owner",
		ownerPid: 515_151,
		checkpoint: { kind: "provider_turn", committed: false, turnId: "completed-turn" },
	});
	fixture.store.subagentTasks.complete({ ...completed, report: "durably done" });

	fixture.store.agentThreads.reserve(reserveInput("live-child", "live"));
	fixture.store.agentThreads.transition({ threadId: "live-child", status: "running" });
	reserveAndStart(fixture.store, "live-task", "live-child");
	fixture.store.agentThreads.saveLease({
		threadId: "live-child",
		generation: "live-generation",
		ownerId: "live-owner",
		ownerPid: 616_161,
		checkpoint: { kind: "provider_turn", committed: false, turnId: "live-turn" },
	});
	fixture.store.close();

	const reopened = new SQLiteSessionStore({
		dbPath: fixture.dbPath,
		clock: () => COMPLETED,
		isProcessAlive: (processId) => processId === 616_161,
	});
	t.after(() => reopened.close());
	assert.equal(reopened.agentThreads.get("completed-child")?.status, "idle");
	assert.equal(reopened.subagentTasks.get("completed-task")?.status, "completed");
	assert.equal(reopened.agentThreads.loadLease("completed-child"), undefined);
	assert.equal(reopened.agentThreads.get("live-child")?.status, "running");
	assert.equal(reopened.subagentTasks.get("live-task")?.status, "running");
	assert.equal(reopened.agentThreads.loadLease("live-child")?.ownerId, "live-owner");
});

test("filters durable topology by canonical path prefix", async (t) => {
	const fixture = await storeFixture(t);
	fixture.store.agentThreads.reserve(reserveInput("child-a", "alpha"));
	fixture.store.agentThreads.reserve(reserveInput("child-b", "beta"));
	fixture.store.agentThreads.reserve({
		...reserveInput("grandchild", "review"),
		parentThreadId: "child-a",
		parentPath: parseAgentPath("/root/alpha"),
	});

	assert.deepEqual(
		fixture.store.agentThreads.list({
			rootThreadId: "root-thread",
			pathPrefix: parseAgentPath("/root/alpha"),
		}).map((item) => item.path),
		["/root/alpha", "/root/alpha/review"],
	);
});

test("projects legacy terminal tasks without reviving abandoned work", async (t) => {
	const fixture = await storeFixture(t);
	const completed = reserveAndStart(fixture.store, "legacy-completed", "legacy-child-completed");
	fixture.store.subagentTasks.complete({ ...completed, report: "legacy complete" });
	const failed = reserveAndStart(fixture.store, "legacy-failed", "legacy-child-failed");
	fixture.store.subagentTasks.fail({ ...failed, error: "legacy failed" });
	const interrupted = reserveAndStart(fixture.store, "legacy-interrupted", "legacy-child-interrupted");
	fixture.store.subagentTasks.interrupt({ ...interrupted, reason: "legacy interrupted" });
	fixture.store.close();

	const reopened = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: () => COMPLETED });
	t.after(() => reopened.close());
	const projected = reopened.agentThreads.list({ rootThreadId: "parent-session" });
	assert.deepEqual(projected.map((item) => item.status).sort(), ["completed", "failed", "interrupted"]);
	assert.deepEqual(
		projected.map((item) => item.sourceTaskId).sort(),
		["legacy-completed", "legacy-failed", "legacy-interrupted"],
	);
	assert.equal(projected.every((item) => item.spawnConfig === undefined), true);
	assert.equal(reopened.agentThreads.projectLegacyTasks(), 0);
});

function reserveInput(threadId: string, taskName: string) {
	return {
		threadId,
		rootThreadId: "root-thread",
		parentThreadId: "root-thread",
		parentPath: rootAgentPath(),
		taskName,
		profileId: "explore",
		spawnConfig: spawnConfig(),
	};
}

function spawnConfig(): AgentSpawnConfigSnapshot {
	return {
		workspaceRoot: "/workspace",
		cwd: "/workspace",
		environment: { PATH: "/usr/bin" },
		executionPolicy: {
			trusted: true,
			permission: "workspace",
			sandboxMode: "workspace-write",
			filesystem: "workspace_write",
			network: "enabled",
			networkDomains: ["api.example.com"],
			writableRoots: ["/workspace"],
		},
		provider: { provider: "openai", protocol: "responses", model: "test-model" },
		instructions: { project: "project instructions", role: "role instructions" },
		tools: ["Read", "Shell"],
		forkTurns: "none",
	};
}

function reserveAndStart(store: SQLiteSessionStore, taskId: string, childSessionId: string) {
	const ownership = { taskId, parentSessionId: "parent-session", childSessionId };
	store.subagentTasks.reserve({
		...ownership,
		parentTurnId: "parent-turn",
		profileId: "explore",
	});
	store.subagentTasks.markRunning(ownership);
	return ownership;
}

async function storeFixture(
	t: test.TestContext,
	agentLifecycleFailpoint?: (name: AgentLifecycleFailpoint) => void,
) {
	const root = await mkdtemp(join(tmpdir(), "mycli-agent-thread-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dbPath = join(root, "sessions.db");
	const timestamps = [CREATED, UPDATED, COMPLETED];
	let index = 0;
	const store = new SQLiteSessionStore({
		dbPath,
		clock: () => timestamps[Math.min(index++, timestamps.length - 1)] ?? COMPLETED,
		...(agentLifecycleFailpoint ? { agentLifecycleFailpoint } : {}),
	});
	t.after(() => {
		try {
			store.close();
		} catch {
			// The legacy projection test closes the initial store before reopening it.
		}
	});
	return { root, dbPath, store };
}

function count(database: Database.Database, table: string): number {
	return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: unknown }).count);
}
