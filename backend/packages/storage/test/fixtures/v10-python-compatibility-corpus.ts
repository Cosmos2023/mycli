import process from "node:process";
import Database from "better-sqlite3";
import {
	parseTranscriptEventAppendInput,
	SQLiteTranscriptEventRepository,
	TRANSCRIPT_EVENT_SCHEMA_VERSION,
} from "../../src/index.ts";

const NOW = "2026-08-14T00:00:00.000Z";

const [dbPath, workspaceRoot] = process.argv.slice(2);
if (!dbPath || !workspaceRoot) {
	throw new Error("usage: v10-python-compatibility-corpus <db-path> <workspace-root>");
}

const repository = new SQLiteTranscriptEventRepository({ dbPath, clock: () => NOW });
try {
	completeToolTurn(repository, "parent", "turn-parent", "client-parent", "shared-marker request");
	repository.appendDisplayActivity({
		sessionId: "parent",
		eventId: "parent-plan",
		turnId: "turn-parent",
		activityType: "plan",
		text: "Plan complete",
		metadata: { items: [{ id: "step-1", text: "Inspect", status: "completed" }] },
		createdAt: NOW,
	});
	const boundary = repository.loadTurnEventWindow("parent", "turn-parent", { limit: 100 })
		.events.find((event) => event.eventType === "turn_lifecycle"
			&& event.payload.phase === "completed");
	if (!boundary) throw new Error("parent terminal boundary missing");
	repository.forkSession({
		sourceSessionId: "parent",
		targetSessionId: "child",
		forkEventId: boundary.eventId,
	});
	completeTextTurn(repository, "child", "turn-child", "client-child", "child request", "child answer");
	completeTextTurn(repository, "parent", "turn-later", "client-later", "later parent", "later answer");

	completeTextTurn(repository, "compact", "turn-old", "client-old", "old request", "old answer");
	const source = repository.loadTurnEventWindow("compact", "turn-old", { limit: 100 })
		.events.find((event) => event.eventType === "assistant_output");
	if (!source || source.providerIndex === undefined) throw new Error("compaction source missing");
	repository.appendEvent(parseTranscriptEventAppendInput({
		schemaVersion: TRANSCRIPT_EVENT_SCHEMA_VERSION,
		sessionId: "compact",
		eventId: "compact-latest",
		turnId: "turn-old",
		eventType: "compaction",
		modelVisible: false,
		createdAt: NOW,
		payload: {
			windowId: "window-latest",
			sourceEventId: source.eventId,
			sourceProviderIndex: source.providerIndex,
			replacement: [{ type: "user", text: "latest summary" }],
			summary: "latest summary",
		},
	}));
	completeTextTurn(repository, "compact", "turn-suffix", "client-suffix", "fresh suffix", "fresh answer");

	insertSession(dbPath, "opaque-provider", workspaceRoot, "opaque-provider-thread");
	insertSession(dbPath, "opaque-readable", workspaceRoot, "opaque-readable-thread");
	repository.appendEvent(parseTranscriptEventAppendInput({
		schemaVersion: TRANSCRIPT_EVENT_SCHEMA_VERSION,
		sessionId: "opaque-provider",
		eventId: "opaque-provider-event",
		eventType: "opaque_legacy",
		modelVisible: true,
		createdAt: NOW,
		payload: {
			sourceKind: "conversation_messages",
			sourceIdentity: "provider-row",
			rawPayload: "private provider payload",
			errorCode: "projection_failure",
		},
	}));
	repository.appendEvent(parseTranscriptEventAppendInput({
		schemaVersion: TRANSCRIPT_EVENT_SCHEMA_VERSION,
		sessionId: "opaque-readable",
		eventId: "opaque-readable-event",
		eventType: "opaque_legacy",
		modelVisible: false,
		createdAt: NOW,
		payload: {
			sourceKind: "history_items",
			sourceIdentity: "history-row",
			rawPayload: "private readable payload",
			errorCode: "invalid_json",
		},
	}));

	const output = {
		provider: {
			parent: repository.loadConversationItems("parent"),
			child: repository.loadConversationItems("child"),
			compact: repository.loadConversationItems("compact"),
		},
		history: {
			parent: historyShape(repository.loadHistoryItems("parent")),
			child: historyShape(repository.loadHistoryItems("child")),
		},
		searchSessionIds: repository.searchMessages("shared-marker", { limit: 20 })
			.map((result) => result.sessionId),
		sessions: repository.listSessions({ workspaceRoot, limit: 20 }).map((session) => ({
			sessionId: session.sessionId,
			messageCount: session.messageCount,
			summaryCount: session.summaryCount,
			threadId: session.threadId,
		})),
	};
	process.stdout.write(`${JSON.stringify(output)}\n`);
} finally {
	repository.close();
}

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
		workspaceRoot,
		threadId: `${sessionId}-thread`,
		userText,
		startedAt: NOW,
	});
	repository.appendAssistantToolCalls({
		sessionId,
		clientTurnId,
		assistantText: "Reading.",
		calls: [
			{ callId: "call-read", name: "Read", argumentsJson: "{\"path\":\"README.md\"}" },
			{ callId: "call-grep", name: "Grep", argumentsJson: "{\"query\":\"marker\"}" },
		],
		responseId: "response-tools",
		providerState: { provider: "openai", value: { opaque: "state" } },
	});
	repository.appendToolResult({
		sessionId,
		clientTurnId,
		result: { callId: "call-read", toolName: "Read", output: "read output", success: true },
		summary: "Read complete",
	});
	repository.appendToolResult({
		sessionId,
		clientTurnId,
		result: { callId: "call-grep", toolName: "Grep", output: "grep output", success: true },
		summary: "Grep complete",
	});
	repository.completeTurn({
		sessionId,
		clientTurnId,
		assistantText: "parent answer",
		providerState: { provider: "openai", value: { opaque: "final" } },
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
		workspaceRoot,
		threadId: `${sessionId}-thread`,
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

function insertSession(
	path: string,
	sessionId: string,
	workspace: string,
	threadId: string,
): void {
	const database = new Database(path);
	try {
		database.prepare(`
			INSERT INTO sessions (
				session_id, workspace_root, thread_id, created_at,
				updated_at, last_active_at, status
			) VALUES (?, ?, ?, ?, ?, ?, 'active')
		`).run(sessionId, workspace, threadId, NOW, NOW, NOW);
	} finally {
		database.close();
	}
}

function historyShape(
	items: readonly Readonly<Record<string, unknown>>[],
): readonly Readonly<Record<string, unknown>>[] {
	return items.map((item) => ({
		type: item.type,
		text: item.text,
		thread_id: item.thread_id,
		tool_name: item.tool_name,
		call_id: item.call_id,
	}));
}
