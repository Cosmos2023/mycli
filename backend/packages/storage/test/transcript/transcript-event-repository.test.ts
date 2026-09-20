import { removeFixtureDirectoryAfterTests } from "../fixtures/directory-cleanup.ts";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	SQLiteTranscriptEventRepository,
	StorageFailure,
	TRANSCRIPT_EVENT_SCHEMA_VERSION,
} from "../../src/index.ts";

const NOW = "2026-08-14T00:00:00.000Z";

test("appends canonical events with global sequence and session-local provider order", async (t) => {
	const fixture = await repositoryFixture(t);
	const second = new SQLiteTranscriptEventRepository({ dbPath: fixture.dbPath });
	t.after(() => second.close());
	const user = fixture.repository.appendEvent(event("user_input", "event-user", {
		text: "hello",
		clientUserMessageId: "user-1",
		source: "submit",
	}, true));
	const status = second.appendEvent(event("display_activity", "event-status", {
		activityType: "status",
		text: "working",
	}, false));
	const assistant = fixture.repository.appendEvent(event("assistant_output", "event-assistant", {
		text: "done",
	}, true));

	assert.deepEqual(
		[user.sequenceNo, status.sequenceNo, assistant.sequenceNo],
		[1, 2, 3],
	);
	assert.equal(user.providerIndex, 0);
	assert.equal(status.providerIndex, undefined);
	assert.equal(assistant.providerIndex, 1);
	assert.deepEqual(fixture.repository.loadEvent("session-1", "event-assistant"), assistant);
});

test("loads bounded chronological event windows in both directions", async (t) => {
	const fixture = await repositoryFixture(t);
	for (let index = 1; index <= 5; index += 1) {
		fixture.repository.appendEvent(event("turn_lifecycle", `event-${index}`, {
			phase: index === 5 ? "completed" : "started",
		}, false, index <= 3 ? "turn-a" : "turn-b"));
	}

	const latest = fixture.repository.loadEventWindow("session-1", { limit: 2 });
	assert.deepEqual(latest.events.map((item) => item.sequenceNo), [4, 5]);
	assert.equal(latest.hasMore, true);
	const older = fixture.repository.loadEventWindow("session-1", {
		beforeSequence: 4,
		limit: 2,
	});
	assert.deepEqual(older.events.map((item) => item.sequenceNo), [2, 3]);
	assert.equal(older.hasMore, true);
	const suffix = fixture.repository.loadEventWindow("session-1", {
		afterSequence: 3,
		limit: 10,
	});
	assert.deepEqual(suffix.events.map((item) => item.sequenceNo), [4, 5]);
	assert.equal(suffix.hasMore, false);
	const turn = fixture.repository.loadTurnEventWindow("session-1", "turn-a", { limit: 2 });
	assert.deepEqual(turn.events.map((item) => item.eventId), ["event-1", "event-2"]);
	assert.equal(turn.hasMore, true);
});

test("loads the newest compaction and preserves ordered source references", async (t) => {
	const fixture = await repositoryFixture(t);
	fixture.repository.appendEvent(event("assistant_output", "source-a", { text: "a" }, true));
	fixture.repository.appendEvent(event("compaction", "compact-1", compactionPayload("window-1"), false));
	fixture.repository.appendEvent(event("assistant_output", "source-b", { text: "b" }, true));
	fixture.repository.appendEvent(event("compaction", "compact-2", compactionPayload("window-2"), false));

	assert.equal(fixture.repository.loadLatestCompaction("session-1")?.eventId, "compact-2");
	assert.deepEqual(
		fixture.repository.loadSourceEvents("session-1", ["source-b", "source-a"])
			.map((item) => item.eventId),
		["source-b", "source-a"],
	);
	assert.throws(
		() => fixture.repository.loadSourceEvents("session-1", ["missing-private-reference"]),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.missing_count === 1
			&& !error.message.includes("missing-private-reference"),
	);
});

test("rejects duplicate append identities and invalid bounds with sanitized errors", async (t) => {
	const fixture = await repositoryFixture(t);
	const input = event("assistant_output", "private-duplicate-id", {
		text: "private assistant payload",
	}, true);
	fixture.repository.appendEvent(input);
	assert.throws(
		() => fixture.repository.appendEvent(input),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.sqlite_code === "SQLITE_CONSTRAINT_UNIQUE"
			&& !error.message.includes("private-duplicate-id")
			&& !error.message.includes("private assistant payload"),
	);
	assert.throws(
		() => fixture.repository.loadEventWindow("session-1", { limit: 2_001 }),
		/limit must be between 1 and 2000/u,
	);
	assert.throws(
		() => fixture.repository.loadEventWindow("session-1", {
			beforeSequence: 2,
			afterSequence: 1,
		}),
		/mutually exclusive/u,
	);
});

function event(
	eventType: string,
	eventId: string,
	payload: Readonly<Record<string, unknown>>,
	modelVisible: boolean,
	turnId = "turn-1",
) {
	return {
		schemaVersion: TRANSCRIPT_EVENT_SCHEMA_VERSION,
		sessionId: "session-1",
		eventId,
		turnId,
		eventType,
		modelVisible,
		createdAt: NOW,
		payload,
	} as never;
}

function compactionPayload(windowId: string): Readonly<Record<string, unknown>> {
	return {
		windowId,
		sourceProviderIndex: 0,
		replacement: [{ type: "user", text: "summary" }],
		summary: "summary",
	};
}

async function repositoryFixture(t: test.TestContext): Promise<{
	readonly dbPath: string;
	readonly repository: SQLiteTranscriptEventRepository;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-event-repository-"));
	removeFixtureDirectoryAfterTests(t, root);
	const dbPath = join(root, "sessions.db");
	const repository = new SQLiteTranscriptEventRepository({ dbPath });
	t.after(() => repository.close());
	const database = new Database(dbPath);
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at, updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run("session-1", "/workspace", "thread-1", NOW, NOW, NOW, "active");
	database.close();
	return { dbPath, repository };
}
