import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	TURN_INTERRUPTED_NOTICE,
	turnCompletedDurationId,
	turnFailedNoticeId,
	turnFailureNotice,
	turnInterruptedNoticeId,
} from "@mycli/contracts";
import Database from "better-sqlite3";
import {
	SQLiteTranscriptEventRepository,
	type ReserveTurnInput,
} from "../src/index.ts";

const NOW = "2026-08-14T00:00:00.000Z";
const LATER = "2026-08-14T00:01:00.000Z";
const CONTEXT_METADATA = Object.freeze({
	kind: "skill_instructions" as const,
	role: "developer" as const,
	cacheClass: "dynamic" as const,
	durability: "persistent" as const,
	scope: "transcript" as const,
	sourceId: "turn-store-test",
	contentSha256: "a".repeat(64),
	contentLength: 19,
});

test("writes one canonical event per turn semantic action without legacy transcript rows", async (t) => {
	const fixture = await repositoryFixture(t);
	const reservation = fixture.repository.reserveTurn({
		...submission("session-complete", "client-complete", "turn-complete"),
		imagePaths: ["/input/image.png"],
		images: [{ mediaType: "image/png", data: "aGVsbG8=" }],
	});
	const duplicate = fixture.repository.reserveTurn({
		...submission("session-complete", "client-complete", "turn-complete"),
		imagePaths: ["/input/image.png"],
		images: [{ mediaType: "image/png", data: "aGVsbG8=" }],
	});
	assert.equal(reservation.kind, "reserved");
	assert.equal(duplicate.kind, "existing");

	fixture.repository.appendAssistantToolCalls({
		sessionId: "session-complete",
		clientTurnId: "client-complete",
		assistantText: "Checking both files.",
		calls: [
			{ callId: "call-a", name: "Read", argumentsJson: "{\"offset\":1,\"path\":\"a.ts\"}" },
			{ callId: "call-b", name: "Read", argumentsJson: "{\"path\":\"b.ts\"}" },
		],
		responseId: "response-tools",
	});
	fixture.repository.appendToolResult({
		sessionId: "session-complete",
		clientTurnId: "client-complete",
		result: {
			callId: "call-a",
			toolName: "Read",
			output: "unique-full-tool-output-a",
			success: true,
		},
		summary: "Read a.ts",
	});
	fixture.repository.appendToolResult({
		sessionId: "session-complete",
		clientTurnId: "client-complete",
		result: {
			callId: "call-b",
			toolName: "Read",
			output: "unique-full-tool-output-b",
			success: true,
		},
		summary: "Read b.ts",
	});
	fixture.repository.appendContextItem({
		sessionId: "session-complete",
		itemId: "context-complete",
		text: "Persistent context",
		metadata: CONTEXT_METADATA,
	});
	const completed = fixture.repository.completeTurn({
		sessionId: "session-complete",
		clientTurnId: "client-complete",
		assistantText: "Repository inspected.",
		usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
		lastTokenUsage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
		responseId: "response-complete",
		completedAt: LATER,
	});

	assert.equal(completed.status, "completed");
	const events = fixture.repository.loadEventWindow("session-complete", { limit: 100 }).events;
	assert.deepEqual(events.map((event) => event.eventType), [
		"user_input",
		"assistant_tool_call_batch",
		"tool_result",
		"tool_result",
		"context",
		"assistant_output",
		"display_activity",
		"turn_lifecycle",
	]);
	assert.equal(events.filter((event) => event.eventType === "user_input").length, 1);
	const user = events.find((event) => event.eventType === "user_input");
	assert.equal(user?.eventType === "user_input" && user.payload.images?.[0]?.data, "aGVsbG8=");
	const completedDuration = events.find(
		(event) => event.eventId === turnCompletedDurationId("turn-complete"),
	);
	assert.equal(completedDuration?.modelVisible, false);
	assert.deepEqual(
		completedDuration?.eventType === "display_activity" ? completedDuration.payload : undefined,
		{
			activityType: "turn_completed",
			status: "completed",
			metadata: { duration_ms: 60_000 },
		},
	);
	assert.deepEqual(fixture.repository.loadReadableTranscript("session-complete").at(-1), {
		id: turnCompletedDurationId("turn-complete"),
		type: "turn_completed",
		created_at: LATER,
		duration_ms: 60_000,
	});
	assert.deepEqual(fixture.repository.loadConversationItems("session-complete").map((item) => item.type), [
		"user",
		"assistant_tool_calls",
		"tool_result",
		"tool_result",
		"context",
		"assistant",
	]);

	const database = new Database(fixture.dbPath, { readonly: true });
	t.after(() => database.close());
	const tables = new Set((database.prepare(`
		SELECT name FROM sqlite_master WHERE type = 'table'
	`).all() as readonly { name: string }[]).map((row) => row.name));
	for (const legacy of [
		"conversation_messages",
		"history_items",
		"turn_rollouts",
		"session_summaries",
	]) {
		assert.equal(tables.has(legacy), false);
	}
	const payloads = (database.prepare(`
		SELECT payload_json FROM transcript_events WHERE session_id = ? ORDER BY sequence_no
	`).all("session-complete") as readonly { payload_json: string }[])
		.map((row) => row.payload_json).join("\n");
	assert.equal(payloads.split("unique-full-tool-output-a").length - 1, 1);
	assert.equal(payloads.split("unique-full-tool-output-b").length - 1, 1);
});

