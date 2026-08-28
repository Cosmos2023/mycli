import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	TURN_INTERRUPTED_NOTICE,
	turnInterruptedNoticeId,
} from "@mycli/contracts";
import Database from "better-sqlite3";
import {
	parseTranscriptEventAppendInput,
	parseTranscriptEventEnvelope,
	projectTranscriptEventsToReadableItems,
	SQLiteTranscriptEventRepository,
	StorageFailure,
	type TranscriptEventAppendInput,
} from "../src/index.ts";

const NOW = "2026-08-14T00:00:00.000Z";

test("projects reasoning, plans, approvals, clarifications, shell activity, and merged tools", () => {
	const events = [
		event(1, "user_input", {
			text: "inspect",
			clientUserMessageId: "user-1",
			source: "submit",
		}, true),
		event(2, "assistant_tool_call_batch", {
			text: "Working.",
			calls: [{ callId: "call-shell", name: "Shell", argumentsJson: "{\"command\":\"npm test\"}" }],
			readableProjection: {
				itemId: "legacy-assistant-preamble",
				assistantPreambleVisible: true,
				toolCallItemIds: { "call-shell": "legacy-tool-call" },
			},
		}, true),
		displayEvent(3, "reasoning", "Checking the failure."),
		displayEvent(4, "plan", "Plan updated", {
			items: [{ id: "step-1", text: "Run tests", status: "completed" }],
		}),
		displayEvent(5, "approval_request", "Approve command"),
		displayEvent(6, "approval_resolution", "Approved"),
		displayEvent(7, "clarification_request", "Which package?"),
		displayEvent(8, "clarification_response", "storage", {
			request_id: "question-1",
			header: "Package",
			question: "Which package?",
			response: "storage",
			multi_select: false,
		}),
		event(9, "display_activity", {
			activityType: "shell",
			callId: "call-shell",
			toolName: "Shell",
			status: "completed",
			metadata: {
				terminal_state: "completed",
				process_state: "completed",
				command_preview: "npm test",
				output: "tests passed",
				exit_code: 0,
			},
		}, false),
		event(10, "tool_result", {
			result: {
				callId: "call-shell",
				toolName: "Shell",
				output: "tests passed",
				success: true,
			},
			summary: "Tests passed",
		}, true),
		displayEvent(11, "warning", "One warning remains"),
		event(12, "display_activity", {
			activityType: "web_search",
			text: "mycli docs ...",
			callId: "ws-1",
			status: "completed",
			metadata: {
				action_type: "search",
				queries: ["mycli docs", "mycli web search"],
			},
		}, false),
		displayEvent(13, "turn_completed", "", { duration_ms: 4_000 }),
	];

	const items = projectTranscriptEventsToReadableItems(events, { limit: Number.MAX_SAFE_INTEGER });
	assert.deepEqual(items.map((item) => item.type), [
		"user_message",
		"assistant_message",
		"tool",
		"reasoning_summary",
		"plan_update",
		"warning",
		"status",
		"status",
		"clarification",
		"warning",
		"web_search",
		"turn_completed",
	]);
	const tool = items.find((item) => item.type === "tool");
	assert.equal(items.find((item) => item.type === "assistant_message")?.id, "legacy-assistant-preamble");
	assert.equal(tool?.call_id, "call-shell");
	assert.equal(tool?.status, "completed");
	assert.equal(tool?.output, "tests passed");
	assert.equal(tool?.command, "npm test");
	assert.deepEqual(items.find((item) => item.type === "plan_update")?.metadata?.items, [
		{ id: "step-1", text: "Run tests", status: "completed" },
	]);
	assert.deepEqual(items.find((item) => item.type === "clarification")?.metadata, {
		request_id: "question-1",
		header: "Package",
		question: "Which package?",
		response: "storage",
		multi_select: false,
	});
	assert.deepEqual(items.find((item) => item.type === "web_search"), {
		id: "event-12",
		type: "web_search",
		text: "mycli docs ...",
		created_at: NOW,
		call_id: "ws-1",
		metadata: {
			action_type: "search",
			queries: ["mycli docs", "mycli web search"],
		},
		status: "completed",
	});
	assert.deepEqual(items.find((item) => item.type === "turn_completed"), {
		id: "event-13",
		type: "turn_completed",
		created_at: NOW,
		duration_ms: 4_000,
	});
});

test("hides model-only, compaction, rollback, activation, and internal user events", () => {
	const events = [
		event(1, "context", {
			itemId: "context-1",
			text: "private instructions",
			metadata: contextMetadata(),
		}, true),
		event(2, "display_activity", {
			activityType: "tool_activation",
			text: "private activation",
		}, false),
		event(3, "compaction", {
			windowId: "window-1",
			sourceProviderIndex: 0,
			replacement: [{ type: "user", text: "private summary replacement" }],
			summary: "private summary",
		}, false),
		event(4, "rollback", {
			removedTurnIds: ["turn-old"],
			reason: "user_requested",
		}, false),
		event(5, "user_input", {
			text: "private mailbox notification",
			clientUserMessageId: "mailbox-1",
			source: "agent_mailbox",
		}, true),
		event(6, "user_input", {
			text: "private approval resume",
			clientUserMessageId: "approval-1",
			source: "approval_resume",
		}, true),
		event(7, "assistant_output", { text: "visible answer" }, true),
	];

	assert.deepEqual(projectTranscriptEventsToReadableItems(events), [{
		id: "turn-1:assistant:1",
		type: "assistant_message",
		text: "visible answer",
		created_at: NOW,
	}]);
});

