import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	SQLiteTranscriptEventRepository,
	parseTranscriptEventAppendInput,
	StorageFailure,
	TRANSCRIPT_EVENT_SCHEMA_VERSION,
} from "../../src/index.ts";

const NOW = "2026-08-14T00:00:00.000Z";
const CONTEXT_METADATA = Object.freeze({
	kind: "skill_instructions" as const,
	role: "developer" as const,
	cacheClass: "dynamic" as const,
	durability: "persistent" as const,
	scope: "transcript" as const,
	sourceId: "provider-read-test",
	contentSha256: "a".repeat(64),
	contentLength: 7,
});

test("reconstructs provider items, pending calls, activations, and context from v10 events", async (t) => {
	const fixture = await repositoryFixture(t);
	append(fixture.repository, "user_input", "user", {
		text: "inspect",
		clientUserMessageId: "user-1",
		source: "submit",
	});
	append(fixture.repository, "assistant_tool_call_batch", "calls", {
		text: "Reading.",
		calls: [
			{ callId: "call-a", name: "Read", argumentsJson: "{}" },
			{ callId: "call-b", name: "Read", argumentsJson: "{}" },
		],
	});
	append(fixture.repository, "tool_result", "result-a", {
		result: { callId: "call-a", toolName: "Read", output: "a", success: true },
		summary: "Read a",
	});
	append(fixture.repository, "assistant_tool_call_batch", "activation-call", {
		text: "",
		calls: [{ callId: "call-tool-search", name: "tool_search", argumentsJson: "{}" }],
	});
	append(fixture.repository, "tool_result", "activation-result", {
		result: {
			callId: "call-tool-search",
			toolName: "tool_search",
			output: "activated",
			success: true,
		},
		summary: "Activated",
		metadata: { tool_activation: { version: 1, names: ["Read", "Grep"] } },
	});
	append(fixture.repository, "context", "context", {
		itemId: "context-1",
		text: "context",
		metadata: CONTEXT_METADATA,
	});

	const items = fixture.repository.loadConversationItems("session-1");
	assert.deepEqual(items.map((item) => item.type), [
		"user",
		"assistant_tool_calls",
		"tool_result",
		"tool_result",
		"assistant_tool_calls",
		"tool_result",
		"context",
	]);
	assert.equal(items[3]?.type === "tool_result" && items[3].callId, "call-b");
	assert.deepEqual(
		fixture.repository.loadPendingToolCalls("session-1", "turn-1").map((call) => call.callId),
		["call-b"],
	);
	assert.deepEqual(fixture.repository.loadToolActivations("session-1", "turn-1"), ["Read", "Grep"]);
	assert.deepEqual(fixture.repository.loadContextItems("session-1", "turn-1"), [{
		type: "context",
		text: "context",
		metadata: CONTEXT_METADATA,
	}]);
});

test("does not synthesize results for calls owned by an active v10 turn", async (t) => {
	const fixture = await repositoryFixture(t);
	append(fixture.repository, "assistant_tool_call_batch", "active-call", {
		text: "",
		calls: [{ callId: "call-active", name: "Read", argumentsJson: "{}" }],
	});
	const database = new Database(fixture.dbPath);
	database.prepare(`
		INSERT INTO runtime_turns (
			session_id, client_turn_id, turn_id, request_fingerprint, status,
			error_code, result_json, started_at, completed_at, owner_id, owner_pid
		) VALUES (?, ?, ?, ?, 'in_progress', NULL, NULL, ?, NULL, NULL, NULL)
	`).run("session-1", "client-1", "turn-1", `sha256:${"b".repeat(64)}`, NOW);
	database.close();

	assert.deepEqual(fixture.repository.loadConversationItems("session-1").map((item) => item.type), [
		"assistant_tool_calls",
	]);
});

test("uses only the newest compaction replacement and its provider suffix", async (t) => {
	const fixture = await repositoryFixture(t);
	append(fixture.repository, "user_input", "old-user", {
		text: "old request",
		clientUserMessageId: "old-user",
		source: "submit",
	});
	append(fixture.repository, "compaction", "compact-1", {
		windowId: "window-1",
		sourceProviderIndex: 0,
		replacement: [{ type: "user", text: "first summary" }],
		summary: "first summary",
	}, false);
	append(fixture.repository, "assistant_output", "between", { text: "between" });
	append(fixture.repository, "compaction", "compact-2", {
		windowId: "window-2",
		sourceProviderIndex: 1,
		replacement: [{ type: "user", text: "latest summary" }],
		summary: "latest summary",
	}, false);
	append(fixture.repository, "assistant_output", "suffix", { text: "suffix" });

	assert.deepEqual(fixture.repository.loadConversationItems("session-1"), [
		{ type: "user", text: "latest summary" },
		{ type: "assistant", text: "suffix" },
	]);
});

