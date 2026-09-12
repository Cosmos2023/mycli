import { resolveProviderRetryPolicy, type NodeRuntimeConfig } from "@mycli/config";
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
	RuntimeEvent,
	ShellLifecycleEvent,
	ToolDefinition,
	WebSearchAction,
	WebSearchCall,
} from "@mycli/core";
import {
	ProviderFailure,
	providerFailureToRuntimeFailure,
	providerFailureReason,
} from "@mycli/providers";
import type { ModelProvider, ProviderRouteDescriptor } from "@mycli/providers";
import type {
	ApprovalPolicyDecision,
	ExecutionPolicy,
	PermissionGrant,
	PermissionProfile,
	ToolExecutionResult,
	ToolRouterContract,
} from "@mycli/tools";
import {
	StorageFailure,
} from "@mycli/storage";
import type {
	AgentRuntimeCheckpoint,
	AgentEffectLedgerStore,
	ModelInputLedgerStore,
	ProviderAttemptLedgerStore,
	RuntimeTurnStore,
	StoredTurnTerminalization,
	TurnReservation,
} from "@mycli/storage";
import {
	createErrorContext,
	errorOccurrence,
	errorSummary,
	legacyRuntimeReason,
	storageErrorReason,
	readErrorContext,
	isRuntimeErrorCode,
	runtimeErrorPublicMessage,
} from "@mycli/contracts";
import type {
	ErrorReasonDetails,
	FailureSource,
	RuntimeErrorCode,
	ProviderAttemptUpdate,
	RuntimeFailure,
	RuntimeTurnRecord,
} from "@mycli/contracts";
import { assertNotAborted, UserTurnCancellation } from "../abort.ts";
import type { QueueCoordinator } from "./queue-coordinator.ts";
import type {
	ApprovalChoice,
	ApprovalSuspensionInput,
	PendingApprovalContinuation,
} from "./approval-continuation-coordinator.ts";
import { ApprovalNotPendingError } from "./approval-continuation-coordinator.ts";
import { toolEffectAttemptId, type ParallelApprovalCoordinator } from "./parallel-approval-coordinator.ts";
import type {
	ClarificationSuspensionInput,
	PendingClarificationContinuation,
} from "./clarification-continuation-coordinator.ts";
import { ClarificationNotPendingError } from "./clarification-continuation-coordinator.ts";
import type {
	CompactInput,
	CompactionResult,
} from "../context/compaction-coordinator.ts";
import type { MemoryContextServiceContract } from "../memory/memory-context-service.ts";
import type {
	ExecutionPolicyConfiguration,
	ExecutionPolicySnapshot,
	PermissionGrantInput,
} from "./execution-policy-coordinator.ts";
import {
	buildProviderRequestSignature,
	type ContinuationDecision,
	type SafeProviderCompletionInput,
} from "../providers/provider-continuation.ts";
import { HookCoordinator } from "../hooks/hook-coordinator.ts";
import { HookContextAccumulator } from "../hooks/hook-context-accumulator.ts";
import type { ContextItemCoordinatorContract } from "../context/context-item-coordinator.ts";
import type {
	RuntimeHookContext,
	TurnContextSources,
} from "../context/instruction-context.ts";
import { collaborationModeDeveloperInstruction } from "../context/collaboration-mode.ts";
import { renderExecutionPolicyContext } from "../context/execution-policy-instructions.ts";
import type { TokenCounter } from "../context/token-counter.ts";
import { NodeTurnCoordinatorBroker } from "./node-turn-coordinator-broker.ts";
import {
	InProcessProviderStepExecutor,
} from "../providers/provider-step-executor.ts";
import type { ProviderStepExecutor } from "../providers/provider-step-executor.ts";
import { publishRuntimeDiagnostic } from "../runtime-observability.ts";
import type { RuntimeDiagnosticEvent } from "../runtime-observability.ts";
import { projectCommittedTurnTerminalization } from "./turn-terminalization.ts";
import {
	toolExposureForSnapshot,
} from "./run-execution-snapshot.ts";
import type {
	RunExecutionSnapshot,
	RunToolCatalogInput,
} from "./run-execution-snapshot.ts";
import { AgentBudgetTracker } from "../agents/agent-budget-tracker.ts";
import {
	ActiveToolExecutionRegistry,
	boundedRuntimeToolName as boundedToolName,
	boundedToolCallId as boundedCallId,
	emitToolExecutionResult as emitToolResult,
	type ActiveToolExecutionClaim,
} from "../tools/active-tool-execution-registry.ts";
import {
	RunExecutionCoordinator,
	type RunExecutionPolicyCoordinator,
} from "./run-execution-coordinator.ts";
import {
	ToolBatchCoordinator,
	type PendingToolBatch,
} from "../tools/tool-batch-coordinator.ts";

