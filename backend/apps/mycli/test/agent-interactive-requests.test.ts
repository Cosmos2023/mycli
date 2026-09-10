import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import type { RuntimeEvent } from "@mycli/core";
import type { AgentInteractiveRuntime } from "../src/node-runtime/agent-interactive-requests.ts";
import { AgentInteractiveRequestBroker } from "../src/node-runtime/agent-interactive-requests.ts";

test("child approval remains pending and resumes the same runtime to terminal completion", async () => {
	const broker = new AgentInteractiveRequestBroker();
	const notifications: Array<{ readonly method: string; readonly params: Record<string, unknown> }> = [];
	const lifecycle: string[] = [];
	const resolutions: unknown[] = [];
	broker.subscribe((notification) => { notifications.push(notification); });
	const runtime: AgentInteractiveRuntime = {
		resolveApproval: async (input, emit) => {
			resolutions.push(input);
			emit({ type: "turn_completed", assistantText: "done", usage: { total_tokens: 12 } });
			return turn("completed", "child-1");
		},
		resolveClarification: async () => turn("completed", "child-1"),
	};
	const controller = new AbortController();
	const interactive = broker.openTurn({
		sessionId: "child-1",
		agentPath: "/root/reviewer",
		workerName: "reviewer",
		runtime,
		signal: controller.signal,
		emitLifecycle: (event) => { lifecycle.push(event.type); },
		emitRuntime: () => undefined,
	});
	interactive.onRuntimeEvent(approvalRequest("decision-1", "child-turn-1"));
	const terminal = interactive.waitForTerminal(turn("in_progress", "child-1"));

	assert.deepEqual(lifecycle, ["waiting"]);
	assert.equal(notifications[0]?.method, "approval.request");
	assert.equal(notifications[0]?.params.session_id, "child-1");
	assert.equal(notifications[0]?.params.child_session_id, "child-1");
	assert.equal(notifications[0]?.params.agent_path, "/root/reviewer");
	assert.deepEqual(broker.respondApproval({
		session_id: "child-1",
		generation: 1,
		decision_id: "decision-1",
		choice: "approve_once",
	}), {
		accepted: true,
		decision_id: "decision-1",
		client_turn_id: "child-turn-1",
		turn_id: "turn-child-turn-1",
		session_id: "child-1",
		generation: 1,
	});

	assert.equal((await terminal).status, "completed");
	assert.deepEqual(resolutions, [{ decisionId: "decision-1", choice: "approve_once" }]);
	assert.deepEqual(lifecycle, ["waiting", "resumed"]);
	assert.deepEqual(notifications.map((item) => item.method), [
		"approval.request",
		"approval.respond",
	]);
});

test("child approval preserves proposed file mutation details", () => {
	const broker = new AgentInteractiveRequestBroker();
	const notifications: Array<{ readonly method: string; readonly params: Record<string, unknown> }> = [];
	broker.subscribe((notification) => { notifications.push(notification); });
	const controller = new AbortController();
	const interactive = broker.openTurn({
		sessionId: "child-write",
		agentPath: "/root/writer",
		workerName: "writer",
		runtime: {
			resolveApproval: async () => turn("completed", "child-write"),
			resolveClarification: async () => turn("completed", "child-write"),
		},
		signal: controller.signal,
		emitLifecycle: () => undefined,
		emitRuntime: () => undefined,
	});
	interactive.onRuntimeEvent({
		type: "approval_requested",
		clientTurnId: "child-write-turn",
		turnId: "turn-child-write",
		decisionId: "decision-write",
		callId: "call-write",
		toolName: "Edit",
		preview: "Edit notes.txt",
		reason: "A workspace file will change.",
		options: ["approve_once", "reject"],
		diff: "-old\n+new",
		diffChars: 9,
		diffTruncated: false,
	});

	assert.equal(notifications[0]?.method, "approval.request");
	assert.equal(notifications[0]?.params.diff, "-old\n+new");
	assert.equal(notifications[0]?.params.diff_chars, 9);
	assert.equal(notifications[0]?.params.diff_truncated, false);
	assert.equal("diffChars" in (notifications[0]?.params ?? {}), false);
	controller.abort();
});