test("keeps resume bounded after five hundred compactions without hiding readable history", async (t) => {
	const fixture = await repositoryFixture(t);
	append(fixture.repository, "user_input", "user-before-compaction", {
		text: "original request",
		clientUserMessageId: "user-before-compaction",
		source: "submit",
	});
	for (let window = 1; window <= 500; window += 1) {
		append(fixture.repository, "assistant_output", `assistant-${window}`, {
			text: `assistant before window ${window}`,
		});
		append(fixture.repository, "compaction", `compact-${window}`, {
			windowId: `window-${window}`,
			sourceProviderIndex: window,
			replacement: [{ type: "user", text: `summary-${window}` }],
			summary: `summary-${window}`,
		}, false);
	}
	append(fixture.repository, "user_input", "user-after-compaction", {
		text: "fresh suffix",
		clientUserMessageId: "user-after-compaction",
		source: "submit",
	});

	const providerItems = fixture.repository.loadConversationItems("session-1");
	assert.deepEqual(providerItems, [
		{ type: "user", text: "summary-500" },
		{ type: "user", text: "fresh suffix" },
	]);
	assert.equal(JSON.stringify(providerItems).includes("summary-499"), false);

	const readable = fixture.repository.loadReadableTranscript("session-1");
	assert.equal(readable.length, 502);
	assert.equal(readable[0]?.text, "original request");
	assert.equal(readable.at(-1)?.text, "fresh suffix");
	assert.equal(JSON.stringify(readable).includes("summary-"), false);

	const database = new Database(fixture.dbPath, { readonly: true });
	const plan = database.prepare(`
		EXPLAIN QUERY PLAN
		SELECT sequence_no
		FROM transcript_events
		WHERE session_id = ? AND event_type = 'compaction'
		ORDER BY sequence_no DESC
		LIMIT 1
	`).all("session-1") as readonly { readonly detail: unknown }[];
	database.close();
	assert.match(
		plan.map((row) => String(row.detail)).join("\n"),
		/idx_transcript_events_session_type_sequence/u,
	);
});

test("commits one compaction event and keeps only its reference in mutable state", async (t) => {
	const fixture = await repositoryFixture(t);
	append(fixture.repository, "user_input", "source-user", {
		text: "source text",
		clientUserMessageId: "source-user",
		source: "submit",
	});
	fixture.repository.commitCompaction({
		sessionId: "session-1",
		replacementMessages: [storedUserMessage("[compact-summary]\nsummary text")],
		replacementItems: [{ type: "user", text: "[compact-summary]\nsummary text" }],
		summary: "summary text",
		checkpoint: compactionCheckpoint("window-1", "turn-1", 1),
	});

	assert.deepEqual(fixture.repository.loadConversationItems("session-1"), [
		{ type: "user", text: "[compact-summary]\nsummary text" },
	]);
	assert.deepEqual(fixture.repository.loadSessionSummaries("session-1"), ["summary text"]);
	const checkpoint = fixture.repository.loadState("session-1", "compact_checkpoint");
	assert.equal(typeof checkpoint, "object");
	assert.equal(Reflect.get(checkpoint!, "transcript_event_id"), "compaction:window-1");
	assert.equal("replacement_messages" in (checkpoint as object), false);

	const database = new Database(fixture.dbPath, { readonly: true });
	const stateRow = database.prepare(`
		SELECT payload_json FROM session_state
		WHERE session_id = ? AND state_key = 'compact_checkpoint'
	`).get("session-1") as { readonly payload_json: string };
	const eventRow = database.prepare(`
		SELECT payload_json FROM transcript_events
		WHERE session_id = ? AND event_type = 'compaction'
	`).get("session-1") as { readonly payload_json: string };
	database.close();
	assert.equal(stateRow.payload_json.includes("summary text"), false);
	assert.equal(stateRow.payload_json.includes("replacement_messages"), false);
	assert.equal(eventRow.payload_json.match(/summary text/gu)?.length, 2);
	assert.equal(
		Reflect.get(fixture.repository.loadState("session-1", "responses_continuation_state")!, "eligible"),
		false,
	);
});

