import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { parseRuntimeState, type RuntimeStateRecord } from "@mycli/contracts";
import { modelInputSha256, type CanonicalToolCall, type RuntimeEvent } from "@mycli/core";
import { openRuntimeSessionStore, type RuntimeSessionStore } from "@mycli/storage";
import type { ToolExecutionResult } from "@mycli/tools";
import { AgentBudgetTracker } from "../../src/agents/agent-budget-tracker.ts";
import { HookContextAccumulator } from "../../src/hooks/hook-context-accumulator.ts";
import { ActiveToolExecutionRegistry } from "../../src/tools/active-tool-execution-registry.ts";
import { ToolBatchCoordinator, type ToolBatchRuntimeContext } from "../../src/tools/tool-batch-coordinator.ts";
import { ApprovalContinuationCoordinator, ApprovalNotPendingError } from "../../src/turns/approval-continuation-coordinator.ts";
import { NodeTurnCoordinatorBroker } from "../../src/turns/node-turn-coordinator-broker.ts";
import { ParallelApprovalCoordinator, toolEffectAttemptId } from "../../src/turns/parallel-approval-coordinator.ts";
import { createRunExecutionSnapshot } from "../../src/turns/run-execution-snapshot.ts";

const NOW = "2026-09-06T00:00:00.000Z";
const CALLS: readonly CanonicalToolCall[] = [1, 2].map((index) => ({
	callId: `call-${index}`, name: "Shell",
	argumentsJson: `{ "command": "echo ${index}", "yield_time_ms": 30000, "justification": "Verify command ${index}." }`,
}));
type SuspendedState = Extract<RuntimeStateRecord, { kind: "suspended_turn" }>;

test("persists every approval before publication and resolves only the matching waiter", async (t) => {
	const fixture = await approvalFixture(t);
	fixture.begin();
	assert.equal(fixture.events.length, 0);
	assert.equal(fixture.state().payload.parallel_batch?.calls.length, 2);
	assert.equal(fixture.state().payload.parallel_batch?.revision, 0);
	assert.equal(fixture.store.loadState("session-1", "node_effect_checkpoint"), undefined);
	await setImmediate();
	assert.deepEqual(approvalIds(fixture.events), ["call-1"]);
	assert.equal(fixture.events.find((event) => event.type === "approval_requested")?.commandPreview, "echo 1");
	assert.equal(fixture.events.find((event) => event.type === "approval_requested")?.justification, "Verify command 1.");
	let firstResolved = false;
	const first = fixture.coordinator.waitForApproval("call-1").then((allowed) => {
		firstResolved = true;
		return allowed;
	});
	const second = fixture.coordinator.waitForApproval("call-2");
	fixture.coordinator.respond({ decisionId: "call-2", choice: "approve_once" });
	assert.equal(await second, true);
	assert.equal(firstResolved, false);
	assert.equal(fixture.coordinator.pending()?.decisionId, "call-1");
	assert.deepEqual(approvalIds(fixture.events), ["call-1"]);
	for (const decisionId of ["wrong-call", "call-2"]) {
		assert.throws(() => fixture.coordinator.respond({ decisionId, choice: "reject" }), ApprovalNotPendingError);
	}
	assert.throws(() => fixture.coordinator.respond({
		decisionId: "call-1", choice: "always_allow",
	}), ApprovalNotPendingError);
	fixture.coordinator.respond({ decisionId: "call-1", choice: "reject" });
	assert.equal(await first, false);
	assert.equal(fixture.state().payload.parallel_batch?.revision, 2);
	assert.equal(fixture.store.loadState("session-1", "pending_decision"), undefined);
	fixture.store.validateRecoveryReferences("session-1");
	fixture.coordinator.finish();
	assert.equal(fixture.store.loadState("session-1", "suspended_turn"), undefined);
});

