import { removeFixtureDirectoryAfterTests } from "../fixtures/directory-cleanup.ts";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	SQLiteSessionStore,
	StorageFailure,
	type ReserveAgentEffectAttemptInput,
} from "../../src/index.ts";

const NOW = "2026-08-12T00:00:00.000Z";
const LATER = "2026-08-12T00:00:01.000Z";

test("durably reserves and terminalizes provider attempts idempotently", async (t) => {
	const fixture = await databaseFixture(t);
	const store = sessionStore(fixture.dbPath);
	t.after(() => store.close());
	reserveSession(store, fixture.root);
	const input = providerAttempt();

	const first = store.agentEffectLedger.reserve(input);
	const duplicate = store.agentEffectLedger.reserve(input);
	assert.equal(first.kind, "reserved");
	assert.equal(duplicate.kind, "existing");
	assert.deepEqual(duplicate.attempt, first.attempt);

	const completed = store.agentEffectLedger.complete({
		attemptId: input.attemptId,
		state: "completed",
		result: { provider_lifecycle: "acknowledged", response_id_present: true },
		completedAt: LATER,
	});
	assert.equal(completed.state, "completed");
	assert.deepEqual(store.agentEffectLedger.complete({
		attemptId: input.attemptId,
		state: "completed",
		result: { response_id_present: true, provider_lifecycle: "acknowledged" },
		completedAt: "2026-08-12T00:00:02.000Z",
	}), completed);

	assert.throws(() => store.agentEffectLedger.complete({
		attemptId: input.attemptId,
		state: "failed",
		result: { code: "provider_error" },
		completedAt: LATER,
	}), StorageFailure);

	store.close();
	const reopened = sessionStore(fixture.dbPath);
	t.after(() => reopened.close());
	assert.deepEqual(reopened.agentEffectLedger.load(input.attemptId), completed);
});

test("rejects attempt and external identity collisions", async (t) => {
	const fixture = await databaseFixture(t);
	const store = sessionStore(fixture.dbPath);
	t.after(() => store.close());
	reserveSession(store, fixture.root);
	const input = providerAttempt();
	store.agentEffectLedger.reserve(input);

	assert.throws(() => store.agentEffectLedger.reserve({
		...input,
		request: { provider_step: 2, logical_input_sha256: "b".repeat(64) },
	}), /attempt id collides/u);
	assert.throws(() => store.agentEffectLedger.reserve({
		...input,
		attemptId: "request-2",
	}), /external identity is already reserved/u);
});

test("atomically deduplicates attempts across independent stores", async (t) => {
	const fixture = await databaseFixture(t);
	const firstStore = sessionStore(fixture.dbPath);
	reserveSession(firstStore, fixture.root);
	const secondStore = sessionStore(fixture.dbPath);
	t.after(() => firstStore.close());
	t.after(() => secondStore.close());

	const first = firstStore.agentEffectLedger.reserve(providerAttempt());
	const second = secondStore.agentEffectLedger.reserve(providerAttempt());
	assert.equal(first.kind, "reserved");
	assert.equal(second.kind, "existing");

	const database = new Database(fixture.dbPath, { readonly: true });
	t.after(() => database.close());
	assert.equal(count(database, "agent_effect_attempts"), 1);
	assert.equal(count(database, "agent_effect_attempt_outcomes"), 0);
});

