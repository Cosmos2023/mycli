import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import {
	parseTranscriptEventAppendInput,
	SQLiteTranscriptEventRepository,
	StorageFailure,
} from "../src/index.ts";

const NOW = "2026-08-14T00:00:00.000Z";

test("forks a normalized parent prefix by completed event boundary without copying payloads", async (t) => {
	const fixture = await repositoryFixture(t);
	completeToolTurn(fixture.repository, "source", "turn-1", "client-1", "first request");
	completeTextTurn(fixture.repository, "source", "turn-2", "client-2", "second request", "second answer");
	const preferences = {
		state_version: 1,
		provider: "openai",
		protocol: "responses",
		model: "gpt-session",
		api_base_url: "https://session.invalid/v1",
		auth_ref: "session-account",
		reasoning_effort: "high",
		collaboration_mode: "plan",
	};
	fixture.repository.saveState({
		sessionId: "source",
		workspaceRoot: fixture.root,
		threadId: "source",
		key: "session_preferences",
		payload: preferences,
	});
	const boundary = fixture.repository.loadTurnEventWindow("source", "turn-1", { limit: 100 })
		.events.find((event) => event.eventType === "turn_lifecycle"
			&& event.payload.phase === "completed");
	assert.ok(boundary);

	const forked = fixture.repository.forkSession({
		sourceSessionId: "source",
		targetSessionId: "branch",
		forkEventId: boundary.eventId,
	});
	assert.deepEqual(forked, {
		sourceSessionId: "source",
		targetSessionId: "branch",
		forkPoint: 5,
		forkEventSessionId: "source",
		forkEventId: boundary.eventId,
		messageCount: 5,
	});
	assert.deepEqual(fixture.repository.loadSessionLineage("branch"), [
		{ sessionId: "source" },
		{
			sessionId: "branch",
			parentId: "source",
			forkPoint: 5,
			forkEventSessionId: "source",
			forkEventId: boundary.eventId,
		},
	]);
	assert.deepEqual(fixture.repository.loadConversationItems("branch"), [
		{ type: "user", text: "first request" },
		{
			type: "assistant_tool_calls",
			text: "Reading.",
			calls: [
				{ callId: "turn-1-call-a", name: "Read", argumentsJson: "{}" },
				{ callId: "turn-1-call-b", name: "Grep", argumentsJson: "{}" },
			],
			responseId: "turn-1-response-private",
			providerState: { provider: "openai", value: { private: true } },
		},
		{ type: "tool_result", callId: "turn-1-call-a", toolName: "Read", output: "read output", success: true },
		{ type: "tool_result", callId: "turn-1-call-b", toolName: "Grep", output: "grep output", success: true },
		{
			type: "assistant",
			text: "first answer",
			providerState: { provider: "openai", value: { private: "final" } },
		},
	]);
	assert.deepEqual(fixture.repository.loadState("branch", "session_preferences"), preferences);
	assert.equal(fixture.repository.loadState("branch", "input_queue"), undefined);

	const database = new Database(fixture.dbPath, { readonly: true });
	assert.equal(database.prepare(
		"SELECT COUNT(*) FROM transcript_events WHERE session_id = 'branch'",
	).pluck().get(), 0);
	database.close();

	completeTextTurn(fixture.repository, "branch", "branch-turn", "branch-client", "branch request", "branch answer");
	completeTextTurn(fixture.repository, "source", "turn-3", "client-3", "later source", "later answer");
	assert.deepEqual(fixture.repository.loadConversationItems("branch").map(itemText), [
		"first request",
		"Reading.",
		"read output",
		"grep output",
		"first answer",
		"branch request",
		"branch answer",
	]);
	const childDatabase = new Database(fixture.dbPath, { readonly: true });
	assert.deepEqual(childDatabase.prepare(`
		SELECT provider_index FROM transcript_events
		WHERE session_id = 'branch' AND model_visible = 1
		ORDER BY provider_index
	`).all().map((row) => Reflect.get(row as object, "provider_index")), [5, 6]);
	childDatabase.close();

	const complete = fixture.repository.loadReadableTranscript("branch");
	const paged: typeof complete[number][] = [];
	let before: number | undefined;
	for (;;) {
		const page = fixture.repository.loadReadableTranscriptPage("branch", {
			...(before === undefined ? {} : { beforeSequence: before }),
			limit: 2,
		});
		paged.unshift(...page.items);
		if (page.nextBeforeSequence === null) break;
		before = page.nextBeforeSequence;
	}
	assert.deepEqual(paged, complete);
	assert.equal(JSON.stringify(complete).includes("later source"), false);

	assert.throws(
		() => fixture.repository.forkSession({
			sourceSessionId: "source",
			targetSessionId: "split-turn",
			forkPoint: 1,
		}),
		(error: unknown) => error instanceof StorageFailure
			&& error.message === "persistence_error: fork point splits a turn or tool lifecycle",
	);
});