test("approval persistence rolls back atomically and stale revisions cannot overwrite a choice", async (t) => {
	const fixture = await approvalFixture(t);
	fixture.failWrites(true);
	assert.throws(() => fixture.begin(), /injected approval failure/u);
	assert.equal(fixture.store.loadState("session-1", "suspended_turn"), undefined);
	assert.equal(fixture.store.loadState("session-1", "pending_decision"), undefined);
	assert.equal(fixture.events.length, 0);
	fixture.failWrites(false);
	fixture.begin();
	const before = fixture.state();
	const turnBefore = fixture.store.loadState("session-1", "turn_record");
	fixture.failWrites(true);
	assert.throws(() => fixture.coordinator.respond({
		decisionId: "call-1", choice: "approve_once",
	}), /injected approval failure/u);
	assert.deepEqual(fixture.state(), before);
	assert.deepEqual(fixture.store.loadState("session-1", "turn_record"), turnBefore);
	assert.equal(fixture.coordinator.hasActiveApproval("call-1"), true);
	fixture.failWrites(false);
	fixture.coordinator.respond({ decisionId: "call-1", choice: "approve_once" });
	await setImmediate();
	assert.deepEqual(approvalIds(fixture.events), ["call-2"]);
	assert.equal(fixture.events.find((event) => event.type === "approval_requested")?.commandPreview, "echo 2");
	assert.equal(fixture.events.find((event) => event.type === "approval_requested")?.justification, "Verify command 2.");
	assert.throws(() => fixture.save(before, 0), /revision conflict/u);
	const after = fixture.state();
	assert.throws(() => fixture.save(after, 0), /revision conflict/u);
	assert.deepEqual(fixture.state(), after);
	fixture.store.clearParallelApprovalBatch("session-1", "other-turn", "call-1");
	fixture.store.clearParallelApprovalBatch("session-1", "turn-1", "other-batch");
	assert.deepEqual(fixture.state(), after);
});

test("rejects changed canonical arguments and frozen execution authority", async (t) => {
	const fixture = await approvalFixture(t);
	fixture.begin();
	const before = fixture.state();
	const changed = structuredClone(before);
	changed.payload.parallel_batch!.calls[0]!.call.argumentsJson = "{\"command\":\"different\"}";
	assert.throws(() => fixture.save(changed, 0), /session_state_invalid/u);
	const changedExecution = structuredClone(before);
	changedExecution.payload.parallel_batch!.revision = 1;
	changedExecution.payload.parallel_batch!.calls[0]!.execution_call.argumentsJson = "{}";
	assert.throws(() => fixture.save(changedExecution, 0), /session_state_invalid/u);
	assert.deepEqual(fixture.state(), before);
});

for (const mode of ["signal", "phase_failure"] as const) {
	test(`${mode} cancels every waiter and rejects late decisions`, async (t) => {
		const fixture = await approvalFixture(t);
		fixture.begin();
		const first = assert.rejects(fixture.coordinator.waitForApproval("call-1"), { name: "AbortError" });
		const second = assert.rejects(fixture.coordinator.waitForApproval("call-2"), { name: "AbortError" });
		fixture.coordinator.respond({ decisionId: "call-1", choice: "approve_once" });
		if (mode === "signal") fixture.controller.abort();
		else fixture.coordinator.abortPending();
		await Promise.all([first, second]);
		assert.equal(fixture.coordinator.hasActiveApproval("call-2"), false);
		assert.throws(() => fixture.coordinator.respond({
			decisionId: "call-2", choice: "approve_once",
		}), ApprovalNotPendingError);
		assert.deepEqual(fixture.events, []);
		fixture.coordinator.finish();
		assert.equal(fixture.store.loadState("session-1", "pending_decision"), undefined);
	});
}

