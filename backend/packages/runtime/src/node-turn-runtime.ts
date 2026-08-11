import { randomUUID } from "node:crypto";
import type { NodeRuntimeConfig } from "@mycli/config";
import {
	AgentBudgetExhaustedError,
	fingerprintSubmission,
	modelInputSha256,
	projectProviderRequest,
} from "@mycli/core";
import type {
	AgentBudget,
	AgentBudgetExhaustionKind,
	CanonicalConversationItem,
	CanonicalImage,
	CanonicalToolCall,
	HookRunnerContract,
	InstructionSnapshot,
	ProviderRequest,
	ProviderRequestConfig,
	ProviderReplayState,
	ProviderUsage,
	ReasoningEffort,
	RuntimeErrorCode,
	RuntimeEvent,
	ShellLifecycleEvent,
	ToolDefinition,
} from "@mycli/core";
import {
	ProviderFailure,
} from "@mycli/providers";
import type { ModelProvider } from "@mycli/providers";
import type {
	ApprovalPolicyDecision,
	ExecutionPolicy,
	PermissionProfile,
	ToolExecutionResult,
	ToolRouterContract,
} from "@mycli/tools";
import {
	StorageFailure,
} from "@mycli/storage";
import type {
	AgentRuntimeCheckpoint,
	AppendContextItemInput,
	ModelInputLedgerStore,
	TurnReservation,
	TurnStore,
} from "@mycli/storage";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import {
	decideRetry,
	sleepWithSignal,
} from "./retry-policy.ts";
import type { QueueCoordinator } from "./queue-coordinator.ts";
import type {
	ApprovalChoice,
	ApprovalSuspensionInput,
	PendingApprovalContinuation,
} from "./approval-continuation-coordinator.ts";
import { ApprovalNotPendingError } from "./approval-continuation-coordinator.ts";
import type {
	ClarificationOption,
	ClarificationSuspensionInput,
	PendingClarificationContinuation,
} from "./clarification-continuation-coordinator.ts";
import { ClarificationNotPendingError } from "./clarification-continuation-coordinator.ts";
import type {
	CompactInput,
	CompactionResult,
} from "./compaction-coordinator.ts";
import type { MemoryContextServiceContract } from "./memory-context-service.ts";
import type {
	ExecutionPolicyConfiguration,
	ExecutionPolicySnapshot,
	TurnExecutionPolicy,
} from "./execution-policy-coordinator.ts";
import {
	buildProviderRequestSignature,
	type ContinuationDecision,
	type SafeProviderCompletionInput,
} from "./provider-continuation.ts";
import { HookCoordinator } from "./hook-coordinator.ts";
import { HookContextAccumulator } from "./hook-context-accumulator.ts";
import type { ContextItemCoordinatorContract } from "./context-item-coordinator.ts";
import type {
	RuntimeHookContext,
	TurnContextSources,
} from "./instruction-context.ts";
import { commitRuntimeProviderStep } from "./model-input-pipeline.ts";
import type { TokenCounter } from "./token-counter.ts";

export interface TurnSubmission {
	readonly clientTurnId: string;
	readonly clientUserMessageId?: string;
	readonly turnId?: string;
	readonly message: string;
	readonly localImages?: readonly string[];
	readonly modelOverride?: string;
	readonly reasoningEffort?: ReasoningEffort;
	readonly source?: "user" | "agent_mailbox";
}

export interface NodeTurnRuntimeOptions {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly instructions: string;
	readonly developerInstructions?: readonly string[];
	readonly resolveInstructionSnapshot?: () => InstructionSnapshot;
	readonly modelInputLedger?: ModelInputLedgerStore;
	readonly modelInputTokenCounter?: TokenCounter;
	readonly contextSources?: (input: RuntimeContextSourceInput) => TurnContextSources;
	readonly createModelInputId?: (
		kind: "tools" | "context" | "request" | "lifecycle",
	) => string;
	readonly agentBudget?: AgentBudget;
	readonly store: TurnStore;
	readonly resolveConfig: (
		submission: TurnSubmission,
	) => NodeRuntimeConfig | Promise<NodeRuntimeConfig>;
	readonly createProvider: (config: NodeRuntimeConfig) => ModelProvider;
	readonly loadLocalImages: (paths: readonly string[]) => readonly CanonicalImage[];
	readonly createTurnId: () => string;
	readonly clock: () => string;
	readonly maxOutputTokens?: number;
	readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
	readonly random?: () => number;
	readonly monotonicClock?: () => number;
	readonly planTools?: (capabilities: { readonly shell: boolean }) => readonly ToolDefinition[];
	readonly deferredTools?: readonly ToolDefinition[];
	readonly loadToolActivations?: (turnId: string) => readonly string[];
	readonly executionPolicyCoordinator?: ExecutionPolicyCoordinatorContract;
	readonly toolRouter?: ToolRouterContract;
	readonly approvalPolicy?: ApprovalPolicyContract;
	readonly approvalCoordinator?: ApprovalContinuationContract;
	readonly clarificationCoordinator?: ClarificationContinuationContract;
	readonly queueCoordinator?: QueueCoordinator;
	readonly compactionCoordinator?: CompactionCoordinatorContract;
	readonly createCompactionCoordinator?: (
		config: NodeRuntimeConfig,
	) => CompactionCoordinatorContract;
	readonly memoryContextService?: MemoryContextServiceContract;
	readonly providerContinuation?: ProviderContinuationContract;
	readonly hookRunner?: HookRunnerContract;
	readonly contextItemCoordinator?: ContextItemCoordinatorContract;
	readonly agentCheckpoint?: (checkpoint: AgentRuntimeCheckpoint) => void;
	readonly isMutatingTool?: (toolName: string) => boolean;
	readonly writeTerminalSnapshot?: (turn: RuntimeTurnRecord) => Promise<void>;
	readonly publishLifecycle: (event: ShellLifecycleEvent) => void;
}

export interface RuntimeContextSourceInput {
	readonly submission: TurnSubmission;
	readonly config: NodeRuntimeConfig;
	readonly tools: readonly ToolDefinition[];
	readonly executionPolicy?: ExecutionPolicy;
	readonly hooks: readonly RuntimeHookContext[];
	readonly memory?: readonly string[];
}

export interface CompactionCoordinatorContract {
	compact(input: CompactInput): Promise<CompactionResult>;
}

export interface ApprovalPolicyContract {
	evaluate(
		call: CanonicalToolCall,
		executionPolicy?: ExecutionPolicy,
	): ApprovalPolicyDecision | Promise<ApprovalPolicyDecision>;
	configurePermissionProfile?(profile: PermissionProfile): void;
}

export interface ApprovalContinuationContract {
	suspend(input: ApprovalSuspensionInput): PendingApprovalContinuation;
	pending(): PendingApprovalContinuation | undefined;
	resolve(input: {
		readonly decisionId: string;
		readonly choice: ApprovalChoice;
		readonly signal: AbortSignal;
		readonly onExecutionStart?: () => void;
		readonly executionPolicy?: ExecutionPolicy;
	}): Promise<ApprovalRuntimeResolution>;
	finish(decisionId: string): void;
	recover?(): RuntimeTurnRecord | undefined;
}

export interface ClarificationContinuationContract {
	suspend(input: ClarificationSuspensionInput): PendingClarificationContinuation;
	pending(): PendingClarificationContinuation | undefined;
	resolve(input: {
		readonly requestId: string;
		readonly response: string;
	}): {
		readonly continuation: PendingClarificationContinuation;
		readonly response: string;
	};
}

export interface ExecutionPolicyCoordinatorContract {
	configure(input: ExecutionPolicyConfiguration): void;
	snapshot(): ExecutionPolicySnapshot;
	beginTurn(turnId: string): TurnExecutionPolicy;
	finishTurn(turnId: string): void;
}

export interface ProviderContinuationContract {
	select(input: {
		readonly protocol: ProviderRequestConfig["protocol"];
		readonly requestSignature: string;
		readonly requestInput: readonly Readonly<Record<string, unknown>>[];
		readonly model: string;
		readonly historyBoundary: string;
	}): ContinuationDecision;
	recordSafeCompletion(input: SafeProviderCompletionInput): void;
	invalidate(reason: string): void;
}

export type ApprovalRuntimeResolution =
	| {
		readonly status: "completed" | "rejected";
		readonly continuation?: PendingApprovalContinuation;
		readonly toolResult?: ToolExecutionResult;
	}
	| {
		readonly status: "interrupted";
		readonly turn: RuntimeTurnRecord;
	};

export interface ResolveApprovalInput {
	readonly decisionId: string;
	readonly choice: ApprovalChoice;
}

export interface ResolveClarificationInput {
	readonly requestId: string;
	readonly response: string;
}

export interface SubmitTurnOptions {
	readonly signal: AbortSignal;
	readonly reservation?: TurnReservation;
}

export interface ForceInterruptInput {
	readonly clientTurnId: string;
	readonly turnId: string;
}

interface NormalizedFailure {
	readonly code: RuntimeErrorCode;
	readonly message: string;
	readonly retryable: boolean;
	readonly retryAfterSeconds?: number;
	readonly diagnostics?: Readonly<Record<string, string | number | boolean | null>>;
}

interface ProviderStepResult {
	readonly assistantText: string;
	readonly usage: ProviderUsage;
	readonly responseId?: string;
	readonly toolCalls: readonly CanonicalToolCall[];
	readonly providerState?: ProviderReplayState;
}

interface TurnExecutionContext {
	readonly submission: TurnSubmission;
	readonly turnId: string;
	readonly config: NodeRuntimeConfig;
	readonly provider: ModelProvider;
	readonly instructions: string;
	readonly instructionSnapshot: InstructionSnapshot;
	readonly tools: readonly ToolDefinition[];
	readonly executionPolicy?: ExecutionPolicy;
	readonly requestConfig: ProviderRequestConfig;
	readonly emit: (event: RuntimeEvent) => void;
	readonly signal: AbortSignal;
	readonly compactionCoordinator?: CompactionCoordinatorContract;
	readonly hookCoordinator?: HookCoordinator;
	readonly hookContexts: HookContextAccumulator;
}