test("child live approvals advance while its initial execution remains active", async () => {
	const broker = new AgentInteractiveRequestBroker();
	const decisions: string[] = [];
	const lifecycle: string[] = [];
	const notifications: string[] = [];
	broker.subscribe((notification) => { notifications.push(notification.method); });
	const interactive = broker.openTurn({
		sessionId: "child-live", agentPath: "/root/live", workerName: "live",
		runtime: {
			hasActiveApproval: (id) => !decisions.includes(id),
			respondActiveApproval: ({ decisionId }) => {
				decisions.push(decisionId);
				if (decisionId === "decision-1") queueMicrotask(() => {
					interactive.onRuntimeEvent(approvalRequest("decision-2", "child-live-turn"));
				});
			},
			resolveApproval: async () => { assert.fail("must keep the initial execution active"); },
			resolveClarification: async () => turn("completed", "child-live"),
		},
		signal: new AbortController().signal, emitRuntime: () => undefined,
		emitLifecycle: (event) => { lifecycle.push(event.type); },
	});
	interactive.onRuntimeEvent(approvalRequest("decision-1", "child-live-turn"));
	for (const decisionId of ["decision-1", "decision-2"]) {
		assert.equal(broker.pending()[0]?.requestId, decisionId);
		assert.equal(broker.respondApproval({
			session_id: "child-live", generation: 1, decision_id: decisionId, choice: "approve_once",
		})?.accepted, true);
		await Promise.resolve();
	}
	assert.deepEqual(broker.pending(), []);
	assert.deepEqual(decisions, ["decision-1", "decision-2"]);
	assert.deepEqual(lifecycle, ["waiting", "resumed", "waiting", "resumed"]);
	assert.deepEqual(notifications, ["approval.request", "approval.respond", "approval.request", "approval.respond"]);
	assert.equal((await interactive.waitForTerminal(turn("completed", "child-live"))).status, "completed");
});

test("child approval may resolve before the initial suspended submit returns", async () => {
	const broker = new AgentInteractiveRequestBroker();
	const resume = deferred<RuntimeTurnRecord>();
	const runtime: AgentInteractiveRuntime = {
		resolveApproval: async () => resume.promise,
		resolveClarification: async () => turn("completed", "child-race"),
	};
	broker.subscribe(() => undefined);
	const interactive = broker.openTurn({
		sessionId: "child-race",
		agentPath: "/root/race",
		workerName: "race",
		runtime,
		signal: new AbortController().signal,
		emitLifecycle: () => undefined,
		emitRuntime: () => undefined,
	});
	interactive.onRuntimeEvent(approvalRequest("decision-race", "turn-race"));
	broker.respondApproval({
		session_id: "child-race",
		generation: 1,
		decision_id: "decision-race",
		choice: "approve_once",
	});

	const terminal = interactive.waitForTerminal(turn("in_progress", "child-race"));
	resume.resolve(turn("completed", "child-race"));
	assert.equal((await terminal).status, "completed");
});

