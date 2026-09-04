import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeStateRecord, RuntimeTurnRecord } from "@mycli/contracts";
import {
	ApprovalConflictError,
	transitionApproval,
	type ApprovalChoice,
	type ApprovalResolution,
	type ApprovalTransition,
	type CanonicalToolCall,
	type PermissionRequestProfile,
	type ShellLifecycleEvent,
} from "@mycli/core";
import type {
	ApprovalCheckpoint,
	AppendToolResultInput,
} from "@mycli/storage";
import type {
	PreparedMutationGuard,
	ToolExecutionOptions,
	ToolExecutionResult,
	ToolRouterContract,
} from "@mycli/tools";
import * as runtime from "../src/index.ts";

const NOW = "2026-08-04T00:00:00.000Z";
const PREPARED_GUARD: PreparedMutationGuard = Object.freeze({
	version: 1,
	mutationId: "a".repeat(64),
	intentSha256: "b".repeat(64),
	targets: Object.freeze([Object.freeze({
		pathSha256: "c".repeat(64),
		existed: false,
		resultSha256: "d".repeat(64),
	})]),
});

test("suspends only after all compatible approval state is durable", () => {
	const fixture = approvalFixture();
	const pending = fixture.coordinator.suspend(suspension());

	assert.equal(pending.callId, "call-1");
	assert.deepEqual(fixture.trace, ["store:suspend"]);
	assert.equal(fixture.state.get("pending_decision")?.kind, "pending_decision");
	assert.equal(fixture.state.get("suspended_turn")?.kind, "suspended_turn");
	assert.equal(fixture.effect.status, "waiting");
	assert.equal((JSON.stringify([...fixture.state.values()]).match(/mutation_id/gu) ?? []).length, 1);
});