interface PendingToolBatch {
	readonly calls: readonly CanonicalToolCall[];
	readonly assistantText: string;
	readonly responseId?: string;
}

interface ProviderLoopState {
	readonly history: readonly CanonicalConversationItem[];
	readonly freshItemIds: ReadonlySet<string>;
	readonly previousResponseId?: string;
	readonly accumulatedUsage: ProviderUsage;
	readonly pendingBatch?: PendingToolBatch;
	readonly approvalDecisionId?: string;
	readonly preTurnCompactionChecked?: boolean;
	readonly compactionEntered?: boolean;
}

interface PreparedTurn {
	readonly context: TurnExecutionContext;
	readonly initial: ProviderLoopState;
}

interface ActiveToolExecution {
	readonly turnId: string;
	readonly callId: string;
	readonly toolName: string;
	readonly startedAt: number;
	readonly interruptErrorKind: "tool_interrupted" | "effect_outcome_unknown";
	terminalEmitted: boolean;
}

interface AgentBudgetState {
	readonly budget: AgentBudget;
	readonly startedAt: number;
	providerSteps: number;
	toolCalls: number;
	tokens: number;
	noProgressTurns: number;
	exhausted?: AgentBudgetExhaustionKind;
}

export class NodeTurnRuntime {
	readonly #options: NodeTurnRuntimeOptions;
	readonly #fallbackInstructionSnapshot: InstructionSnapshot;
	readonly #agentBudget: AgentBudgetState;
	#collaborationMode = "default";
	#executionPolicyConfiguration: ExecutionPolicyConfiguration | undefined;
	readonly queueCoordinator: QueueCoordinator | undefined;
	readonly #activeToolExecutions = new Map<string, ActiveToolExecution>();

