import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { removeFixtureDirectoryAfterTests } from "../../../packages/storage/test/fixtures/directory-cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openRuntimeSessionStore, TranscriptSnapshotStore } from "@mycli/storage";
import { canonicalSnapshot, emptyQueue } from "../src/node-runtime/node-session-bootstrap.ts";

test("an empty canonical session writes valid coverage without inventing a model request", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-empty-snapshot-"));
	removeFixtureDirectoryAfterTests(t, root);
	const store = openRuntimeSessionStore({ dbPath: join(root, "sessions.db") });
	t.after(() => store.close());
	store.saveQueueSnapshot({ sessionId: "empty", workspaceRoot: root, threadId: "thread-empty",
		snapshot: { ...emptyQueue("empty"), revision: 1 } });
	const overview = store.loadSession("empty");
	assert.ok(overview);
	const snapshot = canonicalSnapshot(store, overview, false, false, false);
	assert.deepEqual(snapshot.transcript, []);
	assert.equal(snapshot.session?.thread_id, "thread-empty");
	assert.equal(snapshot.last_request, undefined);
	assert.equal(snapshot.coverage?.included_events, 0);
	assert.equal(snapshot.coverage?.included_items, 0);
	assert.equal(snapshot.coverage?.history_truncated, false);
	assert.equal(snapshot.coverage?.first_event_sequence, null);
	const snapshots = new TranscriptSnapshotStore({ homeDir: root });
	await snapshots.write(snapshot);
	const loaded = await snapshots.loadOrRebuild("empty", {
		loadCanonical: () => undefined,
		importLegacy: () => { throw new Error("unexpected import"); },
	});
	assert.equal(loaded.readOnly, true);
	assert.deepEqual(loaded.snapshot, snapshot);
});
