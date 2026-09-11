import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { QueuedInput } from "@mycli/core";
import { TURN_INTERRUPTED_NOTICE } from "@mycli/contracts";
import Database from "better-sqlite3";
import {
	SQLiteTranscriptEventRepository,
	SessionStateError,
	SessionInUseError,
	type SaveApprovalSuspensionInput,
	type SaveClarificationSuspensionInput,
} from "../../src/index.ts";

const NOW = "2026-08-14T00:00:00.000Z";

for (const kind of ["approval", "clarification"] as const) {
	test(`cold session activation interrupts a stored ${kind} once and clears its pending state`, async (t) => {
		const { repository, root } = await repositoryFixture(t);
		if (kind === "approval") {
			prepareToolTurn(repository, root, "call-approval", "Write", "resp-approval");
			repository.saveApprovalSuspension(approvalSuspension(root));
		} else {
			prepareToolTurn(repository, root, "call-question", "AskUserQuestion", "resp-question");
			repository.saveClarificationSuspension(clarificationSuspension(root));
		}
		assert.throws(() => repository.interruptSessionForResume("session-1"), SessionInUseError);
		repository.acquireSessionLease("session-1");
		assert.equal(repository.interruptSessionForResume("session-1"), 1);
		assert.equal(repository.loadTurn("session-1", "client-1")?.status, "interrupted");
		for (const key of ["pending_decision", "suspended_turn", "node_effect_checkpoint", "turn_record"] as const) {
			assert.equal(repository.loadState("session-1", key), undefined);
		}
		assert.deepEqual(repository.loadPendingToolCalls("session-1", "turn-1"), []);
		const output = repository.loadConversationItems("session-1").find((item) => item.type === "tool_result");
		assert.equal(output?.success, false);
		assert.equal(repository.loadReadableTranscript("session-1").filter((item) => item.text === TURN_INTERRUPTED_NOTICE).length, 1);
		assert.throws(() => repository.compareAndSetApproval({
			sessionId: "session-1", expectedStatus: "waiting", transition: { type: "approve_once" },
		}));
		const history = repository.loadConversationItems("session-1");
		assert.equal(repository.interruptSessionForResume("session-1"), 0);
		assert.deepEqual(repository.loadConversationItems("session-1"), history);
	});
}

test("cold recovery cannot interrupt a different live session owner", async (t) => {
	const { repository, root, dbPath } = await repositoryFixture(t);
	prepareToolTurn(repository, root, "call-approval", "Write", "resp-approval");
	repository.saveApprovalSuspension(approvalSuspension(root));
	repository.acquireSessionLease("session-1");
	const observer = new SQLiteTranscriptEventRepository({ dbPath, isProcessAlive: () => true });
	t.after(() => observer.close());
	assert.throws(() => observer.interruptSessionForResume("session-1"), SessionInUseError);
	assert.equal(repository.loadTurn("session-1", "client-1")?.status, "in_progress");
	assert.ok(repository.loadState("session-1", "pending_decision"));
});

test("cold recovery rolls back the interruption and continuation cleanup together", async (t) => {
	const { repository: seed, root, dbPath } = await repositoryFixture(t);
	prepareToolTurn(seed, root, "call-approval", "Write", "resp-approval");
	seed.saveApprovalSuspension(approvalSuspension(root));
	seed.close();
	let failing = true;
	const repository = new SQLiteTranscriptEventRepository({
		dbPath, clock: () => NOW,
		turnTerminalizationFailpoint: (name) => {
			if (failing && name === "failure_after_turn") throw new Error("injected recovery failure");
		},
	});
	t.after(() => repository.close());
	repository.acquireSessionLease("session-1");
	const history = repository.loadConversationItems("session-1");
	const pending = repository.loadState("session-1", "pending_decision");
	assert.throws(() => repository.interruptSessionForResume("session-1"), { code: "persistence_error" });
	assert.equal(repository.loadTurn("session-1", "client-1")?.status, "in_progress");
	assert.deepEqual(repository.loadState("session-1", "pending_decision"), pending);
	assert.deepEqual(repository.loadConversationItems("session-1"), history);
	failing = false;
	assert.equal(repository.interruptSessionForResume("session-1"), 1);
});

