import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeStateRecord, RuntimeTurnRecord } from "@mycli/contracts";
import {
	ApprovalConflictError,
	transitionApproval,
	type ApprovalResolution,
	type ApprovalTransition,
	type CanonicalToolCall,
} from "@mycli/core";
import type {
	ApprovalCheckpoint,
	AppendToolResultInput,
} from "@mycli/storage";
import type { ToolExecutionResult, ToolRouterContract } from "@mycli/tools";
import * as runtime from "../src/index.ts";

const NOW = "2026-08-04T00:00:00.000Z";

test("suspends only after all compatible approval state is durable", () => {
	const fixture = approvalFixture();
	const pending = fixture.coordinator.suspend(suspension());

	assert.equal(pending.callId, "call-1");
	assert.deepEqual(fixture.trace, ["store:suspend"]);
	assert.equal(fixture.state.get("pending_decision")?.kind, "pending_decision");
	assert.equal(fixture.state.get("suspended_turn")?.kind, "suspended_turn");
	assert.equal(fixture.effect.status, "waiting");
});

test("restores an unambiguous waiting approval after restart", () => {
	const fixture = approvalFixture();
	fixture.coordinator.suspend(suspension());

	const reopened = fixture.reopen();

	assert.equal(reopened.pending()?.callId, "call-1");
	assert.equal(reopened.pending()?.decisionId, "call-1");
	assert.deepEqual(reopened.pending()?.options, ["approve_once", "reject"]);
});

test("approve once claims executes and commits one effect in order", async () => {
	const fixture = approvalFixture();
	fixture.coordinator.suspend(suspension());

	const result = await fixture.coordinator.resolve({
		decisionId: "call-1",
		choice: "approve_once",
		signal: new AbortController().signal,
		onExecutionStart: () => { fixture.trace.push("runtime:tool_start"); },
	});

	assert.equal(result.status, "completed");
	assert.equal(fixture.executeCalls, 1);
	assert.deepEqual(fixture.trace, [
		"store:suspend",
		"store:approve_once",
		"store:claim_effect",
		"runtime:tool_start",
		"router:execute",
		"store:commit_result",
	]);
	assert.equal(fixture.effect.status, "completed");
	assert.equal(result.continuation?.decisionId, "call-1");
	assert.equal(fixture.state.has("pending_decision"), true);
	assert.equal(fixture.state.has("suspended_turn"), true);
});