test("uses deterministic branch selection and accepts legacy fork points at whole turns", async (t) => {
	const fixture = await repositoryFixture(t);
	completeTextTurn(fixture.repository, "root", "turn-1", "client-1", "request", "answer");
	fixture.repository.forkSession({ sourceSessionId: "root", targetSessionId: "branch-a", forkPoint: 2 });
	fixture.repository.forkSession({ sourceSessionId: "root", targetSessionId: "branch-z", forkPoint: 2 });
	const database = new Database(fixture.dbPath);
	database.prepare(`
		UPDATE sessions SET last_active_at = ?, updated_at = ? WHERE session_id = ?
	`).run("2026-08-14T01:00:00.000Z", "2026-08-14T01:00:00.000Z", "branch-a");
	database.prepare(`
		UPDATE sessions SET last_active_at = ?, updated_at = ? WHERE session_id = ?
	`).run("2026-08-14T02:00:00.000Z", "2026-08-14T02:00:00.000Z", "branch-z");
	database.close();

	assert.equal(fixture.repository.resolveResumeSessionId("root"), "branch-z");
	assert.deepEqual(fixture.repository.loadConversationItems("branch-a"), [
		{ type: "user", text: "request" },
		{ type: "assistant", text: "answer" },
	]);
});

test("resumes a fork from the newest of five hundred ancestor compactions", async (t) => {
	const fixture = await repositoryFixture(t);
	completeTextTurn(fixture.repository, "source", "turn-1", "client-1", "old request", "old answer");
	const sourceEvent = fixture.repository.loadTurnEventWindow("source", "turn-1", { limit: 100 })
		.events.find((event) => event.eventType === "assistant_output");
	assert.ok(sourceEvent?.providerIndex !== undefined);
	for (let window = 1; window <= 500; window += 1) {
		fixture.repository.appendEvent(parseTranscriptEventAppendInput({
			schemaVersion: 1,
			sessionId: "source",
			eventId: `compaction-${window}`,
			turnId: "turn-1",
			eventType: "compaction",
			modelVisible: false,
			createdAt: NOW,
			payload: {
				windowId: `window-${window}`,
				sourceEventId: sourceEvent.eventId,
				sourceProviderIndex: sourceEvent.providerIndex,
				replacement: [{ type: "user", text: `summary-${window}` }],
				summary: `summary-${window}`,
			},
		}));
	}
	completeTextTurn(fixture.repository, "source", "turn-2", "client-2", "fresh request", "fresh answer");
	const boundary = fixture.repository.loadTurnEventWindow("source", "turn-2", { limit: 100 })
		.events.find((event) => event.eventType === "turn_lifecycle"
			&& event.payload.phase === "completed");
	assert.ok(boundary);
	fixture.repository.forkSession({
		sourceSessionId: "source",
		targetSessionId: "branch",
		forkEventId: boundary.eventId,
	});

	assert.equal(fixture.repository.loadLatestCompaction("branch")?.eventId, "compaction-500");
	assert.deepEqual(fixture.repository.loadConversationItems("branch"), [
		{ type: "user", text: "summary-500" },
		{ type: "user", text: "fresh request" },
		{ type: "assistant", text: "fresh answer" },
	]);
});