test("restart reuses an out-of-order completed effect and commits results in provider order", async (t) => {
	const fixture = await approvalFixture(t);
	fixture.begin();
	fixture.coordinator.respond({ decisionId: "call-2", choice: "approve_once" });
	assert.equal(await fixture.coordinator.waitForApproval("call-2"), true);
	const completed = await executeEffect(fixture.store, CALLS[1]!, async () => result(CALLS[1]!));
	fixture.coordinator.abortPending();
	fixture.store.close();
	const reopened = fixture.reopen();
	reopened.store.validateRecoveryReferences("session-1");
	assert.equal(reopened.coordinator.recover(), undefined);
	assert.equal(reopened.coordinator.pending()?.decisionId, "call-1");
	assert.deepEqual(reopened.coordinator.pending()?.runSnapshot, context().runSnapshot);
	let executions = 0;
	const batches = new ToolBatchCoordinator({
		sessionId: "session-1", store: reopened.store, budget: new AgentBudgetTracker(),
		activeTools: new ActiveToolExecutionRegistry(), parallelApprovals: reopened.coordinator,
		toolRouter: { execute: async (call) => { executions += 1; return result(call); } },
		executeToolEffect: (input, execute) => executeEffect(reopened.store, input.call, execute),
		publishLifecycle: () => undefined,
	});
	await batches.resumeApprovals({ context: context(), decisionId: "call-1", choice: "reject" });
	assert.equal(executions, 0);
	const outputs = reopened.store.loadConversationItems("session-1").filter((item) => item.type === "tool_result");
	assert.deepEqual(outputs.map((item) => item.callId), ["call-1", "call-2"]);
	assert.match(outputs[0]!.output, /rejected/u);
	assert.equal(outputs[1]!.output, completed.modelOutput);
	assert.equal(reopened.store.loadState("session-1", "suspended_turn"), undefined);
	assert.deepEqual(reopened.store.loadPendingToolCalls("session-1", "turn-1"), []);
});

test("restart interrupts a reserved effect, closes unanswered calls, and never replays the command", async (t) => {
	const fixture = await approvalFixture(t);
	fixture.begin();
	fixture.coordinator.respond({ decisionId: "call-1", choice: "approve_once" });
	await fixture.coordinator.waitForApproval("call-1");
	const call = CALLS[0]!;
	const attemptId = toolEffectAttemptId("session-1", "turn-1", call.callId);
	fixture.store.agentEffectLedger.reserve({
		attemptId, kind: "tool", sessionId: "session-1", turnId: "turn-1", jobId: "root-session-1",
		externalId: call.callId, mutating: true, createdAt: NOW,
		request: { tool_name: call.name, arguments_sha256: modelInputSha256(call.argumentsJson), mutating: true },
	});
	fixture.coordinator.abortPending();
	fixture.store.close();
	const reopened = fixture.reopen();
	reopened.store.validateRecoveryReferences("session-1");
	assert.equal(reopened.coordinator.recover()?.status, "interrupted");
	assert.equal(reopened.store.agentEffectLedger.load(attemptId)?.state, "effect_outcome_unknown");
	assert.equal(reopened.store.loadState("session-1", "pending_decision"), undefined);
	assert.equal(reopened.store.loadState("session-1", "suspended_turn"), undefined);
	assert.deepEqual(reopened.store.loadPendingToolCalls("session-1", "turn-1"), []);
	let effects = 0;
	await assert.rejects(executeEffect(reopened.store, call, async () => {
		effects += 1;
		return result(call);
	}), /not replayable/u);
	assert.equal(effects, 0);
});