	constructor(options: NodeTurnRuntimeOptions) {
		this.#options = options;
		const instructionHash = modelInputSha256(options.instructions);
		this.#fallbackInstructionSnapshot = Object.freeze({
			snapshotId: `instructions:${modelInputSha256({
				session_id: options.sessionId,
				content_sha256: instructionHash,
			})}`,
			version: "runtime-options-v1",
			source: "runtime-options",
			content: options.instructions,
			contentSha256: instructionHash,
			createdAt: options.clock(),
		});
		const budget = validatedAgentBudget(options.agentBudget);
		this.#agentBudget = {
			budget,
			startedAt: budget.wallClockMs === undefined
				? 0
				: options.monotonicClock?.() ?? performance.now(),
			providerSteps: 0,
			toolCalls: 0,
			tokens: 0,
			noProgressTurns: 0,
		};
		this.queueCoordinator = options.queueCoordinator;
	}

	agentBudgetExhaustion(): AgentBudgetExhaustionKind | undefined {
		return this.#agentBudget.exhausted;
	}

	configureExecutionPolicy(input: ExecutionPolicyConfiguration): void {
		this.#executionPolicyConfiguration = Object.freeze({ ...input });
		this.#options.executionPolicyCoordinator?.configure(input);
		this.#options.approvalPolicy?.configurePermissionProfile?.(input.permission);
	}

	configureRuntimeContext(input: { readonly collaborationMode: string }): void {
		const mode = input.collaborationMode.trim();
		if (!mode || mode.length > 64) throw new TypeError("collaboration mode is invalid");
		this.#collaborationMode = mode;
	}

	executionPolicySnapshot(): ExecutionPolicySnapshot | undefined {
		return this.#options.executionPolicyCoordinator?.snapshot();
	}

	reserve(submission: TurnSubmission): TurnReservation {
		const turnId = submission.turnId ?? this.#options.createTurnId();
		const imagePaths = submission.localImages ?? [];
		const images = imagePaths.length > 0
			? this.#options.loadLocalImages(imagePaths)
			: [];
		return this.#options.store.reserveTurn({
			sessionId: this.#options.sessionId,
			clientTurnId: submission.clientTurnId,
			clientUserMessageId: submission.clientUserMessageId ?? submission.clientTurnId,
			turnId,
			requestFingerprint: fingerprintSubmission({
				message: submission.message,
				localImages: submission.localImages,
				modelOverride: submission.modelOverride,
				reasoningEffort: submission.reasoningEffort,
			}),
			workspaceRoot: this.#options.workspaceRoot,
			threadId: this.#options.threadId,
			userText: submission.message,
			...(imagePaths.length > 0 ? { imagePaths, images } : {}),
			...(submission.source ? { source: submission.source } : {}),
			startedAt: this.#options.clock(),
		});
	}

	async submit(
		submission: TurnSubmission,
		emit: (event: RuntimeEvent) => void,
		options: SubmitTurnOptions,
	): Promise<RuntimeTurnRecord> {
		const reservation = options.reservation ?? this.reserve(submission);
		if (reservation.kind === "existing") {
			return reservation.turn;
		}
		const turnId = reservation.turn.turn_id;
		emit({
			type: "turn_started",
			clientTurnId: submission.clientTurnId,
			turnId,
		});

		let retainPolicy = false;
		try {
			let prepared: PreparedTurn;
			try {
				prepared = await this.#prepareTurn(submission, turnId, emit, options.signal);
			} catch (error) {
				return await this.#finalizeFailure(
					submission,
					normalizeFailure(error, options.signal, "config_error"),
					emit,
				);
			}
			if ((submission.localImages?.length ?? 0) > 0 && !prepared.context.config.supportsImages) {
				return await this.#finalizeFailure(submission, unsupportedImageFailure(), emit);
			}

			const result = await this.#runProviderLoop(prepared.context, prepared.initial);
			retainPolicy = result.status === "in_progress";
			return result;
		} finally {
			if (!retainPolicy) this.#options.executionPolicyCoordinator?.finishTurn(turnId);
		}
	}

	async forceInterrupt(
		input: ForceInterruptInput,
		emit: (event: RuntimeEvent) => void,
	): Promise<RuntimeTurnRecord> {
		const current = this.#options.store.loadTurn(this.#options.sessionId, input.clientTurnId);
		if (!current || current.turn_id !== input.turnId) {
			throw new StorageFailure("active turn does not match interrupt request");
		}
		if (current.status !== "in_progress") return current;

		const approvalCoordinator = this.#options.approvalCoordinator;
		let interrupted = approvalCoordinator?.recover?.();
		if (interrupted && (
			interrupted.client_turn_id !== input.clientTurnId
			|| interrupted.turn_id !== input.turnId
		)) {
			throw new StorageFailure("approval interruption returned a different turn");
		}
		if (!interrupted) {
			const pendingApproval = approvalCoordinator?.pending();
			if (pendingApproval?.clientTurnId === input.clientTurnId
				&& pendingApproval.turnId === input.turnId) {
				try {
					approvalCoordinator?.finish(pendingApproval.decisionId);
				} catch {
					// Executing approval effects are handled by recover(); other transient
					// checkpoints remain storage-fenced by the interrupted turn below.
				}
			}
		}
		interrupted ??= this.#options.store.failTurn({
			sessionId: this.#options.sessionId,
			clientTurnId: input.clientTurnId,
			code: "interrupted",
			message: "turn interrupted",
			completedAt: this.#options.clock(),
		});
		this.#interruptActiveTool(input.turnId, emit);
		await this.#writeTerminalSnapshot(interrupted);
		this.#options.executionPolicyCoordinator?.finishTurn(input.turnId);
		emit({ type: "turn_interrupted", message: "turn interrupted" });
		return interrupted;
	}

	async resolveApproval(
		input: ResolveApprovalInput,
		emit: (event: RuntimeEvent) => void,
		options: Pick<SubmitTurnOptions, "signal">,
	): Promise<RuntimeTurnRecord> {
		const coordinator = this.#options.approvalCoordinator;
		const pending = coordinator?.pending();
		if (!coordinator || !pending) throw new ApprovalNotPendingError();
		const submission: TurnSubmission = {
			clientTurnId: pending.clientTurnId,
			clientUserMessageId: pending.clientUserMessageId,
			turnId: pending.turnId,
			message: pending.userMessage,
			...(pending.modelOverride ? { modelOverride: pending.modelOverride } : {}),
			...(pending.reasoningEffort ? { reasoningEffort: pending.reasoningEffort } : {}),
		};
		const context = await this.#executionContext(
			submission,
			pending.turnId,
			emit,
			options.signal,
			pending.providerProtocol,
		);
		let activeTool: ActiveToolExecution | undefined;
		const resolution = await coordinator.resolve({
			...input,
			signal: options.signal,
			onExecutionStart: () => {
				activeTool = this.#beginToolExecution(
					pending.turnId,
					pending.callId,
					pending.toolName,
					"effect_outcome_unknown",
					emit,
				);
			},
			...(context.executionPolicy ? { executionPolicy: context.executionPolicy } : {}),
		});
		if (resolution.status === "interrupted") {
			if (activeTool) this.#interruptToolExecution(activeTool, emit);
			await this.#writeTerminalSnapshot(resolution.turn);
			emit({ type: "turn_interrupted", message: "turn interrupted" });
			this.#options.executionPolicyCoordinator?.finishTurn(pending.turnId);
			return resolution.turn;
		}
		if (!resolution.continuation) {
			const existing = this.#options.store.loadTurn(
				this.#options.sessionId,
				pending.clientTurnId,
			);
			if (existing && existing.status !== "in_progress") {
				this.#options.executionPolicyCoordinator?.finishTurn(pending.turnId);
				return existing;
			}
			throw new ApprovalNotPendingError();
		}
		if (resolution.toolResult) {
			if (activeTool) this.#completeToolExecution(activeTool, resolution.toolResult, emit);
			else emitToolResult(resolution.toolResult, 0, emit);
		}
		const continuation = resolution.continuation;
		const resumed = await this.#runProviderLoop(context, {
			history: this.#options.store.loadConversationItems(this.#options.sessionId),
			freshItemIds: new Set([
					`${pending.turnId}:user:${pending.clientUserMessageId}`,
			]),
			...(continuation.responseId ? { previousResponseId: continuation.responseId } : {}),
			accumulatedUsage: continuation.usage,
			approvalDecisionId: continuation.decisionId,
			preTurnCompactionChecked: true,
			...(continuation.remainingCalls.length > 0 ? {
				pendingBatch: {
					calls: continuation.remainingCalls,
					assistantText: continuation.assistantText,
					...(continuation.responseId ? { responseId: continuation.responseId } : {}),
				},
			} : {}),
		});
		if (resumed.status !== "in_progress") {
			this.#options.executionPolicyCoordinator?.finishTurn(pending.turnId);
		}
		return resumed;
	}

	async resolveClarification(
		input: ResolveClarificationInput,
		emit: (event: RuntimeEvent) => void,
		options: Pick<SubmitTurnOptions, "signal">,
	): Promise<RuntimeTurnRecord> {
		const coordinator = this.#options.clarificationCoordinator;
		const pending = coordinator?.pending();
		if (!coordinator || !pending) throw new ClarificationNotPendingError();
		const submission: TurnSubmission = {
			clientTurnId: pending.clientTurnId,
			clientUserMessageId: pending.clientUserMessageId,
			turnId: pending.turnId,
			message: pending.userMessage,
			...(pending.modelOverride ? { modelOverride: pending.modelOverride } : {}),
			...(pending.reasoningEffort ? { reasoningEffort: pending.reasoningEffort } : {}),
		};
		const context = await this.#executionContext(
			submission,
			pending.turnId,
			emit,
			options.signal,
			pending.providerProtocol,
		);
		const resolution = coordinator.resolve(input);
		const continuation = resolution.continuation;
		const resumed = await this.#runProviderLoop(context, {
			history: this.#options.store.loadConversationItems(this.#options.sessionId),
			freshItemIds: new Set([
				`${pending.turnId}:user:${pending.clientUserMessageId}`,
			]),
			...(continuation.responseId ? { previousResponseId: continuation.responseId } : {}),
			accumulatedUsage: continuation.usage,
			preTurnCompactionChecked: true,
			...(continuation.remainingCalls.length > 0 ? {
				pendingBatch: {
					calls: continuation.remainingCalls,
					assistantText: continuation.assistantText,
					...(continuation.responseId ? { responseId: continuation.responseId } : {}),
				},
			} : {}),
		});
		if (resumed.status !== "in_progress") {
			this.#options.executionPolicyCoordinator?.finishTurn(pending.turnId);
		}
		return resumed;
	}

	async #prepareTurn(
		submission: TurnSubmission,
		turnId: string,
		emit: (event: RuntimeEvent) => void,
		signal: AbortSignal,
	): Promise<PreparedTurn> {
		const context = await this.#executionContext(submission, turnId, emit, signal);
		if (submission.source !== "agent_mailbox") {
			const hookResult = await context.hookCoordinator?.runPoint("user_prompt_submit", {
				prompt: submission.message,
				promptChars: submission.message.length,
			}, signal);
			if (hookResult) {
				context.hookContexts.append({
					point: "user_prompt_submit",
					contexts: hookResult.contexts,
				});
			}
		}
		const history = submission.source === "agent_mailbox"
			? this.#options.store.loadConversationItems(this.#options.sessionId)
			: this.#conversationForCurrentSubmission(submission.message);
		return Object.freeze({
			context,
			initial: Object.freeze({
				history,
				freshItemIds: submission.source === "agent_mailbox"
					? new Set<string>()
					: new Set([
						`${turnId}:user:${submission.clientUserMessageId ?? submission.clientTurnId}`,
					]),
				accumulatedUsage: {},
			}),
		});
	}

	async #executionContext(
		submission: TurnSubmission,
		turnId: string,
		emit: (event: RuntimeEvent) => void,
		signal: AbortSignal,
		expectedProtocol?: NodeRuntimeConfig["protocol"],
	): Promise<TurnExecutionContext> {
		assertNotAborted(signal);
		const turnPolicy = this.#options.executionPolicyCoordinator?.beginTurn(turnId);
		const config = await this.#options.resolveConfig(submission);
		const instructionSnapshot = this.#options.resolveInstructionSnapshot?.()
			?? this.#fallbackInstructionSnapshot;
		const instructions = instructionSnapshot.content;
		const plannedTools = this.#options.planTools?.({ shell: turnPolicy?.toolsEnabled ?? false }) ?? [];
		const tools = this.#toolExposureForTurn(plannedTools, turnId);
		if (config.sessionId !== this.#options.sessionId) {
			throw configFailure("resolved session does not match runtime session");
		}
		if (expectedProtocol && config.protocol !== expectedProtocol) {
			throw configFailure("resolved provider protocol does not match suspended turn");
		}
		return {
			submission,
			turnId,
			config,
			provider: this.#options.createProvider(config),
			instructions,
			instructionSnapshot,
			hookContexts: new HookContextAccumulator(),
			tools,
			...(turnPolicy ? { executionPolicy: turnPolicy.profile } : {}),
			requestConfig: {
				provider: config.provider,
				protocol: config.protocol,
				model: submission.modelOverride ?? config.model,
				reasoningEffort: submission.reasoningEffort
					?? (config.thinkingEnabled ? config.reasoningEffort : "none"),
				...(config.promptCacheKeyEnabled
					? { promptCacheKey: this.#options.sessionId }
					: {}),
				...(config.cacheControlEnabled ? { cacheControlEnabled: true } : {}),
				...(this.#options.maxOutputTokens === undefined
					? {}
					: { maxOutputTokens: this.#options.maxOutputTokens }),
			},
			emit,
			signal,
			...(this.#options.hookRunner ? {
				hookCoordinator: new HookCoordinator({
					runner: this.#options.hookRunner,
					sessionId: this.#options.sessionId,
					turnId,
				}),
			} : {}),
			...(this.#options.createCompactionCoordinator
				? { compactionCoordinator: this.#options.createCompactionCoordinator(config) }
				: this.#options.compactionCoordinator
					? { compactionCoordinator: this.#options.compactionCoordinator }
					: {}),
		};
	}

	async #runProviderLoop(
		context: TurnExecutionContext,
		initial: ProviderLoopState,
	): Promise<RuntimeTurnRecord> {
		const {
			submission,
			turnId,
			config,
			provider,
			instructions,
			tools: initialTools,
			requestConfig,
			emit,
			signal,
		} = context;
		let tools = initialTools;
		let history = initial.history;
		let previousResponseId = initial.previousResponseId;
		let accumulatedUsage = initial.accumulatedUsage;
		let pendingBatch = initial.pendingBatch;
		let approvalDecisionId = initial.approvalDecisionId;
		const freshItemIds = new Set(initial.freshItemIds);
		let preTurnCompactionChecked = initial.preTurnCompactionChecked ?? false;
		let compactionEntered = initial.compactionEntered ?? false;
		let memoryCollected = false;
		let memoryItem: Extract<CanonicalConversationItem, { readonly type: "user" }> | undefined;
		while (true) {
			const wallClockExhausted = this.#wallClockExhausted();
			if (wallClockExhausted) {
				return this.#finalizeAgentBudget(context, wallClockExhausted);
			}
			if (approvalDecisionId) {
				this.#options.approvalCoordinator?.finish(approvalDecisionId);
				approvalDecisionId = undefined;
			}
			if (pendingBatch) {
				try {
					const suspended = await this.#processToolBatch(
						context,
						pendingBatch,
						accumulatedUsage,
					);
					if (suspended) return suspended;
					history = this.#options.store.loadConversationItems(this.#options.sessionId);
					pendingBatch = undefined;
					assertNotAborted(signal);
					const refreshedTools = this.#toolExposureForTurn(tools, turnId);
					if (!sameToolExposure(tools, refreshedTools)) {
						const invalidation = this.#invalidateProviderContinuation("tool_exposure_changed");
						if (invalidation) return this.#finalizeFailure(submission, invalidation, emit);
						tools = refreshedTools;
						previousResponseId = undefined;
					}
				} catch (error) {
					return this.#finalizeFailure(
						submission,
						normalizeFailure(error, signal, "persistence_error"),
						emit,
					);
				}
			}
			try {
				assertNotAborted(signal);
					const committed = this.queueCoordinator?.commitPending(turnId) ?? [];
					if (committed.length > 0) {
						if (!config.supportsImages
							&& committed.some((record) => record.imagePaths.length > 0)) {
							return await this.#finalizeFailure(
								submission,
								unsupportedImageFailure(),
								emit,
							);
						}
					for (const record of committed) {
						freshItemIds.add(`${turnId}:queue:${record.queueId}`);
						if (record.source !== "task_notification" && record.source !== "agent_mailbox") {
							const lifecycle = {
								clientTurnId: submission.clientTurnId,
								turnId,
								itemId: `${turnId}:queue:${record.queueId}`,
								clientUserMessageId: record.clientTurnId,
								content: record.text,
								source: "steer" as const,
							};
							emit({ type: "user_message_started", ...lifecycle });
							emit({ type: "user_message_completed", ...lifecycle });
						}
					}
					history = this.#options.store.loadConversationItems(this.#options.sessionId);
				}
				assertNotAborted(signal);
			} catch (error) {
				return this.#finalizeFailure(
					submission,
					normalizeFailure(error, signal, "persistence_error"),
					emit,
				);
			}
			if (!preTurnCompactionChecked && context.compactionCoordinator) {
				preTurnCompactionChecked = true;
				let compacted: CompactionResult;
				try {
					compacted = await this.#compactContext(
						context,
						"pre_turn",
						history,
						freshItemIds,
					);
				} catch (error) {
					return this.#finalizeFailure(
						submission,
						normalizeFailure(error, signal, "persistence_error"),
						emit,
					);
				}
				compactionEntered = compacted.status !== "not_needed";
				if (compacted.status !== "not_needed") {
					const invalidation = this.#invalidateProviderContinuation("compacted_history");
					if (invalidation) return this.#finalizeFailure(submission, invalidation, emit);
				}
				if (compacted.status === "interrupted") {
					return this.#finalizeFailure(submission, {
						code: "interrupted",
						message: "turn interrupted",
						retryable: false,
					}, emit);
				}
				if (compacted.status === "compressed") {
					history = compacted.providerConversation;
					previousResponseId = undefined;
				}
			}
			if (!memoryCollected) {
				memoryCollected = true;
				memoryItem = await this.#collectMemoryItem(context);
			}
			const providerBudgetExhausted = this.#beginProviderStep();
			if (providerBudgetExhausted) {
				return this.#finalizeAgentBudget(context, providerBudgetExhausted);
			}
			let requestSignature: string;
			let durableRequestId: string | undefined;
			let durableProviderStep: number | undefined;
			let logicalRequest: ProviderRequest;
			if (this.#options.modelInputLedger) {
				try {
					const hookContexts = context.hookContexts.snapshot();
					const collectedSources = this.#options.contextSources?.({
						submission,
						config,
						tools,
						...(context.executionPolicy ? { executionPolicy: context.executionPolicy } : {}),
						hooks: hookContexts,
						...(memoryItem ? { memory: [memoryItem.text] } : {}),
					}) ?? {};
					const providerStep = this.#nextDurableProviderStep(turnId);
					const committed = commitRuntimeProviderStep({
						sessionId: this.#options.sessionId,
						turnId,
						providerStep,
						requestConfig,
						instructionSnapshot: context.instructionSnapshot,
						tools,
						history,
						currentUserRequest: currentUserRequest(context, history),
						sources: mergeRuntimeContextSources({
							collected: collectedSources,
							hooks: hookContexts,
							memory: memoryItem ? [memoryItem.text] : [],
							developerInstructions: this.#options.developerInstructions ?? [],
							collaborationMode: this.#collaborationMode,
							executionPolicy: context.executionPolicy,
							executionPolicyConfiguration: this.#executionPolicyConfiguration,
						}),
						ledger: this.#options.modelInputLedger,
						maxPromptTokens: config.maxPromptTokens,
						clock: this.#options.clock,
						...(this.#options.createModelInputId
							? { createId: this.#options.createModelInputId }
							: {}),
						...(this.#options.modelInputTokenCounter
							? { tokenCounter: this.#options.modelInputTokenCounter }
							: {}),
					});
					requestSignature = committed.requestSignature;
					durableRequestId = committed.manifest.requestId;
					durableProviderStep = committed.manifest.providerStep;
					logicalRequest = committed.request;
				} catch (error) {
					return this.#finalizeFailure(
						submission,
						normalizeFailure(error, signal, "persistence_error"),
						emit,
					);
				}
			} else {
				const providerHistory = memoryItem
					? insertMemoryBeforeCurrentInput(history, memoryItem, context.submission.message)
					: history;
				requestSignature = buildProviderRequestSignature({
					...requestConfig,
					instructions,
					...(this.#options.developerInstructions
						? { developerInstructions: this.#options.developerInstructions }
						: {}),
					tools,
				});
				logicalRequest = projectProviderRequest({
					config: requestConfig,
					instructions,
					...(this.#options.developerInstructions
						? { developerInstructions: this.#options.developerInstructions }
						: {}),
					history: providerHistory,
					tools,
				});
			}
			const logicalRequestInput = (logicalRequest.items ?? history).map(continuationRecord);
			const continuation = this.#selectProviderContinuation(
				requestConfig,
				requestSignature,
				turnId,
				previousResponseId,
				logicalRequestInput,
			);
			const request = continuation
				? Object.freeze({ ...logicalRequest, previousResponseId: continuation })
				: logicalRequest;
			try {
				this.#options.agentCheckpoint?.({
					kind: "provider_turn",
					committed: false,
					turnId,
				});
				if (durableRequestId) {
					this.#appendProviderStepLifecycle(durableRequestId, "dispatch_started", {
						provider_step: durableProviderStep ?? this.#agentBudget.providerSteps,
						continuation: continuation !== undefined,
					});
				}
			} catch (error) {
				return this.#finalizeFailure(
					submission,
					normalizeFailure(error, signal, "persistence_error"),
					emit,
				);
			}
			const stepResult = await this.#streamWithRetry(
				provider,
				request,
				config.streamMaxRetries,
				emit,
				signal,
				Boolean(this.#options.toolRouter),
			);
			if ("failure" in stepResult) {
				if (durableRequestId) {
					try {
						this.#appendProviderStepLifecycle(durableRequestId, "failed", {
							code: stepResult.failure.code,
							retryable: stepResult.failure.retryable,
							events_observed: stepResult.eventsObserved,
						});
					} catch (error) {
						return this.#finalizeFailure(
							submission,
							normalizeFailure(error, signal, "persistence_error"),
							emit,
						);
					}
				}
				const invalidation = this.#invalidateProviderContinuation("provider_rejected");
				if (invalidation) return this.#finalizeFailure(submission, invalidation, emit);
				if (
					stepResult.failure.code === "context_window_exceeded"
					&& stepResult.eventsObserved === 0
					&& !compactionEntered
					&& context.compactionCoordinator
				) {
					let compacted: CompactionResult;
					try {
						compacted = await this.#compactContext(
							context,
							"context_overflow",
							history,
							freshItemIds,
						);
					} catch (error) {
						return this.#finalizeFailure(
							submission,
							normalizeFailure(error, signal, "persistence_error"),
							emit,
						);
					}
					compactionEntered = true;
					const compactionInvalidation = this.#invalidateProviderContinuation(
						"compacted_history",
					);
					if (compactionInvalidation) {
						return this.#finalizeFailure(submission, compactionInvalidation, emit);
					}
					if (compacted.status === "interrupted") {
						return this.#finalizeFailure(submission, {
							code: "interrupted",
							message: "turn interrupted",
							retryable: false,
						}, emit);
					}
					if (compacted.status === "compressed") {
						history = compacted.providerConversation;
						previousResponseId = undefined;
						continue;
					}
				}
				return this.#finalizeFailure(submission, stepResult.failure, emit);
			}
			if (durableRequestId) {
				try {
					this.#appendProviderStepLifecycle(durableRequestId, "acknowledged", {
						tool_call_count: stepResult.toolCalls.length,
						response_id_present: stepResult.responseId !== undefined,
					});
				} catch (error) {
					return this.#finalizeFailure(
						submission,
						normalizeFailure(error, signal, "persistence_error"),
						emit,
					);
				}
			}
			const continuationFailure = this.#recordSafeProviderCompletion({
				requestConfig,
				requestSignature,
				historyBoundary: turnId,
				requestInput: logicalRequest.items ?? history,
				stepResult,
			});
			if (continuationFailure) {
				return this.#finalizeFailure(submission, continuationFailure, emit);
			}
			accumulatedUsage = addUsage(accumulatedUsage, stepResult.usage);
			this.#agentBudget.tokens = usageTokenTotal(accumulatedUsage);
			if (stepResult.toolCalls.length > 0
				&& this.#agentBudget.budget.maxTokens !== undefined
				&& this.#agentBudget.tokens >= this.#agentBudget.budget.maxTokens) {
				return this.#finalizeAgentBudget(context, "max_tokens");
			}

			if (stepResult.toolCalls.length === 0) {
				if (!stepResult.assistantText.trim()
					&& this.#agentBudget.budget.noProgressTurnLimit !== undefined) {
					this.#agentBudget.noProgressTurns += 1;
					if (this.#agentBudget.noProgressTurns
						>= this.#agentBudget.budget.noProgressTurnLimit) {
						return this.#finalizeAgentBudget(context, "no_progress");
					}
					previousResponseId = stepResult.responseId;
					continue;
				}
				this.#agentBudget.noProgressTurns = 0;
				return this.#finalizePreparedTurn(context, stepResult, accumulatedUsage);
			}
			this.#agentBudget.noProgressTurns = 0;
			if (!hasUniqueCallIds(stepResult.toolCalls)) {
				return this.#finalizeFailure(submission, toolProtocolFailure(), emit);
			}

			if (config.protocol === "responses" && !stepResult.responseId) {
				return this.#finalizeFailure(submission, toolProtocolFailure(), emit);
			}
			const exposedToolNames = new Set(tools.map((tool) => tool.name));
			if (stepResult.toolCalls.some((call) => !exposedToolNames.has(call.name))) {
				return this.#finalizeFailure(submission, toolProtocolFailure(), emit);
			}

			if (!this.#options.toolRouter) {
				return this.#finalizeFailure(submission, unsupportedToolFailure(), emit);
			}
			const toolBudgetExhausted = this.#reserveToolCalls(stepResult.toolCalls.length);
			if (toolBudgetExhausted) {
				return this.#finalizeAgentBudget(context, toolBudgetExhausted);
			}

			try {
				assertNotAborted(signal);
					this.#options.store.appendAssistantToolCalls({
					sessionId: this.#options.sessionId,
					clientTurnId: submission.clientTurnId,
					assistantText: stepResult.assistantText,
					calls: stepResult.toolCalls,
					...(stepResult.responseId ? { responseId: stepResult.responseId } : {}),
						...(stepResult.providerState ? { providerState: stepResult.providerState } : {}),
					});
					this.#options.agentCheckpoint?.({
						kind: "provider_turn",
						committed: true,
						turnId,
					});
				assertNotAborted(signal);
				for (const call of stepResult.toolCalls) {
					emit({
						type: "tool_call_accepted",
						callId: boundedCallId(call.callId),
						toolName: boundedToolName(call.name),
					});
				}
			} catch (error) {
				return this.#finalizeFailure(
					submission,
					normalizeFailure(error, signal, "persistence_error"),
					emit,
				);
			}
			previousResponseId = stepResult.responseId;
			pendingBatch = {
				calls: stepResult.toolCalls,
				assistantText: stepResult.assistantText,
				...(stepResult.responseId ? { responseId: stepResult.responseId } : {}),
			};
		}
	}

	#toolExposureForTurn(
		baseTools: readonly ToolDefinition[],
		turnId: string,
	): readonly ToolDefinition[] {
		const activated = new Set(this.#options.loadToolActivations?.(turnId) ?? []);
		if (activated.size === 0) return baseTools;
		const existing = new Set(baseTools.map((tool) => tool.name));
		const additions = (this.#options.deferredTools ?? []).filter(
			(tool) => activated.has(tool.name) && !existing.has(tool.name),
		);
		return additions.length === 0 ? baseTools : Object.freeze([...baseTools, ...additions]);
	}

	#appendProviderStepLifecycle(
		requestId: string,
		state: "dispatch_started" | "acknowledged" | "failed" | "unknown",
		payload: Readonly<Record<string, string | number | boolean | null>>,
	): void {
		const ledger = this.#options.modelInputLedger;
		if (!ledger) throw new StorageFailure("model-input ledger is not configured");
		ledger.appendProviderStepEvent({
			eventId: this.#options.createModelInputId?.("lifecycle")
				?? `lifecycle-${randomUUID()}`,
			requestId,
			sessionId: this.#options.sessionId,
			state,
			payload,
			createdAt: this.#options.clock(),
		});
	}

	#nextDurableProviderStep(turnId: string): number {
		const latest = this.#options.modelInputLedger?.loadLatestProviderRequestManifest(
			this.#options.sessionId,
		);
		if (!latest || latest.turnId !== turnId) return 1;
		if (!Number.isSafeInteger(latest.providerStep) || latest.providerStep >= Number.MAX_SAFE_INTEGER) {
			throw new StorageFailure("provider step sequence is exhausted");
		}
		return latest.providerStep + 1;
	}

	async #finalizePreparedTurn(
		context: TurnExecutionContext,
		stepResult: ProviderStepResult,
		accumulatedUsage: ProviderUsage,
	): Promise<RuntimeTurnRecord> {
		const { submission, turnId, config, emit, signal } = context;
		try {
			await context.hookCoordinator?.runPoint("stop", {
				assistantMessageChars: stepResult.assistantText.length,
			}, signal);
			assertNotAborted(signal);
			this.queueCoordinator?.rejectPending(turnId);
			assertNotAborted(signal);
		} catch (error) {
			return this.#finalizeFailure(
				submission,
				normalizeFailure(error, signal, "persistence_error"),
				emit,
			);
		}
		return this.#completeTurn(
			submission,
			stepResult.assistantText,
			accumulatedUsage,
			stepResult.usage,
			stepResult.responseId,
			stepResult.providerState,
			emit,
			signal,
			config.memoryEnabled,
		);
	}

	#selectProviderContinuation(
		requestConfig: ProviderRequestConfig,
		requestSignature: string,
		historyBoundary: string,
		fallbackResponseId: string | undefined,
		requestInput: readonly Readonly<Record<string, unknown>>[],
	): string | undefined {
		if (requestConfig.protocol !== "responses") return undefined;
		const coordinator = this.#options.providerContinuation;
		if (!coordinator) {
			return this.#options.modelInputLedger ? undefined : fallbackResponseId;
		}
		const decision = coordinator.select({
			protocol: requestConfig.protocol,
			requestSignature,
			requestInput,
			model: requestConfig.model,
			historyBoundary,
		});
		return decision.kind === "responses_continuation" ? decision.responseId : undefined;
	}

	#recordSafeProviderCompletion(input: {
		readonly requestConfig: ProviderRequestConfig;
		readonly requestSignature: string;
		readonly historyBoundary: string;
		readonly requestInput: readonly CanonicalConversationItem[];
		readonly stepResult: ProviderStepResult;
	}): NormalizedFailure | undefined {
		const coordinator = this.#options.providerContinuation;
		if (!coordinator) return undefined;
		try {
			if (!input.stepResult.responseId) {
				coordinator.invalidate("missing_response_id");
				return undefined;
			}
			coordinator.recordSafeCompletion({
				protocol: input.requestConfig.protocol,
				responseId: input.stepResult.responseId,
				requestSignature: input.requestSignature,
				requestInput: input.requestInput.map(continuationRecord),
				responseOutput: providerStepOutput(input.stepResult),
				model: input.requestConfig.model,
				historyBoundary: input.historyBoundary,
			});
			return undefined;
		} catch (error) {
			return normalizeFailure(error, undefined, "persistence_error");
		}
	}

	#invalidateProviderContinuation(reason: string): NormalizedFailure | undefined {
		try {
			this.#options.providerContinuation?.invalidate(reason);
			return undefined;
		} catch (error) {
			return normalizeFailure(error, undefined, "persistence_error");
		}
	}

	#compactContext(
		context: TurnExecutionContext,
		source: "pre_turn" | "context_overflow",
		conversation: readonly CanonicalConversationItem[],
		freshItemIds: ReadonlySet<string>,
	): Promise<CompactionResult> {
		const coordinator = context.compactionCoordinator;
		if (!coordinator) throw new StorageFailure("compaction coordinator is not configured");
		return coordinator.compact({
			clientTurnId: context.submission.clientTurnId,
			turnId: context.turnId,
			source,
			conversation,
			freshItemIds,
			emit: context.emit,
			signal: context.signal,
		});
	}

	async #collectMemoryItem(
		context: TurnExecutionContext,
	): Promise<Extract<CanonicalConversationItem, { readonly type: "user" }> | undefined> {
		if (context.submission.source === "agent_mailbox") return undefined;
		const service = this.#options.memoryContextService;
		if (!service || !context.config.memoryEnabled) return undefined;
		try {
			const memory = await service.collect({
				userMessage: context.submission.message,
				sessionId: this.#options.sessionId,
				enabled: true,
				signal: context.signal,
			});
			return memory.item;
		} catch {
			return undefined;
		}
	}

	async #processToolBatch(
		context: TurnExecutionContext,
		batch: PendingToolBatch,
		accumulatedUsage: ProviderUsage,
	): Promise<RuntimeTurnRecord | undefined> {
		const { submission, turnId, config, emit, signal } = context;
		const deferredContextItems: Array<Omit<AppendContextItemInput, "sessionId">> = [];
		for (const [index, call] of batch.calls.entries()) {
			const wallClockExhausted = this.#wallClockExhausted();
			if (wallClockExhausted) throw new AgentBudgetExhaustedError(wallClockExhausted);
			assertNotAborted(signal);
			const policy = await this.#options.approvalPolicy?.evaluate(call, context.executionPolicy);
			if (policy?.kind === "request") {
				const coordinator = this.#options.approvalCoordinator;
				if (!coordinator) {
					throw new ProviderFailure({
						code: "unsupported_capability",
						message: "approval continuation is not configured",
					});
				}
				this.#persistDeferredContextItems(deferredContextItems, signal);
					const pending = coordinator.suspend({
						clientTurnId: submission.clientTurnId,
						clientUserMessageId: submission.clientUserMessageId ?? submission.clientTurnId,
					turnId,
					userMessage: submission.message,
					providerProtocol: config.protocol,
					call,
					remainingCalls: batch.calls.slice(index + 1),
					conversation: this.#options.store.loadConversation(this.#options.sessionId),
					assistantText: batch.assistantText,
					...(batch.responseId ? { responseId: batch.responseId } : {}),
					usage: accumulatedUsage,
					...(submission.modelOverride ? { modelOverride: submission.modelOverride } : {}),
					...(submission.reasoningEffort ? { reasoningEffort: submission.reasoningEffort } : {}),
					preview: policy.preview,
					reason: policy.reason,
					...(policy.commandPattern ? { commandPattern: policy.commandPattern } : {}),
					...(policy.proposedExecPolicyPattern ? {
						proposedExecPolicyPattern: policy.proposedExecPolicyPattern,
					} : {}),
				});
				emit({
					type: "approval_requested",
					clientTurnId: pending.clientTurnId,
					turnId: pending.turnId,
					decisionId: pending.decisionId,
					callId: boundedCallId(pending.callId),
					toolName: boundedToolName(pending.toolName),
					preview: pending.preview,
					reason: pending.reason,
					options: pending.options,
				});
				const running = this.#runningTurn(pending.clientTurnId);
				await this.#writeTerminalSnapshot(running);
				return running;
			}

			let executionCall = call;
			let blockedByHook: ToolExecutionResult | undefined;
				if (policy?.kind !== "deny" && context.hookCoordinator) {
					const before = await context.hookCoordinator.beforeTool(call, signal);
					context.hookContexts.append({
						point: "pre_tool_use",
						contexts: before.contexts,
					});
				if (before.status === "deny") {
					blockedByHook = hookDeniedResult(call, before.errorKind);
				} else {
					executionCall = before.call;
				}
			}
			const result = policy?.kind === "deny"
				? policyDeniedResult(call, policy)
				: blockedByHook ?? await this.#executeTool(executionCall, context);
			if (policy?.kind === "deny" || blockedByHook) emitToolResult(result, 0, emit);
			const clarification = clarificationRequest(result);
			if (clarification) {
				const coordinator = this.#options.clarificationCoordinator;
				if (!coordinator) {
					throw new ProviderFailure({
						code: "unsupported_capability",
						message: "clarification continuation is not configured",
					});
				}
				this.#persistDeferredContextItems(deferredContextItems, signal);
				const pending = coordinator.suspend({
					clientTurnId: submission.clientTurnId,
					clientUserMessageId: submission.clientUserMessageId ?? submission.clientTurnId,
					turnId,
					userMessage: submission.message,
					providerProtocol: config.protocol,
					call,
					remainingCalls: batch.calls.slice(index + 1),
					conversation: this.#options.store.loadConversation(this.#options.sessionId),
					assistantText: batch.assistantText,
					...(batch.responseId ? { responseId: batch.responseId } : {}),
					usage: accumulatedUsage,
					...(submission.modelOverride ? { modelOverride: submission.modelOverride } : {}),
					...(submission.reasoningEffort ? { reasoningEffort: submission.reasoningEffort } : {}),
					...clarification,
				});
				emit({
					type: "clarification_requested",
					clientTurnId: pending.clientTurnId,
					turnId: pending.turnId,
					requestId: pending.requestId,
					callId: boundedCallId(pending.call.callId),
					toolName: boundedToolName(pending.call.name),
					question: pending.question,
					options: pending.options,
					header: pending.header,
					multiSelect: pending.multiSelect,
				});
				const running = this.#runningTurn(pending.clientTurnId);
				await this.#writeTerminalSnapshot(running);
				return running;
				}
				const contextItem = this.#persistToolResult(submission.clientTurnId, turnId, result);
				if (contextItem) deferredContextItems.push(contextItem);
				if (result.success && result.planUpdate) {
					emit({
						type: "plan_updated",
						...(result.planUpdate.explanation
							? { explanation: result.planUpdate.explanation }
							: {}),
						items: result.planUpdate.items,
					});
				}
				if (policy?.kind !== "deny" && !blockedByHook) {
					this.#options.agentCheckpoint?.({
						kind: "tool_call",
						committed: true,
						turnId,
						callId: executionCall.callId,
						mutating: this.#options.isMutatingTool?.(executionCall.name) ?? true,
					});
				}
				if (policy?.kind !== "deny" && !blockedByHook) {
					const after = await context.hookCoordinator?.afterTool(executionCall, result, signal);
					if (after) {
						context.hookContexts.append({
							point: "post_tool_use",
							contexts: after.contexts,
						});
					}
				}
			assertNotAborted(signal);
		}
		this.#persistDeferredContextItems(deferredContextItems, signal);
		return undefined;
	}

	#beginProviderStep(): AgentBudgetExhaustionKind | undefined {
		const maxTurns = this.#agentBudget.budget.maxTurns;
		if (maxTurns !== undefined && this.#agentBudget.providerSteps >= maxTurns) {
			return this.#markBudgetExhausted("max_turns");
		}
		this.#agentBudget.providerSteps += 1;
		return undefined;
	}

	#reserveToolCalls(count: number): AgentBudgetExhaustionKind | undefined {
		const maxToolCalls = this.#agentBudget.budget.maxToolCalls;
		if (maxToolCalls !== undefined && this.#agentBudget.toolCalls + count > maxToolCalls) {
			return this.#markBudgetExhausted("max_tool_calls");
		}
		this.#agentBudget.toolCalls += count;
		return undefined;
	}

	#wallClockExhausted(): AgentBudgetExhaustionKind | undefined {
		const limit = this.#agentBudget.budget.wallClockMs;
		if (limit === undefined) return undefined;
		const elapsed = (this.#options.monotonicClock?.() ?? performance.now())
			- this.#agentBudget.startedAt;
		return elapsed >= limit ? this.#markBudgetExhausted("wall_clock") : undefined;
	}

	#markBudgetExhausted(kind: AgentBudgetExhaustionKind): AgentBudgetExhaustionKind {
		this.#agentBudget.exhausted ??= kind;
		return this.#agentBudget.exhausted;
	}

	async #finalizeAgentBudget(
		context: TurnExecutionContext,
		kind: AgentBudgetExhaustionKind,
	): Promise<RuntimeTurnRecord> {
		this.#markBudgetExhausted(kind);
		return this.#finalizeFailure(context.submission, {
			code: "tool_budget_exceeded",
			message: `agent budget exhausted: ${kind}`,
			retryable: false,
		}, context.emit);
	}

	async #executeTool(
		call: CanonicalToolCall,
		context: TurnExecutionContext,
	): Promise<ToolExecutionResult> {
		const { emit, signal } = context;
		const router = this.#options.toolRouter;
		if (!router) throw new ProviderFailure({
			code: "unsupported_capability",
			message: "tool execution is not configured",
		});
		this.#options.agentCheckpoint?.({
			kind: "tool_call",
			committed: false,
			turnId: context.turnId,
			callId: call.callId,
			mutating: this.#options.isMutatingTool?.(call.name) ?? true,
		});
		const activeTool = this.#beginToolExecution(
			context.turnId,
			call.callId,
			call.name,
			"tool_interrupted",
			emit,
		);
		let result: ToolExecutionResult;
		try {
			result = await router.execute(call, {
				signal,
				ownerSessionId: this.#options.sessionId,
				ownerTurnId: context.turnId,
				callId: call.callId,
				publishLifecycle: this.#options.publishLifecycle,
				...(context.executionPolicy ? { executionPolicy: context.executionPolicy } : {}),
			});
			assertNotAborted(signal);
		} catch (error) {
			if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
				this.#interruptToolExecution(activeTool, emit);
				throw error;
			}
			this.#failToolExecution(activeTool, "tool_execution_failed", emit);
			throw new ProviderFailure({
				code: "provider_error",
				message: "tool execution failed",
				diagnostics: { tool_name: boundedToolName(call.name) },
			});
		}
		this.#completeToolExecution(activeTool, result, emit);
		return result;
	}

	#beginToolExecution(
		turnId: string,
		callId: string,
		toolName: string,
		interruptErrorKind: ActiveToolExecution["interruptErrorKind"],
		emit: (event: RuntimeEvent) => void,
	): ActiveToolExecution {
		const active: ActiveToolExecution = {
			turnId,
			callId: boundedCallId(callId),
			toolName: boundedToolName(toolName),
			startedAt: this.#options.monotonicClock?.() ?? performance.now(),
			interruptErrorKind,
			terminalEmitted: false,
		};
		this.#activeToolExecutions.set(turnId, active);
		emit({
			type: "tool_execution_started",
			callId: active.callId,
			toolName: active.toolName,
		});
		return active;
	}

	#completeToolExecution(
		active: ActiveToolExecution,
		result: ToolExecutionResult,
		emit: (event: RuntimeEvent) => void,
	): void {
		if (active.terminalEmitted) return;
		active.terminalEmitted = true;
		this.#forgetToolExecution(active);
		const finishedAt = this.#options.monotonicClock?.() ?? performance.now();
		emitToolResult(result, boundedDurationMs(active.startedAt, finishedAt), emit);
	}

	#interruptActiveTool(turnId: string, emit: (event: RuntimeEvent) => void): void {
		const active = this.#activeToolExecutions.get(turnId);
		if (active) this.#interruptToolExecution(active, emit);
	}

	#interruptToolExecution(
		active: ActiveToolExecution,
		emit: (event: RuntimeEvent) => void,
	): void {
		this.#failToolExecution(active, active.interruptErrorKind, emit);
	}

	#failToolExecution(
		active: ActiveToolExecution,
		errorKind: string,
		emit: (event: RuntimeEvent) => void,
	): void {
		if (active.terminalEmitted) return;
		active.terminalEmitted = true;
		this.#forgetToolExecution(active);
		const finishedAt = this.#options.monotonicClock?.() ?? performance.now();
		emit({
			type: "tool_execution_failed",
			callId: active.callId,
			toolName: active.toolName,
			summary: errorKind === "effect_outcome_unknown"
				? `${active.toolName} outcome is unknown after interruption`
				: errorKind === "tool_interrupted"
					? `${active.toolName} interrupted`
					: `${active.toolName} failed`,
			durationMs: boundedDurationMs(active.startedAt, finishedAt),
			errorKind,
			metadata: Object.freeze({}),
		});
	}

	#forgetToolExecution(active: ActiveToolExecution): void {
		if (this.#activeToolExecutions.get(active.turnId) === active) {
			this.#activeToolExecutions.delete(active.turnId);
		}
	}

	#persistToolResult(
		clientTurnId: string,
		turnId: string,
		result: ToolExecutionResult,
	): Omit<AppendContextItemInput, "sessionId"> | undefined {
		const contextItem = this.#options.contextItemCoordinator?.contextItemFor({ turnId, result });
		this.#options.store.appendToolResult({
			sessionId: this.#options.sessionId,
			clientTurnId,
			result: toCanonicalResult(result),
			summary: result.summary,
			metadata: result.metadata,
			...(result.errorKind ? { errorKind: result.errorKind } : {}),
			...(result.planUpdate ? { planUpdate: result.planUpdate } : {}),
			...(result.toolActivation ? { toolActivation: result.toolActivation } : {}),
		});
		return contextItem;
	}

	#persistDeferredContextItems(
		items: Array<Omit<AppendContextItemInput, "sessionId">>,
		signal: AbortSignal,
	): void {
		for (const contextItem of items) {
			assertNotAborted(signal);
			this.#options.store.appendContextItem({
				sessionId: this.#options.sessionId,
				...contextItem,
			});
		}
		items.length = 0;
	}

	#runningTurn(clientTurnId: string): RuntimeTurnRecord {
		const turn = this.#options.store.loadTurn(this.#options.sessionId, clientTurnId);
		if (!turn || turn.status !== "in_progress") {
			throw new StorageFailure("approval suspension has no running turn");
		}
		return turn;
	}

	async #streamWithRetry(
		provider: ModelProvider,
		request: ProviderRequest,
		maxRetries: number,
		emit: (event: RuntimeEvent) => void,
		signal: AbortSignal,
		toolCallsAllowed: boolean,
	): Promise<ProviderStepResult | {
		readonly failure: NormalizedFailure;
		readonly eventsObserved: number;
	}> {
		let retriesUsed = 0;
		while (true) {
			let eventsObserved = 0;
			let assistantText = "";
			let usage: ProviderUsage = {};
			let responseId: string | undefined;
			let providerState: ProviderReplayState | undefined;
			const toolCalls: CanonicalToolCall[] = [];
			let completed = false;
			try {
				assertNotAborted(signal);
				for await (const event of provider.stream(request, { signal })) {
					assertNotAborted(signal);
					eventsObserved += 1;
					if (completed) {
						throw providerProtocolFailure("provider emitted an event after completion");
					}
					switch (event.type) {
						case "reasoning_delta":
							emit(event);
							break;
						case "text_delta":
							assistantText += event.text;
							emit(event);
							break;
						case "provider_state":
							if (providerState || event.state.provider !== request.provider) {
								throw providerProtocolFailure("invalid provider replay state");
							}
							providerState = event.state;
							break;
						case "usage":
							usage = { ...usage, ...event.usage };
							break;
						case "completed":
							completed = true;
							responseId = event.responseId;
							emit({
								type: "message_complete",
								...(event.responseId ? { responseId: event.responseId } : {}),
							});
							break;
						case "tool_call":
							if (!toolCallsAllowed) {
								throw unsupportedToolFailure();
							}
							if (!event.callId.trim()) {
								throw new ProviderFailure({
									code: "tool_protocol_error",
									message: "provider tool call is missing a call ID",
								});
							}
							toolCalls.push({
								callId: event.callId,
								name: event.name,
								argumentsJson: event.argumentsJson,
							});
					}
				}
				if (!completed) {
					throw providerProtocolFailure("provider stream ended without completion");
				}
				if (retriesUsed > 0) {
					emit({ type: "stream_recovered" });
				}
				return {
					assistantText,
					usage,
						toolCalls,
						...(responseId ? { responseId } : {}),
						...(providerState ? { providerState } : {}),
				};
			} catch (error) {
				const failure = normalizeFailure(error, signal, "provider_error");
				const decision = decideRetry({
					retryable: failure.retryable,
					eventsObserved,
					retriesUsed,
					maxRetries,
					...(failure.retryAfterSeconds === undefined
						? {}
						: { retryAfterSeconds: failure.retryAfterSeconds }),
					random: this.#options.random ?? Math.random,
				});
				if (!decision.shouldRetry) {
					const retryLimit = Math.max(0, Math.min(100, Math.trunc(maxRetries)));
					return {
						failure: failure.retryable
							&& eventsObserved === 0
							&& retriesUsed >= retryLimit
							? {
								code: "retry_exhausted",
								message: "provider retry budget exhausted",
								retryable: false,
								...(failure.diagnostics ? { diagnostics: failure.diagnostics } : {}),
							}
							: failure,
						eventsObserved,
					};
				}
				emit({
					type: "stream_retrying",
					attempt: decision.attempt,
					delayMs: decision.delayMs,
				});
				try {
					assertNotAborted(signal);
					await (this.#options.sleep ?? sleepWithSignal)(decision.delayMs, signal);
					assertNotAborted(signal);
				} catch (sleepError) {
					return {
						failure: normalizeFailure(sleepError, signal, "interrupted"),
						eventsObserved,
					};
				}
				retriesUsed += 1;
			}
		}
	}

	#conversationForCurrentSubmission(userText: string): readonly CanonicalConversationItem[] {
		const conversation = this.#options.store.loadConversationItems(this.#options.sessionId);
		const current = conversation.at(-1);
		if (!current || current.type !== "user" || current.text !== userText) {
			throw new StorageFailure("reserved user message is missing from canonical history");
		}
		return conversation;
	}

	async #completeTurn(
		submission: TurnSubmission,
		assistantText: string,
		usage: ProviderUsage,
		lastTokenUsage: ProviderUsage,
		responseId: string | undefined,
		providerState: ProviderReplayState | undefined,
		emit: (event: RuntimeEvent) => void,
		signal: AbortSignal,
		memoryEnabled: boolean,
	): Promise<RuntimeTurnRecord> {
		try {
			assertNotAborted(signal);
			const completed = this.#options.store.completeTurn({
				sessionId: this.#options.sessionId,
				clientTurnId: submission.clientTurnId,
				assistantText,
				usage,
				lastTokenUsage,
				...(responseId ? { responseId } : {}),
				...(providerState ? { providerState } : {}),
				completedAt: this.#options.clock(),
			});
			const snapshotWritten = await this.#writeTerminalSnapshot(completed);
			emit({ type: "turn_completed", assistantText, usage });
			if (snapshotWritten
				&& memoryEnabled
				&& submission.source !== "agent_mailbox"
				&& this.#options.memoryContextService) {
				try {
					await this.#options.memoryContextService.applyExplicitActions({
						userMessage: submission.message,
						enabled: true,
					});
				} catch {
					// Memory is auxiliary and cannot rewrite an already completed turn.
				}
			}
			return completed;
		} catch (error) {
			return this.#finalizeFailure(
				submission,
				normalizeFailure(error, signal, "persistence_error"),
				emit,
			);
		}
	}

	async #finalizeFailure(
		submission: TurnSubmission,
		failure: NormalizedFailure,
		emit: (event: RuntimeEvent) => void,
	): Promise<RuntimeTurnRecord> {
		try {
			const existing = this.#options.store.loadTurn(
				this.#options.sessionId,
				submission.clientTurnId,
			);
			if (existing && existing.status !== "in_progress") return existing;
			try {
				this.#options.providerContinuation?.invalidate(
					failure.code === "interrupted" ? "turn_interrupted" : "turn_failed",
				);
			} catch {
				// The terminal turn still has to be closed even if continuation cleanup fails.
			}
			const failed = this.#options.store.failTurn({
				sessionId: this.#options.sessionId,
				clientTurnId: submission.clientTurnId,
				code: failure.code,
				message: failure.message,
				...(failure.diagnostics ? { diagnostics: failure.diagnostics } : {}),
				completedAt: this.#options.clock(),
			});
			await this.#writeTerminalSnapshot(failed);
			if (failure.code === "interrupted") {
				emit({ type: "turn_interrupted", message: failure.message });
			} else {
				emit({
					type: "turn_failed",
					code: failure.code,
					message: failure.message,
				});
			}
			return failed;
		} catch (error) {
			const persistence = normalizeFailure(error, undefined, "persistence_error");
			emit({
				type: "turn_failed",
				code: "persistence_error",
				message: persistence.message,
			});
			throw error;
		}
	}

	async #writeTerminalSnapshot(turn: RuntimeTurnRecord): Promise<boolean> {
		if (!this.#options.writeTerminalSnapshot) return true;
		try {
			await this.#options.writeTerminalSnapshot(turn);
			return true;
		} catch {
			return false;
		}
	}
}

