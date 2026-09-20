import assert from "node:assert/strict";
import { removeFixtureDirectoryAfterTests } from "../fixtures/directory-cleanup.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createErrorContext, errorSummary } from "@mycli/contracts";
import { openRuntimeSessionStore, SQLiteTranscriptEventRepository, StorageFailure } from "../../src/index.ts";
import { interruptedToolResult } from "../../src/agents/interrupted-tool-result.ts";

const NOW = "2026-09-10T00:00:00.000Z";

test("error context survives atomic terminalization, display projection, and reopening", async (t) => {
	const dbPath = await temporaryDatabase(t);
	const store = openRuntimeSessionStore({ dbPath, clock: () => NOW });
	t.after(() => store.close());
	reserve(store);
	const context = imageFailure();
	const terminal = store.turnTerminalizations.terminalize({
		kind: "failed", sessionId: "session:error", clientTurnId: "client:error",
		code: "unsupported_capability", message: "generic old text", errorContext: context, completedAt: NOW,
	});
	assert.deepEqual(terminal.outbox.payload.errorContext, context);
	assert.deepEqual(terminal.turn.result?.error_context, context);
	assert.equal(terminal.turn.result?.message, errorSummary(context));
	const display = store.loadReadableTranscript("session:error").find((item) => item.type === "error");
	assert.equal(display?.text, errorSummary(context));
	assert.deepEqual(display?.metadata?.error_context, context);
	const before = store.loadConversation("session:error");
	store.close();
	const reopened = openRuntimeSessionStore({ dbPath, clock: () => NOW });
	t.after(() => reopened.close());
	assert.deepEqual(reopened.turnTerminalizations.load("session:error", "client:error"), terminal);
	assert.deepEqual(reopened.loadConversation("session:error"), before);
	assert.deepEqual(reopened.loadReadableTranscript("session:error").find((item) => item.type === "error"), display);
});

for (const failpoint of ["failure_after_tools", "failure_after_display", "failure_after_outbox", "failure_after_turn"] as const) {
	test(`error context leaves no partial terminal records at ${failpoint}`, async (t) => {
		const dbPath = await temporaryDatabase(t);
		let armed = false;
		let triggered = false;
		const store = new SQLiteTranscriptEventRepository({ dbPath, initializeSchemaVersion: 14,
			turnTerminalizationFailpoint: (name) => { if (armed && name === failpoint) { triggered = true; throw new Error("test failure"); } },
		});
		t.after(() => store.close());
		reserve(store);
		const before = store.loadEventWindow("session:error", { limit: 100 }).events;
		armed = true;
		assert.throws(() => store.failTurn({
			sessionId: "session:error", clientTurnId: "client:error", code: "unsupported_capability",
			message: "old message", errorContext: imageFailure(), completedAt: NOW,
		}), StorageFailure);
		assert.equal(triggered, true);
		assert.equal(store.loadTurn("session:error", "client:error")?.status, "in_progress");
		assert.deepEqual(store.loadEventWindow("session:error", { limit: 100 }).events, before);
	});
}

test("v13 migration retains transcript bytes and old format writers reject enriched records", async (t) => {
	const dbPath = await temporaryDatabase(t);
	const legacy = new SQLiteTranscriptEventRepository({ dbPath, initializeSchemaVersion: 13 });
	t.after(() => legacy.close());
	reserve(legacy);
	assert.throws(() => legacy.failTurn({
		sessionId: "session:error", clientTurnId: "client:error", code: "unsupported_capability",
		message: "old message", errorContext: imageFailure(), completedAt: NOW,
	}), StorageFailure);
	legacy.completeTurn({ sessionId: "session:error", clientTurnId: "client:error", assistantText: "done", usage: {}, completedAt: NOW });
	legacy.close();
	const before = storedEvents(dbPath);
	const current = openRuntimeSessionStore({ dbPath });
	assert.equal(current.errorContextVersion, 1);
	current.close();
	assert.deepEqual(storedEvents(dbPath), before);
	const database = new Database(dbPath, { readonly: true });
	try { assert.equal(database.prepare("SELECT version FROM schema_version").pluck().get(), 15); }
	finally { database.close(); }
});

