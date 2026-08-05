import { createHash } from "node:crypto";
import { parseRuntimeState } from "@mycli/contracts";
import type {
	RuntimeStateRecord,
	RuntimeTurnRecord,
} from "@mycli/contracts";
import {
	ApprovalConflictError,
	createWaitingApproval,
} from "@mycli/core";
import type {
	ApprovalChoice as CoreApprovalChoice,
	ApprovalResolution,
	ApprovalTransition,
	CanonicalMessage,
	CanonicalToolCall,
	ExecPolicyRule,
	ProtocolId,
	ProviderUsage,
	ReasoningEffort,
	ShellLifecycleEvent,
} from "@mycli/core";
import type {
	AppendToolResultInput,
	ApprovalCheckpoint,
	RuntimeStateKey,
} from "@mycli/storage";
import type {
	ExecutionPolicy,
	ToolExecutionResult,
	ToolRouterContract,
} from "@mycli/tools";
import { NO_RUNTIME_FAILPOINT } from "./fault-injection.ts";
import type { RuntimeFailpointHook } from "./fault-injection.ts";

export type ApprovalChoice = CoreApprovalChoice;

export interface ApprovalSuspensionInput {
	readonly clientTurnId: string;
	readonly turnId: string;
	readonly userMessage: string;
	readonly providerProtocol: ProtocolId;
	readonly call: CanonicalToolCall;
	readonly remainingCalls: readonly CanonicalToolCall[];
	readonly conversation: readonly CanonicalMessage[];
	readonly assistantText: string;
	readonly responseId?: string;
	readonly usage: ProviderUsage;
	readonly modelOverride?: string;
	readonly reasoningEffort?: ReasoningEffort;
	readonly preview: string;
	readonly reason: string;
	readonly commandPattern?: readonly string[];
	readonly proposedExecPolicyPattern?: readonly string[];
}

export interface PendingApprovalContinuation {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly turnId: string;
	readonly decisionId: string;
	readonly callId: string;
	readonly toolName: string;
	readonly preview: string;
	readonly reason: string;
	readonly options: readonly ApprovalChoice[];
	readonly commandPattern?: readonly string[];
	readonly proposedExecPolicyPattern?: readonly string[];
	readonly providerProtocol: ProtocolId;
	readonly userMessage: string;
	readonly call: CanonicalToolCall;
	readonly remainingCalls: readonly CanonicalToolCall[];
	readonly assistantText: string;
	readonly responseId?: string;
	readonly usage: ProviderUsage;
	readonly modelOverride?: string;
	readonly reasoningEffort?: ReasoningEffort;
}

export type ApprovalContinuationResult =
	| {
		readonly status: "completed" | "rejected";
		readonly checkpoint: ApprovalCheckpoint;
		readonly continuation?: PendingApprovalContinuation;
		readonly toolResult?: ToolExecutionResult;
	}
	| {
		readonly status: "interrupted";
		readonly turn: RuntimeTurnRecord;
	};

export interface SaveApprovalSuspensionInput {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly pendingDecision: Extract<RuntimeStateRecord, { kind: "pending_decision" }>;
	readonly suspendedTurn: Extract<RuntimeStateRecord, { kind: "suspended_turn" }>;
	readonly turnRecord: Readonly<Record<string, unknown>>;
	readonly checkpoint: ApprovalCheckpoint;
}

export interface CommitApprovalResultInput {
	readonly sessionId: string;
	readonly expectedStatus: ApprovalResolution["status"];
	readonly transition: ApprovalTransition;
	readonly toolResult: AppendToolResultInput;
}

export interface InterruptAmbiguousApprovalInput {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly callId: string;
	readonly toolName: string;
	readonly errorKind: "effect_outcome_unknown";
	readonly completedAt: string;
}

export interface FinalizeApprovalContinuationInput {
	readonly sessionId: string;
	readonly decisionId: string;
}