test("cold session activation cancels unanswered approvals and retains completed sibling effects", async (t) => {
	const fixture = await approvalFixture(t);
	fixture.begin();
	fixture.coordinator.respond({ decisionId: "call-2", choice: "approve_once" });
	await fixture.coordinator.waitForApproval("call-2");
	await executeEffect(fixture.store, CALLS[1]!, async () => result(CALLS[1]!));
	fixture.coordinator.abortPending();
	fixture.store.close();
	const reopened = fixture.reopen();
	reopened.store.acquireSessionLease("session-1");
	assert.equal(reopened.store.interruptSessionForResume("session-1"), 1);
	assert.equal(reopened.store.loadTurn("session-1", "client-1")?.status, "interrupted");
	assert.equal(reopened.coordinator.pending(), undefined);
	assert.throws(() => reopened.coordinator.respond({ decisionId: "call-1", choice: "approve_once" }), ApprovalNotPendingError);
	const outputs = reopened.store.loadConversationItems("session-1").filter((item) => item.type === "tool_result");
	assert.deepEqual(outputs.map((item) => [item.callId, item.success]), [["call-1", false], ["call-2", true]]);
	assert.equal(outputs[1]?.output, "call-2");
	assert.deepEqual(reopened.store.loadPendingToolCalls("session-1", "turn-1"), []);
	assert.equal(reopened.store.interruptSessionForResume("session-1"), 0);
});

test("restart after the last decision validates and clears the orphaned batch", async (t) => {
	const fixture = await approvalFixture(t);
	fixture.begin();
	for (const call of CALLS) fixture.coordinator.respond({ decisionId: call.callId, choice: "reject" });
	fixture.coordinator.abortPending();
	fixture.store.close();
	const reopened = fixture.reopen();
	reopened.store.validateRecoveryReferences("session-1");
	assert.equal(reopened.coordinator.recover()?.status, "interrupted");
	assert.equal(reopened.store.loadState("session-1", "suspended_turn"), undefined);
	assert.equal(reopened.coordinator.pending(), undefined);
	assert.equal(reopened.coordinator.recover(), undefined);
});

test("failure terminalization preserves completed siblings and marks ambiguous mutations", async (t) => {
	const fixture = await approvalFixture(t);
	fixture.begin();
	for (const call of CALLS) fixture.coordinator.respond({ decisionId: call.callId, choice: "approve_once" });
	await executeEffect(fixture.store, CALLS[1]!, async () => result(CALLS[1]!));
	await assert.rejects(executeEffect(fixture.store, CALLS[0]!, async () => {
		throw new Error("effect transport disconnected");
	}), /effect transport disconnected/u);
	fixture.store.turnTerminalizations.terminalize({
		kind: "failed", sessionId: "session-1", clientTurnId: "client-1",
		code: "provider_error", message: "tool execution failed", completedAt: NOW,
	});
	fixture.coordinator.finish();
	const outputs = fixture.store.loadTurnEventWindow("session-1", "turn-1").events
		.filter((event) => event.eventType === "tool_result");
	assert.deepEqual(outputs.map((event) => event.payload.result.callId), ["call-1", "call-2"]);
	assert.equal(outputs[0]?.payload.errorKind, "effect_outcome_unknown");
	assert.equal(outputs[1]?.payload.result.output, "call-2");
	assert.equal(outputs[1]?.payload.result.success, true);
});

test("an allowed sibling can finish while another call waits for approval", async (t) => {
	const fixture = await approvalFixture(t);
	const executed: string[] = [];
	const batches = new ToolBatchCoordinator({
		sessionId: "session-1", store: fixture.store, budget: new AgentBudgetTracker(),
		activeTools: new ActiveToolExecutionRegistry(), parallelApprovals: fixture.coordinator,
		approvalPolicy: { evaluate: (call) => ({
			kind: call.callId === "call-1" ? "request" : "allow", callId: call.callId, toolName: call.name,
			preview: call.callId, reason: "test policy", options: ["approve_once", "reject"],
		}) },
		toolRouter: {
			supportsParallelToolCalls: () => true,
			execute: async (call) => { executed.push(call.callId); return result(call); },
		},
		executeToolEffect: (input, execute) => executeEffect(fixture.store, input.call, execute),
		publishLifecycle: () => undefined,
	});
	const running = batches.process({
		context: { ...context(), emit: (event) => { fixture.events.push(event); } },
		batch: { calls: CALLS, assistantText: "" }, accumulatedUsage: {},
		exposedTools: [{ id: "shell", name: "Shell", description: "Shell", inputSchema: { type: "object" } }],
	});
	for (let attempt = 0; attempt < 100 && !executed.includes("call-2"); attempt += 1) await setImmediate();
	assert.deepEqual(executed, ["call-2"]);
	assert.equal(fixture.coordinator.pending()?.callId, "call-1");
	assert.equal(fixture.store.loadConversationItems("session-1").some((item) => item.type === "tool_result"), false);
	fixture.coordinator.respond({ decisionId: "call-1", choice: "reject" });
	await running;
	assert.deepEqual(executed, ["call-2"]);
	assert.deepEqual(fixture.store.loadPendingToolCalls("session-1", "turn-1"), []);
});