test("cold recovery preserves an approval result committed before continuation cleanup", async (t) => {
	const { repository: seed, root, dbPath } = await repositoryFixture(t);
	prepareToolTurn(seed, root, "call-approval", "Write", "resp-approval");
	seed.saveApprovalSuspension(approvalSuspension(root));
	seed.compareAndSetApproval({ sessionId: "session-1", expectedStatus: "waiting", transition: { type: "approve_once" } });
	seed.compareAndSetApproval({ sessionId: "session-1", expectedStatus: "approved", transition: { type: "claim_effect", fingerprint: "sha256:effect" } });
	seed.commitApprovalResult({
		sessionId: "session-1", expectedStatus: "executing",
		transition: { type: "complete_effect", resultCallId: "call-approval" },
		toolResult: {
			sessionId: "session-1", clientTurnId: "client-1",
			result: { callId: "call-approval", toolName: "Write", output: "saved", success: true }, summary: "Saved file",
		},
	});
	seed.close();
	const repository = new SQLiteTranscriptEventRepository({ dbPath, clock: () => NOW });
	t.after(() => repository.close());
	repository.acquireSessionLease("session-1");
	assert.equal(repository.interruptSessionForResume("session-1"), 1);
	const results = repository.loadConversationItems("session-1").filter((item) => item.type === "tool_result");
	assert.deepEqual(results.map((item) => [item.callId, item.output, item.success]), [["call-approval", "saved", true]]);
	assert.equal(repository.loadTurn("session-1", "client-1")?.status, "interrupted");
	assert.equal(repository.loadState("session-1", "pending_decision"), undefined);
});

test("cold recovery of a claimed approval closes every remaining tool call", async (t) => {
	const { repository, root } = await repositoryFixture(t);
	repository.reserveTurn(submission(root));
	repository.appendAssistantToolCalls({
		sessionId: "session-1", clientTurnId: "client-1", assistantText: "", responseId: "resp-approval",
		calls: [
			{ callId: "call-approval", name: "Write", argumentsJson: "{}" },
			{ callId: "call-later", name: "Read", argumentsJson: "{}" },
		],
	});
	repository.saveApprovalSuspension(approvalSuspension(root));
	repository.compareAndSetApproval({ sessionId: "session-1", expectedStatus: "waiting", transition: { type: "approve_once" } });
	repository.compareAndSetApproval({ sessionId: "session-1", expectedStatus: "approved", transition: { type: "claim_effect", fingerprint: "sha256:effect" } });
	repository.acquireSessionLease("session-1");
	assert.equal(repository.interruptSessionForResume("session-1"), 1);
	assert.deepEqual(repository.loadPendingToolCalls("session-1", "turn-1"), []);
	const results = repository.loadTurnEventWindow("session-1", "turn-1").events.filter((event) => event.eventType === "tool_result");
	assert.deepEqual(results.map((event) => [event.payload.result.callId, event.payload.errorKind]), [
		["call-approval", "effect_outcome_unknown"], ["call-later", "tool_interrupted"],
	]);
});