export interface ApprovalContinuationStore {
	loadState(sessionId: string, key: RuntimeStateKey): unknown | undefined;
	loadTurn(sessionId: string, clientTurnId: string): RuntimeTurnRecord | undefined;
	saveApprovalSuspension(input: SaveApprovalSuspensionInput): ApprovalCheckpoint;
	compareAndSetApproval(input: {
		readonly sessionId: string;
		readonly expectedStatus: ApprovalResolution["status"];
		readonly transition: ApprovalTransition;
	}): ApprovalCheckpoint;
	commitApprovalResult(input: CommitApprovalResultInput): ApprovalCheckpoint;
	finalizeApprovalContinuation(input: FinalizeApprovalContinuationInput): void;
	interruptAmbiguousApproval(input: InterruptAmbiguousApprovalInput): RuntimeTurnRecord;
}

export interface ApprovalContinuationCoordinatorOptions {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly store: ApprovalContinuationStore;
	readonly toolRouter: ToolRouterContract;
	readonly publishLifecycle: (event: ShellLifecycleEvent) => void;
	readonly clock: () => string;
	readonly ruleStore?: {
		allow(pattern: readonly string[]): Promise<unknown>;
		load(): Promise<readonly ExecPolicyRule[]>;
	};
	readonly publishExecPolicyRules?: (rules: readonly ExecPolicyRule[]) => void;
	readonly allowSession?: (pattern: readonly string[]) => void;
	readonly failpoint?: RuntimeFailpointHook;
}

export class ApprovalNotPendingError extends Error {
	readonly code = "approval_not_pending" as const;

	constructor() {
		super("approval_not_pending: no matching approval is pending");
		this.name = "ApprovalNotPendingError";
	}
}

export class ApprovalContinuationCoordinator {
	readonly #sessionId: string;
	readonly #workspaceRoot: string;
	readonly #threadId: string;
	readonly #store: ApprovalContinuationStore;
	readonly #toolRouter: ToolRouterContract;
	readonly #publishLifecycle: (event: ShellLifecycleEvent) => void;
	readonly #clock: () => string;
	readonly #ruleStore: ApprovalContinuationCoordinatorOptions["ruleStore"];
	readonly #publishExecPolicyRules: ApprovalContinuationCoordinatorOptions["publishExecPolicyRules"];
	readonly #allowSession: ApprovalContinuationCoordinatorOptions["allowSession"];
	readonly #failpoint: RuntimeFailpointHook;

	constructor(options: ApprovalContinuationCoordinatorOptions) {
		this.#sessionId = nonEmpty(options.sessionId, "sessionId");
		this.#workspaceRoot = nonEmpty(options.workspaceRoot, "workspaceRoot");
		this.#threadId = nonEmpty(options.threadId, "threadId");
		this.#store = options.store;
		this.#toolRouter = options.toolRouter;
		this.#publishLifecycle = options.publishLifecycle;
		this.#clock = options.clock;
		this.#ruleStore = options.ruleStore;
		this.#publishExecPolicyRules = options.publishExecPolicyRules;
		this.#allowSession = options.allowSession;
		this.#failpoint = options.failpoint ?? NO_RUNTIME_FAILPOINT;
	}