test("a failed approved call cancels an unanswered sibling without hanging the phase", { timeout: 2_000 }, async (t) => {
	const fixture = await approvalFixture(t);
	const batches = new ToolBatchCoordinator({
		sessionId: "session-1", store: fixture.store, budget: new AgentBudgetTracker(),
		activeTools: new ActiveToolExecutionRegistry(), parallelApprovals: fixture.coordinator,
		approvalPolicy: { evaluate: (call) => ({
			kind: "request", callId: call.callId, toolName: call.name, preview: call.callId,
			reason: "test policy", options: ["approve_once", "reject"],
		}) },
		toolRouter: {
			supportsParallelToolCalls: () => true,
			execute: async () => { throw new Error("tool adapter disconnected"); },
		},
		executeToolEffect: (input, execute) => executeEffect(fixture.store, input.call, execute),
		publishLifecycle: () => undefined,
	});
	const running = assert.rejects(batches.process({
		context: context(), batch: { calls: CALLS, assistantText: "" }, accumulatedUsage: {},
		exposedTools: [{ id: "shell", name: "Shell", description: "Shell", inputSchema: { type: "object" } }],
	}), /tool execution failed/u);
	for (let attempt = 0; attempt < 100 && !fixture.coordinator.hasActiveApproval("call-1"); attempt += 1) {
		await setImmediate();
	}
	fixture.coordinator.respond({ decisionId: "call-1", choice: "approve_once" });
	await running;
	assert.equal(fixture.coordinator.hasActiveApproval("call-2"), false);
	assert.equal(fixture.store.loadState("session-1", "pending_decision"), undefined);
	assert.equal(fixture.store.agentEffectLedger.load(toolEffectAttemptId("session-1", "turn-1", "call-2")), undefined);
});

interface ApprovalFixture {
	readonly store: RuntimeSessionStore;
	readonly coordinator: ParallelApprovalCoordinator;
	readonly controller: AbortController;
	readonly events: RuntimeEvent[];
	begin(): void;
	state(): SuspendedState;
	save(state: SuspendedState, expectedRevision?: number): void;
	failWrites(enabled: boolean): void;
	reopen(): { readonly store: RuntimeSessionStore; readonly coordinator: ParallelApprovalCoordinator };
}