export interface TurnSubmission {
	readonly clientTurnId: string;
	readonly clientUserMessageId?: string;
	readonly turnId?: string;
	readonly message: string;
	readonly queueId?: string;
	readonly inputSource?: "submit" | "steer" | "queued";
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
	readonly agentEffectLedger?: AgentEffectLedgerStore;
	readonly providerAttemptLedger?: ProviderAttemptLedgerStore;
	readonly modelInputTokenCounter?: TokenCounter;
	readonly contextSources?: (input: RuntimeContextSourceInput) => TurnContextSources;
	readonly createModelInputId?: (
		kind: "tools" | "context" | "request" | "lifecycle",
	) => string;
	readonly agentBudget?: AgentBudget;
	readonly store: RuntimeTurnStore;
	readonly runLifecycle?: {
		prepare(turnId: string, signal: AbortSignal): Promise<void>;
		finish(turnId: string): void;
	};
	readonly resolveConfig: (
		submission: TurnSubmission,
	) => NodeRuntimeConfig | Promise<NodeRuntimeConfig>;
	readonly createProvider: (config: NodeRuntimeConfig) => ModelProvider;
	readonly resolveProviderRoute?: (config: NodeRuntimeConfig) => ProviderRouteDescriptor;
	readonly providerStepExecutor?: ProviderStepExecutor;
	readonly loadLocalImages: (paths: readonly string[]) => readonly CanonicalImage[];
	readonly createTurnId: () => string;
	readonly clock: () => string;
	readonly maxOutputTokens?: number;
	readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
	readonly random?: () => number;
	readonly monotonicClock?: () => number;
	readonly recordDiagnostic?: (event: RuntimeDiagnosticEvent) => void;
	readonly planTools?: (capabilities: {
		readonly shell: boolean;
		readonly collaborationMode: string;
	}) => readonly ToolDefinition[];
	readonly resolveToolCatalog?: (capabilities: {
		readonly turnId: string;
		readonly shell: boolean;
		readonly collaborationMode: string;
	}) => RunToolCatalogInput;
	readonly deferredTools?: readonly ToolDefinition[] | ((turnId: string) => readonly ToolDefinition[]);
	readonly loadToolActivations?: (turnId: string) => readonly string[];
	readonly executionPolicyCoordinator?: ExecutionPolicyCoordinatorContract;
	readonly toolRouter?: ToolRouterContract;
	readonly approvalPolicy?: ApprovalPolicyContract;
	readonly approvalCoordinator?: ApprovalContinuationContract;
	readonly parallelApprovals?: ParallelApprovalCoordinator;
	readonly clarificationCoordinator?: ClarificationContinuationContract;
	readonly queueCoordinator?: QueueCoordinator;
	readonly compactionCoordinator?: CompactionCoordinatorContract;
	readonly createCompactionCoordinator?: (
		config: NodeRuntimeConfig,
		runSnapshot?: RunExecutionSnapshot,
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
	readonly executionPolicyConfiguration?: ExecutionPolicyConfiguration;
	readonly runSnapshot: RunExecutionSnapshot;
	readonly hooks: readonly RuntimeHookContext[];
	readonly memory?: readonly string[];
}

export interface CompactionCoordinatorContract {
	compact(input: CompactInput): Promise<CompactionResult>;
}

export interface ApprovalPolicyContract {
	beginTurn?(turnId: string): void;
	finishTurn?(turnId: string): void;
	evaluate(
		call: CanonicalToolCall,
		executionPolicy?: ExecutionPolicy,
		turnId?: string,
	): ApprovalPolicyDecision | Promise<ApprovalPolicyDecision>;
	recordResult?(
		call: CanonicalToolCall,
		result: ToolExecutionResult,
		executionPolicy?: ExecutionPolicy,
		turnId?: string,
	): void;
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
		readonly sandboxOverridePolicy?: ExecutionPolicy;
	}): Promise<ApprovalRuntimeResolution>;
	finish(decisionId: string): void;
	recover?(): RuntimeTurnRecord | undefined;
}

export interface ClarificationContinuationContract {
	suspend(input: ClarificationSuspensionInput): PendingClarificationContinuation;
	pending(): PendingClarificationContinuation | undefined;
	cancel(input: { readonly requestId: string }): PendingClarificationContinuation;
	resolve(input: {
		readonly requestId: string;
		readonly response: string;
	}): {
		readonly continuation: PendingClarificationContinuation;
		readonly response: string;
	};
}