test("interactive requests publish independently and clarification routes by child session", async () => {
	const broker = new AgentInteractiveRequestBroker();
	const notifications: string[] = [];
	let clarificationResponse: Readonly<Record<string, unknown>> | undefined;
	broker.subscribe((notification) => {
		notifications.push(`${notification.method}:${String(notification.params.session_id)}`);
		if (notification.method === "clarify.respond") clarificationResponse = notification.params;
	});
	const runtime = (sessionId: string): AgentInteractiveRuntime => ({
		resolveApproval: async () => turn("completed", sessionId),
		resolveClarification: async () => turn("completed", sessionId),
	});
	const first = broker.openTurn({
		sessionId: "child-a",
		agentPath: "/root/a",
		workerName: "a",
		runtime: runtime("child-a"),
		signal: new AbortController().signal,
		emitLifecycle: () => undefined,
		emitRuntime: () => undefined,
	});
	const second = broker.openTurn({
		sessionId: "child-b",
		agentPath: "/root/b",
		workerName: "b",
		runtime: runtime("child-b"),
		signal: new AbortController().signal,
		emitLifecycle: () => undefined,
		emitRuntime: () => undefined,
	});
	first.onRuntimeEvent(approvalRequest("decision-a", "turn-a"));
	second.onRuntimeEvent(clarificationRequest("question-b", "turn-b"));
	const firstTerminal = first.waitForTerminal(turn("in_progress", "child-a"));
	const secondTerminal = second.waitForTerminal(turn("in_progress", "child-b"));

	assert.deepEqual(notifications, [
		"approval.request:child-a",
		"clarify.request:child-b",
	]);
	assert.deepEqual(broker.pending().map((pending) => ({
		sessionId: pending.sessionId,
		kind: pending.kind,
		requestId: pending.requestId,
	})), [
		{ sessionId: "child-a", kind: "approval", requestId: "decision-a" },
		{ sessionId: "child-b", kind: "clarification", requestId: "question-b" },
	]);
	broker.respondApproval({
		session_id: "child-a",
		generation: 1,
		decision_id: "decision-a",
		choice: "approve_once",
	});
	await firstTerminal;
	assert.deepEqual(notifications, [
		"approval.request:child-a",
		"clarify.request:child-b",
		"approval.respond:child-a",
	]);
	broker.respondClarification({
		session_id: "child-b",
		generation: 2,
		request_id: "question-b",
		response: "Use the integration tests",
	});
	assert.equal((await secondTerminal).status, "completed");
	assert.equal(notifications.at(-1), "clarify.respond:child-b");
	assert.deepEqual(clarificationResponse, {
		session_id: "child-b",
		generation: 2,
		client_turn_id: "turn-b",
		turn_id: "turn-turn-b",
		request_id: "question-b",
		header: "Tests",
		question: "Which tests?",
		response: "Use the integration tests",
		multi_select: false,
	});
	assert.deepEqual(broker.pending(), []);
});

test("subscription replays every pending request in registration order", () => {
	const broker = new AgentInteractiveRequestBroker();
	const runtime = (sessionId: string): AgentInteractiveRuntime => ({
		resolveApproval: async () => turn("completed", sessionId),
		resolveClarification: async () => turn("completed", sessionId),
	});
	for (const [sessionId, request] of [
		["child-a", approvalRequest("decision-a", "turn-a")],
		["child-b", clarificationRequest("question-b", "turn-b")],
	] as const) {
		broker.openTurn({
			sessionId,
			agentPath: `/root/${sessionId}`,
			workerName: sessionId,
			runtime: runtime(sessionId),
			signal: new AbortController().signal,
			emitLifecycle: () => undefined,
			emitRuntime: () => undefined,
		}).onRuntimeEvent(request);
	}
	const replayed: string[] = [];
	broker.subscribe((notification) => {
		replayed.push(`${notification.method}:${String(notification.params.session_id)}`);
	});
	assert.deepEqual(replayed, [
		"approval.request:child-a",
		"clarify.request:child-b",
	]);
});

test("stale generation cannot consume a child's pending request", () => {
	const broker = new AgentInteractiveRequestBroker();
	const interactive = broker.openTurn({
		sessionId: "child-stale",
		agentPath: "/root/stale",
		workerName: "stale",
		runtime: {
			resolveApproval: async () => turn("completed", "child-stale"),
			resolveClarification: async () => turn("completed", "child-stale"),
		},
		signal: new AbortController().signal,
		emitLifecycle: () => undefined,
		emitRuntime: () => undefined,
	});
	interactive.onRuntimeEvent(approvalRequest("decision-stale", "turn-stale"));

	assert.throws(() => broker.respondApproval({
		session_id: "child-stale",
		generation: 2,
		decision_id: "decision-stale",
		choice: "approve_once",
	}), (error: unknown) => (
		error instanceof Error
		&& "code" in error
		&& error.code === "approval_not_pending"
	));
	assert.equal(broker.pending().length, 1);
	assert.equal(broker.pending()[0]?.requestId, "decision-stale");
});