	suspend(input: ApprovalSuspensionInput): PendingApprovalContinuation {
		const pending = pendingFromInput(this.#sessionId, input);
		const now = this.#clock();
		const checkpoint = checkpointFromResolution({
			...createWaitingApproval(pending.decisionId),
			sessionId: this.#sessionId,
			clientTurnId: pending.clientTurnId,
			turnId: pending.turnId,
			callId: pending.callId,
			toolName: pending.toolName,
			updatedAt: now,
		});
		this.#store.saveApprovalSuspension({
			sessionId: this.#sessionId,
			workspaceRoot: this.#workspaceRoot,
			threadId: this.#threadId,
			pendingDecision: pendingDecisionState(pending),
			suspendedTurn: suspendedTurnState(pending, input.conversation),
			turnRecord: {
				turn_id: pending.turnId,
				client_turn_id: pending.clientTurnId,
				user_message: pending.userMessage,
				status: "waiting_approval",
				stop_reason: "approval_required",
				updated_at: now,
			},
			checkpoint,
		});
		return pending;
	}

	pending(): PendingApprovalContinuation | undefined {
		const pendingState = this.#state("pending_decision");
		const suspendedState = this.#state("suspended_turn");
		if (!pendingState && !suspendedState) return undefined;
		if (pendingState?.kind !== "pending_decision" || suspendedState?.kind !== "suspended_turn") {
			throw new ApprovalNotPendingError();
		}
		return pendingFromStates(this.#sessionId, pendingState, suspendedState);
	}

	async resolve(input: {
		readonly decisionId: string;
		readonly choice: ApprovalChoice;
		readonly signal: AbortSignal;
		readonly onExecutionStart?: () => void;
		readonly executionPolicy?: ExecutionPolicy;
	}): Promise<ApprovalContinuationResult> {
		const checkpoint = this.#checkpoint();
		if (!checkpoint || checkpoint.decisionId !== input.decisionId.trim()) {
			throw new ApprovalNotPendingError();
		}
		if (checkpoint.status === "executing") {
			return this.#interruptUnknown(checkpoint);
		}
		if (checkpoint.status === "completed") {
			if (!isApprovingChoice(input.choice)) {
				throw new ApprovalConflictError(checkpoint.status, "reject");
			}
			return { status: "completed", checkpoint, continuation: this.pending() };
		}
		if (checkpoint.status === "rejected") {
			if (input.choice !== "reject") {
				throw new ApprovalConflictError(checkpoint.status, "approve_once");
			}
			return { status: "rejected", checkpoint, continuation: this.pending() };
		}
		const pending = this.pending();
		if (!pending || pending.decisionId !== checkpoint.decisionId) {
			throw new ApprovalNotPendingError();
		}
		if (!pending.options.includes(input.choice)) {
			throw new ApprovalConflictError(checkpoint.status, input.choice === "reject" ? "reject" : "approve_once");
		}
		if (input.choice === "reject") {
			const result = rejectedResult(pending.call);
			const rejected = this.#store.commitApprovalResult({
				sessionId: this.#sessionId,
				expectedStatus: "waiting",
				transition: { type: "reject" },
				toolResult: storedToolResult(this.#sessionId, pending.clientTurnId, result),
			});
			return { status: "rejected", checkpoint: rejected, continuation: pending, toolResult: result };
		}
		if (input.choice === "always_allow") {
			const pattern = requiredPattern(pending.proposedExecPolicyPattern, "persistent approval");
			if (!this.#ruleStore || !this.#publishExecPolicyRules) {
				throw new ApprovalPersistenceError("Persistent Shell approval is not configured.");
			}
			await this.#ruleStore.allow(pattern);
			const rules = await this.#ruleStore.load();
			this.#publishExecPolicyRules(rules);
		}
		if (input.choice === "allow_session") {
			const pattern = requiredPattern(pending.commandPattern, "session approval");
			if (!this.#allowSession) {
				throw new ApprovalPersistenceError("Session Shell approval is not configured.");
			}
			this.#allowSession(pattern);
		}

		const approved = this.#store.compareAndSetApproval({
			sessionId: this.#sessionId,
			expectedStatus: checkpoint.status,
			transition: { type: "approve_once" },
		});
		this.#failpoint("approval_after_resolution");
		const fingerprint = effectFingerprint(pending.call);
		const executing = this.#store.compareAndSetApproval({
			sessionId: this.#sessionId,
			expectedStatus: "approved",
			transition: { type: "claim_effect", fingerprint },
		});
		this.#failpoint("effect_after_claim");
		if (approved.status !== "approved" || executing.status !== "executing") {
			throw new ApprovalConflictError(executing.status, "claim_effect");
		}
		let result: ToolExecutionResult;
		try {
			input.onExecutionStart?.();
			result = await this.#toolRouter.execute(pending.call, {
				signal: input.signal,
				ownerSessionId: this.#sessionId,
				callId: pending.call.callId,
				publishLifecycle: this.#publishLifecycle,
				...(input.executionPolicy ? { executionPolicy: input.executionPolicy } : {}),
			});
		} catch {
			return this.#interruptUnknown(executing);
		}
		const completed = this.#store.commitApprovalResult({
			sessionId: this.#sessionId,
			expectedStatus: "executing",
			transition: { type: "complete_effect", resultCallId: result.callId },
			toolResult: storedToolResult(this.#sessionId, pending.clientTurnId, result),
		});
		return { status: "completed", checkpoint: completed, continuation: pending, toolResult: result };
	}

	finish(decisionId: string): void {
		this.#store.finalizeApprovalContinuation({
			sessionId: this.#sessionId,
			decisionId: nonEmpty(decisionId, "decisionId"),
		});
	}

	recover(): RuntimeTurnRecord | undefined {
		const checkpoint = this.#checkpoint();
		return checkpoint?.status === "executing"
			? this.#interruptUnknown(checkpoint).turn
			: undefined;
	}

	#state(key: "pending_decision" | "suspended_turn"): RuntimeStateRecord | undefined {
		const raw = this.#store.loadState(this.#sessionId, key);
		if (raw === undefined) return undefined;
		return stateEnvelope(raw, key);
	}

	#checkpoint(): ApprovalCheckpoint | undefined {
		const raw = this.#store.loadState(this.#sessionId, "node_effect_checkpoint");
		if (raw === undefined) return undefined;
		const state = stateEnvelope(raw, "effect_checkpoint");
		if (state.kind !== "effect_checkpoint") throw new ApprovalNotPendingError();
		return checkpointFromEffect(state.payload);
	}

	#interruptUnknown(checkpoint: ApprovalCheckpoint): Extract<ApprovalContinuationResult, {
		readonly status: "interrupted";
	}> {
		return {
			status: "interrupted",
			turn: this.#store.interruptAmbiguousApproval({
				sessionId: this.#sessionId,
				clientTurnId: checkpoint.clientTurnId,
				callId: checkpoint.callId,
				toolName: checkpoint.toolName,
				errorKind: "effect_outcome_unknown",
				completedAt: this.#clock(),
			}),
		};
	}
}