export interface ExecutionPolicyCoordinatorContract extends RunExecutionPolicyCoordinator {
	configure(input: ExecutionPolicyConfiguration): void;
	snapshot(): ExecutionPolicySnapshot;
	grant?(input: PermissionGrantInput): PermissionGrant;
	sandboxOverrideProfile?(): ExecutionPolicy;
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
		readonly permissionGrant?: PermissionGrant;
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

type NormalizedFailure = RuntimeFailure & {
	readonly providerFailure?: ProviderFailure;
	readonly reason?: ErrorReasonDetails;
	readonly source?: FailureSource;
};

interface ProviderStepResult {
	readonly assistantText: string;
	readonly usage: ProviderUsage;
	readonly responseId?: string;
	readonly toolCalls: readonly CanonicalToolCall[];
	readonly webSearchCalls: readonly WebSearchCall[];
	readonly providerState?: ProviderReplayState;
}

interface TurnExecutionContext {
	readonly submission: TurnSubmission;
	readonly turnId: string;
	readonly config: NodeRuntimeConfig;
	readonly provider: ModelProvider;
	readonly providerRoute?: ProviderRouteDescriptor;
	readonly instructions: string;
	readonly instructionSnapshot: InstructionSnapshot;
	readonly tools: readonly ToolDefinition[];
	readonly collaborationMode: string;
	readonly executionPolicy?: ExecutionPolicy;
	readonly runSnapshot: RunExecutionSnapshot;
	readonly requestConfig: ProviderRequestConfig;
	readonly emit: (event: RuntimeEvent) => void;
	readonly signal: AbortSignal;
	readonly compactionCoordinator?: CompactionCoordinatorContract;
	readonly hookCoordinator?: HookCoordinator;
	readonly hookContexts: HookContextAccumulator;
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

export class NodeTurnRuntime {
	readonly #options: NodeTurnRuntimeOptions;
	readonly #fallbackInstructionSnapshot: InstructionSnapshot;
	readonly #agentBudget: AgentBudgetTracker;
	readonly #coordinatorBroker: NodeTurnCoordinatorBroker | undefined;
	readonly #defaultProviderStepExecutor: ProviderStepExecutor;
	#providerStepExecutor: ProviderStepExecutor;
	readonly #runExecutions: RunExecutionCoordinator;
	readonly #toolExecutions: ActiveToolExecutionRegistry;
	readonly #toolBatches: ToolBatchCoordinator;
	readonly queueCoordinator: QueueCoordinator | undefined;

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
		const monotonicClock = options.monotonicClock ?? (() => performance.now());
		this.#agentBudget = new AgentBudgetTracker({
			...(options.agentBudget ? { budget: options.agentBudget } : {}),
			clock: monotonicClock,
		});
		this.#runExecutions = new RunExecutionCoordinator({
			...(options.executionPolicyCoordinator
				? { executionPolicyCoordinator: options.executionPolicyCoordinator }
				: {}),
			...(options.resolveToolCatalog ? { resolveToolCatalog: options.resolveToolCatalog } : {}),
			...(options.planTools ? { planTools: options.planTools } : {}),
			...(options.deferredTools ? { deferredTools: options.deferredTools } : {}),
		});
		this.#toolExecutions = new ActiveToolExecutionRegistry({
			clock: monotonicClock,
			...(options.recordDiagnostic ? { recordDiagnostic: options.recordDiagnostic } : {}),
		});
		this.#coordinatorBroker = options.modelInputLedger
			? new NodeTurnCoordinatorBroker({
				sessionId: options.sessionId,
				ledger: options.modelInputLedger,
				...(options.agentEffectLedger ? { effectLedger: options.agentEffectLedger } : {}),
				...(options.providerAttemptLedger ? { attemptLedger: options.providerAttemptLedger } : {}),
				clock: options.clock,
				...(options.createModelInputId ? { createId: options.createModelInputId } : {}),
				})
			: undefined;
		const coordinatorBroker = this.#coordinatorBroker;
		this.#toolBatches = new ToolBatchCoordinator({
			sessionId: options.sessionId,
			store: options.store,
			budget: this.#agentBudget,
			activeTools: this.#toolExecutions,
			...(options.toolRouter ? { toolRouter: options.toolRouter } : {}),
			...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
			...(options.approvalCoordinator
				? { approvalCoordinator: options.approvalCoordinator }
				: {}),
			...(options.parallelApprovals ? { parallelApprovals: options.parallelApprovals } : {}),
			...(options.clarificationCoordinator
				? { clarificationCoordinator: options.clarificationCoordinator }
				: {}),
			...(options.contextItemCoordinator
				? { contextItemCoordinator: options.contextItemCoordinator }
				: {}),
			...(options.agentCheckpoint ? { agentCheckpoint: options.agentCheckpoint } : {}),
			...(options.isMutatingTool ? { isMutatingTool: options.isMutatingTool } : {}),
			...(options.executionPolicyCoordinator?.sandboxOverrideProfile
				? {
					sandboxOverrideProfile: () => options.executionPolicyCoordinator
						?.sandboxOverrideProfile?.(),
				}
				: {}),
			...(coordinatorBroker && options.agentEffectLedger
				? {
					executeToolEffect: async (input, execute) => {
						const attempt = await coordinatorBroker.executeTool({
							attemptId: toolEffectAttemptId(options.sessionId, input.turnId, input.call.callId),
							jobId: input.turnId,
							turnId: input.turnId,
							base: { windowId: input.turnId, version: input.version },
							call: input.call,
							mutating: input.mutating,
						}, execute);
						return attempt.result;
					},
				}
				: {}),
			writeTerminalSnapshot: async (turn) => await this.#writeTerminalSnapshot(turn),
			publishLifecycle: options.publishLifecycle,
		});
		this.#defaultProviderStepExecutor = options.providerStepExecutor
			?? new InProcessProviderStepExecutor();
		this.#providerStepExecutor = this.#defaultProviderStepExecutor;
		this.queueCoordinator = options.queueCoordinator;
	}

	bindProviderStepExecutor(executor: ProviderStepExecutor | undefined): void {
		this.#providerStepExecutor = executor ?? this.#defaultProviderStepExecutor;
	}

	continuationTurnId(): string | undefined {
		return this.#options.parallelApprovals?.pending()?.turnId
			?? this.#options.clarificationCoordinator?.pending()?.turnId
			?? this.#options.approvalCoordinator?.pending()?.turnId;
	}

	hasActiveApproval(decisionId: string): boolean {
		return this.#options.parallelApprovals?.hasActiveApproval(decisionId) === true;
	}

	respondActiveApproval(input: ResolveApprovalInput): void {
		if (!this.#options.parallelApprovals) throw new ApprovalNotPendingError();
		this.#options.parallelApprovals.respond(input);
	}

	agentBudgetExhaustion(): AgentBudgetExhaustionKind | undefined {
		return this.#agentBudget.exhaustion();
	}

	configureExecutionPolicy(input: ExecutionPolicyConfiguration): void {
		this.#runExecutions.configurePolicy(input);
		this.#options.executionPolicyCoordinator?.configure(input);
		this.#options.approvalPolicy?.configurePermissionProfile?.(input.permission);
	}

	#finishTurn(turnId: string): void {
		this.#options.toolRouter?.finishTurn?.(turnId);
		this.#options.approvalPolicy?.finishTurn?.(turnId);
		this.#runExecutions.finish(turnId);
		this.#options.runLifecycle?.finish(turnId);
	}

	configureRuntimeContext(input: {
		readonly collaborationMode: string;
		readonly turnId?: string;
	}): void {
		this.#runExecutions.configureCollaborationMode(input);
	}

	executionPolicySnapshot(): ExecutionPolicySnapshot | undefined {
		return this.#options.executionPolicyCoordinator?.snapshot();
	}

	runExecutionSnapshot(turnId: string): RunExecutionSnapshot | undefined {
		return this.#runExecutions.snapshot(turnId);
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
			...(submission.queueId ? { queueId: submission.queueId } : {}),
			...(submission.inputSource ? { inputSource: submission.inputSource } : {}),
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
				return await this.#finalizeFailure(submission, unsupportedImageFailure(prepared.context, "user", this.#options.store.errorContextVersion), emit);
			}

			const result = await this.#runProviderLoop(prepared.context, prepared.initial);
			retainPolicy = result.status === "in_progress";
			return result;
		} finally {
			if (!retainPolicy) this.#finishTurn(turnId);
		}
	}

	async failReservedTurn(
		reservation: TurnReservation,
		error: unknown,
		emit: (event: RuntimeEvent) => void,
		signal: AbortSignal,
	): Promise<RuntimeTurnRecord> {
		if (reservation.turn.session_id !== this.#options.sessionId) {
			throw new StorageFailure("reserved turn does not belong to runtime session");
		}
		try {
			return await this.#finalizeFailure(
				{ clientTurnId: reservation.turn.client_turn_id },
				normalizeFailure(error, signal, "config_error"),
				emit,
			);
		} finally {
			this.#finishTurn(reservation.turn.turn_id);
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
		this.#options.parallelApprovals?.abortPending();
		this.#options.parallelApprovals?.finish();
		let interrupted = approvalCoordinator?.recover?.();
		if (interrupted && (
			interrupted.client_turn_id !== input.clientTurnId
			|| interrupted.turn_id !== input.turnId
		)) {
			throw new StorageFailure("approval interruption returned a different turn");
		}
		if (!interrupted) {
			const clarificationCoordinator = this.#options.clarificationCoordinator;
			const pendingClarification = clarificationCoordinator?.pending();
			if (pendingClarification?.clientTurnId === input.clientTurnId
				&& pendingClarification.turnId === input.turnId) {
				clarificationCoordinator?.cancel({ requestId: pendingClarification.requestId });
			}
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
		const terminalization = interrupted
			? this.#options.store.turnTerminalizations.load(
				this.#options.sessionId,
				input.clientTurnId,
			)
			: this.#options.store.turnTerminalizations.terminalize({
				kind: "failed",
				sessionId: this.#options.sessionId,
				clientTurnId: input.clientTurnId,
				code: "interrupted",
				message: "turn interrupted",
				completedAt: this.#options.clock(),
			});
		interrupted ??= terminalization?.turn;
		if (!interrupted) throw new StorageFailure("turn interruption did not terminalize the turn");
		this.#toolExecutions.interruptTurn(input.turnId, emit);
		await this.#writeTerminalSnapshot(interrupted);
		this.#finishTurn(input.turnId);
		emit(terminalization
			? projectCommittedTurnTerminalization(terminalization)
			: { type: "turn_interrupted", message: "turn interrupted" });
		return interrupted;
	}

	async resolveApproval(
		input: ResolveApprovalInput,
		emit: (event: RuntimeEvent) => void,
		options: Pick<SubmitTurnOptions, "signal">,
	): Promise<RuntimeTurnRecord> {
		const parallel = this.#options.parallelApprovals?.pending();
		if (parallel) return this.#resolveParallelApproval(input, parallel, emit, options.signal);
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
		let context = await this.#executionContext(
			submission,
			pending.turnId,
			emit,
			options.signal,
			pending.providerProtocol,
			pending.runSnapshot,
		);
		let activeTool: ActiveToolExecutionClaim | undefined;
		const resolution = await coordinator.resolve({
			...input,
			signal: options.signal,
			onExecutionStart: () => {
				activeTool = this.#toolExecutions.begin({
					turnId: pending.turnId,
					callId: pending.callId,
					toolName: pending.toolName,
					interruptErrorKind: "effect_outcome_unknown",
				},
					emit,
				);
			},
			...(context.executionPolicy ? { executionPolicy: context.executionPolicy } : {}),
			...(this.#options.executionPolicyCoordinator?.sandboxOverrideProfile
				? {
					sandboxOverridePolicy: this.#options.executionPolicyCoordinator
						.sandboxOverrideProfile(),
				}
				: {}),
		});
		if (resolution.status === "interrupted") {
			if (activeTool) this.#toolExecutions.interrupt(activeTool, emit);
			await this.#writeTerminalSnapshot(resolution.turn);
			const terminalization = this.#options.store.turnTerminalizations.load(
				this.#options.sessionId,
				pending.clientTurnId,
			);
			emit(terminalization
				? projectCommittedTurnTerminalization(terminalization)
				: { type: "turn_interrupted", message: "turn interrupted" });
			this.#finishTurn(pending.turnId);
			return resolution.turn;
		}
		if (!resolution.continuation) {
			const existing = this.#options.store.loadTurn(
				this.#options.sessionId,
				pending.clientTurnId,
			);
			if (existing && existing.status !== "in_progress") {
				this.#finishTurn(pending.turnId);
				return existing;
			}
			throw new ApprovalNotPendingError();
		}
		if (resolution.toolResult) {
			if (activeTool) this.#toolExecutions.complete(activeTool, resolution.toolResult, emit);
			else emitToolResult(resolution.toolResult, 0, emit);
		}
		if (resolution.permissionGrant) {
			const runSnapshot = this.#runExecutions.refreshPolicy(pending.turnId);
			context = Object.freeze({
				...context,
				runSnapshot,
				...(runSnapshot.policy
					? { executionPolicy: runSnapshot.policy.profile }
					: {}),
			});
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
			this.#finishTurn(pending.turnId);
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
			pending.runSnapshot,
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
			this.#finishTurn(pending.turnId);
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
						submission.queueId
							? `${turnId}:queue:${submission.queueId}`
							: `${turnId}:user:${submission.clientUserMessageId ?? submission.clientTurnId}`,
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
		restoredSnapshot?: RunExecutionSnapshot,
	): Promise<TurnExecutionContext> {
		assertNotAborted(signal);
		if (this.#options.runLifecycle) await this.#options.runLifecycle.prepare(turnId, signal);
		assertNotAborted(signal);
		const runSnapshot = this.#runExecutions.resolve(turnId, restoredSnapshot);
		const collaborationMode = runSnapshot.collaborationMode;
		this.#options.toolRouter?.beginTurn?.(turnId, runSnapshot.toolCatalog);
		this.#options.approvalPolicy?.beginTurn?.(turnId);
		const resolvedConfig = await this.#options.resolveConfig(submission);
		const provider = this.#options.createProvider(resolvedConfig);
		const providerRoute = this.#options.resolveProviderRoute?.(resolvedConfig);
		const capabilities = await provider.resolveCapabilities?.();
		const config = Object.freeze({ ...resolvedConfig,
			supportsImages: resolvedConfig.supportsImages && (capabilities?.supportsImages ?? true),
		});
		const instructionSnapshot = this.#options.resolveInstructionSnapshot?.()
			?? this.#options.modelInputLedger?.loadLatestInstructionSnapshot(this.#options.sessionId)
			?? this.#fallbackInstructionSnapshot;
		const instructions = instructionSnapshot.content;
		const tools = this.#toolExposureForTurn(runSnapshot, turnId, config.supportsImages);
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
			provider,
			...(providerRoute ? { providerRoute } : {}),
			instructions,
			instructionSnapshot,
			hookContexts: new HookContextAccumulator(),
			tools,
			collaborationMode,
			...(runSnapshot.policy ? { executionPolicy: runSnapshot.policy.profile } : {}),
			runSnapshot,
			requestConfig: {
				provider: config.provider,
				protocol: config.protocol,
				model: submission.modelOverride ?? config.model,
				...(config.nativeTransport ? { nativeTransport: config.nativeTransport } : {}),
				reasoningEffort: submission.reasoningEffort
					?? (config.thinkingEnabled ? config.reasoningEffort : "none"),
				sessionId: this.#options.sessionId,
				cacheRetention: config.cacheRetention,
				...((this.#options.maxOutputTokens ?? config.maxOutputTokens) === undefined
					? {}
					: { maxOutputTokens: this.#options.maxOutputTokens ?? config.maxOutputTokens }),
				webSearchMode: config.webSearchMode,
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
				? { compactionCoordinator: this.#options.createCompactionCoordinator(config, runSnapshot) }
				: this.#options.compactionCoordinator
					? { compactionCoordinator: this.#options.compactionCoordinator }
					: {}),
		};
	}

	async #resolveParallelApproval(
		input: ResolveApprovalInput,
		pending: PendingApprovalContinuation,
		emit: (event: RuntimeEvent) => void,
		signal: AbortSignal,
	): Promise<RuntimeTurnRecord> {
		if (input.decisionId !== pending.decisionId) throw new ApprovalNotPendingError();
		const submission: TurnSubmission = {
			clientTurnId: pending.clientTurnId, clientUserMessageId: pending.clientUserMessageId,
			turnId: pending.turnId, message: pending.userMessage,
			...(pending.modelOverride ? { modelOverride: pending.modelOverride } : {}),
			...(pending.reasoningEffort ? { reasoningEffort: pending.reasoningEffort } : {}),
		};
		let retainPolicy = false;
		try {
			const context = await this.#executionContext(
				submission, pending.turnId, emit, signal, pending.providerProtocol, pending.runSnapshot,
			);
			const continuation = await this.#toolBatches.resumeApprovals({ ...input, context });
			const result = await this.#runProviderLoop(context, {
				history: this.#options.store.loadConversationItems(this.#options.sessionId),
				freshItemIds: new Set([`${pending.turnId}:user:${pending.clientUserMessageId}`]),
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
			retainPolicy = result.status === "in_progress";
			return result;
		} catch (error) {
			return await this.#finalizeFailure(submission, normalizeFailure(error, signal, "persistence_error"), emit);
		} finally {
			if (!retainPolicy) this.#finishTurn(pending.turnId);
		}
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
			collaborationMode,
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
		const developerInstructions = Object.freeze([
			...(this.#options.developerInstructions ?? []),
			collaborationModeDeveloperInstruction(collaborationMode),
		]);
		let memoryCollected = false;
		let memoryItem: Extract<CanonicalConversationItem, { readonly type: "user" }> | undefined;
		while (true) {
			let completedToolBatch = false;
			const wallClockExhausted = this.#agentBudget.wallClockExhaustion();
			if (wallClockExhausted) {
				return this.#finalizeAgentBudget(context, wallClockExhausted);
			}
			if (approvalDecisionId) {
				this.#options.approvalCoordinator?.finish(approvalDecisionId);
				approvalDecisionId = undefined;
			}
			if (pendingBatch) {
				try {
					const suspended = await this.#toolBatches.process({
						context,
						batch: pendingBatch,
						accumulatedUsage,
						exposedTools: tools,
					});
					if (suspended) return suspended;
					history = this.#options.store.loadConversationItems(this.#options.sessionId);
					pendingBatch = undefined;
					completedToolBatch = true;
					assertNotAborted(signal);
					const refreshedTools = this.#toolExposureForTurn(context.runSnapshot, turnId, config.supportsImages);
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
							unsupportedImageFailure(context, "user", this.#options.store.errorContextVersion),
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
			if (!config.supportsImages && history.some((item) =>
				(item.type === "user" || item.type === "tool_result") && item.images?.length)) {
				const origin = completedToolBatch ? "tool" : "history";
				return this.#finalizeFailure(submission, unsupportedImageFailure(context, origin, this.#options.store.errorContextVersion), emit);
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
				if (compacted.status !== "not_needed") {
					accumulatedUsage = addUsage(accumulatedUsage, compacted.usage ?? {});
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
					freshItemIds.clear();
				}
			}
			if (completedToolBatch && context.compactionCoordinator) {
				let compacted: CompactionResult;
				try {
					compacted = await this.#compactContext(
						context,
						"mid_turn",
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
				if (compacted.status === "interrupted") {
					return this.#finalizeFailure(submission, {
						code: "interrupted",
						message: "turn interrupted",
						retryable: false,
					}, emit);
				}
				accumulatedUsage = addUsage(accumulatedUsage, compacted.usage ?? {});
				if (compacted.status === "compressed") {
					const invalidation = this.#invalidateProviderContinuation("compacted_history");
					if (invalidation) return this.#finalizeFailure(submission, invalidation, emit);
					history = compacted.providerConversation;
					previousResponseId = undefined;
					freshItemIds.clear();
				}
			}
			if (!memoryCollected) {
				memoryCollected = true;
				memoryItem = await this.#collectMemoryItem(context);
			}
			const providerBudgetExhausted = this.#agentBudget.beginProviderStep();
			if (providerBudgetExhausted) {
				return this.#finalizeAgentBudget(context, providerBudgetExhausted);
			}
			let requestSignature: string;
			let durableRequestId: string | undefined;
			let durableProviderStep: number | undefined;
			let durableTimelineWindowId: string | undefined;
			let logicalRequest: ProviderRequest;
			if (this.#coordinatorBroker) {
				try {
					const hookContexts = context.hookContexts.snapshot();
					const collectedSources = this.#options.contextSources?.({
						submission,
						config,
						tools,
						...(context.executionPolicy ? { executionPolicy: context.executionPolicy } : {}),
						...(context.runSnapshot.policy?.configuration ? {
							executionPolicyConfiguration: context.runSnapshot.policy.configuration,
						} : {}),
						runSnapshot: context.runSnapshot,
						hooks: hookContexts,
						...(memoryItem ? { memory: [memoryItem.text] } : {}),
					}) ?? {};
					const providerStep = this.#coordinatorBroker.nextProviderStep(turnId);
					const committed = this.#coordinatorBroker.commitProviderStep({
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
							collaborationMode,
							executionPolicy: context.executionPolicy,
							executionPolicyConfiguration:
								context.runSnapshot.policy?.configuration,
						}),
						maxPromptTokens: config.maxPromptTokens,
						...(this.#options.modelInputTokenCounter
							? { tokenCounter: this.#options.modelInputTokenCounter }
							: {}),
					});
					requestSignature = committed.requestSignature;
					durableRequestId = committed.manifest.requestId;
					durableProviderStep = committed.manifest.providerStep;
					durableTimelineWindowId = committed.manifest.timelineWindowId;
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
					developerInstructions,
					tools,
				});
				logicalRequest = projectProviderRequest({
					config: requestConfig,
					instructions,
					developerInstructions,
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
			const retryPolicy = resolveProviderRetryPolicy(config, request.provider);
			try {
				this.#options.agentCheckpoint?.({
					kind: "provider_turn",
					committed: false,
					turnId,
				});
				if (durableRequestId) {
					this.#coordinatorBroker?.recordProviderStep(durableRequestId, "dispatch_started", {
						provider_step: durableProviderStep ?? this.#agentBudget.providerStepCount(),
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
			let rawStepResult;
			try {
				rawStepResult = await this.#providerStepExecutor.execute({
					errorContextVersion: this.#options.store.errorContextVersion,
					config,
					provider,
					...(context.providerRoute ? { providerRoute: context.providerRoute } : {}),
					request,
					retryPolicy,
					...(durableRequestId ? { requestId: durableRequestId } : {}),
					...(durableRequestId && this.#options.providerAttemptLedger ? {
						recordAttempt: async (update: ProviderAttemptUpdate): Promise<void> => {
							const record = this.#coordinatorBroker!.recordProviderAttempt({
								turnId, requestId: durableRequestId, provider: request.provider, model: request.model,
								source: this.#providerStepExecutor.attemptSource ?? "in_process", update,
							});
							emit({ type: "provider_attempt", record });
						},
					} : {}),
					clock: this.#options.clock,
					timelineWindowId: durableTimelineWindowId ?? turnId,
					timelineVersion: durableProviderStep ?? this.#agentBudget.providerStepCount(),
					maxRetries: config.streamMaxRetries,
					emit,
					signal,
					toolCallsAllowed: Boolean(this.#options.toolRouter),
					recordDiagnostic: (diagnostic) => publishRuntimeDiagnostic(
						this.#options.recordDiagnostic,
						{
							kind: "model_stream_diagnostics",
							turnId,
							provider: config.provider,
							protocol: config.protocol,
							model: config.model,
							...diagnostic,
						},
					),
					...(this.#options.sleep ? { sleep: this.#options.sleep } : {}),
					...(this.#options.random ? { random: this.#options.random } : {}),
				});
			} catch (error) {
				return this.#finalizeFailure(
					submission,
					normalizeFailure(error, signal, "provider_error"),
					emit,
				);
			}
			if ("failure" in rawStepResult) {
				if (durableRequestId) {
					try {
						this.#coordinatorBroker?.recordProviderStep(durableRequestId, "failed", {
							code: rawStepResult.failure.code,
							retryable: rawStepResult.failure.retryable,
							events_observed: rawStepResult.eventsObserved,
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
					rawStepResult.failure.code === "context_window_exceeded"
					&& rawStepResult.eventsObserved === 0
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
					accumulatedUsage = addUsage(accumulatedUsage, compacted.usage ?? {});
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
						freshItemIds.clear();
						continue;
					}
				}
				return this.#finalizeFailure(submission, rawStepResult.failure, emit);
			}
			const stepResult = providerStepWithReplayTokenEstimate(rawStepResult);
			try {
				this.#persistWebSearchCalls(turnId, stepResult.webSearchCalls);
			} catch (error) {
				return this.#finalizeFailure(
					submission,
					normalizeFailure(error, signal, "persistence_error"),
					emit,
				);
			}
			if (Object.keys(stepResult.usage).length > 0) {
				emit({ type: "provider_usage", usage: Object.freeze({ ...stepResult.usage }) });
			}
			if (durableRequestId) {
				try {
					this.#coordinatorBroker?.recordProviderStep(durableRequestId, "acknowledged", {
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
			accumulatedUsage = addUsage(accumulatedUsage, stepResult.usage);
			const budgetObservation = this.#agentBudget.observeProviderOutput({
				usage: accumulatedUsage,
				assistantText: stepResult.assistantText,
				toolCallCount: stepResult.toolCalls.length,
			});
			if (budgetObservation.exhaustion) {
				return this.#finalizeAgentBudget(context, budgetObservation.exhaustion);
			}

			if (stepResult.toolCalls.length === 0) {
				if (budgetObservation.retryEmptyOutput) {
					previousResponseId = stepResult.responseId;
					continue;
				}
				return this.#finalizePreparedTurn(context, stepResult, accumulatedUsage, {
					requestConfig,
					requestSignature,
					requestInput: logicalRequest.items ?? history,
				});
			}
			if (!hasUniqueCallIds(stepResult.toolCalls)) {
				return this.#finalizeFailure(submission, toolProtocolFailure(), emit);
			}

			if (config.protocol === "responses" && !stepResult.responseId) {
				return this.#finalizeFailure(submission, toolProtocolFailure(), emit);
			}
			if (!this.#options.toolRouter) {
				return this.#finalizeFailure(submission, unsupportedToolFailure(), emit);
			}
			const toolBudgetExhausted = this.#agentBudget.reserveToolCalls(stepResult.toolCalls.length);
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

	#persistWebSearchCalls(turnId: string, calls: readonly WebSearchCall[]): void {
		const append = this.#options.store.appendDisplayActivity;
		if (!append) return;
		for (const call of calls) {
			const presentation = webSearchPresentation(call.action);
			append.call(this.#options.store, {
				sessionId: this.#options.sessionId,
				eventId: `web-search:${modelInputSha256([
					this.#options.sessionId,
					turnId,
					call.callId,
				])}`,
				turnId,
				activityType: "web_search",
				text: presentation.detail,
				callId: call.callId,
				status: "completed",
				metadata: presentation.metadata,
				createdAt: this.#options.clock(),
			});
		}
	}

	#toolExposureForTurn(
		runSnapshot: RunExecutionSnapshot,
		turnId: string,
		supportsImages: boolean,
	): readonly ToolDefinition[] {
		return toolExposureForSnapshot(
			runSnapshot.toolCatalog,
			this.#options.loadToolActivations?.(turnId) ?? [],
		).filter((tool) => supportsImages || tool.name !== "view_image");
	}

	async #finalizePreparedTurn(
		context: TurnExecutionContext,
		stepResult: ProviderStepResult,
		accumulatedUsage: ProviderUsage,
		continuation: Readonly<{
			readonly requestConfig: ProviderRequestConfig;
			readonly requestSignature: string;
			readonly requestInput: readonly CanonicalConversationItem[];
		}>,
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
			continuation,
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

	async #compactContext(
		context: TurnExecutionContext,
		source: "pre_turn" | "mid_turn" | "context_overflow",
		conversation: readonly CanonicalConversationItem[],
		freshItemIds: ReadonlySet<string>,
	): Promise<CompactionResult> {
		const coordinator = context.compactionCoordinator;
		if (!coordinator) throw new StorageFailure("compaction coordinator is not configured");
		const startedAt = this.#options.monotonicClock?.() ?? performance.now();
		const result = await coordinator.compact({
			clientTurnId: context.submission.clientTurnId,
			turnId: context.turnId,
			source,
			conversation,
			freshItemIds: new Set(freshItemIds),
			emit: context.emit,
			signal: context.signal,
		});
		const finishedAt = this.#options.monotonicClock?.() ?? performance.now();
		publishRuntimeDiagnostic(this.#options.recordDiagnostic, {
			kind: "compaction",
			turnId: context.turnId,
			source,
			status: result.status,
			beforeTokens: result.beforeTokens,
			afterTokens: result.afterTokens,
			maxTokens: context.config.maxPromptTokens,
			durationMs: boundedDurationMs(startedAt, finishedAt),
		});
		return result;
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

	async #finalizeAgentBudget(
		context: TurnExecutionContext,
		kind: AgentBudgetExhaustionKind,
	): Promise<RuntimeTurnRecord> {
		this.#agentBudget.markExhausted(kind);
		return this.#finalizeFailure(context.submission, {
			code: "tool_budget_exceeded",
			message: `agent budget exhausted: ${kind}`,
			retryable: false,
		}, context.emit);
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
		continuation: Readonly<{
			readonly requestConfig: ProviderRequestConfig;
			readonly requestSignature: string;
			readonly requestInput: readonly CanonicalConversationItem[];
		}>,
	): Promise<RuntimeTurnRecord> {
		try {
			assertNotAborted(signal);
			const now = (): number => this.#options.monotonicClock?.() ?? performance.now();
			const startedAt = now();
			const terminalization = this.#options.store.turnTerminalizations.terminalize({
				kind: "completed",
				sessionId: this.#options.sessionId,
				clientTurnId: submission.clientTurnId,
				assistantText,
				usage,
				lastTokenUsage,
				...(responseId ? { responseId } : {}),
				...(providerState ? { providerState } : {}),
				completedAt: this.#options.clock(),
			});
			const completed = terminalization.turn;
			const committedAt = now();
			const continuationFailure = this.#recordSafeProviderCompletion({
				requestConfig: continuation.requestConfig,
				requestSignature: continuation.requestSignature,
				historyBoundary: completed.turn_id,
				requestInput: continuation.requestInput,
				stepResult: {
					assistantText,
					toolCalls: Object.freeze([]),
					webSearchCalls: Object.freeze([]),
					usage: lastTokenUsage,
					...(responseId ? { responseId } : {}),
					...(providerState ? { providerState } : {}),
				},
			});
			if (continuationFailure) {
				try {
					this.#options.providerContinuation?.invalidate("continuation_persistence_failed");
				} catch {
					// Canonical replay remains valid when optional provider continuation state fails.
				}
			}
			const continuationFinishedAt = now();
			const snapshotWritten = await this.#writeTerminalSnapshot(completed);
			const snapshotFinishedAt = now();
			emit(projectCommittedTurnTerminalization(terminalization));
			const publishedAt = now();
			publishRuntimeDiagnostic(this.#options.recordDiagnostic, {
				kind: "turn_completion_diagnostics",
				turnId: completed.turn_id,
				commitMs: boundedDurationMs(startedAt, committedAt),
				continuationMs: boundedDurationMs(committedAt, continuationFinishedAt),
				snapshotMs: boundedDurationMs(continuationFinishedAt, snapshotFinishedAt),
				publishMs: boundedDurationMs(snapshotFinishedAt, publishedAt),
				elapsedMs: boundedDurationMs(startedAt, publishedAt),
				snapshotWritten,
			});
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
		submission: Pick<TurnSubmission, "clientTurnId">,
		failure: NormalizedFailure,
		emit: (event: RuntimeEvent) => void,
	): Promise<RuntimeTurnRecord> {
		let terminalization: StoredTurnTerminalization;
		let turnId = submission.clientTurnId;
		try {
			const existing = this.#options.store.loadTurn(
				this.#options.sessionId,
				submission.clientTurnId,
			);
			turnId = existing?.turn_id ?? turnId;
			if (existing && existing.status !== "in_progress") return existing;
			if (this.#options.store.errorContextVersion === 1 && !failure.errorContext
				&& failure.diagnostics?.error_context_invalid !== true) {
				const scope = { kind: "turn" as const, id: existing?.turn_id ?? submission.clientTurnId };
				const errorContext = failure.providerFailure
					? providerFailureToRuntimeFailure(failure.providerFailure, { scope, errorContextVersion: 1 }).errorContext!
					: createErrorContext({ ...(failure.reason ?? { reason: legacyRuntimeReason(failure.code) }),
						source: failure.source ?? "runtime", scope,
						outcome: { state: failure.code === "interrupted" ? "cancelled" : "failed", effects: "possible" },
					});
				failure = { ...failure, errorContext, message: errorSummary(errorContext) };
			}
			try {
				this.#options.providerContinuation?.invalidate(
					failure.code === "interrupted" ? "turn_interrupted" : "turn_failed",
				);
			} catch {
				// The terminal turn still has to be closed even if continuation cleanup fails.
			}
			terminalization = this.#options.store.turnTerminalizations.terminalize({
				kind: "failed",
				sessionId: this.#options.sessionId,
				clientTurnId: submission.clientTurnId,
					code: failure.code,
					message: failure.message,
					...(failure.additionalDetails
						? { additionalDetails: failure.additionalDetails }
						: {}),
					...(failure.diagnostics ? { diagnostics: failure.diagnostics } : {}),
					...(failure.errorContext ? { errorContext: failure.errorContext } : {}),
				completedAt: this.#options.clock(),
			});
		} catch (error) {
			const persistence = normalizeFailure(error, undefined, "persistence_error");
			const errorContext = this.#options.store.errorContextVersion === 1 ? createErrorContext({
				reason: error instanceof StorageFailure && error.reason !== "storage.failure_unclassified" ? error.reason : "storage.write_failed",
				source: "storage", scope: { kind: "turn", id: turnId }, details: { operation: "commit",
					...(typeof persistence.diagnostics?.sqlite_code === "string" ? { storage_code: persistence.diagnostics.sqlite_code } : {}),
				},
				outcome: { state: "unknown", effects: "possible" },
				...(failure.errorContext ? { causes: [errorOccurrence(failure.errorContext), ...(failure.errorContext.causes ?? [])] } : {}),
			}) : undefined;
			publishRuntimeDiagnostic(this.#options.recordDiagnostic, {
				kind: "runtime_error", operation: "terminal_commit", ...(errorContext ? { errorContext } : {}),
			});
			emit({
				type: "runtime_error",
				code: "persistence_error",
				message: errorContext ? errorSummary(errorContext) : persistence.message,
				...(errorContext ? { errorContext } : {}),
			});
			throw error;
		}
		const failed = terminalization.turn;
		await this.#writeTerminalSnapshot(failed);
		emit(projectCommittedTurnTerminalization(terminalization));
		return failed;
	}

	async #writeTerminalSnapshot(turn: RuntimeTurnRecord): Promise<boolean> {
		if (!this.#options.writeTerminalSnapshot) return true;
		try {
			await this.#options.writeTerminalSnapshot(turn);
			return true;
		} catch {
			publishRuntimeDiagnostic(this.#options.recordDiagnostic, {
				kind: "runtime_error", operation: "terminal_projection",
				...(this.#options.store.errorContextVersion === 1 ? { errorContext: createErrorContext({
					reason: "storage.write_failed", source: "storage", scope: { kind: "turn", id: turn.turn_id },
					details: { operation: "projection" }, outcome: { state: "completed", effects: "confirmed" },
				}) } : {}),
			});
			return false;
		}
	}
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
		return {
			code: "interrupted",
			message: runtimeErrorPublicMessage("interrupted"),
			retryable: false,
			...(signal?.reason instanceof UserTurnCancellation || error instanceof UserTurnCancellation
				? { reason: { reason: "runtime.user_cancelled" as const } } : {}),
		};
	}
	if (error instanceof AgentBudgetExhaustedError) {
		return {
			code: "tool_budget_exceeded",
			message: `${runtimeErrorPublicMessage("tool_budget_exceeded")}: ${error.kind}`,
			retryable: false,
		};
	}
	if (error instanceof ProviderFailure) {
		return { ...providerFailureToRuntimeFailure(error), providerFailure: error,
			reason: providerFailureReason(error), source: error.source };
	}
	if (error instanceof StorageFailure) {
		return {
			code: "persistence_error",
			message: runtimeErrorPublicMessage("persistence_error"),
			retryable: false,
			source: "storage",
			reason: { reason: error.reason, details: {
				...(typeof error.diagnostics.sqlite_code === "string" ? { storage_code: error.diagnostics.sqlite_code } : {}),
				...(typeof error.diagnostics.expected_version === "number" ? { expected_version: error.diagnostics.expected_version } : {}),
				...(typeof error.diagnostics.actual_version === "number" ? { actual_version: error.diagnostics.actual_version } : {}),
			} },
			...(Object.keys(error.diagnostics).length > 0 ? { diagnostics: error.diagnostics } : {}),
		};
	}
	if (isFailureLike(error)) {
		const context = readErrorContext("errorContext" in error ? error.errorContext : undefined);
		return {
			code: error.code,
			message: runtimeErrorPublicMessage(error.code),
			retryable: error.retryable === true,
			...(context ? { errorContext: context, message: errorSummary(context) } : {}),
		};
	}
	const errorContext = readErrorContext(typeof error === "object" && error !== null && "errorContext" in error ? error.errorContext : undefined);
	return {
		code: fallbackCode,
		message: runtimeErrorPublicMessage(fallbackCode),
		retryable: false,
		...(errorContext ? { errorContext, message: errorSummary(errorContext) } : {}),
		...(fallbackCode === "persistence_error" ? { source: "storage" as const,
			reason: { reason: storageErrorReason(typeof error === "object" && error !== null && "code" in error
				&& typeof error.code === "string" ? error.code : undefined) } } : {}),
	};
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