test("restores historical interrupted warnings and deduplicates persisted notices", async (t) => {
	const fixture = await repositoryFixture(t);
	append(fixture.repository, 1, "user_input", "old-user", {
		text: "/old",
		clientUserMessageId: "old-user",
		source: "submit",
	}, true);
	fixture.repository.appendEvent(parseTranscriptEventAppendInput({
		schemaVersion: 1,
		sessionId: "session-1",
		eventId: "old-turn-aborted-context",
		eventType: "context",
		modelVisible: true,
		createdAt: NOW,
		payload: {
			itemId: "turn-aborted:old",
			text: "<turn_aborted>interrupted</turn_aborted>",
			metadata: {
				...contextMetadata(),
				kind: "turn_aborted",
				sourceId: "turn-aborted:old",
			},
		},
	}));
	append(fixture.repository, 1, "turn_lifecycle", "old-interrupted", {
		phase: "interrupted",
		errorCode: "interrupted",
		message: "turn interrupted",
	}, false);
	append(fixture.repository, 2, "user_input", "new-user", {
		text: "/new",
		clientUserMessageId: "new-user",
		source: "submit",
	}, true);
	append(
		fixture.repository,
		2,
		"display_activity",
		turnInterruptedNoticeId("turn-2"),
		{
			activityType: "warning",
			text: TURN_INTERRUPTED_NOTICE,
			status: "interrupted",
			metadata: {
				event_kind: "turn_interrupted",
				interrupted_turn_id: "turn-2",
				status: "interrupted",
			},
		},
		false,
	);
	append(fixture.repository, 2, "turn_lifecycle", "new-interrupted", {
		phase: "interrupted",
		errorCode: "interrupted",
		message: "turn interrupted",
	}, false);

	const readable = fixture.repository.loadReadableTranscript("session-1");
	const recent = fixture.repository.loadRecentReadableTranscript("session-1");
	const page = fixture.repository.loadReadableTranscriptPage("session-1", { limit: 500 });
	assert.deepEqual(
		readable.filter((item) => item.type === "warning").map((item) => [
			item.id,
			item.text,
			item.metadata?.status,
		]),
		[
			[turnInterruptedNoticeId("turn-1"), TURN_INTERRUPTED_NOTICE, "interrupted"],
			[turnInterruptedNoticeId("turn-2"), TURN_INTERRUPTED_NOTICE, "interrupted"],
		],
	);
	assert.deepEqual(recent, readable);
	assert.deepEqual(page.items, readable);
	assert.equal(page.nextBeforeSequence, null);
	assert.equal(
		JSON.stringify(fixture.repository.loadConversationItems("session-1"))
			.includes(TURN_INTERRUPTED_NOTICE),
		false,
	);
});

test("preserves valid opaque readable rows and fails malformed rows without exposing bytes", () => {
	const valid = event(1, "opaque_legacy", {
		sourceKind: "history_items",
		sourceIdentity: "row-1",
		rawPayload: JSON.stringify({
			id: "legacy-warning",
			turn_id: "turn-1",
			type: "warning",
			text: "legacy warning",
			metadata: {},
		}),
		errorCode: "unsupported_shape",
	}, false);
	assert.equal(projectTranscriptEventsToReadableItems([valid])[0]?.text, "legacy warning");

	const malformed = event(1, "opaque_legacy", {
		sourceKind: "history_items",
		sourceIdentity: "private-row",
		rawPayload: "private-malformed-bytes",
		errorCode: "invalid_json",
	}, false);
	assert.throws(
		() => projectTranscriptEventsToReadableItems([malformed]),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.legacy_error_code === "invalid_json"
			&& !error.message.includes("private-row")
			&& !error.message.includes("private-malformed-bytes"),
	);
});

