import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { modelInputSha256 } from "@mycli/core";
import { SQLiteSessionStore } from "@mycli/storage";
import { resolveSessionInstructionSnapshot } from "../src/node-runtime/instruction-snapshot.ts";
import type { PackagedSystemPrompt } from "../src/node-runtime/system-prompt.ts";

const NOW = "2026-08-08T00:00:00.000Z";

test("freezes the first system template per session", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-instruction-snapshot-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const store = new SQLiteSessionStore({ dbPath: join(root, "sessions.db"), clock: () => NOW });
	t.after(() => store.close());
	reserve(store, "session-1", root);
	reserve(store, "session-2", root);
	const firstTemplate = template("v1", "First complete system prompt.");
	const updatedTemplate = template("v2", "Updated complete system prompt.");

	const first = resolveSessionInstructionSnapshot({
		sessionId: "session-1",
		ledger: store.modelInputLedger,
		template: firstTemplate,
		clock: () => NOW,
		createSnapshotId: () => "instructions-session-1",
	});
	const resumed = resolveSessionInstructionSnapshot({
		sessionId: "session-1",
		ledger: store.modelInputLedger,
		template: updatedTemplate,
		clock: () => "2026-08-08T00:00:01.000Z",
		createSnapshotId: () => "must-not-be-used",
	});
	const newSession = resolveSessionInstructionSnapshot({
		sessionId: "session-2",
		ledger: store.modelInputLedger,
		template: updatedTemplate,
		clock: () => "2026-08-08T00:00:01.000Z",
		createSnapshotId: () => "instructions-session-2",
	});

	assert.equal(first.content, firstTemplate.content);
	assert.deepEqual(resumed, first);
	assert.equal(newSession.content, updatedTemplate.content);
	assert.equal(newSession.version, "v2");
	assert.deepEqual(
		store.modelInputLedger.loadLatestInstructionSnapshot("session-1"),
		first,
	);
});

test("rejects a template whose declared hash does not match", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-instruction-hash-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const store = new SQLiteSessionStore({ dbPath: join(root, "sessions.db"), clock: () => NOW });
	t.after(() => store.close());
	reserve(store, "session-1", root);
	assert.throws(() => resolveSessionInstructionSnapshot({
		sessionId: "session-1",
		ledger: store.modelInputLedger,
		template: { ...template("v1", "Prompt."), contentSha256: "0".repeat(64) },
		clock: () => NOW,
		createSnapshotId: () => "instructions-session-1",
	}), /template hash does not match/u);
	assert.equal(store.modelInputLedger.loadLatestInstructionSnapshot("session-1"), undefined);
});

function template(version: string, content: string): PackagedSystemPrompt {
	return Object.freeze({
		version,
		source: "builtin-system-md",
		content,
		contentSha256: modelInputSha256(content),
	});
}

function reserve(store: SQLiteSessionStore, sessionId: string, workspaceRoot: string): void {
	store.reserveTurn({
		sessionId,
		clientTurnId: `${sessionId}:client-turn`,
		clientUserMessageId: `${sessionId}:user-message`,
		turnId: `${sessionId}:turn`,
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot,
		threadId: sessionId,
		userText: "hello",
		startedAt: NOW,
	});
}
