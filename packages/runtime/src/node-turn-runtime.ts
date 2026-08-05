import type { NodeRuntimeConfig } from "@mycli/config";
import {
	fingerprintSubmission,
	projectProviderRequest,
} from "@mycli/core";
import type {
	CanonicalConversationItem,
	CanonicalToolCall,
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
	ToolExecutionResult,
	ToolRouterContract,
} from "@mycli/tools";
import {
	StorageFailure,
} from "@mycli/storage";
import type { TurnReservation, TurnStore } from "@mycli/storage";
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

export interface TurnSubmission {
	readonly clientTurnId: string;
	readonly turnId?: string;
	readonly message: string;
	readonly localImages?: readonly string[];
	readonly modelOverride?: string;
	readonly reasoningEffort?: ReasoningEffort;
}

export interface NodeTurnRuntimeOptions {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly instructions: string;
	readonly store: TurnStore;
	readonly resolveConfig: (
		submission: TurnSubmission,
	) => NodeRuntimeConfig | Promise<NodeRuntimeConfig>;
	readonly createProvider: (config: NodeRuntimeConfig) => ModelProvider;
	readonly createTurnId: () => string;
	readonly clock: () => string;
	readonly maxOutputTokens?: number;
	readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
	readonly random?: () => number;
	readonly monotonicClock?: () => number;
	readonly planTools?: (capabilities: { readonly shell: boolean }) => readonly ToolDefinition[];
	readonly executionPolicyCoordinator?: ExecutionPolicyCoordinatorContract;
	readonly toolRouter?: ToolRouterContract;
	readonly approvalPolicy?: ApprovalPolicyContract;
	readonly approvalCoordinator?: ApprovalContinuationContract;
	readonly queueCoordinator?: QueueCoordinator;
	readonly compactionCoordinator?: CompactionCoordinatorContract;
	readonly createCompactionCoordinator?: (
		config: NodeRuntimeConfig,
	) => CompactionCoordinatorContract;
	readonly memoryContextService?: MemoryContextServiceContract;
	readonly providerContinuation?: ProviderContinuationContract;
	readonly writeTerminalSnapshot?: (turn: RuntimeTurnRecord) => Promise<void>;
	readonly publishLifecycle: (event: ShellLifecycleEvent) => void;
}

export interface CompactionCoordinatorContract {
	compact(input: CompactInput): Promise<CompactionResult>;
}

export interface ApprovalPolicyContract {
	evaluate(call: CanonicalToolCall): ApprovalPolicyDecision | Promise<ApprovalPolicyDecision>;
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

export interface SubmitTurnOptions {
	readonly signal: AbortSignal;
	readonly reservation?: TurnReservation;
}

interface NormalizedFailure {
	readonly code: RuntimeErrorCode;
	readonly message: string;
	readonly retryable: boolean;
	readonly retryAfterSeconds?: number;
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
	readonly tools: readonly ToolDefinition[];
	readonly executionPolicy?: ExecutionPolicy;
	readonly requestConfig: ProviderRequestConfig;
	readonly emit: (event: RuntimeEvent) => void;
	readonly signal: AbortSignal;
	readonly compactionCoordinator?: CompactionCoordinatorContract;
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

export class NodeTurnRuntime {
	readonly #options: NodeTurnRuntimeOptions;
	readonly queueCoordinator: QueueCoordinator | undefined;

	constructor(options: NodeTurnRuntimeOptions) {
		this.#options = options;
		this.queueCoordinator = options.queueCoordinator;
	}

	configureExecutionPolicy(input: ExecutionPolicyConfiguration): void {
		this.#options.executionPolicyCoordinator?.configure(input);
	}

	reserve(submission: TurnSubmission): TurnReservation {
		const turnId = submission.turnId ?? this.#options.createTurnId();
		return this.#options.store.reserveTurn({
			sessionId: this.#options.sessionId,
			clientTurnId: submission.clientTurnId,
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
			if ((submission.localImages?.length ?? 0) > 0) {
				const failed = await this.#finalizeFailure(submission, {
					code: "unsupported_capability",
					message: "local images are not supported by the Node runtime",
					retryable: false,
				}, emit);
				return failed;
			}

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

