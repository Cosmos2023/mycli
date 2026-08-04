import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import type {
	CanonicalConversationItem,
	CanonicalToolCall,
} from "@mycli/core";
import * as storage from "../src/index.ts";

interface Store {
	reserveTurn(input: ReturnType<typeof submission>): unknown;
	loadTurn(sessionId: string, clientTurnId: string): RuntimeTurnRecord | undefined;
	loadConversationItems(sessionId: string): readonly CanonicalConversationItem[];
	appendAssistantToolCalls(input: {
		readonly sessionId: string;
		readonly clientTurnId: string;
		readonly assistantText: string;
		readonly calls: readonly CanonicalToolCall[];
		readonly responseId?: string;
	}): void;
	completeTurn(input: {
		readonly sessionId: string;
		readonly clientTurnId: string;
		readonly assistantText: string;
		readonly usage: Readonly<Record<string, number>>;
		readonly completedAt: string;
	}): RuntimeTurnRecord;
	recoverInterruptedTurns(): number;
	close(): void;
}

type StoreConstructor = new (options: {
	readonly dbPath: string;
	readonly clock?: () => string;
	readonly ownerId?: string;
	readonly processId?: number;
	readonly isProcessAlive?: (processId: number) => boolean;
}) => Store;

test("reopening the store interrupts orphaned running turns without changing completed turns", async (t) => {
	const SQLiteSessionStore = constructor();
	const root = await mkdtemp(join(tmpdir(), "mycli-node-recovery-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const dbPath = join(root, ".mycli", "sessions.db");
	const initial = new SQLiteSessionStore({ dbPath, clock: () => NOW });
	initial.reserveTurn(submission(root, "client-running", "turn-running"));
	initial.reserveTurn(submission(root, "client-complete", "turn-complete"));
	initial.completeTurn({
		sessionId: "session-1",
		clientTurnId: "client-complete",
		assistantText: "done",
		usage: {},
		completedAt: COMPLETED,
	});
	initial.close();

	const reopened = new SQLiteSessionStore({ dbPath, clock: () => RECOVERED });
	t.after(() => reopened.close());

	const interrupted = reopened.loadTurn("session-1", "client-running");
	const completed = reopened.loadTurn("session-1", "client-complete");
	assert.equal(interrupted?.status, "interrupted");
	assert.equal(interrupted?.error_code, "interrupted");
	assert.equal(interrupted?.completed_at, RECOVERED);
	assert.equal(completed?.status, "completed");
	assert.equal(reopened.recoverInterruptedTurns(), 0);
});

test("opening a concurrent store does not interrupt a turn owned by a live process", async (t) => {
	const SQLiteSessionStore = constructor();
	const root = await mkdtemp(join(tmpdir(), "mycli-node-recovery-live-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const dbPath = join(root, ".mycli", "sessions.db");
	const liveProcesses = new Set([101, 202]);
	const first = new SQLiteSessionStore({
		dbPath,
		ownerId: "owner-1",
		processId: 101,
		isProcessAlive: (processId) => liveProcesses.has(processId),
	});
	const second = new SQLiteSessionStore({
		dbPath,
		ownerId: "owner-2",
		processId: 202,
		isProcessAlive: (processId) => liveProcesses.has(processId),
	});
	t.after(() => first.close());
	t.after(() => second.close());

	first.reserveTurn(submission(root, "client-running", "turn-running"));
	assert.equal(second.recoverInterruptedTurns(), 0);
	assert.equal(second.loadTurn("session-1", "client-running")?.status, "in_progress");

	liveProcesses.delete(101);
	assert.equal(second.recoverInterruptedTurns(), 1);
	assert.equal(second.loadTurn("session-1", "client-running")?.status, "interrupted");
});

test("recovery appends one synthetic result for each unmatched tool call", async (t) => {
	const SQLiteSessionStore = constructor();
	const root = await mkdtemp(join(tmpdir(), "mycli-node-tool-recovery-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const dbPath = join(root, ".mycli", "sessions.db");
	const initial = new SQLiteSessionStore({ dbPath, clock: () => NOW });
	initial.reserveTurn(submission(root, "client-running", "turn-running"));
	initial.appendAssistantToolCalls({
		sessionId: "session-1",
		clientTurnId: "client-running",
		assistantText: "",
		calls: [{
			callId: "call-read-1",
			name: "Read",
			argumentsJson: "{\"file_path\":\"README.md\",\"offset\":1,\"limit\":20}",
		}],
		responseId: "resp-tools-1",
	});
	initial.close();

	const reopened = new SQLiteSessionStore({ dbPath, clock: () => RECOVERED });
	assert.deepEqual(reopened.loadConversationItems("session-1").at(-1), {
		type: "tool_result",
		callId: "call-read-1",
		toolName: "Read",
		output: "Tool call interrupted before it completed.",
		success: false,
	});
	reopened.close();

	const secondReopen = new SQLiteSessionStore({ dbPath, clock: () => RECOVERED });
	t.after(() => secondReopen.close());
	const results = secondReopen.loadConversationItems("session-1")
		.filter((item) => item.type === "tool_result" && item.callId === "call-read-1");
	assert.equal(results.length, 1);
});

const NOW = "2026-08-03T00:00:00+00:00";
const COMPLETED = "2026-08-03T00:00:01+00:00";
const RECOVERED = "2026-08-03T00:01:00+00:00";

function constructor(): StoreConstructor {
	const value = Reflect.get(storage, "SQLiteSessionStore") as StoreConstructor | undefined;
	assert.equal(typeof value, "function");
	return value!;
}

function submission(workspaceRoot: string, clientTurnId: string, turnId: string) {
	return {
		sessionId: "session-1",
		clientTurnId,
		turnId,
		requestFingerprint: `sha256:${(clientTurnId === "client-running" ? "a" : "b").repeat(64)}`,
		workspaceRoot,
		threadId: "session-1",
		userText: clientTurnId,
		startedAt: NOW,
	};
}