export class ApprovalPersistenceError extends Error {
	readonly code = "persistence_error" as const;

	constructor(message: string) {
		super(`persistence_error: ${message}`);
		this.name = "ApprovalPersistenceError";
	}
}

function pendingFromInput(
	sessionId: string,
	input: ApprovalSuspensionInput,
): PendingApprovalContinuation {
	const argumentsValue = parseArguments(input.call.argumentsJson);
	if (!argumentsValue) throw new TypeError("approval tool arguments must be an object");
	return Object.freeze({
		sessionId,
		clientTurnId: nonEmpty(input.clientTurnId, "clientTurnId"),
		turnId: nonEmpty(input.turnId, "turnId"),
		decisionId: nonEmpty(input.call.callId, "decisionId"),
		callId: nonEmpty(input.call.callId, "callId"),
		toolName: nonEmpty(input.call.name, "toolName"),
		preview: bounded(input.preview, 512),
		reason: bounded(input.reason, 512),
		options: approvalOptions(input.commandPattern, input.proposedExecPolicyPattern),
		...(input.commandPattern ? { commandPattern: requiredPattern(input.commandPattern, "command") } : {}),
		...(input.proposedExecPolicyPattern ? {
			proposedExecPolicyPattern: requiredPattern(input.proposedExecPolicyPattern, "persistent approval"),
		} : {}),
		providerProtocol: input.providerProtocol,
		userMessage: input.userMessage,
		call: freezeCall(input.call),
		remainingCalls: Object.freeze(input.remainingCalls.map(freezeCall)),
		assistantText: input.assistantText,
		...(input.responseId ? { responseId: input.responseId } : {}),
		usage: Object.freeze({ ...input.usage }),
		...(input.modelOverride ? { modelOverride: bounded(input.modelOverride, 256) } : {}),
		...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
	});
}