function clarificationRequest(result: ToolExecutionResult): {
	readonly question: string;
	readonly options: readonly ClarificationOption[];
	readonly header: string;
	readonly multiSelect: boolean;
} | undefined {
	if (!result.success || result.metadata.status !== "awaiting_user_response") return undefined;
	const question = boundedMetadataString(result.metadata.question, 4_096);
	const header = boundedMetadataString(result.metadata.header, 256, true);
	const multiSelect = result.metadata.multi_select;
	const options = clarificationOptions(result.metadata.options);
	if (question === undefined || header === undefined || typeof multiSelect !== "boolean" || !options) {
		throw new ProviderFailure({
			code: "tool_protocol_error",
			message: "tool returned an invalid clarification request",
		});
	}
	return Object.freeze({ question, options, header, multiSelect });
}

function clarificationOptions(value: unknown): readonly ClarificationOption[] | undefined {
	if (!Array.isArray(value) || value.length < 1 || value.length > 5) return undefined;
	const options: ClarificationOption[] = [];
	for (const item of value) {
		if (!isRecord(item)) return undefined;
		const label = boundedMetadataString(item.label, 128);
		const description = boundedMetadataString(item.description, 512, true);
		if (label === undefined || description === undefined) return undefined;
		options.push(Object.freeze({ label, ...(description ? { description } : {}) }));
	}
	return Object.freeze(options);
}