test("persists ambiguous mutating tool outcomes without replaying the reservation", async (t) => {
	const fixture = await databaseFixture(t);
	const store = sessionStore(fixture.dbPath);
	t.after(() => store.close());
	reserveSession(store, fixture.root);
	const input: ReserveAgentEffectAttemptInput = {
		attemptId: "attempt-tool-1",
		kind: "tool",
		sessionId: "session-1",
		turnId: "turn-1",
		jobId: "job-1",
		externalId: "call-1",
		mutating: true,
		request: { tool_name: "Write", arguments_sha256: "c".repeat(64) },
		createdAt: NOW,
	};
	store.agentEffectLedger.reserve(input);
	const terminal = store.agentEffectLedger.complete({
		attemptId: input.attemptId,
		state: "effect_outcome_unknown",
		result: { error_kind: "effect_outcome_unknown" },
		completedAt: LATER,
	});

	assert.equal(store.agentEffectLedger.reserve(input).attempt.state, "effect_outcome_unknown");
	assert.deepEqual(store.agentEffectLedger.load(input.attemptId), terminal);

	const database = new Database(fixture.dbPath);
	t.after(() => database.close());
	assert.throws(
		() => database.prepare("UPDATE agent_effect_attempts SET job_id = job_id").run(),
		/immutable/u,
	);
	assert.throws(
		() => database.prepare("DELETE FROM agent_effect_attempt_outcomes").run(),
		/append-only/u,
	);
});

test("recovers every reserved tool attempt once with mutation-aware outcomes", async (t) => {
	const fixture = await databaseFixture(t);
	const store = sessionStore(fixture.dbPath);
	t.after(() => store.close());
	reserveSession(store, fixture.root);
	const read = toolAttempt("attempt-read", "call-read", false);
	const write = toolAttempt("attempt-write", "call-write", true);
	store.agentEffectLedger.reserve(read);
	store.agentEffectLedger.reserve(write);

	const first = store.agentEffectLedger.recoverInterruptedTools({
		sessionId: "session-1",
		turnId: "turn-1",
		completedAt: LATER,
	});
	const duplicate = store.agentEffectLedger.recoverInterruptedTools({
		sessionId: "session-1",
		turnId: "turn-1",
		completedAt: "2026-08-12T00:00:02.000Z",
	});

	assert.deepEqual(first.map((attempt) => [attempt.externalId, attempt.state]), [
		["call-read", "interrupted"],
		["call-write", "effect_outcome_unknown"],
	]);
	assert.deepEqual(duplicate, first);
	assert.throws(() => store.agentEffectLedger.complete({
		attemptId: write.attemptId,
		state: "completed",
		result: { callId: "call-write" },
		completedAt: "2026-08-12T00:00:03.000Z",
	}), /different terminal outcome/u);

	const database = new Database(fixture.dbPath, { readonly: true });
	t.after(() => database.close());
	assert.equal(count(database, "agent_effect_attempt_outcomes"), 2);
});

function providerAttempt(): ReserveAgentEffectAttemptInput {
	return {
		attemptId: "request-1",
		kind: "provider",
		sessionId: "session-1",
		turnId: "turn-1",
		jobId: "job-1",
		externalId: "provider-step-1",
		mutating: false,
		request: { provider_step: 1, logical_input_sha256: "a".repeat(64) },
		createdAt: NOW,
	};
}

function toolAttempt(
	attemptId: string,
	externalId: string,
	mutating: boolean,
): ReserveAgentEffectAttemptInput {
	return {
		attemptId,
		kind: "tool",
		sessionId: "session-1",
		turnId: "turn-1",
		jobId: "job-1",
		externalId,
		mutating,
		request: { tool_name: mutating ? "Write" : "Read", arguments_sha256: "c".repeat(64) },
		createdAt: NOW,
	};
}

function reserveSession(store: SQLiteSessionStore, workspaceRoot: string): void {
	store.reserveTurn({
		sessionId: "session-1",
		clientTurnId: "client-turn-1",
		clientUserMessageId: "user-message-1",
		turnId: "turn-1",
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot,
		threadId: "thread-1",
		userText: "Inspect the repository.",
		startedAt: NOW,
	});
}

function sessionStore(dbPath: string): SQLiteSessionStore {
	return new SQLiteSessionStore({ dbPath, clock: () => NOW });
}

function count(database: Database.Database, table: string): number {
	return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
		readonly count: unknown;
	}).count);
}

async function databaseFixture(t: test.TestContext): Promise<{
	readonly root: string;
	readonly dbPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-agent-effect-ledger-"));
	removeFixtureDirectoryAfterTests(t, root);
	return { root, dbPath: join(root, "sessions.db") };
}