function configFailure(message: string): ProviderFailure {
	return new ProviderFailure({ code: "config_error", message });
}

function unsupportedToolFailure(): NormalizedFailure {
	return {
		code: "unsupported_capability",
		reason: { reason: "capability.tool_calls_unsupported" },
		message: runtimeErrorPublicMessage("unsupported_capability"),
		retryable: false,
	};
}

function unsupportedImageFailure(
	context: TurnExecutionContext,
	inputOrigin: "user" | "tool" | "history",
	errorContextVersion: 1 | undefined,
): NormalizedFailure {
	return providerFailureToRuntimeFailure(new ProviderFailure({
		code: "unsupported_capability", message: "model configuration does not support image input",
		errorReason: { reason: "capability.image_input_unsupported", details: {
			model: context.config.model, provider: context.config.provider, input_origin: inputOrigin,
		} },
		outcome: { state: "failed", effects: inputOrigin === "tool" ? "possible" : "none" },
	}), { scope: { kind: "turn", id: context.turnId }, errorContextVersion });
}

function toolProtocolFailure(): NormalizedFailure {
	return {
		code: "tool_protocol_error",
		message: runtimeErrorPublicMessage("tool_protocol_error"),
		retryable: false,
	};
}

function addUsage(left: ProviderUsage, right: ProviderUsage): ProviderUsage {
	const accumulated: Record<string, number> = { ...left };
	for (const [key, value] of Object.entries(right)) {
		accumulated[key] = (accumulated[key] ?? 0) + value;
	}
	return accumulated;
}