function boundedMetadataString(
	value: unknown,
	limit: number,
	optional = false,
): string | undefined {
	if (optional && (value === undefined || value === null || value === "")) return "";
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 && normalized.length <= limit ? normalized : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function continuationRecord(item: CanonicalConversationItem): Readonly<Record<string, unknown>> {
	if (item.type === "assistant_tool_calls") {
		return {
			...item,
			calls: item.calls.map((call) => ({ ...call })),
		};
	}
	return { ...item };
}

function sameToolExposure(
	left: readonly ToolDefinition[],
	right: readonly ToolDefinition[],
): boolean {
	return left.length === right.length && left.every((tool, index) => tool.name === right[index]?.name);
}

function providerStepOutput(
	step: ProviderStepResult,
): readonly Readonly<Record<string, unknown>>[] {
	if (step.toolCalls.length > 0) {
		return [{
			type: "assistant_tool_calls",
			text: step.assistantText,
			calls: step.toolCalls.map((call) => ({ ...call })),
			...(step.responseId ? { responseId: step.responseId } : {}),
			...(step.providerState ? { providerState: step.providerState } : {}),
		}];
	}
	return step.assistantText ? [{
		type: "assistant",
		text: step.assistantText,
		...(step.providerState ? { providerState: step.providerState } : {}),
	}] : [];
}

function normalizeFailure(
	error: unknown,
	signal: AbortSignal | undefined,
	fallbackCode: RuntimeErrorCode,
): NormalizedFailure {
	if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
		return { code: "interrupted", message: "turn interrupted", retryable: false };
	}
	if (error instanceof AgentBudgetExhaustedError) {
		return {
			code: "tool_budget_exceeded",
			message: `agent budget exhausted: ${error.kind}`,
			retryable: false,
		};
	}
	if (error instanceof ProviderFailure) {
		return {
			code: error.code,
			message: publicMessage(error.code),
			retryable: error.retryable,
			...(Object.keys(error.diagnostics).length > 0 ? { diagnostics: error.diagnostics } : {}),
			...(error.retryAfterSeconds === undefined
				? {}
				: { retryAfterSeconds: error.retryAfterSeconds }),
		};
	}
	if (error instanceof StorageFailure) {
		return {
			code: "persistence_error",
			message: "session persistence failed",
			retryable: false,
			...(Object.keys(error.diagnostics).length > 0 ? { diagnostics: error.diagnostics } : {}),
		};
	}
	if (isFailureLike(error)) {
		return {
			code: error.code,
			message: publicMessage(error.code),
			retryable: error.retryable === true,
		};
	}
	return { code: fallbackCode, message: publicMessage(fallbackCode), retryable: false };
}