test("retains a referenced pending approval on restart and commits its result once", async (t) => {
	const fixture = await repositoryFixture(t);
	let repository = fixture.repository;
	prepareToolTurn(repository, fixture.root, "call-approval", "Write", "resp-approval");
	repository.saveApprovalSuspension(approvalSuspension(fixture.root));
	const suspended = repository.loadState("session-1", "suspended_turn") as {
		readonly conversation: readonly unknown[];
		readonly transcript_event_id: string;
	};
	assert.deepEqual(suspended.conversation, []);
	assert.equal(typeof suspended.transcript_event_id, "string");
	repository.close();

	repository = new SQLiteTranscriptEventRepository({
		dbPath: fixture.dbPath,
		clock: () => NOW,
		isProcessAlive: () => false,
	});
	t.after(() => repository.close());
	assert.equal(repository.loadTurn("session-1", "client-1")?.status, "in_progress");
	assert.doesNotThrow(() => repository.validateRecoveryReferences("session-1"));
	repository.compareAndSetApproval({
		sessionId: "session-1",
		expectedStatus: "waiting",
		transition: { type: "approve_once" },
	});
	repository.compareAndSetApproval({
		sessionId: "session-1",
		expectedStatus: "approved",
		transition: { type: "claim_effect", fingerprint: "sha256:effect" },
	});
	const completed = repository.commitApprovalResult({
		sessionId: "session-1",
		expectedStatus: "executing",
		transition: { type: "complete_effect", resultCallId: "call-approval" },
		toolResult: {
			sessionId: "session-1",
			clientTurnId: "client-1",
			result: {
				callId: "call-approval",
				toolName: "Write",
				output: "write complete",
				success: true,
			},
			summary: "Write complete",
		},
	});
	assert.equal(completed.status, "completed");
	repository.finalizeApprovalContinuation({ sessionId: "session-1", decisionId: "call-approval" });
	assert.equal(repository.loadState("session-1", "suspended_turn"), undefined);
	assert.equal(repository.loadConversationItems("session-1").filter((item) => (
		item.type === "tool_result" && item.callId === "call-approval"
	)).length, 1);
});

test("retains clarification state on restart and reconstructs it from the event reference", async (t) => {
	const fixture = await repositoryFixture(t);
	let repository = fixture.repository;
	prepareToolTurn(repository, fixture.root, "call-question", "AskUserQuestion", "resp-question");
	repository.saveClarificationSuspension(clarificationSuspension(fixture.root));
	const stored = repository.loadState("session-1", "suspended_turn") as {
		readonly conversation: readonly unknown[];
		readonly transcript_event_id: string;
	};
	assert.deepEqual(stored.conversation, []);
	assert.equal(typeof stored.transcript_event_id, "string");
	repository.close();

	repository = new SQLiteTranscriptEventRepository({
		dbPath: fixture.dbPath,
		clock: () => NOW,
		isProcessAlive: () => false,
	});
	t.after(() => repository.close());
	assert.equal(repository.loadTurn("session-1", "client-1")?.status, "in_progress");
	assert.doesNotThrow(() => repository.validateRecoveryReferences("session-1"));
	repository.commitClarificationResponse({
		sessionId: "session-1",
		requestId: "call-question",
		display: {
			header: "Runtime",
			question: "Which runtime?",
			response: "Node",
			multiSelect: false,
		},
		toolResult: {
			sessionId: "session-1",
			clientTurnId: "client-1",
			result: {
				callId: "call-question",
				toolName: "AskUserQuestion",
				output: "User response: Node",
				success: true,
			},
			summary: "User answered clarification",
		},
	});
	assert.equal(repository.loadState("session-1", "suspended_turn"), undefined);
	assert.equal(repository.loadConversationItems("session-1").at(-1)?.type, "tool_result");
	const clarification = repository.loadReadableTranscript("session-1")
		.find((item) => item.type === "clarification");
	assert.equal(clarification?.text, "Node");
	assert.deepEqual(clarification?.metadata, {
		request_id: "call-question",
		header: "Runtime",
		question: "Which runtime?",
		response: "Node",
		multi_select: false,
	});
});

