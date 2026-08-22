import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	createV9ProjectionManifest,
	SQLiteSessionStore,
} from "../src/index.ts";

const NOW = "2026-08-14T00:00:00.000Z";
const WORKSPACE_ROOT = "/workspace";

test("freezes deterministic v9 provider, readable, search, lineage, recovery, and ledger projections", async (t) => {
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: () => NOW });
	seedCompletedToolTurn(store, WORKSPACE_ROOT);
	store.forkSession({
		sourceSessionId: "private-parent",
		targetSessionId: "private-child",
		forkPoint: 2,
	});
	store.saveState({
		sessionId: "private-parent",
		workspaceRoot: WORKSPACE_ROOT,
		threadId: "private-parent",
		key: "context_baseline",
		payload: {
			kind: "context_baseline",
			schema_version: 1,
			session_id: "private-parent",
			entries: [],
			updated_at: NOW,
		},
	});
	store.close();
	const database = new Database(fixture.dbPath);
	database.prepare(`
		INSERT INTO model_input_blobs (blob_id, payload_json, created_at)
		VALUES (?, ?, ?)
	`).run("private-blob", "{\"private\":true}", NOW);
	database.prepare(`
		INSERT INTO instruction_snapshots (
			snapshot_id, session_id, blob_id, content_sha256, created_at
		) VALUES (?, ?, ?, ?, ?)
	`).run("private-snapshot", "private-parent", "private-blob", "a".repeat(64), NOW);
	database.close();

	const first = createV9ProjectionManifest({ dbPath: fixture.dbPath });
	const second = createV9ProjectionManifest({ dbPath: fixture.dbPath });

	assert.deepEqual(second, first);
	assert.equal(
		first.manifestSha256,
		"b5828dd11cbb84cd40db62079eb79637825fa557e24eba8dfa02e20947328a70",
	);
	assert.equal(first.sessionCount, 2);
	assert.equal(first.sessions.length, 2);
	assert.ok(first.sessions.every((session) => session.providerWindow.status === "ok"));
	assert.ok(first.sessions.every((session) => session.readableTranscript.status === "ok"));
	assert.ok(first.sessions.every((session) => session.searchDocuments.status === "ok"));
	assert.ok(first.sessions.every((session) => session.lineage.status === "ok"));
	assert.ok(first.sessions.every((session) => session.recoveryState.status === "ok"));
	assert.equal(first.providerLedger.rowCount, 2);
	assert.match(first.manifestSha256, /^[a-f0-9]{64}$/u);
	const rendered = JSON.stringify(first);
	for (const privateValue of [
		"private-parent",
		"private-child",
		"private-turn",
		"private tool output",
		"private-blob",
		fixture.root,
	]) {
		assert.equal(rendered.includes(privateValue), false);
	}
});

test("freezes stable projection errors for malformed v9 provider rows", async (t) => {
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: () => NOW });
	seedCompletedToolTurn(store, WORKSPACE_ROOT);
	store.close();
	const database = new Database(fixture.dbPath);
	database.prepare(`
		UPDATE conversation_messages
		SET payload_json = ?
		WHERE session_id = ? AND message_index = 0
	`).run("{private-invalid-payload", "private-parent");
	database.close();

	const manifest = createV9ProjectionManifest({ dbPath: fixture.dbPath });
	const session = manifest.sessions[0];
	assert.equal(session?.providerWindow.status, "error");
	assert.equal(session?.searchDocuments.status, "error");
	assert.equal(session?.readableTranscript.status, "ok");
	assert.equal(JSON.stringify(manifest).includes("private-invalid-payload"), false);
});

function seedCompletedToolTurn(store: SQLiteSessionStore, workspaceRoot: string): void {
	store.reserveTurn({
		sessionId: "private-parent",
		clientTurnId: "private-client",
		clientUserMessageId: "private-user",
		turnId: "private-turn",
		requestFingerprint: `sha256:${"b".repeat(64)}`,
		workspaceRoot,
		threadId: "private-parent",
		userText: "private request",
		startedAt: NOW,
	});
	store.appendAssistantToolCalls({
		sessionId: "private-parent",
		clientTurnId: "private-client",
		assistantText: "Checking.",
		calls: [{ callId: "private-call", name: "Read", argumentsJson: "{}" }],
	});
	store.appendToolResult({
		sessionId: "private-parent",
		clientTurnId: "private-client",
		result: {
			callId: "private-call",
			toolName: "Read",
			output: "private tool output",
			success: true,
		},
		summary: "Read complete",
	});
	store.completeTurn({
		sessionId: "private-parent",
		clientTurnId: "private-client",
		assistantText: "Complete.",
		usage: {},
		completedAt: NOW,
	});
}

async function databaseFixture(t: test.TestContext): Promise<{
	readonly root: string;
	readonly dbPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-v9-manifest-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return { root, dbPath: join(root, "sessions.db") };
}