async function approvalFixture(t: test.TestContext): Promise<ApprovalFixture> {
	const root = await mkdtemp(join(tmpdir(), "mycli-parallel-approval-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const dbPath = join(root, "sessions.db");
	let failWrites = false;
	const open = (): { store: RuntimeSessionStore; coordinator: ParallelApprovalCoordinator } => {
		const store = openRuntimeSessionStore({ dbPath, clock: () => NOW, stateFailpoint: (point) => {
			if (failWrites && point === "parallel_approval_after_states") throw new Error("injected approval failure");
		} });
		t.after(() => store.close());
		const approval = new ApprovalContinuationCoordinator({
			sessionId: "session-1", workspaceRoot: root, threadId: "session-1", store,
			toolRouter: { execute: async (call) => result(call) }, publishLifecycle: () => undefined, clock: () => NOW,
		});
		const coordinator = new ParallelApprovalCoordinator({
			sessionId: "session-1", workspaceRoot: root, threadId: "session-1", store, approval,
		});
		t.after(() => coordinator.abortPending());
		return { store, coordinator };
	};
	const { store, coordinator } = open();
	store.reserveTurn({
		sessionId: "session-1", clientTurnId: "client-1", clientUserMessageId: "message-1", turnId: "turn-1",
		requestFingerprint: `sha256:${"a".repeat(64)}`, workspaceRoot: root, threadId: "session-1",
		userText: "Run independent commands", startedAt: NOW,
	});
	store.appendAssistantToolCalls({
		sessionId: "session-1", clientTurnId: "client-1", assistantText: "", calls: CALLS, responseId: "resp-1",
	});
	const calls = CALLS.map((call) => ({
		call, executionCall: call, sandboxOverrideApproved: false,
		approval: coordinator.prepare({
			clientTurnId: "client-1", clientUserMessageId: "message-1", turnId: "turn-1",
			userMessage: "Run independent commands", providerProtocol: "responses", call,
			remainingCalls: [], conversation: [], assistantText: "", responseId: "resp-1", usage: {},
			preview: call.callId, reason: "approval required", options: ["approve_once", "reject"],
			runSnapshot: context().runSnapshot,
		}),
	}));
	const controller = new AbortController();
	const events: RuntimeEvent[] = [];
	return {
		store, coordinator, controller, events,
		begin: () => coordinator.begin({
			calls, continuation: calls[0]!.approval, conversation: store.loadConversation("session-1"),
			signal: controller.signal, emit: (event) => events.push(event),
		}),
		state: () => {
			const state = parseRuntimeState({
				kind: "suspended_turn", version: 1, payload: store.loadState("session-1", "suspended_turn"),
			});
			assert.equal(state.kind, "suspended_turn");
			return state;
		},
		save: (suspendedTurn, expectedRevision) => store.saveParallelApprovalBatch({
			sessionId: "session-1", workspaceRoot: root, threadId: "session-1", suspendedTurn,
			...(expectedRevision === undefined ? {} : { expectedRevision }),
		}),
		failWrites: (enabled) => { failWrites = enabled; },
		reopen: open,
	};
}

function context(): ToolBatchRuntimeContext {
	return {
		submission: { clientTurnId: "client-1", clientUserMessageId: "message-1", message: "Run independent commands" },
		turnId: "turn-1", config: { protocol: "responses" }, collaborationMode: "default",
		runSnapshot: createRunExecutionSnapshot({
			turnId: "turn-1", collaborationMode: "default", toolCatalog: { catalogVersion: 1, directTools: [] },
		}),
		emit: () => undefined, signal: new AbortController().signal, hookContexts: new HookContextAccumulator(),
	};
}

async function executeEffect(
	store: RuntimeSessionStore,
	call: CanonicalToolCall,
	execute: () => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
	const broker = new NodeTurnCoordinatorBroker({
		sessionId: "session-1", ledger: store.modelInputLedger, effectLedger: store.agentEffectLedger, clock: () => NOW,
	});
	const outcome = await broker.executeTool({
		attemptId: toolEffectAttemptId("session-1", "turn-1", call.callId), jobId: "root-session-1",
		turnId: "turn-1", base: { windowId: "turn-1", version: 0 }, call, mutating: true,
	}, execute);
	return outcome.result;
}

function result(call: CanonicalToolCall): ToolExecutionResult {
	return { callId: call.callId, toolName: call.name, success: true, modelOutput: call.callId, summary: "done", metadata: {} };
}

function approvalIds(events: readonly RuntimeEvent[]): readonly string[] {
	return events.filter((event) => event.type === "approval_requested").map((event) => event.decisionId);
}