test("commits queued input into one canonical event and validates continuation response ids", async (t) => {
	const fixture = await repositoryFixture(t);
	const repository = fixture.repository;
	prepareToolTurn(repository, fixture.root, "call-1", "Read", "resp-1");
	const record = queuedInput();
	repository.saveState({
		sessionId: "session-1",
		workspaceRoot: fixture.root,
		threadId: "session-1",
		key: "input_queue",
		payload: queuePayload(),
	});
	repository.commitQueuedInputs({ sessionId: "session-1", turnId: "turn-1", records: [record] });
	repository.commitQueuedInputs({ sessionId: "session-1", turnId: "turn-1", records: [record] });
	assert.deepEqual([...repository.loadCommittedQueueIds("session-1")], ["queue-1"]);
	assert.equal(repository.loadEventWindow("session-1", { limit: 100 }).events.filter((event) => (
		event.eventType === "user_input" && event.payload.queueId === "queue-1"
	)).length, 1);

	repository.saveState({
		sessionId: "session-1",
		workspaceRoot: fixture.root,
		threadId: "session-1",
		key: "responses_continuation_state",
		payload: continuationState("resp-1"),
	});
	assert.equal(
		Reflect.get(repository.loadState("session-1", "responses_continuation_state")!, "eligible"),
		true,
	);
	assert.throws(() => repository.saveState({
		sessionId: "session-1",
		workspaceRoot: fixture.root,
		threadId: "session-1",
		key: "responses_continuation_state",
		payload: continuationState("missing-response"),
	}), (error: unknown) => error instanceof SessionStateError
		&& error.stateKey === "responses_continuation_state");
});

test("fails closed on a suspended turn whose transcript reference is missing", async (t) => {
	const fixture = await repositoryFixture(t);
	prepareToolTurn(fixture.repository, fixture.root, "call-approval", "Write", "resp-approval");
	fixture.repository.saveApprovalSuspension(approvalSuspension(fixture.root));
	fixture.repository.close();
	const database = new Database(fixture.dbPath);
	const row = database.prepare(`
		SELECT payload_json FROM session_state
		WHERE session_id = 'session-1' AND state_key = 'suspended_turn'
	`).get() as { readonly payload_json: string };
	const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
	payload.transcript_event_id = "missing-event";
	database.prepare(`
		UPDATE session_state SET payload_json = ?
		WHERE session_id = 'session-1' AND state_key = 'suspended_turn'
	`).run(JSON.stringify(payload));
	database.close();

	assert.throws(() => new SQLiteTranscriptEventRepository({
		dbPath: fixture.dbPath,
		clock: () => NOW,
		isProcessAlive: () => false,
	}), (error: unknown) => error instanceof SessionStateError
		&& error.stateKey === "suspended_turn");
	const check = new Database(fixture.dbPath, { readonly: true });
	assert.equal(check.prepare(`
		SELECT status FROM runtime_turns
		WHERE session_id = 'session-1' AND client_turn_id = 'client-1'
	`).pluck().get(), "in_progress");
	check.close();
});

function prepareToolTurn(
	repository: SQLiteTranscriptEventRepository,
	workspaceRoot: string,
	callId: string,
	toolName: string,
	responseId: string,
): void {
	repository.reserveTurn(submission(workspaceRoot));
	repository.appendAssistantToolCalls({
		sessionId: "session-1",
		clientTurnId: "client-1",
		assistantText: "",
		calls: [{ callId, name: toolName, argumentsJson: "{}" }],
		responseId,
	});
}

function approvalSuspension(workspaceRoot: string): SaveApprovalSuspensionInput {
	const call = storedToolCall("call-approval", "Write");
	return {
		sessionId: "session-1",
		workspaceRoot,
		threadId: "session-1",
		pendingDecision: {
			kind: "pending_decision",
			version: 1,
			payload: {
				tool_call: call,
				kind: "needs_choice",
				reason: "Approval required",
				preview: "Write file",
				options: ["approve_once", "reject"],
			},
		},
		suspendedTurn: {
			kind: "suspended_turn",
			version: 1,
			payload: {
				user_message: "request",
				conversation: [storedMessage("user", "request")],
				suspend_reason: "approval_required",
				pending_approval: { tool_call: call, reason: "Approval required", preview: "Write file" },
				session_id: "session-1",
				client_turn_id: "client-1",
				turn_id: "turn-1",
				provider_protocol: "responses",
				remaining_tool_calls: [],
				continuation: { assistant_text: "", response_id: "resp-approval", usage: {} },
			},
		},
		turnRecord: {
			turn_id: "turn-1",
			client_turn_id: "client-1",
			user_message: "request",
			status: "waiting_approval",
			stop_reason: "approval_required",
			updated_at: NOW,
		},
		checkpoint: {
			sessionId: "session-1",
			clientTurnId: "client-1",
			turnId: "turn-1",
			decisionId: "call-approval",
			callId: "call-approval",
			toolName: "Write",
			status: "waiting",
			updatedAt: NOW,
		},
	};
}