test("writes terminal lifecycle events for failures and closes interrupted calls canonically", async (t) => {
	const fixture = await repositoryFixture(t);
	fixture.repository.reserveTurn(submission("session-failed", "client-failed", "turn-failed"));
	const failed = fixture.repository.failTurn({
		sessionId: "session-failed",
		clientTurnId: "client-failed",
		code: "provider_error",
		message: "provider request failed",
		additionalDetails: "Invalid schema token=private-value (status 400)\n at request (/Users/private/app.ts:1:2)",
		diagnostics: { status: 400 },
		completedAt: LATER,
	});
	assert.equal(failed.status, "failed");
	assert.deepEqual(
		fixture.repository.loadEventWindow("session-failed", { limit: 20 }).events
			.map((event) => event.eventType),
		["user_input", "display_activity", "turn_lifecycle"],
	);
	const failedTranscript = fixture.repository.loadReadableTranscript("session-failed");
	assert.deepEqual(failedTranscript.map((item) => item.type), ["user_message", "error"]);
	assert.deepEqual(
		failedTranscript.filter((item) => item.id === turnFailedNoticeId("turn-failed")),
		[{
			id: turnFailedNoticeId("turn-failed"),
			type: "error",
			text: turnFailureNotice(
				"provider_error",
				"provider request failed",
			),
			created_at: LATER,
			metadata: {
				status: "failed",
				source: "runtime",
				code: "provider_error",
				additional_details: "Invalid schema token=[REDACTED] (status 400)",
			},
		}],
	);
	assert.doesNotMatch(JSON.stringify(failedTranscript), /private-value/u);
	assert.deepEqual(failed.result, {
		message: "provider request failed",
		additional_details: "Invalid schema token=[REDACTED] (status 400)",
		diagnostics: { status: 400 },
	});
	const failedLifecycle = fixture.repository.loadEventWindow("session-failed", { limit: 20 }).events
		.find((event) => event.eventType === "turn_lifecycle");
	assert.equal(
		failedLifecycle?.eventType === "turn_lifecycle"
			? failedLifecycle.payload.additionalDetails
			: undefined,
		"Invalid schema token=[REDACTED] (status 400)",
	);

	fixture.repository.reserveTurn(
		submission("session-interrupted", "client-interrupted", "turn-interrupted"),
	);
	fixture.repository.appendAssistantToolCalls({
		sessionId: "session-interrupted",
		clientTurnId: "client-interrupted",
		assistantText: "",
		calls: [{ callId: "call-read", name: "Read", argumentsJson: "{}" }],
	});
	const interrupted = fixture.repository.failTurn({
		sessionId: "session-interrupted",
		clientTurnId: "client-interrupted",
		code: "interrupted",
		message: "turn interrupted",
		completedAt: LATER,
	});
	assert.equal(interrupted.status, "interrupted");
	const events = fixture.repository.loadEventWindow("session-interrupted", { limit: 20 }).events;
	assert.deepEqual(events.map((event) => event.eventType), [
		"user_input",
		"assistant_tool_call_batch",
		"tool_result",
		"context",
		"display_activity",
		"turn_lifecycle",
	]);
	const generated = events.find((event) => event.eventType === "tool_result");
	assert.equal(
		generated?.eventType === "tool_result" && generated.payload.errorKind,
		"tool_interrupted",
	);
	assert.deepEqual(fixture.repository.loadPendingToolCalls(
		"session-interrupted",
		"turn-interrupted",
	), []);
	const display = events.find((event) => event.eventType === "display_activity");
	assert.equal(display?.modelVisible, false);
	assert.equal(
		display?.eventType === "display_activity" ? display.payload.activityType : undefined,
		"warning",
	);
	assert.equal(
		display?.eventType === "display_activity" ? display.payload.text : undefined,
		TURN_INTERRUPTED_NOTICE,
	);
	assert.deepEqual(
		fixture.repository.loadReadableTranscript("session-interrupted")
			.filter((item) => item.id === turnInterruptedNoticeId("turn-interrupted")),
		[{
			id: turnInterruptedNoticeId("turn-interrupted"),
			type: "warning",
			text: TURN_INTERRUPTED_NOTICE,
			created_at: LATER,
			metadata: { status: "interrupted" },
		}],
	);
	assert.equal(
		JSON.stringify(fixture.repository.loadConversationItems("session-interrupted"))
			.includes(TURN_INTERRUPTED_NOTICE),
		false,
	);
});