function insertMemoryBeforeCurrentInput(
	history: readonly CanonicalConversationItem[],
	memory: Extract<CanonicalConversationItem, { readonly type: "user" }>,
	currentInput: string,
): readonly CanonicalConversationItem[] {
	let insertionIndex = -1;
	for (let index = history.length - 1; index >= 0; index -= 1) {
		const item = history[index];
		if (item?.type === "user" && item.text === currentInput) {
			insertionIndex = index;
			break;
		}
	}
	if (insertionIndex < 0) {
		insertionIndex = history.findLastIndex((item) => item.type === "user");
	}
	if (insertionIndex < 0) return history;
	return Object.freeze([
		...history.slice(0, insertionIndex),
		Object.freeze({ ...memory }),
		...history.slice(insertionIndex),
	]);
}

function mergeRuntimeContextSources(input: {
	readonly collected: TurnContextSources;
	readonly hooks: readonly RuntimeHookContext[];
	readonly memory: readonly string[];
	readonly developerInstructions: readonly string[];
	readonly collaborationMode: string;
	readonly executionPolicy?: ExecutionPolicy;
	readonly executionPolicyConfiguration?: ExecutionPolicyConfiguration;
}): TurnContextSources {
	const subagentContext = [
		input.collected.subagentContext?.trim() ?? "",
		...input.developerInstructions.map((item) => item.trim()),
	].filter(Boolean).join("\n\n");
	return Object.freeze({
		...input.collected,
		collaborationMode: input.collected.collaborationMode ?? input.collaborationMode,
		permissionContext: input.collected.permissionContext
			?? renderExecutionPolicyContext(
				input.executionPolicy,
				input.executionPolicyConfiguration,
			),
		...(input.hooks.length > 0 ? { hooks: input.hooks } : {}),
		...(input.memory.length > 0
			? { memory: Object.freeze([...(input.collected.memory ?? []), ...input.memory]) }
			: {}),
		...(subagentContext ? { subagentContext } : {}),
	});
}