function pendingFromStates(
	sessionId: string,
	pending: Extract<RuntimeStateRecord, { kind: "pending_decision" }>,
	suspended: Extract<RuntimeStateRecord, { kind: "suspended_turn" }>,
): PendingApprovalContinuation {
	const payload = suspended.payload;
	if (payload.session_id !== undefined && payload.session_id !== sessionId) {
		throw new ApprovalNotPendingError();
	}
	const call = canonicalCall(pending.payload.tool_call);
	if (payload.pending_approval?.tool_call.call_id !== undefined
		&& payload.pending_approval.tool_call.call_id !== call.callId) {
		throw new ApprovalNotPendingError();
	}
	const continuation = record(payload.continuation);
	const metadata = record(pending.payload.metadata);
	const commandPattern = optionalPattern(metadata.command_pattern_tokens);
	const proposedExecPolicyPattern = optionalPattern(pending.payload.proposed_execpolicy_pattern);
	const suspendedProposal = optionalPattern(
		suspended.payload.pending_approval?.proposed_execpolicy_pattern,
	);
	if (!equalOptionalPatterns(proposedExecPolicyPattern, suspendedProposal)) {
		throw new ApprovalNotPendingError();
	}
	return Object.freeze({
		sessionId,
		clientTurnId: nonEmpty(String(payload.client_turn_id ?? ""), "clientTurnId"),
		turnId: nonEmpty(String(payload.turn_id ?? ""), "turnId"),
		decisionId: call.callId,
		callId: call.callId,
		toolName: call.name,
		preview: bounded(pending.payload.preview, 512),
		reason: bounded(pending.payload.reason, 512),
		options: restoredApprovalOptions(pending.payload.options, commandPattern, proposedExecPolicyPattern),
		...(commandPattern ? { commandPattern } : {}),
		...(proposedExecPolicyPattern ? { proposedExecPolicyPattern } : {}),
		providerProtocol: payload.provider_protocol ?? "responses",
		userMessage: payload.user_message,
		call,
		remainingCalls: Object.freeze((payload.remaining_tool_calls ?? []).map(canonicalStoredCall)),
		assistantText: typeof continuation.assistant_text === "string" ? continuation.assistant_text : "",
		...(typeof continuation.response_id === "string" && continuation.response_id
			? { responseId: continuation.response_id }
			: {}),
		usage: numberRecord(continuation.usage),
		...(typeof continuation.model_override === "string" && continuation.model_override.trim()
			? { modelOverride: bounded(continuation.model_override.trim(), 256) }
			: {}),
		...(reasoningEffort(continuation.reasoning_effort)
			? { reasoningEffort: reasoningEffort(continuation.reasoning_effort) }
			: {}),
	});
}

function pendingDecisionState(
	pending: PendingApprovalContinuation,
): Extract<RuntimeStateRecord, { kind: "pending_decision" }> {
	return {
		kind: "pending_decision",
		version: 1,
		payload: {
			tool_call: storedToolCall(pending.call),
			kind: "needs_choice",
			reason: pending.reason,
			preview: pending.preview,
			options: persistedOptions(pending.options),
			...(pending.commandPattern ? { command_pattern: pending.commandPattern.join(" ") } : {}),
			...(pending.proposedExecPolicyPattern ? {
				proposed_execpolicy_pattern: tuplePattern(pending.proposedExecPolicyPattern),
			} : {}),
			metadata: {
				source: "node_runtime",
				...(pending.commandPattern ? {
					command_pattern_tokens: [...pending.commandPattern],
				} : {}),
			},
		},
	};
}

function suspendedTurnState(
	pending: PendingApprovalContinuation,
	conversation: readonly CanonicalMessage[],
): Extract<RuntimeStateRecord, { kind: "suspended_turn" }> {
	const pendingApproval = {
		tool_call: storedToolCall(pending.call),
		reason: pending.reason,
		preview: pending.preview,
		...(pending.commandPattern ? { command_pattern: pending.commandPattern.join(" ") } : {}),
		...(pending.proposedExecPolicyPattern ? {
			proposed_execpolicy_pattern: tuplePattern(pending.proposedExecPolicyPattern),
		} : {}),
		metadata: {
			source: "node_runtime",
			...(pending.commandPattern ? { command_pattern_tokens: [...pending.commandPattern] } : {}),
		},
	};
	return {
		kind: "suspended_turn",
		version: 1,
		payload: {
			user_message: pending.userMessage,
			conversation: conversation.map((message) => ({ ...message })),
			suspend_reason: "approval_required",
			pending_approval: pendingApproval,
			session_id: pending.sessionId,
			client_turn_id: pending.clientTurnId,
			turn_id: pending.turnId,
			provider_protocol: pending.providerProtocol,
			remaining_tool_calls: pending.remainingCalls.map(storedCanonicalCall),
			continuation: {
				assistant_text: pending.assistantText,
					response_id: pending.responseId ?? null,
					usage: pending.usage,
					model_override: pending.modelOverride ?? null,
					reasoning_effort: pending.reasoningEffort ?? null,
				},
		},
	};
}