test("restores an unambiguous waiting approval after restart", () => {
	const fixture = approvalFixture();
	fixture.coordinator.suspend(suspension());

	const reopened = fixture.reopen();

	assert.equal(reopened.pending()?.callId, "call-1");
	assert.equal(reopened.pending()?.decisionId, "call-1");
	assert.deepEqual(reopened.pending()?.options, ["approve_once", "reject"]);
	assert.deepEqual(reopened.pending()?.preparedMutationGuard, PREPARED_GUARD);
	assert.deepEqual(Reflect.get(reopened.pending() ?? {}, "runSnapshot"), runSnapshot());
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

test("approval execution uses the coordinator-owned lifecycle publisher", async () => {
	const events: ShellLifecycleEvent[] = [];
	const publishLifecycle = (event: ShellLifecycleEvent): void => { events.push(event); };
	const fixture = approvalFixture({ publishLifecycle });
	fixture.coordinator.suspend(suspension());

	await fixture.coordinator.resolve({
		decisionId: "call-1",
		choice: "approve_once",
		signal: new AbortController().signal,
	});
	fixture.executionOptions?.publishLifecycle(shellLifecycleEvent());

	assert.equal(fixture.executionOptions?.ownerSessionId, "session-1");
	assert.equal(fixture.executionOptions?.ownerTurnId, "turn-1");
	assert.equal(fixture.executionOptions?.callId, "call-1");
	assert.deepEqual(fixture.executionOptions?.preparedMutationGuard, PREPARED_GUARD);
	assert.deepEqual(events, [shellLifecycleEvent()]);
});

test("approval execution forwards the frozen execution policy", async () => {
	const fixture = approvalFixture();
	fixture.coordinator.suspend(suspension(true));
	const executionPolicy = Object.freeze({
		mode: "read-only" as const,
		filesystem: "read_only" as const,
		network: "disabled" as const,
		writableRoots: Object.freeze([] as string[]),
	});
	const sandboxOverridePolicy = Object.freeze({
		mode: "workspace-write" as const,
		filesystem: "workspace_write" as const,
		network: "disabled" as const,
		writableRoots: Object.freeze(["/managed"]),
	});

	await fixture.coordinator.resolve({
		decisionId: "call-1",
		choice: "approve_once",
		signal: new AbortController().signal,
		executionPolicy,
		sandboxOverridePolicy,
	});

	assert.equal(fixture.executionOptions?.executionPolicy, executionPolicy);
	assert.equal(fixture.executionOptions?.sandboxOverridePolicy, sandboxOverridePolicy);
});

test("approval recovery derives sandbox override authorization from the persisted Shell call", async () => {
	const fixture = approvalFixture({ shellApproval: true });
	fixture.coordinator.suspend(suspension(true, true));

	await fixture.reopen().resolve({
		decisionId: "call-1",
		choice: "approve_once",
		signal: new AbortController().signal,
	});

	assert.equal(fixture.executionOptions?.sandboxOverrideApproved, true);
});

test("approval recovery derives sandbox override authorization from a persisted mutation call", async () => {
	const fixture = approvalFixture();
	fixture.coordinator.suspend(suspension(false, true));

	await fixture.reopen().resolve({
		decisionId: "call-1",
		choice: "approve_once",
		signal: new AbortController().signal,
	});

	assert.equal(fixture.executionOptions?.sandboxOverrideApproved, true);
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

test("always allow persists reloads and publishes before claiming one effect", async () => {
	const fixture = approvalFixture({ shellApproval: true });
	const pending = fixture.coordinator.suspend(suspension(true));

	assert.deepEqual(pending.options, [
		"approve_once",
		"reject",
		"allow_session",
		"always_allow",
	]);
	assert.deepEqual(pending.proposedExecPolicyPattern, ["python", "-m", "pytest"]);
	assert.deepEqual(fixture.reopen().pending()?.proposedExecPolicyPattern, [
		"python",
		"-m",
		"pytest",
	]);

	const result = await fixture.coordinator.resolve({
		decisionId: "call-1",
		choice: "always_allow",
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.equal(fixture.executeCalls, 1);
	assert.deepEqual(fixture.persistedPatterns, [["python", "-m", "pytest"]]);
	assert.deepEqual(fixture.trace, [
		"store:suspend",
		"rules:allow",
		"rules:load",
		"rules:publish",
		"store:approve_once",
		"store:claim_effect",
		"router:execute",
		"store:commit_result",
	]);
});

test("refresh failure after persistence leaves approval pending and never claims the effect", async () => {
	const fixture = approvalFixture({ shellApproval: true, refreshFailure: true });
	fixture.coordinator.suspend(suspension(true));

	await assert.rejects(fixture.coordinator.resolve({
		decisionId: "call-1",
		choice: "always_allow",
		signal: new AbortController().signal,
	}), /refresh failed/u);

	assert.equal(fixture.effect.status, "waiting");
	assert.equal(fixture.executeCalls, 0);
	assert.equal(fixture.state.has("pending_decision"), true);
	assert.equal(fixture.state.has("suspended_turn"), true);
	assert.deepEqual(fixture.trace, [
		"store:suspend",
		"rules:allow",
		"rules:load",
		"rules:publish",
	]);
});

test("allow session publishes the exact command pattern before claiming one effect", async () => {
	const fixture = approvalFixture({ shellApproval: true });
	fixture.coordinator.suspend(suspension(true));

	await fixture.coordinator.resolve({
		decisionId: "call-1",
		choice: "allow_session",
		signal: new AbortController().signal,
	});

	assert.deepEqual(fixture.sessionPatterns, [["python", "-m", "pytest"]]);
	assert.ok(fixture.trace.indexOf("rules:allow_session") < fixture.trace.indexOf("store:claim_effect"));
});

test("permission approval restores the request and grants the selected scope before execution", async () => {
	const fixture = approvalFixture({ permissionGrant: true });
	fixture.coordinator.suspend(permissionSuspension());
	assert.deepEqual(fixture.reopen().pending()?.permissionRequest, {
		fileSystem: { read: [], write: ["/tmp/mycli-export"] },
	});

	await fixture.coordinator.resolve({
		decisionId: "call-1",
		choice: "allow_session",
		signal: new AbortController().signal,
	});

	assert.deepEqual(fixture.executionOptions?.permissionGrant, {
		scope: "session",
		permissions: { fileSystem: { read: [], write: ["/tmp/mycli-export"] } },
		constrained: false,
	});
	assert.ok(fixture.trace.indexOf("permissions:grant") < fixture.trace.indexOf("router:execute"));
});

interface CoordinatorContract {
	suspend(input: ReturnType<typeof suspension>): PendingContract;
	pending(): PendingContract | undefined;
	resolve(input: {
		readonly decisionId: string;
		readonly choice: ApprovalChoice;
		readonly signal: AbortSignal;
		readonly onExecutionStart?: () => void;
		readonly executionPolicy?: ToolExecutionOptions["executionPolicy"];
		readonly sandboxOverridePolicy?: ToolExecutionOptions["sandboxOverridePolicy"];
	}): Promise<{ readonly status: string; readonly continuation?: PendingContract }>;
	finish(decisionId: string): void;
	recover(): Promise<RuntimeTurnRecord | undefined> | RuntimeTurnRecord | undefined;
}

interface PendingContract {
	readonly decisionId: string;
	readonly callId: string;
	readonly options: readonly string[];
	readonly proposedExecPolicyPattern?: readonly string[];
	readonly preparedMutationGuard?: PreparedMutationGuard;
	readonly permissionRequest?: PermissionRequestProfile;
}

function approvalFixture(options: {
	readonly effectStatus?: ApprovalResolution["status"];
	readonly executeAbort?: boolean;
	readonly publishLifecycle?: (event: ShellLifecycleEvent) => void;
		readonly shellApproval?: boolean;
	readonly refreshFailure?: boolean;
	readonly permissionGrant?: boolean;
} = {}) {
	const trace: string[] = [];
	const state = new Map<string, RuntimeStateRecord>();
	let executeCalls = 0;
	let committedResult: AppendToolResultInput | undefined;
	let interruptedErrorKind: string | undefined;
	let executionOptions: ToolExecutionOptions | undefined;
	const persistedPatterns: string[][] = [];
	const sessionPatterns: string[][] = [];
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
		execute: async (call, routerOptions): Promise<ToolExecutionResult> => {
			executeCalls += 1;
			executionOptions = routerOptions;
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
			publishLifecycle: options.publishLifecycle ?? (() => undefined),
			ruleStore: {
				allow: async (pattern: readonly string[]) => {
					trace.push("rules:allow");
					persistedPatterns.push([...pattern]);
					return { status: "created", patternHash: "0123456789abcdef" };
				},
				load: async () => {
					trace.push("rules:load");
					return persistedPatterns.map((pattern, index) => ({
						source: "user",
						index,
						pattern,
						decision: "allow",
					}));
				},
			},
			publishExecPolicyRules: () => {
				trace.push("rules:publish");
				if (options.refreshFailure) throw new Error("refresh failed");
			},
			allowSession: (pattern: readonly string[]) => {
				trace.push("rules:allow_session");
				sessionPatterns.push([...pattern]);
			},
			...(options.permissionGrant ? {
				grantPermissions: (input: {
					readonly scope: "turn" | "session";
					readonly permissions: PermissionRequestProfile;
				}) => {
					trace.push("permissions:grant");
					return {
						scope: input.scope,
						permissions: input.permissions,
						constrained: false,
					};
				},
			} : {}),
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
		get executionOptions() { return executionOptions; },
		persistedPatterns,
		sessionPatterns,
	};
}

function shellLifecycleEvent(): ShellLifecycleEvent {
	return {
		type: "shell_lifecycle",
		kind: "shell.output",
		shellId: "a1b2c3d4",
		ownerSessionId: "session-1",
		callId: "call-1",
		sequence: 1,
		commandPreview: "npm test",
		background: true,
		processState: "running_background",
		tty: false,
		yielded: true,
		outputDelta: "ready\n",
	};
}

function suspension(shell = false, escalated = false) {
	return {
		clientTurnId: "client-1",
		turnId: "turn-1",
		userMessage: shell ? "run the tests" : "write the notes",
		providerProtocol: "responses" as const,
		call: shell ? shellCall(escalated) : writeCall(escalated),
		remainingCalls: Object.freeze([] as CanonicalToolCall[]),
		conversation: Object.freeze([{ role: "user" as const, content: "write the notes" }]),
		assistantText: "",
		responseId: "resp-1",
		usage: Object.freeze({ input_tokens: 10 }),
		runSnapshot: runSnapshot(),
		preview: "Write notes.txt",
		reason: "Workspace mutation requires one-time approval.",
		...(shell ? {
			commandPattern: ["python", "-m", "pytest"],
			proposedExecPolicyPattern: ["python", "-m", "pytest"],
		} : { preparedMutationGuard: PREPARED_GUARD }),
	};
}

function runSnapshot() {
	return runtime.createRunExecutionSnapshot({
		turnId: "turn-1",
		collaborationMode: "default",
		toolCatalog: {
			catalogVersion: 4,
			directTools: [{
				id: "builtin:Write",
				name: "Write",
				description: "Write a file",
				inputSchema: { type: "object", properties: {}, additionalProperties: false },
			}],
		},
	});
}

function shellCall(escalated = false): CanonicalToolCall {
	return {
		callId: "call-1",
		name: "Shell",
		argumentsJson: JSON.stringify({
			command: "python -m pytest -q",
			prefix_rule: ["python", "-m", "pytest"],
			...(escalated ? { sandbox_permissions: "require_escalated" } : {}),
		}),
	};
}

function permissionSuspension() {
	return {
		...suspension(),
		call: {
			callId: "call-1",
			name: "request_permissions",
			argumentsJson: JSON.stringify({
				permissions: { file_system: { write: ["/tmp/mycli-export"] } },
			}),
		},
		preview: "Request write /tmp/mycli-export",
		reason: "Export the generated artifact.",
		options: ["approve_once", "reject", "allow_session"] as const,
		permissionRequest: {
			fileSystem: { read: [], write: ["/tmp/mycli-export"] },
		},
	};
}

function writeCall(escalated = false): CanonicalToolCall {
	return {
		callId: "call-1",
		name: "Write",
		argumentsJson: JSON.stringify({
			file_path: "notes.txt",
			content: "hello",
			...(escalated ? {
				sandbox_permissions: "danger-full-access",
				justification: "The requested file is outside the workspace.",
			} : {}),
		}),
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