			const result = await this.#runProviderLoop(prepared.context, prepared.initial);
			retainPolicy = result.status === "in_progress";
			return result;
		} finally {
			if (!retainPolicy) this.#options.executionPolicyCoordinator?.finishTurn(turnId);
		}
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
		let startedAt: number | undefined;
		const resolution = await coordinator.resolve({
			...input,
			signal: options.signal,
			onExecutionStart: () => {
				startedAt = this.#options.monotonicClock?.() ?? performance.now();
				emit({
					type: "tool_execution_started",
					callId: boundedCallId(pending.callId),
					toolName: boundedToolName(pending.toolName),
				});
			},
			...(context.executionPolicy ? { executionPolicy: context.executionPolicy } : {}),
		});
		if (resolution.status === "interrupted") {
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
			const finishedAt = this.#options.monotonicClock?.() ?? performance.now();
			emitToolResult(
				resolution.toolResult,
				startedAt === undefined ? 0 : boundedDurationMs(startedAt, finishedAt),
				emit,
			);
		}
		const continuation = resolution.continuation;
		const resumed = await this.#runProviderLoop(context, {
			history: this.#options.store.loadConversationItems(this.#options.sessionId),
			freshItemIds: new Set([
				`${pending.turnId}:user:${pending.clientTurnId}`,
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

	async #prepareTurn(
		submission: TurnSubmission,
		turnId: string,
		emit: (event: RuntimeEvent) => void,
		signal: AbortSignal,
	): Promise<PreparedTurn> {
		const context = await this.#executionContext(submission, turnId, emit, signal);
		const history = this.#conversationForCurrentSubmission(submission.message);
		return Object.freeze({
			context,
			initial: Object.freeze({
				history,
				freshItemIds: new Set([`${turnId}:user:${submission.clientTurnId}`]),
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
			tools: this.#options.planTools?.({ shell: turnPolicy?.toolsEnabled ?? false }) ?? [],
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
				...(this.#options.maxOutputTokens === undefined
					? {}
					: { maxOutputTokens: this.#options.maxOutputTokens }),
			},
			emit,
			signal,
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
		const { submission, turnId, config, provider, tools, requestConfig, emit, signal } = context;
		let history = initial.history;
		let previousResponseId = initial.previousResponseId;
		let accumulatedUsage = initial.accumulatedUsage;
		let pendingBatch = initial.pendingBatch;
		let approvalDecisionId = initial.approvalDecisionId;
		const freshItemIds = new Set(initial.freshItemIds);
		let preTurnCompactionChecked = initial.preTurnCompactionChecked ?? false;
		let compactionEntered = initial.compactionEntered ?? false;
		while (true) {
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
					for (const record of committed) {
						freshItemIds.add(`${turnId}:queue:${record.queueId}`);
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
			const providerHistory = await this.#providerHistoryWithMemory(context, history);
			const requestSignature = buildProviderRequestSignature({
				...requestConfig,
				instructions: this.#options.instructions,
				tools,
			});
			const continuation = this.#selectProviderContinuation(
				requestConfig,
				requestSignature,
				turnId,
				previousResponseId,
			);
			const request = projectProviderRequest({
				config: requestConfig,
				instructions: this.#options.instructions,
				history: providerHistory,
				tools,
				...(continuation ? { previousResponseId: continuation } : {}),
			});
			const stepResult = await this.#streamWithRetry(
				provider,
				request,
				config.streamMaxRetries,
				emit,
				signal,
				Boolean(this.#options.toolRouter),
			);
			if ("failure" in stepResult) {
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
			const continuationFailure = this.#recordSafeProviderCompletion({
				requestConfig,
				requestSignature,
				historyBoundary: turnId,
				requestInput: providerHistory,
				stepResult,
			});
			if (continuationFailure) {
				return this.#finalizeFailure(submission, continuationFailure, emit);
			}
			accumulatedUsage = addUsage(accumulatedUsage, stepResult.usage);

			if (stepResult.toolCalls.length === 0) {
				return this.#finalizePreparedTurn(context, stepResult, accumulatedUsage);
			}
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

	async #finalizePreparedTurn(
		context: TurnExecutionContext,
		stepResult: ProviderStepResult,
		accumulatedUsage: ProviderUsage,
	): Promise<RuntimeTurnRecord> {
		const { submission, turnId, config, emit, signal } = context;
		try {
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
	): string | undefined {
		if (requestConfig.protocol !== "responses") return undefined;
		const coordinator = this.#options.providerContinuation;
		if (!coordinator) return fallbackResponseId;
		const decision = coordinator.select({
			protocol: requestConfig.protocol,
			requestSignature,
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

	async #providerHistoryWithMemory(
		context: TurnExecutionContext,
		history: readonly CanonicalConversationItem[],
	): Promise<readonly CanonicalConversationItem[]> {
		const service = this.#options.memoryContextService;
		if (!service || !context.config.memoryEnabled) return history;
		try {
			const memory = await service.collect({
				userMessage: context.submission.message,
				sessionId: this.#options.sessionId,
				enabled: true,
				signal: context.signal,
			});
			if (!memory.item) return history;
			return insertMemoryBeforeCurrentInput(
				history,
				memory.item,
				context.submission.message,
			);
		} catch {
			return history;
		}
	}

	async #processToolBatch(
		context: TurnExecutionContext,
		batch: PendingToolBatch,
		accumulatedUsage: ProviderUsage,
	): Promise<RuntimeTurnRecord | undefined> {
		const { submission, turnId, config, emit, signal } = context;
		for (const [index, call] of batch.calls.entries()) {
			assertNotAborted(signal);
			const policy = await this.#options.approvalPolicy?.evaluate(call);
			if (policy?.kind === "request") {
				const coordinator = this.#options.approvalCoordinator;
				if (!coordinator) {
					throw new ProviderFailure({
						code: "unsupported_capability",
						message: "approval continuation is not configured",
					});
				}
				const pending = coordinator.suspend({
					clientTurnId: submission.clientTurnId,
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

			const result = policy?.kind === "deny"
				? policyDeniedResult(call, policy)
				: await this.#executeTool(call, context);
			if (policy?.kind === "deny") emitToolResult(result, 0, emit);
			this.#persistToolResult(submission.clientTurnId, result);
			assertNotAborted(signal);
		}
		return undefined;
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
		const startedAt = this.#options.monotonicClock?.() ?? performance.now();
		emit({
			type: "tool_execution_started",
			callId: boundedCallId(call.callId),
			toolName: boundedToolName(call.name),
		});
		let result: ToolExecutionResult;
		try {
			result = await router.execute(call, {
				signal,
				ownerSessionId: this.#options.sessionId,
				callId: call.callId,
				publishLifecycle: this.#options.publishLifecycle,
				...(context.executionPolicy ? { executionPolicy: context.executionPolicy } : {}),
			});
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw error;
			assertNotAborted(signal);
			throw new ProviderFailure({
				code: "provider_error",
				message: "tool execution failed",
				diagnostics: { tool_name: boundedToolName(call.name) },
			});
		}
		const finishedAt = this.#options.monotonicClock?.() ?? performance.now();
		emitToolResult(result, boundedDurationMs(startedAt, finishedAt), emit);
		return result;
	}

	#persistToolResult(clientTurnId: string, result: ToolExecutionResult): void {
		this.#options.store.appendToolResult({
			sessionId: this.#options.sessionId,
			clientTurnId,
			result: toCanonicalResult(result),
			summary: result.summary,
			metadata: result.metadata,
			...(result.errorKind ? { errorKind: result.errorKind } : {}),
		});
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
				...(responseId ? { responseId } : {}),
				...(providerState ? { providerState } : {}),
				completedAt: this.#options.clock(),
			});
			const snapshotWritten = await this.#writeTerminalSnapshot(completed);
			emit({ type: "turn_completed", assistantText, usage });
			if (snapshotWritten && memoryEnabled && this.#options.memoryContextService) {
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

function continuationRecord(item: CanonicalConversationItem): Readonly<Record<string, unknown>> {
	if (item.type === "assistant_tool_calls") {
		return {
			...item,
			calls: item.calls.map((call) => ({ ...call })),
		};
	}
	return { ...item };
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
		}];
	}
	return step.assistantText ? [{ type: "assistant", text: step.assistantText }] : [];
}

function normalizeFailure(
	error: unknown,
	signal: AbortSignal | undefined,
	fallbackCode: RuntimeErrorCode,
): NormalizedFailure {
	if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
		return { code: "interrupted", message: "turn interrupted", retryable: false };
	}
	if (error instanceof ProviderFailure) {
		return {
			code: error.code,
			message: publicMessage(error.code),
			retryable: error.retryable,
			...(error.retryAfterSeconds === undefined
				? {}
				: { retryAfterSeconds: error.retryAfterSeconds }),
		};
	}
	if (error instanceof StorageFailure) {
		return { code: "persistence_error", message: "session persistence failed", retryable: false };
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

function addUsage(left: ProviderUsage, right: ProviderUsage): ProviderUsage {
	const accumulated: Record<string, number> = { ...left };
	for (const [key, value] of Object.entries(right)) {
		accumulated[key] = (accumulated[key] ?? 0) + value;
	}
	return accumulated;
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