test("keeps complete history across compactions and pages it at whole turn boundaries", async (t) => {
	const fixture = await repositoryFixture(t);
	for (let turn = 1; turn <= 260; turn += 1) {
		append(fixture.repository, turn, "user_input", `user-${turn}`, {
			text: `turn-${turn}-user`,
			clientUserMessageId: `user-${turn}`,
			source: "submit",
		}, true);
		append(fixture.repository, turn, "assistant_output", `assistant-${turn}`, {
			text: `turn-${turn}-assistant`,
		}, true);
		if (turn === 80 || turn === 160 || turn === 240) {
			append(fixture.repository, turn, "compaction", `compact-${turn}`, {
				windowId: `window-${turn}`,
				sourceProviderIndex: turn * 2 - 1,
				replacement: [{ type: "user", text: `summary-${turn}` }],
				summary: `summary-${turn}`,
			}, false);
		}
	}

	const complete = fixture.repository.loadReadableTranscript("session-1");
	assert.equal(complete.length, 520);
	assert.equal(complete[0]?.text, "turn-1-user");
	assert.equal(complete.at(-1)?.text, "turn-260-assistant");
	assert.equal(JSON.stringify(complete).includes("summary-"), false);
	const recent = fixture.repository.loadRecentReadableTranscript("session-1");
	assert.equal(recent.length, 500);
	assert.equal(recent[0]?.text, "turn-11-user");

	const paged: typeof complete[number][] = [];
	let before: number | undefined;
	for (;;) {
		const page = fixture.repository.loadReadableTranscriptPage("session-1", {
			...(before === undefined ? {} : { beforeSequence: before }),
			limit: 100,
		});
		paged.unshift(...page.items);
		if (page.nextBeforeSequence === null) break;
		before = page.nextBeforeSequence;
	}
	assert.deepEqual(paged, complete);
});

test("pages call-scoped Shell activity with its originating turn", async (t) => {
	const fixture = await repositoryFixture(t);
	append(fixture.repository, 1, "user_input", "user-1", {
		text: "run the tests",
		clientUserMessageId: "user-1",
		source: "submit",
	}, true);
	append(fixture.repository, 1, "assistant_tool_call_batch", "call-batch-1", {
		text: "",
		calls: [{ callId: "call-shell", name: "Shell", argumentsJson: "{\"command\":\"npm test\"}" }],
	}, true);
	fixture.repository.appendEvent(parseTranscriptEventAppendInput({
		schemaVersion: 1,
		sessionId: "session-1",
		eventId: "shell-snapshot-1",
		turnId: "call-shell",
		eventType: "display_activity",
		modelVisible: false,
		createdAt: NOW,
		payload: {
			activityType: "shell",
			callId: "call-shell",
			toolName: "Shell",
			status: "completed",
			metadata: {
				shell_id: "shell-1",
				command_preview: "npm test",
				output: "tests passed",
				process_state: "completed",
				terminal_state: "completed",
				exit_code: 0,
			},
		},
	}));
	append(fixture.repository, 1, "tool_result", "tool-result-1", {
		result: {
			callId: "call-shell",
			toolName: "Shell",
			output: "Chunk ID: internal-only\nFinal output:\ntests passed",
			success: true,
		},
		summary: "Shell completed",
	}, true);
	append(fixture.repository, 1, "assistant_output", "assistant-1", {
		text: "The tests passed.",
	}, true);

	const complete = fixture.repository.loadReadableTranscript("session-1");
	const page = fixture.repository.loadReadableTranscriptPage("session-1", { limit: 1 });

	assert.deepEqual(page.items, complete);
	assert.equal(page.nextBeforeSequence, null);
	const tools = page.items.filter((item) => item.type === "tool");
	assert.equal(tools.length, 1);
	assert.equal(tools[0]?.command, "npm test");
	assert.equal(tools[0]?.output, "tests passed");
	assert.equal(JSON.stringify(page.items).includes("Chunk ID:"), false);
});

function event(
	sequenceNo: number,
	eventType: string,
	payload: Readonly<Record<string, unknown>>,
	modelVisible: boolean,
) {
	return parseTranscriptEventEnvelope({
		schemaVersion: 1,
		sequenceNo,
		sessionId: "session-1",
		eventId: `event-${sequenceNo}`,
		turnId: "turn-1",
		eventType,
		...(modelVisible ? { providerIndex: sequenceNo - 1 } : {}),
		modelVisible,
		createdAt: NOW,
		payload,
	});
}

function displayEvent(
	sequenceNo: number,
	activityType: string,
	text: string,
	metadata: Readonly<Record<string, unknown>> = {},
) {
	return event(sequenceNo, "display_activity", { activityType, text, metadata }, false);
}

function contextMetadata() {
	return {
		kind: "skill_instructions",
		role: "developer",
		cacheClass: "dynamic",
		durability: "persistent",
		scope: "transcript",
		sourceId: "readable-test",
		contentSha256: "a".repeat(64),
		contentLength: 20,
	};
}

function append(
	repository: SQLiteTranscriptEventRepository,
	turn: number,
	eventType: string,
	eventId: string,
	payload: Readonly<Record<string, unknown>>,
	modelVisible: boolean,
): void {
	repository.appendEvent(parseTranscriptEventAppendInput({
		schemaVersion: 1,
		sessionId: "session-1",
		eventId,
		turnId: `turn-${turn}`,
		eventType,
		modelVisible,
		createdAt: NOW,
		payload,
	}) as TranscriptEventAppendInput);
}

async function repositoryFixture(t: test.TestContext): Promise<{
	readonly repository: SQLiteTranscriptEventRepository;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-readable-events-"));
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
	return { repository };
}
