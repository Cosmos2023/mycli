import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	openRuntimeSessionStore,
	parseTranscriptEventAppendInput,
	SCHEMA_V15_VERSION,
	SCHEMA_V16_VERSION,
	SQLiteTranscriptEventRepository,
	type ReserveTurnInput,
	type TranscriptEventAppendInput,
} from "../../src/index.ts";
import { removeFixtureDirectoryAfterTests } from "../fixtures/directory-cleanup.ts";

const NOW = "2026-08-14T00:00:00.000Z";

/** The transcript store expects the session row to exist before a turn is reserved. */
function seedSession(dbPath: string, sessionId: string): void {
	const database = new Database(dbPath);
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at, updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(sessionId, "/workspace", `thread-${sessionId}`, NOW, NOW, NOW, "active");
	database.close();
}

function storedSchemaVersion(dbPath: string): number {
	const database = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		return Number(database.prepare("SELECT version FROM schema_version LIMIT 1").pluck().get());
	} finally {
		database.close();
	}
}

function submission(
	sessionId: string,
	source: ReserveTurnInput["source"],
	extensionId?: string,
): ReserveTurnInput {
	return {
		sessionId,
		clientTurnId: `${sessionId}-client`,
		clientUserMessageId: `${sessionId}-user`,
		turnId: `${sessionId}-turn`,
		requestFingerprint: `sha256:${"b".repeat(64)}`,
		workspaceRoot: "/workspace",
		threadId: `thread-${sessionId}`,
		userText: "Continue without a human typing anything.",
		startedAt: NOW,
		source,
		...(extensionId === undefined ? {} : { extensionId }),
	};
}

function extensionInput(sessionId: string, extensionId?: string): TranscriptEventAppendInput {
	return parseTranscriptEventAppendInput({
		schemaVersion: 1,
		sessionId,
		eventId: `${sessionId}-input`,
		turnId: `${sessionId}-turn`,
		eventType: "user_input",
		modelVisible: true,
		createdAt: NOW,
		payload: {
			text: "Continue without a human typing anything.",
			clientUserMessageId: `${sessionId}-user`,
			source: "extension",
			...(extensionId === undefined ? {} : { extensionId }),
		},
	}) as TranscriptEventAppendInput;
}

test("an extension-admitted turn is refused below format 16", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-extension-input-fence-"));
	removeFixtureDirectoryAfterTests(t, root);
	const repository = new SQLiteTranscriptEventRepository({
		dbPath: join(root, "sessions.db"),
		initializeSchemaVersion: SCHEMA_V15_VERSION,
		clock: () => NOW,
	});
	t.after(() => repository.close());
	seedSession(join(root, "sessions.db"), "session-3");

	assert.throws(
		() => repository.reserveTurn(submission("session-1", "extension", "scheduler")),
		/extension input requires session format 16/u,
	);
	assert.throws(
		() => repository.appendEvent(extensionInput("session-2", "scheduler")),
		/extension inputs require session schema version 16/u,
	);
	// A format 15 session still records the labels it already knew.
	assert.equal(repository.reserveTurn(submission("session-3", "goal")).kind, "reserved");
});

test("an extension-admitted turn renders as a status row naming its owner", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-extension-input-render-"));
	removeFixtureDirectoryAfterTests(t, root);
	const repository = new SQLiteTranscriptEventRepository({
		dbPath: join(root, "sessions.db"),
		initializeSchemaVersion: SCHEMA_V16_VERSION,
		clock: () => NOW,
	});
	t.after(() => repository.close());
	seedSession(join(root, "sessions.db"), "session-1");
	seedSession(join(root, "sessions.db"), "session-2");

	assert.equal(repository.reserveTurn(submission("session-1", "extension", "scheduler")).kind, "reserved");
	assert.equal(repository.reserveTurn(submission("session-2", "goal")).kind, "reserved");

	const scheduled = repository.loadReadableTranscriptSnapshot("session-1").items;
	assert.deepEqual(scheduled, [{
		created_at: NOW,
		id: "session-1-turn:extension",
		text: "Continuing scheduler",
		turn_id: "session-1-turn",
		type: "status",
	}]);
	// The goal label keeps rendering exactly as before.
	const goal = repository.loadReadableTranscriptSnapshot("session-2").items;
	assert.deepEqual(goal.map((item) => [item.type, item.text]), [["status", "Continuing goal"]]);
});

test("a format 15 session upgrades to 16 on open and then accepts extension turns", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-extension-input-upgrade-"));
	removeFixtureDirectoryAfterTests(t, root);
	const dbPath = join(root, "sessions.db");
	const seeded = new SQLiteTranscriptEventRepository({
		dbPath,
		initializeSchemaVersion: SCHEMA_V15_VERSION,
		clock: () => NOW,
	});
	seeded.close();

	const upgraded = openRuntimeSessionStore({ dbPath, clock: () => NOW });
	t.after(() => upgraded.close());
	assert.equal(storedSchemaVersion(dbPath), SCHEMA_V16_VERSION);
	seedSession(dbPath, "session-1");
	assert.equal(upgraded.reserveTurn(submission("session-1", "extension", "scheduler")).kind, "reserved");
});

test("an extension input must name its owner and no other source may", () => {
	assert.throws(() => extensionInput("session-1"), /payload.extensionId/u);
	assert.throws(() => parseTranscriptEventAppendInput({
		schemaVersion: 1,
		sessionId: "session-1",
		eventId: "session-1-input",
		turnId: "session-1-turn",
		eventType: "user_input",
		modelVisible: true,
		createdAt: NOW,
		payload: { text: "inspect", clientUserMessageId: "user-1", source: "submit", extensionId: "scheduler" },
	}), /payload.extensionId/u);
});