test("recovers orphaned turns once with generated tool results and an interrupted lifecycle", async (t) => {
	const fixture = await repositoryFixture(t, { processId: 900_001 });
	fixture.repository.reserveTurn(
		submission("session-recovery", "client-recovery", "turn-recovery"),
	);
	fixture.repository.appendAssistantToolCalls({
		sessionId: "session-recovery",
		clientTurnId: "client-recovery",
		assistantText: "",
		calls: [{ callId: "call-recovery", name: "Shell", argumentsJson: "{}" }],
	});
	fixture.repository.close();

	const recovered = new SQLiteTranscriptEventRepository({
		dbPath: fixture.dbPath,
		clock: () => LATER,
		isProcessAlive: () => false,
	});
	t.after(() => recovered.close());
	assert.equal(recovered.loadTurn("session-recovery", "client-recovery")?.status, "interrupted");
	assert.equal(recovered.recoverInterruptedTurns(), 0);
	assert.deepEqual(
		recovered.loadEventWindow("session-recovery", { limit: 20 }).events
			.map((event) => event.eventType),
		["user_input", "assistant_tool_call_batch", "tool_result", "display_activity", "turn_lifecycle"],
	);
	assert.deepEqual(recovered.loadPendingToolCalls("session-recovery", "turn-recovery"), []);
	assert.deepEqual(
		recovered.loadReadableTranscript("session-recovery")
			.filter((item) => item.id === turnInterruptedNoticeId("turn-recovery"))
			.map((item) => [item.type, item.text]),
		[["warning", TURN_INTERRUPTED_NOTICE]],
	);
});