test("forks only complete shareable subagent turns and strips provider continuation", async (t) => {
	const fixture = await repositoryFixture(t);
	completeTextTurn(fixture.repository, "source", "turn-1", "client-1", "first", "first answer");
	completeToolTurn(fixture.repository, "source", "turn-2", "client-2", "second");
	fixture.repository.reserveTurn({
		sessionId: "source",
		clientTurnId: "client-pending",
		clientUserMessageId: "user-pending",
		turnId: "turn-pending",
		requestFingerprint: `sha256:${"c".repeat(64)}`,
		workspaceRoot: fixture.root,
		threadId: "source",
		userText: "pending private input",
		startedAt: NOW,
	});

	const forked = fixture.repository.forkAgentConversation({
		sourceSessionId: "source",
		targetSessionId: "child",
		workspaceRoot: fixture.root,
		targetThreadId: "child-thread",
		forkTurns: { kind: "last_n", turns: 1 },
	});
	assert.equal(forked.messageCount, 5);
	assert.deepEqual(fixture.repository.loadConversationItems("child").map(itemText), [
		"second",
		"Reading.",
		"read output",
		"grep output",
		"first answer",
	]);
	assert.deepEqual(fixture.repository.loadSessionLineage("child"), [{ sessionId: "child" }]);
	const database = new Database(fixture.dbPath, { readonly: true });
	const payloads = database.prepare(`
		SELECT payload_json FROM transcript_events WHERE session_id = ? ORDER BY sequence_no
	`).all("child").map((row) => String(Reflect.get(row as object, "payload_json")));
	database.close();
	assert.equal(payloads.join("\n").includes("pending private input"), false);
	assert.equal(payloads.join("\n").includes("providerState"), false);
});

function completeToolTurn(
	repository: SQLiteTranscriptEventRepository,
	sessionId: string,
	turnId: string,
	clientTurnId: string,
	userText: string,
): void {
	repository.reserveTurn({
		sessionId,
		clientTurnId,
		clientUserMessageId: `${clientTurnId}-user`,
		turnId,
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot: "/workspace",
		threadId: sessionId,
		userText,
		startedAt: NOW,
	});
	repository.appendAssistantToolCalls({
		sessionId,
		clientTurnId,
		assistantText: "Reading.",
		calls: [
			{ callId: `${turnId}-call-a`, name: "Read", argumentsJson: "{}" },
			{ callId: `${turnId}-call-b`, name: "Grep", argumentsJson: "{}" },
		],
		responseId: `${turnId}-response-private`,
		providerState: { provider: "openai", value: { private: true } },
	});
	repository.appendToolResult({
		sessionId,
		clientTurnId,
		result: { callId: `${turnId}-call-a`, toolName: "Read", output: "read output", success: true },
		summary: "Read output",
	});
	repository.appendToolResult({
		sessionId,
		clientTurnId,
		result: { callId: `${turnId}-call-b`, toolName: "Grep", output: "grep output", success: true },
		summary: "Grep output",
	});
	repository.completeTurn({
		sessionId,
		clientTurnId,
		assistantText: "first answer",
		responseId: `${turnId}-final-private`,
		providerState: { provider: "openai", value: { private: "final" } },
		usage: {},
		completedAt: NOW,
	});
}

function completeTextTurn(
	repository: SQLiteTranscriptEventRepository,
	sessionId: string,
	turnId: string,
	clientTurnId: string,
	userText: string,
	assistantText: string,
): void {
	repository.reserveTurn({
		sessionId,
		clientTurnId,
		clientUserMessageId: `${clientTurnId}-user`,
		turnId,
		requestFingerprint: `sha256:${"b".repeat(64)}`,
		workspaceRoot: "/workspace",
		threadId: sessionId,
		userText,
		startedAt: NOW,
	});
	repository.completeTurn({
		sessionId,
		clientTurnId,
		assistantText,
		usage: {},
		completedAt: NOW,
	});
}

function itemText(item: ReturnType<SQLiteTranscriptEventRepository["loadConversationItems"]>[number]): string {
	switch (item.type) {
		case "user":
		case "assistant":
		case "assistant_tool_calls":
		case "context":
			return item.text;
		case "tool_result":
			return item.output;
	}
}

async function repositoryFixture(t: TestContext): Promise<{
	readonly root: string;
	readonly dbPath: string;
	readonly repository: SQLiteTranscriptEventRepository;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-event-lineage-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const dbPath = join(root, "sessions.db");
	const repository = new SQLiteTranscriptEventRepository({ dbPath, clock: () => NOW });
	t.after(() => repository.close());
	return { root, dbPath, repository };
}
