import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	SessionArtifactStore,
	StorageIdentityError,
	subagentRunId,
} from "../../src/index.ts";

const NOW = "2026-08-07T00:00:00.000Z";

test("projects Python-compatible private event task and subagent artifacts", async (t) => {
	const root = await temporaryDirectory(t);
	const artifacts = new SessionArtifactStore({ homeDir: root, clock: () => NOW });
	await artifacts.appendEvent({
		sessionId: "parent-session",
		type: "conversation.saved",
		payload: { message_count: 2, type: "cannot-override" },
	});
	const outputPath = await artifacts.writeTaskOutput({
		sessionId: "parent-session",
		taskId: "child-session",
		output: "Finished work",
	});
	const index = await artifacts.writeSubagentSnapshot({
		parentSessionId: "parent-session",
		childSessionId: "child-session",
		parentTurnId: "turn-1",
		profileId: "explore",
		threadId: "child-session",
		rootThreadId: "root-session",
		parentThreadId: "parent-thread",
		agentPath: "/root/review",
		taskName: "review",
		nickname: "tests",
		lifecycleKind: "completed",
		status: "completed",
		mode: "background",
		description: "Inspect files",
		report: "Finished work",
		toolCalls: 2,
		startedAt: NOW,
		completedAt: NOW,
		messages: [{ id: "child:user:1", type: "user_message", text: "Inspect" }],
	});

	const sessionDir = artifacts.paths.sessionDirectory("parent-session");
	const event = JSON.parse((await readFile(join(sessionDir, "events.jsonl"), "utf8")).trim());
	assert.deepEqual(event, {
		created_at: NOW,
		message_count: 2,
		session_id: "parent-session",
		type: "conversation.saved",
	});
	assert.equal(outputPath, join(sessionDir, "tasks", "child-session", "output.txt"));
	assert.equal(await readFile(outputPath, "utf8"), "Finished work");
	const runId = subagentRunId("child-session");
	assert.equal(runId, "subagent-3e323a7328d01dce");
	assert.equal(index.path, `subagents/${runId}.json`);
	const snapshotPath = join(sessionDir, index.path);
	const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
	assert.equal(snapshot.child_session_id, "child-session");
	assert.equal(snapshot.thread_id, "child-session");
	assert.equal(snapshot.root_thread_id, "root-session");
	assert.equal(snapshot.parent_thread_id, "parent-thread");
	assert.equal(snapshot.agent_path, "/root/review");
	assert.equal(snapshot.task_name, "review");
	assert.equal(snapshot.nickname, "tests");
	assert.equal(snapshot.lifecycle_kind, "completed");
	assert.equal(index.agent_path, "/root/review");
	assert.equal(snapshot.messages[0].text, "Inspect");
	if (process.platform !== "win32") {
		assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
		assert.equal((await stat(snapshotPath)).mode & 0o777, 0o600);
		assert.equal((await stat(join(sessionDir, "events.jsonl"))).mode & 0o777, 0o600);
	}
});

test("rejects traversal-like session and task identities", async (t) => {
	const root = await temporaryDirectory(t);
	const artifacts = new SessionArtifactStore({ homeDir: root });

	assert.throws(() => artifacts.paths.eventsPath("../outside"), StorageIdentityError);
	assert.throws(() => artifacts.paths.eventsPath("   "), StorageIdentityError);
	assert.throws(() => artifacts.paths.eventsPath("."), StorageIdentityError);
	assert.throws(() => artifacts.taskOutputPath("session", "a/b"), StorageIdentityError);
	await assert.rejects(() => artifacts.writeSubagentSnapshot({
		parentSessionId: "session",
		childSessionId: "<child>",
		parentTurnId: "turn",
		profileId: "explore",
		status: "running",
		messages: [],
	}), StorageIdentityError);
});

test("atomic artifact failure preserves targets and removes temporary files", async (t) => {
	const root = await temporaryDirectory(t);
	let fail = false;
	const artifacts = new SessionArtifactStore({
		homeDir: root,
		failpoint: (name) => {
			if (fail && name === "task_output_before_rename") throw new Error("rename blocked");
		},
	});
	const input = { sessionId: "session", taskId: "task", output: "before" };
	await artifacts.writeTaskOutput(input);
	const target = artifacts.taskOutputPath("session", "task");
	fail = true;
	await assert.rejects(
		() => artifacts.writeTaskOutput({ ...input, output: "after" }),
		/rename blocked/u,
	);

	assert.equal(await readFile(target, "utf8"), "before");
	assert.deepEqual((await readdir(join(root, ".mycli", "sessions", "session", "tasks", "task")))
		.filter((name) => name.endsWith(".tmp")), []);
});

async function temporaryDirectory(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mycli-session-artifacts-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}