test("aborting a waiting child publishes exact cancellation and clears ownership", async () => {
	const broker = new AgentInteractiveRequestBroker();
	const notifications: Array<{ readonly method: string; readonly params: Record<string, unknown> }> = [];
	broker.subscribe((notification) => { notifications.push(notification); });
	const controller = new AbortController();
	const interactive = broker.openTurn({
		sessionId: "child-abort",
		agentPath: "/root/abort",
		workerName: "abort",
		runtime: {
			resolveApproval: async () => turn("completed", "child-abort"),
			resolveClarification: async () => turn("completed", "child-abort"),
		},
		signal: controller.signal,
		emitLifecycle: () => undefined,
		emitRuntime: () => undefined,
	});
	interactive.onRuntimeEvent(approvalRequest("decision-abort", "turn-abort"));
	const terminal = interactive.waitForTerminal(turn("in_progress", "child-abort"));
	controller.abort();

	await assert.rejects(terminal, { name: "AbortError", message: "interrupted" });
	assert.deepEqual(broker.pending(), []);
	assert.deepEqual(notifications.map((notification) => notification.method), [
		"approval.request",
		"interactive.cancelled",
	]);
	assert.deepEqual(notifications.at(-1)?.params, {
		session_id: "child-abort",
		child_session_id: "child-abort",
		generation: 1,
		client_turn_id: "turn-abort",
		turn_id: "turn-turn-abort",
		decision_id: "decision-abort",
	});
});

test("drops an approval response that arrives after cancellation wins", async () => {
	const broker = new AgentInteractiveRequestBroker();
	const controller = new AbortController();
	let resolutions = 0;
	const interactive = broker.openTurn({
		sessionId: "child-cancel-race",
		agentPath: "/root/cancel-race",
		workerName: "cancel-race",
		runtime: {
			resolveApproval: async () => {
				resolutions += 1;
				return turn("completed", "child-cancel-race");
			},
			resolveClarification: async () => turn("completed", "child-cancel-race"),
		},
		signal: controller.signal,
		emitLifecycle: () => undefined,
		emitRuntime: () => undefined,
	});
	interactive.onRuntimeEvent(approvalRequest("decision-cancel-race", "turn-cancel-race"));
	const terminal = interactive.waitForTerminal(turn("in_progress", "child-cancel-race"));
	controller.abort();

	assert.equal(broker.respondApproval({
		session_id: "child-cancel-race",
		generation: 1,
		decision_id: "decision-cancel-race",
		choice: "approve_once",
	}), undefined);
	await assert.rejects(terminal, { name: "AbortError", message: "interrupted" });
	assert.equal(resolutions, 0);
	assert.deepEqual(broker.pending(), []);
});

function turn(status: RuntimeTurnRecord["status"], sessionId: string): RuntimeTurnRecord {
	return {
		schema_version: 1,
		session_id: sessionId,
		client_turn_id: "child-turn",
		turn_id: "child-turn",
		request_fingerprint: "fingerprint",
		status,
		error_code: null,
		result: status === "completed" ? { assistant_text: "done" } : null,
		started_at: "2026-08-08T00:00:00.000Z",
		completed_at: status === "in_progress" ? null : "2026-08-08T00:00:01.000Z",
	};
}

function approvalRequest(decisionId: string, clientTurnId: string): RuntimeEvent {
	return {
		type: "approval_requested",
		clientTurnId,
		turnId: `turn-${clientTurnId}`,
		decisionId,
		callId: `call-${decisionId}`,
		toolName: "Shell",
		preview: "npm test",
		reason: "Command requires approval",
		options: ["approve_once", "reject"],
	};
}

function clarificationRequest(requestId: string, clientTurnId: string): RuntimeEvent {
	return {
		type: "clarification_requested",
		clientTurnId,
		turnId: `turn-${clientTurnId}`,
		requestId,
		callId: `call-${requestId}`,
		toolName: "AskUserQuestion",
		question: "Which tests?",
		options: [],
		header: "Tests",
		multiSelect: false,
	};
}

function deferred<Value>(): {
	readonly promise: Promise<Value>;
	readonly resolve: (value: Value) => void;
} {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((done) => { resolve = done; });
	return { promise, resolve };
}