test("uses the newest compaction that survives an event-boundary rollback", async (t) => {
	const fixture = await repositoryFixture(t);
	append(fixture.repository, "user_input", "user-1", {
		text: "first request",
		clientUserMessageId: "user-1",
		source: "submit",
	}, true, "turn-1");
	append(fixture.repository, "assistant_output", "assistant-1", { text: "first answer" }, true, "turn-1");
	fixture.repository.commitCompaction({
		sessionId: "session-1",
		replacementMessages: [storedUserMessage("summary one")],
		replacementItems: [{ type: "user", text: "summary one" }],
		summary: "summary one",
		checkpoint: compactionCheckpoint("window-1", "turn-1", 1),
	});
	append(fixture.repository, "user_input", "user-2", {
		text: "second request",
		clientUserMessageId: "user-2",
		source: "submit",
	}, true, "turn-2");
	append(fixture.repository, "assistant_output", "assistant-2", { text: "second answer" }, true, "turn-2");
	fixture.repository.commitCompaction({
		sessionId: "session-1",
		replacementMessages: [storedUserMessage("summary two")],
		replacementItems: [{ type: "user", text: "summary two" }],
		summary: "summary two",
		checkpoint: compactionCheckpoint("window-2", "turn-2", 2),
	});
	append(fixture.repository, "user_input", "user-3", {
		text: "discarded request",
		clientUserMessageId: "user-3",
		source: "submit",
	}, true, "turn-3");
	append(fixture.repository, "rollback", "rollback-1", {
		removedTurnIds: ["turn-2", "turn-3"],
		boundaryEventId: "compaction:window-1",
		reason: "user_requested",
	}, false, "turn-3");
	append(fixture.repository, "user_input", "user-retry", {
		text: "retry request",
		clientUserMessageId: "user-retry",
		source: "submit",
	}, true, "turn-retry");

	assert.equal(fixture.repository.loadLatestCompaction("session-1")?.eventId, "compaction:window-1");
	assert.deepEqual(fixture.repository.loadConversationItems("session-1"), [
		{ type: "user", text: "summary one" },
		{ type: "user", text: "retry request" },
	]);
});

test("preserves bounded opaque provider failures", async (t) => {
	const fixture = await repositoryFixture(t);
	append(fixture.repository, "opaque_legacy", "opaque", {
		sourceKind: "conversation_messages",
		sourceIdentity: "private-row",
		rawPayload: "private-opaque-content",
		errorCode: "projection_failure",
	});

	assert.throws(
		() => fixture.repository.loadConversationItems("session-1"),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.legacy_error_code === "projection_failure"
			&& !error.message.includes("private-row")
			&& !error.message.includes("private-opaque-content"),
	);
});

function append(
	repository: SQLiteTranscriptEventRepository,
	eventType: string,
	eventId: string,
	payload: Readonly<Record<string, unknown>>,
	modelVisible = true,
	turnId = "turn-1",
): void {
	repository.appendEvent(parseTranscriptEventAppendInput({
		schemaVersion: TRANSCRIPT_EVENT_SCHEMA_VERSION,
		sessionId: "session-1",
		eventId,
		turnId,
		eventType,
		modelVisible,
		createdAt: NOW,
		payload,
	}));
}

function compactionCheckpoint(
	windowId: string,
	turnId: string,
	windowNumber: number,
): Readonly<Record<string, unknown>> {
	return {
		version: 1,
		turn_id: turnId,
		reason: "context_limit",
		phase: "pre_turn",
		window_number: windowNumber,
		window_id: windowId,
		history_item_count: windowNumber * 2,
		input_history_hash: `sha256:input-${windowNumber}`,
		replacement_history_hash: `sha256:replacement-${windowNumber}`,
		replacement_messages: [storedUserMessage(`summary ${windowNumber}`)],
		status: "completed",
		summary_request_fingerprint: `sha256:request-${windowNumber}`,
		updated_at: NOW,
	};
}

function storedUserMessage(content: string): Readonly<Record<string, unknown>> {
	return {
		role: "user",
		content,
		tool_call_id: null,
		response_id: null,
		metadata: {},
		blocks: [],
		tool_calls: [],
	};
}

async function repositoryFixture(t: test.TestContext): Promise<{
	readonly dbPath: string;
	readonly repository: SQLiteTranscriptEventRepository;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-event-provider-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
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