function providerStepWithReplayTokenEstimate(step: ProviderStepResult): ProviderStepResult {
	if (!step.providerState) return step;
	const tokenEstimate = step.usage.reasoning_tokens ?? step.usage.reasoningTokens;
	if (typeof tokenEstimate !== "number"
		|| !Number.isSafeInteger(tokenEstimate)
		|| tokenEstimate < 0) return step;
	return Object.freeze({
		...step,
		providerState: Object.freeze({
			...step.providerState,
			tokenEstimate,
		}),
	});
}

function hasUniqueCallIds(calls: readonly CanonicalToolCall[]): boolean {
	const callIds = new Set(calls.map((call) => call.callId));
	return callIds.size === calls.length;
}

function webSearchPresentation(action: WebSearchAction): Readonly<{
	readonly detail: string;
	readonly metadata: Readonly<Record<string, string | readonly string[]>>;
}> {
	switch (action.type) {
		case "search": {
			const query = action.query ?? action.queries?.[0] ?? "";
			const detail = !action.query && (action.queries?.length ?? 0) > 1 && query
				? `${query} ...`
				: query;
			return Object.freeze({
				detail,
				metadata: Object.freeze({
					action_type: action.type,
					...(action.query ? { query: action.query } : {}),
					...(action.queries && action.queries.length > 0
						? { queries: Object.freeze([...action.queries]) }
						: {}),
				}),
			});
		}
		case "open_page":
			return Object.freeze({
				detail: action.url ?? "",
				metadata: Object.freeze({
					action_type: action.type,
					...(action.url ? { url: action.url } : {}),
				}),
			});
		case "find_in_page": {
			const detail = action.pattern && action.url
				? `'${action.pattern}' in ${action.url}`
				: action.pattern
					? `'${action.pattern}'`
					: action.url ?? "";
			return Object.freeze({
				detail,
				metadata: Object.freeze({
					action_type: action.type,
					...(action.url ? { url: action.url } : {}),
					...(action.pattern ? { pattern: action.pattern } : {}),
				}),
			});
		}
		case "other":
			return Object.freeze({
				detail: "",
				metadata: Object.freeze({ action_type: action.type }),
			});
	}
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
	return isRuntimeErrorCode(error.code);
}