function renderExecutionPolicyContext(
	policy: ExecutionPolicy | undefined,
	configuration: ExecutionPolicyConfiguration | undefined,
): string {
	if (!policy) return "";
	return [
		"<execution_policy>",
		`workspace_trust: ${configuration?.trust ?? "unknown"}`,
		`permission_profile: ${configuration?.permission ?? "read-only"}`,
		`sandbox_mode: ${policy.mode}`,
		`filesystem: ${policy.filesystem}`,
		`network: ${policy.network}`,
		`writable_roots: ${policy.writableRoots.length}`,
		"</execution_policy>",
	].join("\n");
}

function currentUserRequest(
	context: TurnExecutionContext,
	history: readonly CanonicalConversationItem[],
): string {
	if (context.submission.source !== "agent_mailbox") return context.submission.message;
	for (let index = history.length - 1; index >= 0; index -= 1) {
		const item = history[index];
		if (item?.type === "user" && item.text.trim()) return item.text;
	}
	return context.submission.message;
}

function publicMessage(code: RuntimeErrorCode): string {
	switch (code) {
		case "config_error":
			return "provider configuration failed";
		case "auth_error":
			return "provider authentication failed";
		case "rate_limited":
			return "provider rate limit exceeded";
		case "context_window_exceeded":
			return "provider context window exceeded";
		case "retry_exhausted":
			return "provider retry budget exhausted";
		case "persistence_error":
			return "session persistence failed";
		case "interrupted":
			return "turn interrupted";
		case "unsupported_capability":
			return "provider requested an unsupported capability";
		case "tool_budget_exceeded":
			return "tool turn budget exceeded";
		case "tool_protocol_error":
			return "provider tool protocol failed";
		default:
			return "provider request failed";
	}
}

function assertNotAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		const error = new Error("interrupted: turn aborted");
		error.name = "AbortError";
		throw error;
	}
}

function configFailure(message: string): ProviderFailure {
	return new ProviderFailure({ code: "config_error", message });
}

function providerProtocolFailure(message: string): ProviderFailure {
	return new ProviderFailure({ code: "provider_error", message });
}

function unsupportedToolFailure(): NormalizedFailure {
	return {
		code: "unsupported_capability",
		message: "provider requested an unsupported capability",
		retryable: false,
	};
}

function unsupportedImageFailure(): NormalizedFailure {
	return {
		code: "unsupported_capability",
		message: "model configuration does not support image input",
		retryable: false,
	};
}

function toolProtocolFailure(): NormalizedFailure {
	return {
		code: "tool_protocol_error",
		message: "provider tool protocol failed",
		retryable: false,
	};
}

function policyDeniedResult(
	call: CanonicalToolCall,
	decision: Extract<ApprovalPolicyDecision, { readonly kind: "deny" }>,
): ToolExecutionResult {
	const toolName = boundedToolName(call.name) || "Tool";
	const errorKind = decision.reason.includes("outside the workspace")
		? "workspace_escape"
		: "approval_rejected";
	return Object.freeze({
		callId: call.callId,
		toolName: call.name,
		success: false,
		modelOutput: `${toolName} denied\nError kind: ${errorKind}`,
		summary: `${toolName} denied`,
		errorKind,
		metadata: Object.freeze({}),
	});
}

function hookDeniedResult(
	call: CanonicalToolCall,
	errorKind: "tool_denied_by_hook" | "tool_hook_error",
): ToolExecutionResult {
	const toolName = boundedToolName(call.name);
	return Object.freeze({
		callId: call.callId,
		toolName: call.name,
		success: false,
		modelOutput: `${toolName} failed\nError kind: ${errorKind}`,
		summary: `${toolName} failed`,
		errorKind,
		metadata: Object.freeze({}),
	});
}

function addUsage(left: ProviderUsage, right: ProviderUsage): ProviderUsage {
	const accumulated: Record<string, number> = { ...left };
	for (const [key, value] of Object.entries(right)) {
		accumulated[key] = (accumulated[key] ?? 0) + value;
	}
	return accumulated;
}

function usageTokenTotal(usage: ProviderUsage): number {
	const total = usage.total_tokens ?? usage.totalTokens;
	if (typeof total === "number" && Number.isFinite(total) && total >= 0) return total;
	const input = usage.input_tokens ?? usage.inputTokens ?? 0;
	const output = usage.output_tokens ?? usage.outputTokens ?? 0;
	return Math.max(0, input) + Math.max(0, output);
}

function validatedAgentBudget(value: AgentBudget | undefined): AgentBudget {
	if (!value) return Object.freeze({});
	const entries = Object.entries(value).flatMap(([key, limit]) => {
		if (limit === undefined) return [];
		if (!Number.isSafeInteger(limit) || limit <= 0) {
			throw new TypeError(`agent budget ${key} must be a positive integer`);
		}
		return [[key, limit] as const];
	});
	return Object.freeze(Object.fromEntries(entries));
}

function hasUniqueCallIds(calls: readonly CanonicalToolCall[]): boolean {
	const callIds = new Set(calls.map((call) => call.callId));
	return callIds.size === calls.length;
}

function toCanonicalResult(result: ToolExecutionResult) {
	return {
		callId: result.callId,
		toolName: result.toolName,
		output: result.modelOutput,
		success: result.success,
	};
}

function emitToolResult(
	result: ToolExecutionResult,
	durationMs: number,
	emit: (event: RuntimeEvent) => void,
): void {
	const shared = {
		callId: boundedCallId(result.callId),
		toolName: boundedToolName(result.toolName),
		summary: result.summary.slice(0, 512),
		durationMs,
		metadata: result.metadata,
	};
	if (result.success) {
		emit({ type: "tool_execution_completed", ...shared });
		return;
	}
	emit({
		type: "tool_execution_failed",
		...shared,
		...(result.errorKind ? { errorKind: result.errorKind.slice(0, 128) } : {}),
	});
}

function boundedCallId(value: string): string {
	return value.slice(0, 256);
}

function boundedToolName(value: string): string {
	return value.slice(0, 128) || "Tool";
}

function boundedDurationMs(startedAt: number, finishedAt: number): number {
	const elapsed = finishedAt - startedAt;
	if (!Number.isFinite(elapsed)) {
		return 0;
	}
	return Math.min(86_400_000, Math.max(0, Math.round(elapsed)));
}

function isFailureLike(error: unknown): error is {
	readonly code: RuntimeErrorCode;
	readonly retryable?: boolean;
} {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return false;
	}
	return typeof error.code === "string" && RUNTIME_ERROR_CODES.has(error.code);
}

const RUNTIME_ERROR_CODES = new Set<string>([
	"config_error",
	"auth_error",
	"provider_error",
	"rate_limited",
	"context_window_exceeded",
	"retry_exhausted",
	"persistence_error",
	"interrupted",
	"unsupported_capability",
	"tool_budget_exceeded",
	"tool_protocol_error",
]);