test("reject commits a denied result without executing the tool", async () => {
	const fixture = approvalFixture();
	fixture.coordinator.suspend(suspension());

	const result = await fixture.coordinator.resolve({
		decisionId: "call-1",
		choice: "reject",
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "rejected");
	assert.equal(fixture.executeCalls, 0);
	assert.equal(fixture.committedResult?.errorKind, "approval_rejected");
	assert.deepEqual(fixture.trace, ["store:suspend", "store:commit_result"]);
});

test("identical resolution retries are idempotent while conflicts and wrong ids fail", async () => {
	const fixture = approvalFixture();
	fixture.coordinator.suspend(suspension());
	const signal = new AbortController().signal;

	await fixture.coordinator.resolve({ decisionId: "call-1", choice: "approve_once", signal });
	const retry = await fixture.coordinator.resolve({
		decisionId: "call-1",
		choice: "approve_once",
		signal,
	});

	assert.equal(retry.status, "completed");
	assert.equal(retry.continuation?.decisionId, "call-1");
	assert.equal(fixture.executeCalls, 1);
	await assert.rejects(
		fixture.coordinator.resolve({ decisionId: "call-1", choice: "reject", signal }),
		ApprovalConflictError,
	);
	await assert.rejects(
		fixture.coordinator.resolve({ decisionId: "wrong", choice: "approve_once", signal }),
		(error: unknown) => hasCode(error, "approval_not_pending"),
	);
	fixture.coordinator.finish("call-1");
	assert.equal(fixture.state.has("node_effect_checkpoint"), false);
});

test("never re-executes an orphaned claimed effect", async () => {
	const fixture = approvalFixture({ effectStatus: "executing" });

	const recovered = await fixture.coordinator.recover();

	assert.equal(recovered?.status, "interrupted");
	assert.equal(fixture.executeCalls, 0);
	assert.equal(fixture.interruptedErrorKind, "effect_outcome_unknown");
	assert.deepEqual(fixture.trace, ["store:interrupt_unknown"]);
});

test("interrupt during claimed tool execution becomes an ambiguous effect", async () => {
	const fixture = approvalFixture({ executeAbort: true });
	fixture.coordinator.suspend(suspension());

	const result = await fixture.coordinator.resolve({
		decisionId: "call-1",
		choice: "approve_once",
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "interrupted");
	assert.equal(fixture.executeCalls, 1);
	assert.equal(fixture.interruptedErrorKind, "effect_outcome_unknown");
	assert.equal(fixture.trace.at(-1), "store:interrupt_unknown");
});

interface CoordinatorContract {
	suspend(input: ReturnType<typeof suspension>): PendingContract;
	pending(): PendingContract | undefined;
	resolve(input: {
		readonly decisionId: string;
		readonly choice: "approve_once" | "reject";
		readonly signal: AbortSignal;
		readonly onExecutionStart?: () => void;
	}): Promise<{ readonly status: string; readonly continuation?: PendingContract }>;
	finish(decisionId: string): void;
	recover(): Promise<RuntimeTurnRecord | undefined> | RuntimeTurnRecord | undefined;
}

interface PendingContract {
	readonly decisionId: string;
	readonly callId: string;
	readonly options: readonly string[];
}

function approvalFixture(options: {
	readonly effectStatus?: ApprovalResolution["status"];
	readonly executeAbort?: boolean;
} = {}) {
	const trace: string[] = [];
	const state = new Map<string, RuntimeStateRecord>();
	let executeCalls = 0;
	let committedResult: AppendToolResultInput | undefined;
	let interruptedErrorKind: string | undefined;
	let effect = checkpoint(options.effectStatus ?? "waiting");
	if (options.effectStatus) {
		state.set("pending_decision", pendingDecision());
		state.set("suspended_turn", suspendedTurn());
		state.set("node_effect_checkpoint", effectState(effect));
	}
	let turn = runtimeTurn("in_progress");
	const store = {
		loadState: (_sessionId: string, key: string) => state.get(key),
		loadTurn: () => turn,
		saveApprovalSuspension: (input: {
			readonly pendingDecision: RuntimeStateRecord;
			readonly suspendedTurn: RuntimeStateRecord;
			readonly turnRecord: Readonly<Record<string, unknown>>;
			readonly checkpoint: ApprovalCheckpoint;
		}) => {
			trace.push("store:suspend");
			state.set("pending_decision", input.pendingDecision);
			state.set("suspended_turn", input.suspendedTurn);
			effect = input.checkpoint;
			state.set("node_effect_checkpoint", effectState(effect));
			return effect;
		},
		compareAndSetApproval: (input: {
			readonly expectedStatus: ApprovalResolution["status"];
			readonly transition: ApprovalTransition;
		}) => {
			const next = transitionApproval(effect, input.transition);
			if (next === effect) return effect;
			if (effect.status !== input.expectedStatus) {
				throw new ApprovalConflictError(effect.status, input.transition.type);
			}
			trace.push(`store:${input.transition.type}`);
			effect = { ...effect, ...next, updatedAt: NOW } as ApprovalCheckpoint;
			state.set("node_effect_checkpoint", effectState(effect));
			return effect;
		},
			commitApprovalResult: (input: {
			readonly expectedStatus: ApprovalResolution["status"];
			readonly transition: ApprovalTransition;
			readonly toolResult: AppendToolResultInput;
		}) => {
			const next = transitionApproval(effect, input.transition);
			if (effect.status !== input.expectedStatus) {
				throw new ApprovalConflictError(effect.status, input.transition.type);
			}
			trace.push("store:commit_result");
				committedResult = input.toolResult;
				effect = { ...effect, ...next, updatedAt: NOW } as ApprovalCheckpoint;
				state.set("node_effect_checkpoint", effectState(effect));
				return effect;
			},
			finalizeApprovalContinuation: (input: { readonly decisionId: string }) => {
				assert.equal(input.decisionId, effect.decisionId);
				trace.push("store:finalize");
				state.delete("pending_decision");
				state.delete("suspended_turn");
				state.delete("node_effect_checkpoint");
			},
		interruptAmbiguousApproval: (input: { readonly errorKind: string }) => {
			trace.push("store:interrupt_unknown");
			interruptedErrorKind = input.errorKind;
			state.delete("pending_decision");
			state.delete("suspended_turn");
			turn = runtimeTurn("interrupted");
			return turn;
		},
	};
	const router: ToolRouterContract = {
		execute: async (call): Promise<ToolExecutionResult> => {
			executeCalls += 1;
			trace.push("router:execute");
			if (options.executeAbort) {
				const error = new Error("aborted during mutation");
				error.name = "AbortError";
				throw error;
			}
			return {
				callId: call.callId,
				toolName: call.name,
				success: true,
				modelOutput: "Write completed",
				summary: "Write completed",
				metadata: { path: "notes.txt", status: "created" },
			};
		},
	};
	const createCoordinator = (): CoordinatorContract => {
		const Constructor = Reflect.get(runtime, "ApprovalContinuationCoordinator");
		assert.equal(typeof Constructor, "function", "ApprovalContinuationCoordinator must be exported");
		return new (Constructor as unknown as new (
			input: Readonly<Record<string, unknown>>,
		) => CoordinatorContract)({
			sessionId: "session-1",
			workspaceRoot: "/repo",
			threadId: "session-1",
			store,
			toolRouter: router,
			clock: () => NOW,
		});
	};
	const coordinator = createCoordinator();
	return {
		coordinator,
		reopen: createCoordinator,
		trace,
		state,
		get effect() { return effect; },
		get executeCalls() { return executeCalls; },
		get committedResult() { return committedResult; },
		get interruptedErrorKind() { return interruptedErrorKind; },
	};
}

function suspension() {
	return {
		clientTurnId: "client-1",
		turnId: "turn-1",
		userMessage: "write the notes",
		providerProtocol: "responses" as const,
		call: writeCall(),
		remainingCalls: Object.freeze([] as CanonicalToolCall[]),
		conversation: Object.freeze([{ role: "user" as const, content: "write the notes" }]),
		assistantText: "",
		responseId: "resp-1",
		usage: Object.freeze({ input_tokens: 10 }),
		preview: "Write notes.txt",
		reason: "Workspace mutation requires one-time approval.",
	};
}

function writeCall(): CanonicalToolCall {
	return {
		callId: "call-1",
		name: "Write",
		argumentsJson: JSON.stringify({ file_path: "notes.txt", content: "hello" }),
	};
}

function pendingDecision(): Extract<RuntimeStateRecord, { kind: "pending_decision" }> {
	return {
		kind: "pending_decision",
		version: 1,
		payload: {
			tool_call: { name: "Write", arguments: { file_path: "notes.txt" }, reason: "", call_id: "call-1" },
			kind: "needs_choice",
			reason: "Approval required",
			preview: "Write notes.txt",
			options: ["approve_once", "reject"],
		},
	};
}

function suspendedTurn(): Extract<RuntimeStateRecord, { kind: "suspended_turn" }> {
	return {
		kind: "suspended_turn",
		version: 1,
		payload: {
			user_message: "write the notes",
			conversation: [{ role: "user", content: "write the notes" }],
			suspend_reason: "approval_required",
			session_id: "session-1",
			client_turn_id: "client-1",
			turn_id: "turn-1",
			provider_protocol: "responses",
			remaining_tool_calls: [],
			pending_approval: {
				tool_call: { name: "Write", arguments: { file_path: "notes.txt" }, reason: "", call_id: "call-1" },
				reason: "Approval required",
				preview: "Write notes.txt",
			},
		},
	};
}

function checkpoint(status: ApprovalResolution["status"]): ApprovalCheckpoint {
	const shared = {
		sessionId: "session-1",
		clientTurnId: "client-1",
		turnId: "turn-1",
		decisionId: "call-1",
		callId: "call-1",
		toolName: "Write",
		updatedAt: NOW,
	};
	if (status === "executing") return { ...shared, status, fingerprint: "sha256:existing" };
	if (status === "completed") {
		return { ...shared, status, fingerprint: "sha256:existing", resultCallId: "call-1" };
	}
	return { ...shared, status };
}

function runtimeTurn(status: RuntimeTurnRecord["status"]): RuntimeTurnRecord {
	return {
		schema_version: 1,
		session_id: "session-1",
		client_turn_id: "client-1",
		turn_id: "turn-1",
		request_fingerprint: "fingerprint",
		status,
		error_code: status === "interrupted" ? "interrupted" : null,
		result: status === "interrupted" ? { error_kind: "effect_outcome_unknown" } : null,
		started_at: NOW,
		completed_at: status === "interrupted" ? NOW : null,
	};
}

function effectState(
	effect: ApprovalCheckpoint,
): Extract<RuntimeStateRecord, { kind: "effect_checkpoint" }> {
	return {
		kind: "effect_checkpoint",
		version: 1,
		payload: {
			session_id: effect.sessionId,
			client_turn_id: effect.clientTurnId,
			turn_id: effect.turnId,
			decision_id: effect.decisionId,
			call_id: effect.callId,
			tool_name: effect.toolName,
			status: effect.status,
			...(effect.status === "executing" || effect.status === "completed"
				? { fingerprint: effect.fingerprint }
				: {}),
			...(effect.status === "completed" ? { result_call_id: effect.resultCallId } : {}),
			updated_at: effect.updatedAt,
		},
	};
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
