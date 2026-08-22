import assert from "node:assert/strict";
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

test("Node writes and reads the preserved session corpus", async (t) => {
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
