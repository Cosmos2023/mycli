import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createErrorContext } from "@mycli/contracts";
import { openRuntimeSessionStore } from "@mycli/storage";
import { openPreviousRuntimeSessionStore } from "../../tests/fixtures/error-system/previous-v12-reader.mjs";

test("previous storage reader refuses an enriched database before constructing a writable store", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-old-reader-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dbPath = join(root, "session.db");
	const store = openRuntimeSessionStore({ dbPath });
	const now = new Date().toISOString();
	store.reserveTurn({ sessionId: "session:old", clientTurnId: "client:old", clientUserMessageId: "user:old", turnId: "turn:old",
		requestFingerprint: `sha256:${"a".repeat(64)}`, workspaceRoot: root, threadId: "session:old", userText: "test", startedAt: now });
	store.failTurn({ sessionId: "session:old", clientTurnId: "client:old", code: "unsupported_capability", message: "failed", completedAt: now,
		errorContext: createErrorContext({ reason: "capability.image_input_unsupported", source: "provider", scope: { kind: "turn", id: "turn:old" } }),
	});
	const before = store.loadEventWindow("session:old", { limit: 100 });
	store.close();
	let opened = false;
	assert.throws(() => openPreviousRuntimeSessionStore({ dbPath }, () => { opened = true; }),
		(error) => error.code === "persistence_error" && error.diagnostics.actual_version === 15);
	assert.equal(opened, false);
	const reopened = openRuntimeSessionStore({ dbPath });
	try { assert.deepEqual(reopened.loadEventWindow("session:old", { limit: 100 }), before); }
	finally { reopened.close(); }
});
