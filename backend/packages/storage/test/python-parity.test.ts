import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	expectedSharedRecords,
	loadSessionFixture,
	readNodeRuntimeTurns,
	readNodeSessions,
	writeNodeSessions,
} from "./support/parity-helper.ts";
import { SQLiteSessionStore } from "../src/index.ts";

test("Node writes and reads the shared Python-compatible session corpus", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-storage-parity-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const fixture = await loadSessionFixture();
	const dbPath = join(root, "sessions.db");

	writeNodeSessions(dbPath, fixture);

	assert.deepEqual(readNodeSessions(dbPath, fixture), expectedSharedRecords(fixture));
	assert.deepEqual(readNodeRuntimeTurns(dbPath, fixture).map((turn) => {
		assert.ok(turn);
		return {
			session_id: turn.session_id,
			client_turn_id: turn.client_turn_id,
			turn_id: turn.turn_id,
			request_fingerprint: turn.request_fingerprint,
			status: turn.status,
			error_code: turn.error_code,
		};
	}), fixture.sessions.map((scenario) => ({
		session_id: scenario.session_id,
		client_turn_id: scenario.client_turn_id,
		turn_id: scenario.turn_id,
		request_fingerprint: scenario.request_fingerprint,
		status: scenario.status,
		error_code: scenario.error_code,
	})));
});

test("Python parity reader ignores the additive subagent task table", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-storage-subagent-python-parity-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const fixture = await loadSessionFixture();
	const dbPath = join(root, "sessions.db");
	writeNodeSessions(dbPath, fixture);
	const scenario = fixture.sessions[0];
	assert.ok(scenario);
	const store = new SQLiteSessionStore({ dbPath });
	store.subagentTasks.reserve({
		taskId: "task-python-parity",
		parentSessionId: scenario.session_id,
		parentTurnId: scenario.turn_id,
		childSessionId: "child-python-parity",
		profileId: "explore",
	});
	store.close();

	const script = [
		"import json, sys",
		"from pathlib import Path",
		"from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore",
		"store = SQLiteSessionStore(Path(sys.argv[1]))",
		"messages = store.load_conversation(sys.argv[2])",
		"print(json.dumps([{'role': item['role'], 'content': item['content']} for item in messages]))",
	].join("; ");
	const stdout = execFileSync("python3", ["-c", script, dbPath, scenario.session_id], {
		cwd: new URL("../../../../", import.meta.url),
		env: {
			...process.env,
			PYTHONPATH: new URL("../../../../src", import.meta.url).pathname,
		},
		encoding: "utf8",
	});

	assert.deepEqual(JSON.parse(stdout), [
		{ role: "user", content: scenario.user_text },
		{ role: "assistant", content: scenario.assistant_text },
	]);
});