function imageFailure(): ReturnType<typeof createErrorContext> {
	return createErrorContext({
		id: "error:image", reason: "capability.image_input_unsupported", source: "provider",
		scope: { kind: "turn", id: "turn:error" }, outcome: { state: "not_started", effects: "none" },
		details: { model: "deepseek-v4-flash", input_origin: "history" },
	});
}

for (const kind of ["Shell", "MCP", "Plugin"] as const) test(`a failed ${kind} tool retains its occurrence through effects, restart recovery, and transcript projection`, async (t) => {
	const integration = kind !== "Shell";
	const dbPath = await temporaryDatabase(t);
	const store = openRuntimeSessionStore({ dbPath, clock: () => NOW });
	t.after(() => store.close());
	reserve(store);
	const call = { callId: "call:error", name: kind === "Plugin" ? "plugin_remote_change" : integration ? "mcp_remote_change" : "Shell", argumentsJson: "{}" };
	store.appendAssistantToolCalls({ sessionId: "session:error", clientTurnId: "client:error", assistantText: "", calls: [call] });
	const errorContext = createErrorContext({ ...(integration ? { reason: "integration.unavailable", source: "integration",
		details: { integration: "remote", operation: "tools/call", phase: "request", ...(kind === "Plugin" ? { exit_code: 91, legacy_kind: "plugin_worker_exited" } : { http_status: 503, recovery_attempts: 1 }) } } as const
		: { reason: "tool.timed_out", source: "tool" } as const),
		scope: { kind: "tool_call", id: call.callId }, outcome: { state: "unknown", effects: "possible" },
	});
	store.agentEffectLedger.reserve({ attemptId: "effect:error", kind: "tool", sessionId: "session:error",
		turnId: "turn:error", jobId: "job:error", externalId: call.callId, mutating: true, request: call, createdAt: NOW,
	});
	store.agentEffectLedger.complete({ attemptId: "effect:error", state: "completed", completedAt: NOW,
		result: { callId: call.callId, toolName: call.name, success: false, modelOutput: kind === "Plugin" ? "Exit code: 91" : integration ? "HTTP 503" : "timed out", summary: "Tool failed",
			errorKind: kind === "Plugin" ? "plugin_worker_exited" : integration ? "mcp_transport_error" : "timeout", errorContext, metadata: { error_context: errorContext },
		},
	});
	const recovered = interruptedToolResult(call, store.agentEffectLedger.load("effect:error"), "interrupted");
	assert.deepEqual(recovered.metadata?.error_context, errorContext);
	store.appendToolResult({ sessionId: "session:error", clientTurnId: "client:error", ...recovered });
	store.completeTurn({ sessionId: "session:error", clientTurnId: "client:error", assistantText: "done", usage: {}, completedAt: NOW });
	store.close();
	const reopened = openRuntimeSessionStore({ dbPath });
	t.after(() => reopened.close());
	assert.deepEqual(interruptedToolResult(call, reopened.agentEffectLedger.load("effect:error"), "interrupted"), recovered);
	const tool = reopened.loadReadableTranscript("session:error").find((item) => item.type === "tool" && item.call_id === call.callId);
	assert.deepEqual(tool?.metadata?.error_context, errorContext);
	assert.equal(JSON.stringify(reopened.loadConversation("session:error")).includes("error_context"), false);
});

function reserve(store: SQLiteTranscriptEventRepository): void {
	store.reserveTurn({ sessionId: "session:error", clientTurnId: "client:error", clientUserMessageId: "message:error",
		turnId: "turn:error", requestFingerprint: `sha256:${"a".repeat(64)}`, workspaceRoot: "/test",
		threadId: "session:error", userText: "hello", startedAt: NOW,
	});
}

function storedEvents(dbPath: string): readonly unknown[] {
	const database = new Database(dbPath, { readonly: true });
	try { return database.prepare("SELECT * FROM transcript_events ORDER BY sequence_no").all(); }
	finally { database.close(); }
}

async function temporaryDatabase(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mycli-error-context-"));
	removeFixtureDirectoryAfterTests(t, root);
	return join(root, "session.db");
}