function stateEnvelope(raw: unknown, kind: RuntimeStateRecord["kind"]): RuntimeStateRecord {
	const candidate = record(raw);
	return parseRuntimeState(candidate.kind === kind
		? raw
		: { kind, version: 1, payload: raw });
}

function checkpointFromEffect(payload: RuntimeStateRecord extends never ? never : {
	readonly session_id: string;
	readonly client_turn_id: string;
	readonly turn_id: string;
	readonly decision_id: string;
	readonly call_id: string;
	readonly tool_name: string;
	readonly status: ApprovalResolution["status"];
	readonly fingerprint?: string;
	readonly result_call_id?: string;
	readonly updated_at: string;
}): ApprovalCheckpoint {
	const shared = {
		sessionId: payload.session_id,
		clientTurnId: payload.client_turn_id,
		turnId: payload.turn_id,
		decisionId: payload.decision_id,
		callId: payload.call_id,
		toolName: payload.tool_name,
		updatedAt: payload.updated_at,
	};
	if (payload.status === "executing") {
		return { ...shared, status: "executing", fingerprint: nonEmpty(payload.fingerprint ?? "", "fingerprint") };
	}
	if (payload.status === "completed") {
		return {
			...shared,
			status: "completed",
			fingerprint: nonEmpty(payload.fingerprint ?? "", "fingerprint"),
			resultCallId: nonEmpty(payload.result_call_id ?? "", "resultCallId"),
		};
	}
	return { ...shared, status: payload.status };
}

function checkpointFromResolution(checkpoint: ApprovalCheckpoint): ApprovalCheckpoint {
	return Object.freeze(checkpoint);
}

function effectFingerprint(call: CanonicalToolCall): string {
	return `sha256:${createHash("sha256")
		.update(call.name)
		.update("\0")
		.update(call.argumentsJson)
		.digest("hex")}`;
}

function storedToolResult(
	sessionId: string,
	clientTurnId: string,
	result: ToolExecutionResult,
): AppendToolResultInput {
	return {
		sessionId,
		clientTurnId,
		result: {
			callId: result.callId,
			toolName: result.toolName,
			output: result.modelOutput,
			success: result.success,
		},
		summary: result.summary,
		metadata: result.metadata,
		...(result.errorKind ? { errorKind: result.errorKind } : {}),
	};
}

function rejectedResult(call: CanonicalToolCall): ToolExecutionResult {
	return Object.freeze({
		callId: call.callId,
		toolName: call.name,
		success: false,
		modelOutput: `${call.name.slice(0, 128) || "Tool"} denied\nError kind: approval_rejected`,
		summary: `${call.name.slice(0, 128) || "Tool"} rejected`,
		errorKind: "approval_rejected",
		metadata: Object.freeze({}),
	});
}

function storedToolCall(call: CanonicalToolCall) {
	return {
		name: call.name,
		arguments: parseArguments(call.argumentsJson) ?? {},
		reason: "",
		call_id: call.callId,
	};
}

function storedCanonicalCall(call: CanonicalToolCall) {
	return { call_id: call.callId, name: call.name, arguments_json: call.argumentsJson };
}

function canonicalStoredCall(value: Readonly<Record<string, unknown>>): CanonicalToolCall {
	return freezeCall({
		callId: nonEmpty(String(value.call_id ?? ""), "callId"),
		name: nonEmpty(String(value.name ?? ""), "toolName"),
		argumentsJson: nonEmpty(String(value.arguments_json ?? ""), "argumentsJson"),
	});
}

