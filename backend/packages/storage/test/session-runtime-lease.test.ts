import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rootAgentPath } from "@mycli/core";
import Database from "better-sqlite3";
import {
	openRuntimeSessionStore,
	SessionInUseError,
} from "../src/index.ts";

test("session runtime leases reject live owners and permit stale-owner takeover", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-session-runtime-lease-"));
	const dbPath = join(root, "sessions.db");
	const liveProcesses = new Set([101, 202, 303]);
	const isProcessAlive = (processId: number): boolean => liveProcesses.has(processId);
	const first = openRuntimeSessionStore({
		dbPath,
		ownerId: "owner-first",
		processId: 101,
		isProcessAlive,
	});
	const second = openRuntimeSessionStore({
		dbPath,
		ownerId: "owner-second",
		processId: 202,
		isProcessAlive,
	});
	const third = openRuntimeSessionStore({
		dbPath,
		ownerId: "owner-third",
		processId: 303,
		isProcessAlive,
	});
	t.after(() => {
		first.close();
		second.close();
		third.close();
	});
	t.after(() => rm(root, { recursive: true, force: true }));

	assert.equal(first.acquireSessionLease("virtual-session"), true);
	assert.equal(first.acquireSessionLease("virtual-session"), false);
	assert.throws(
		() => second.acquireSessionLease("virtual-session"),
		(error: unknown) => error instanceof SessionInUseError
			&& error.code === "session_in_use",
	);

	liveProcesses.delete(101);
	assert.equal(second.acquireSessionLease("virtual-session"), true);
	first.releaseSessionLease("virtual-session");
	assert.throws(
		() => third.acquireSessionLease("virtual-session"),
		(error: unknown) => error instanceof SessionInUseError,
	);

	second.close();
	assert.equal(third.acquireSessionLease("virtual-session"), true);
});

test("session maintenance preserves runtime leases and reclaims unowned rows", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-session-runtime-maintenance-"));
	const dbPath = join(root, "sessions.db");
	const liveProcesses = new Set([101, 202, 303]);
	const isProcessAlive = (processId: number): boolean => liveProcesses.has(processId);
	const liveOwner = openRuntimeSessionStore({
		dbPath,
		ownerId: "owner-live",
		processId: 101,
		isProcessAlive,
	});
	const staleOwner = openRuntimeSessionStore({
		dbPath,
		ownerId: "owner-stale",
		processId: 303,
		isProcessAlive,
	});
	t.after(() => {
		liveOwner.close();
		staleOwner.close();
	});
	t.after(() => rm(root, { recursive: true, force: true }));

	liveOwner.acquireSessionLease("live-empty");
	liveOwner.acquireSessionLease("live-virtual");
	staleOwner.acquireSessionLease("stale-empty");
	const database = new Database(dbPath);
	try {
		database.pragma("foreign_keys = OFF");
		const insertSession = database.prepare(`
			INSERT INTO sessions (
				session_id, workspace_root, thread_id, created_at,
				updated_at, last_active_at, status
			) VALUES (?, '/workspace', ?, ?, ?, ?, 'active')
		`);
		for (const sessionId of ["live-empty", "stale-empty", "unowned-empty"]) {
			insertSession.run(
				sessionId,
				sessionId,
				"2026-08-25T00:00:00.000Z",
				"2026-08-25T00:00:00.000Z",
				"2026-08-25T00:00:00.000Z",
			);
		}
		database.prepare(`
			INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
			VALUES
				('live-virtual', 'turn_record', '{}', '2026-08-25T00:00:00.000Z'),
				('unowned-orphan', 'turn_record', '{}', '2026-08-25T00:00:00.000Z')
		`).run();
	} finally {
		database.close();
	}

	liveProcesses.delete(303);
	const maintainer = openRuntimeSessionStore({
		dbPath,
		ownerId: "owner-maintainer",
		processId: 202,
		isProcessAlive,
	});
	t.after(() => maintainer.close());

	assert.deepEqual(
		maintainer.sessionMaintenanceReport({ workspaceRoot: "/workspace" })
			.emptySessionCandidates.map((candidate) => candidate.sessionId),
		["stale-empty", "unowned-empty"],
	);
	assert.deepEqual(
		maintainer.cleanupEmptySessions({ workspaceRoot: "/workspace" }).deletedSessionIds,
		["stale-empty", "unowned-empty"],
	);
	assert.ok(maintainer.loadSession("live-empty"));
	assert.equal(maintainer.loadSession("stale-empty"), undefined);
	assert.equal(maintainer.loadSession("unowned-empty"), undefined);

	const orphaned = maintainer.cleanupOrphanedSessionRows();
	assert.equal(orphaned.totalDeletedRows, 1);
	assert.deepEqual(maintainer.loadState("live-virtual", "turn_record"), {});
	assert.equal(maintainer.loadState("unowned-orphan", "turn_record"), undefined);
	const verify = new Database(dbPath, { readonly: true });
	try {
		assert.equal(Number((verify.prepare(`
			SELECT COUNT(*) AS count FROM session_runtime_leases
			WHERE owner_id = 'owner-stale'
		`).get() as { readonly count: unknown }).count), 1);
	} finally {
		verify.close();
	}
	assert.equal(maintainer.acquireSessionLease("stale-empty"), true);
	maintainer.releaseSessionLease("stale-empty");
	const afterTakeover = new Database(dbPath, { readonly: true });
	try {
		assert.equal(Number((afterTakeover.prepare(`
			SELECT COUNT(*) AS count FROM session_runtime_leases
			WHERE session_id = 'stale-empty'
		`).get() as { readonly count: unknown }).count), 0);
	} finally {
		afterTakeover.close();
	}
});