function clarificationSuspension(workspaceRoot: string): SaveClarificationSuspensionInput {
	const call = storedToolCall("call-question", "AskUserQuestion");
	return {
		sessionId: "session-1",
		workspaceRoot,
		threadId: "session-1",
		suspendedTurn: {
			kind: "suspended_turn",
			version: 1,
			payload: {
				user_message: "request",
				conversation: [storedMessage("user", "request")],
				suspend_reason: "clarification_required",
				pending_clarification: {
					request_id: "call-question",
					tool_call: call,
					question: "Which runtime?",
					options: [{ label: "Node" }],
					header: "Runtime",
					multi_select: false,
				},
				session_id: "session-1",
				client_turn_id: "client-1",
				client_user_message_id: "user-1",
				turn_id: "turn-1",
				provider_protocol: "responses",
				remaining_tool_calls: [],
				continuation: { assistant_text: "", response_id: "resp-question", usage: {} },
			},
		},
		turnRecord: {
			turn_id: "turn-1",
			client_turn_id: "client-1",
			user_message: "request",
			status: "waiting_clarification",
			stop_reason: "clarification_required",
			updated_at: NOW,
		},
	};
}

function submission(workspaceRoot: string) {
	return {
		sessionId: "session-1",
		clientTurnId: "client-1",
		clientUserMessageId: "user-1",
		turnId: "turn-1",
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot,
		threadId: "session-1",
		userText: "request",
		startedAt: NOW,
	};
}

function storedToolCall(callId: string, name: string) {
	return { name, arguments: {}, reason: "", call_id: callId };
}

function storedMessage(role: "user" | "assistant", content: string) {
	return {
		role,
		content,
		tool_call_id: null,
		response_id: null,
		metadata: {},
		blocks: [],
		tool_calls: [],
	};
}

function queuedInput(): QueuedInput {
	return {
		queueId: "queue-1",
		sessionId: "session-1",
		clientTurnId: "queued-client-1",
		targetTurnId: "turn-1",
		kind: "pending_steer",
		state: "accepted",
		text: "queued input",
		imagePaths: [],
		source: "user",
		createdAt: NOW,
		updatedAt: NOW,
	};
}

function queuePayload() {
	return {
		session_id: "session-1",
		revision: 1,
		pending_steers: [{
			queue_id: "queue-1",
			session_id: "session-1",
			client_turn_id: "queued-client-1",
			target_turn_id: "turn-1",
			kind: "pending_steer",
			state: "accepted",
			text: "queued input",
			image_paths: [],
			source: "user",
			created_at: NOW,
			updated_at: NOW,
		}],
		rejected_steers: [],
		follow_ups: [],
	};
}

function continuationState(responseId: string) {
	return {
		response_id: responseId,
		request_signature: "sha256:request",
		request_input: [{ role: "user", content: "request" }],
		response_output: [{ role: "assistant", content: "" }],
		eligible: true,
		failure_reason: null,
		session_id: "session-1",
		protocol: "responses",
		model: "test-model",
		history_boundary: "event-boundary",
	};
}

async function repositoryFixture(t: TestContext): Promise<{
	readonly root: string;
	readonly dbPath: string;
	readonly repository: SQLiteTranscriptEventRepository;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-event-recovery-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const dbPath = join(root, "sessions.db");
	const repository = new SQLiteTranscriptEventRepository({
		dbPath,
		clock: () => NOW,
		processId: 900_001,
	});
	t.after(() => repository.close());
	return { root, dbPath, repository };
}