function canonicalCall(call: {
	readonly name: string;
	readonly arguments: Readonly<Record<string, unknown>>;
	readonly call_id: string;
}): CanonicalToolCall {
	return freezeCall({
		callId: call.call_id,
		name: call.name,
		argumentsJson: JSON.stringify(call.arguments),
	});
}

function freezeCall(call: CanonicalToolCall): CanonicalToolCall {
	return Object.freeze({ ...call });
}

function parseArguments(value: string): Readonly<Record<string, unknown>> | undefined {
	try {
		const parsed = JSON.parse(value) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? parsed as Readonly<Record<string, unknown>>
			: undefined;
	} catch {
		return undefined;
	}
}

function numberRecord(value: unknown): ProviderUsage {
	const source = record(value);
	return Object.freeze(Object.fromEntries(Object.entries(source).filter(
		(entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
	)));
}

function record(value: unknown): Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Readonly<Record<string, unknown>>
		: {};
}

function nonEmpty(value: string, name: string): string {
	if (!value.trim()) throw new TypeError(`${name} must be a non-empty string`);
	return value.trim();
}

function bounded(value: string, limit: number): string {
	return value.slice(0, limit);
}

type PersistedApprovalOptions =
	| [ApprovalChoice]
	| [ApprovalChoice, ApprovalChoice]
	| [ApprovalChoice, ApprovalChoice, ApprovalChoice]
	| [ApprovalChoice, ApprovalChoice, ApprovalChoice, ApprovalChoice];

function approvalOptions(
	commandPattern: readonly string[] | undefined,
	proposedExecPolicyPattern: readonly string[] | undefined,
): readonly ApprovalChoice[] {
	return Object.freeze([
		"approve_once" as const,
		"reject" as const,
		...(commandPattern ? ["allow_session" as const] : []),
		...(proposedExecPolicyPattern ? ["always_allow" as const] : []),
	]);
}

function restoredApprovalOptions(
	value: readonly ApprovalChoice[],
	commandPattern: readonly string[] | undefined,
	proposedExecPolicyPattern: readonly string[] | undefined,
): readonly ApprovalChoice[] {
	const available = new Set(approvalOptions(commandPattern, proposedExecPolicyPattern));
	const restored = value.filter((choice): choice is ApprovalChoice => available.has(choice));
	return restored.includes("approve_once") && restored.includes("reject")
		? Object.freeze(restored)
		: approvalOptions(commandPattern, proposedExecPolicyPattern);
}

function persistedOptions(options: readonly ApprovalChoice[]): PersistedApprovalOptions {
	if (options.length < 1 || options.length > 4) throw new TypeError("approval options are invalid");
	return [...options] as PersistedApprovalOptions;
}

function requiredPattern(value: readonly string[] | undefined, label: string): readonly string[] {
	const pattern = optionalPattern(value);
	if (!pattern) throw new ApprovalPersistenceError(`${label} pattern is unavailable.`);
	return pattern;
}

function optionalPattern(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > 16
		|| !value.every((token) => typeof token === "string" && token.trim() && token.length <= 256)
		|| value.reduce((total, token) => total + String(token).length, 0) > 512) return undefined;
	return Object.freeze([...(value as string[])]);
}

function tuplePattern(value: readonly string[]): [string, ...string[]] {
	return [...requiredPattern(value, "exec policy")] as [string, ...string[]];
}

function equalOptionalPatterns(
	left: readonly string[] | undefined,
	right: readonly string[] | undefined,
): boolean {
	if (!left || !right) return left === right;
	return left.length === right.length && left.every((token, index) => token === right[index]);
}

function isApprovingChoice(value: ApprovalChoice): boolean {
	return value === "approve_once" || value === "allow_session" || value === "always_allow";
}

function reasoningEffort(value: unknown): ReasoningEffort | undefined {
	return typeof value === "string"
		&& new Set<ReasoningEffort>(["none", "minimal", "low", "medium", "high", "xhigh"])
			.has(value as ReasoningEffort)
		? value as ReasoningEffort
		: undefined;
}