test("live subagent runtime leases block root-session ownership", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-subagent-session-lease-"));
	const dbPath = join(root, "sessions.db");
	const isProcessAlive = (processId: number): boolean => processId === 404;
	const subagentOwner = openRuntimeSessionStore({
		dbPath,
		ownerId: "parent-window",
		processId: 101,
		isProcessAlive,
	});
	const rootWindow = openRuntimeSessionStore({
		dbPath,
		ownerId: "root-window",
		processId: 202,
		isProcessAlive,
	});
	t.after(() => {
		subagentOwner.close();
		rootWindow.close();
	});
	t.after(() => rm(root, { recursive: true, force: true }));

	subagentOwner.agentThreads.reserve({
		threadId: "child-session",
		rootThreadId: "parent-session",
		parentThreadId: "parent-session",
		parentPath: rootAgentPath(),
		taskName: "child",
		profileId: "explore",
		spawnConfig: {
			workspaceRoot: "/workspace",
			cwd: "/workspace",
			environment: {},
			executionPolicy: {
				trusted: true,
				permission: "workspace",
				sandboxMode: "workspace-write",
				filesystem: "workspace_write",
				network: "disabled",
				writableRoots: ["/workspace"],
			},
			provider: { provider: "openai", protocol: "responses", model: "test-model" },
			instructions: { project: "project", role: "child" },
			tools: ["Read"],
			forkTurns: "none",
		},
	});
	subagentOwner.agentThreads.transition({ threadId: "child-session", status: "running" });
	subagentOwner.agentThreads.saveLease({
		threadId: "child-session",
		generation: "generation-child",
		ownerId: "agent-runtime-child",
		ownerPid: 404,
		checkpoint: { kind: "provider_turn", committed: false, turnId: "turn-child" },
	});

	assert.throws(
		() => rootWindow.acquireSessionLease("child-session"),
		(error: unknown) => error instanceof SessionInUseError,
	);
	assert.equal(
		subagentOwner.agentThreads.clearLease("child-session", "agent-runtime-child"),
		true,
	);
	assert.equal(rootWindow.acquireSessionLease("child-session"), true);
});

test("fork creation atomically owns its target session", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-fork-session-lease-"));
	const dbPath = join(root, "sessions.db");
	const liveProcesses = new Set([101, 202]);
	const isProcessAlive = (processId: number): boolean => liveProcesses.has(processId);
	const targetOwner = openRuntimeSessionStore({
		dbPath,
		ownerId: "target-window",
		processId: 101,
		isProcessAlive,
	});
	const forkingWindow = openRuntimeSessionStore({
		dbPath,
		ownerId: "forking-window",
		processId: 202,
		isProcessAlive,
	});
	t.after(() => {
		targetOwner.close();
		forkingWindow.close();
	});
	t.after(() => rm(root, { recursive: true, force: true }));

	forkingWindow.importLegacyConversation({
		sessionId: "source-session",
		workspaceRoot: "/workspace",
		threadId: "source-session",
		messages: [{ role: "user", content: "source" }],
	});
	targetOwner.acquireSessionLease("branch-session");
	assert.throws(
		() => forkingWindow.forkSession({
			sourceSessionId: "source-session",
			targetSessionId: "branch-session",
		}),
		(error: unknown) => error instanceof SessionInUseError,
	);
	assert.equal(forkingWindow.loadSession("branch-session"), undefined);

	targetOwner.releaseSessionLease("branch-session");
	const fork = forkingWindow.forkSession({
		sourceSessionId: "source-session",
		targetSessionId: "branch-session",
	});
	assert.equal(fork.targetSessionId, "branch-session");
	assert.equal(forkingWindow.acquireSessionLease("branch-session"), false);
	forkingWindow.forkAgentConversation({
		sourceSessionId: "source-session",
		targetSessionId: "child-session",
		workspaceRoot: "/workspace",
		targetThreadId: "child-session",
		forkTurns: "none",
	});
	assert.throws(
		() => targetOwner.acquireSessionLease("child-session"),
		(error: unknown) => error instanceof SessionInUseError,
	);
});