test("persists display-only activity without changing provider input or search visibility", async (t) => {
	const fixture = await repositoryFixture(t);
	fixture.repository.reserveTurn(
		submission("session-display", "client-display", "turn-display"),
	);
	const activities = [
		["reasoning", "Private reasoning summary"],
		["approval_request", "Approve the command?"],
		["approval_resolution", "Command approved"],
		["clarification_request", "Which package?"],
		["clarification_response", "Use storage"],
		["shell", "Shell state updated"],
		["context_baseline", "baseline-only-marker"],
	] as const;
	for (const [index, [activityType, text]] of activities.entries()) {
		fixture.repository.appendDisplayActivity({
			sessionId: "session-display",
			eventId: `display-${index}`,
			turnId: "turn-display",
			activityType,
			text,
			...(activityType === "shell" ? {
				callId: "shell-display",
				toolName: "Shell",
				status: "completed",
				metadata: { output: "shell display output", exit_code: 0 },
			} : {}),
			createdAt: NOW,
		});
	}

	fixture.repository.appendAssistantToolCalls({
		sessionId: "session-display",
		clientTurnId: "client-display",
		assistantText: "",
		calls: [{ callId: "call-plan", name: "update_plan", argumentsJson: "{}" }],
	});
	fixture.repository.appendToolResult({
		sessionId: "session-display",
		clientTurnId: "client-display",
		result: {
			callId: "call-plan",
			toolName: "update_plan",
			output: "plan updated",
			success: true,
		},
		summary: "Plan updated",
		planUpdate: {
			explanation: "Implementation plan",
			items: [{ id: "step-1", text: "Implement storage", status: "in_progress" }],
		},
	});
	fixture.repository.appendAssistantToolCalls({
		sessionId: "session-display",
		clientTurnId: "client-display",
		assistantText: "",
		calls: [{ callId: "call-activation", name: "tool_search", argumentsJson: "{}" }],
	});
	fixture.repository.appendToolResult({
		sessionId: "session-display",
		clientTurnId: "client-display",
		result: {
			callId: "call-activation",
			toolName: "tool_search",
			output: "tools activated",
			success: true,
		},
		summary: "Tools activated",
		toolActivation: { names: ["Read", "Grep"] },
	});

	const events = fixture.repository.loadEventWindow("session-display", { limit: 100 }).events;
	const displayEvents = events.filter((event) => event.eventType === "display_activity");
	assert.equal(displayEvents.length, activities.length + 2);
	assert.ok(displayEvents.every((event) => event.modelVisible === false));
	assert.deepEqual(fixture.repository.loadToolActivations("session-display", "turn-display"), [
		"Read",
		"Grep",
	]);
	assert.deepEqual(fixture.repository.loadConversationItems("session-display").map((item) => item.type), [
		"user",
		"assistant_tool_calls",
		"tool_result",
		"assistant_tool_calls",
		"tool_result",
	]);
	assert.deepEqual(fixture.repository.searchMessages("baseline-only-marker"), []);

	const readable = fixture.repository.loadReadableTranscript("session-display");
	assert.ok(readable.some((item) => item.type === "reasoning_summary"));
	assert.ok(readable.some((item) => item.type === "plan_update"
		&& item.text === "Updated Plan"
		&& item.metadata?.items !== undefined));
	assert.ok(readable.some((item) => item.type === "tool"
		&& item.tool_name === "Shell"
		&& item.output === "shell display output"));
	assert.equal(JSON.stringify(readable).includes("baseline-only-marker"), false);
	assert.equal(JSON.stringify(readable).includes("tool_activation"), false);
});

function submission(
	sessionId: string,
	clientTurnId: string,
	turnId: string,
): ReserveTurnInput {
	return {
		sessionId,
		clientTurnId,
		clientUserMessageId: `user-${clientTurnId}`,
		turnId,
		requestFingerprint: `sha256:${"b".repeat(64)}`,
		workspaceRoot: "/workspace",
		threadId: `thread-${sessionId}`,
		userText: "inspect the repository",
		startedAt: NOW,
	};
}

async function repositoryFixture(
	t: test.TestContext,
	options: Readonly<{ readonly processId?: number }> = {},
): Promise<{
	readonly dbPath: string;
	readonly repository: SQLiteTranscriptEventRepository;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-event-turn-store-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const dbPath = join(root, "sessions.db");
	const repository = new SQLiteTranscriptEventRepository({
		dbPath,
		clock: () => NOW,
		...(options.processId === undefined ? {} : { processId: options.processId }),
	});
	t.after(() => repository.close());
	return { dbPath, repository };
}
