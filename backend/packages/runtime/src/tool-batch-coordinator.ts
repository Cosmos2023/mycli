import type { NodeRuntimeConfig } from "@mycli/config";
import {
	AgentBudgetExhaustedError,
	type CanonicalToolCall,
	type ProviderUsage,
	type ReasoningEffort,
	type RuntimeEvent,
	type ShellLifecycleEvent,
	type ToolDefinition,
} from "@mycli/core";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import { ProviderFailure } from "@mycli/providers";
import {
	StorageFailure,
	type AgentRuntimeCheckpoint,
	type AppendContextItemInput,
	type RuntimeTurnStore,
} from "@mycli/storage";
import {
	fileMutationApprovalPreview,
	toolCallRequestsSandboxOverride,
	type ApprovalPolicyDecision,
	type ExecutionPolicy,
	type PreparedMutationGuard,
	type PreparedToolCall,
	type ToolExecutionResult,
	type ToolRouterContract,
} from "@mycli/tools";
import type {
	ApprovalSuspensionInput,
	PendingApprovalContinuation,
} from "./approval-continuation-coordinator.ts";
import type {
	ClarificationOption,
	ClarificationSuspensionInput,
	PendingClarificationContinuation,
} from "./clarification-continuation-coordinator.ts";
import type { ContextItemCoordinatorContract } from "./context-item-coordinator.ts";
import type { HookContextAccumulator } from "./hook-context-accumulator.ts";
import type { HookCoordinator } from "./hook-coordinator.ts";
import type { RunExecutionSnapshot } from "./run-execution-snapshot.ts";
import type { AgentBudgetTracker } from "./agent-budget-tracker.ts";
import {
	boundedRuntimeToolName as boundedToolName,
	boundedToolCallId as boundedCallId,
	emitToolExecutionResult as emitToolResult,
	type ActiveToolExecutionClaim,
	type ActiveToolExecutionRegistry,
} from "./active-tool-execution-registry.ts";

export interface PendingToolBatch {
	readonly calls: readonly CanonicalToolCall[];
	readonly assistantText: string;
	readonly responseId?: string;
}

export interface ToolBatchSubmission {
	readonly clientTurnId: string;
	readonly clientUserMessageId?: string;
	readonly message: string;
	readonly modelOverride?: string;
	readonly reasoningEffort?: ReasoningEffort;
}

export interface ToolBatchRuntimeContext {
	readonly submission: ToolBatchSubmission;
	readonly turnId: string;
	readonly config: Pick<NodeRuntimeConfig, "protocol">;
	readonly collaborationMode: string;
	readonly executionPolicy?: ExecutionPolicy;
	readonly runSnapshot: RunExecutionSnapshot;
	readonly emit: (event: RuntimeEvent) => void;
	readonly signal: AbortSignal;
	readonly hookCoordinator?: HookCoordinator;
	readonly hookContexts: HookContextAccumulator;
}

export interface ToolBatchApprovalPolicy {
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
}

export interface ToolBatchApprovalContinuation {
	suspend(input: ApprovalSuspensionInput): PendingApprovalContinuation;
}

export interface ToolBatchClarificationContinuation {
	suspend(input: ClarificationSuspensionInput): PendingClarificationContinuation;
}

export interface ToolBatchEffectInput {
	readonly turnId: string;
	readonly call: CanonicalToolCall;
	readonly mutating: boolean;
	readonly version: number;
}

export interface ToolBatchCoordinatorOptions {
	readonly sessionId: string;
	readonly store: RuntimeTurnStore;
	readonly budget: AgentBudgetTracker;
	readonly activeTools: ActiveToolExecutionRegistry;
	readonly toolRouter?: ToolRouterContract;
	readonly approvalPolicy?: ToolBatchApprovalPolicy;
	readonly approvalCoordinator?: ToolBatchApprovalContinuation;
	readonly clarificationCoordinator?: ToolBatchClarificationContinuation;
	readonly contextItemCoordinator?: ContextItemCoordinatorContract;
	readonly agentCheckpoint?: (checkpoint: AgentRuntimeCheckpoint) => void;
	readonly isMutatingTool?: (toolName: string) => boolean;
	readonly sandboxOverrideProfile?: () => ExecutionPolicy | undefined;
	readonly executeToolEffect?: (
		input: ToolBatchEffectInput,
		execute: () => Promise<ToolExecutionResult>,
	) => Promise<ToolExecutionResult>;
	readonly writeTerminalSnapshot?: (turn: RuntimeTurnRecord) => Promise<unknown>;
	readonly publishLifecycle: (event: ShellLifecycleEvent) => void;
}

export interface ProcessToolBatchInput {
	readonly context: ToolBatchRuntimeContext;
	readonly batch: PendingToolBatch;
	readonly accumulatedUsage: ProviderUsage;
	readonly exposedTools: readonly ToolDefinition[];
}

interface PreparedParallelToolCall {
	readonly index: number;
	readonly call: CanonicalToolCall;
	readonly executionCall: CanonicalToolCall;
	readonly sandboxOverrideApproved: boolean;
}

interface PendingToolExecutionResult {
	readonly active: ActiveToolExecutionClaim;
	readonly result: ToolExecutionResult;
}

export class ToolBatchCoordinator {
	readonly #options: ToolBatchCoordinatorOptions;

	constructor(options: ToolBatchCoordinatorOptions) {
		this.#options = options;
	}

	async process(input: ProcessToolBatchInput): Promise<RuntimeTurnRecord | undefined> {
		const { context, batch, accumulatedUsage, exposedTools } = input;
		const { submission, turnId, config, emit, signal } = context;
		const deferredContextItems: Array<Omit<AppendContextItemInput, "sessionId">> = [];
		const pendingParallelCalls: PreparedParallelToolCall[] = [];
		const exposedToolNames = new Set(exposedTools.map((tool) => tool.name));
		const flushParallelCalls = async (): Promise<RuntimeTurnRecord | undefined> => {
			if (pendingParallelCalls.length === 0) return undefined;
			const phase = pendingParallelCalls.splice(0);
			const results = await this.#executeParallelToolPhase(phase, context);
			for (const [phaseIndex, prepared] of phase.entries()) {
				const suspended = await this.#applyToolExecutionResult({
					context,
					batch,
					accumulatedUsage,
					deferredContextItems,
					index: prepared.index,
					call: prepared.call,
					executionCall: prepared.executionCall,
					result: results[phaseIndex]!,
					executed: true,
					allowClarification: false,
				});
				if (suspended) return suspended;
			}
			return undefined;
		};

		for (const [index, call] of batch.calls.entries()) {
			const wallClockExhausted = this.#options.budget.wallClockExhaustion();
			if (wallClockExhausted) throw new AgentBudgetExhaustedError(wallClockExhausted);
			assertNotAborted(signal);
			if (!exposedToolNames.has(call.name)) {
				const earlierSuspension = await flushParallelCalls();
				if (earlierSuspension) return earlierSuspension;
				const suspended = await this.#applyToolExecutionResult({
					context,
					batch,
					accumulatedUsage,
					deferredContextItems,
					index,
					call,
					executionCall: call,
					result: unsupportedToolResult(call),
					executed: false,
					allowClarification: false,
				});
				if (suspended) return suspended;
				continue;
			}
			if (context.collaborationMode === "plan" && call.name === "update_plan") {
				const earlierSuspension = await flushParallelCalls();
				if (earlierSuspension) return earlierSuspension;
				const suspended = await this.#applyToolExecutionResult({
					context,
					batch,
					accumulatedUsage,
					deferredContextItems,
					index,
					call,
					executionCall: call,
					result: planModeUpdatePlanResult(call),
					executed: false,
					allowClarification: false,
				});
				if (suspended) return suspended;
				continue;
			}
			if (!this.#supportsParallelToolCall(call, context.turnId)) {
				const earlierSuspension = await flushParallelCalls();
				if (earlierSuspension) return earlierSuspension;
			}
			const policy = await this.#options.approvalPolicy?.evaluate(
				call,
				context.executionPolicy,
				context.turnId,
			);
			if (policy?.kind === "request") {
				const earlierSuspension = await flushParallelCalls();
				if (earlierSuspension) return earlierSuspension;
				const preparation = await this.#emitFileMutationStarted(
					call,
					policy.preview,
					context,
					toolCallRequestsSandboxOverride(call),
				);
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
					runSnapshot: context.runSnapshot,
					preview: policy.preview,
					reason: policy.reason,
					options: policy.options,
					...(policy.commandPattern ? { commandPattern: policy.commandPattern } : {}),
					...(policy.proposedExecPolicyPattern ? {
						proposedExecPolicyPattern: policy.proposedExecPolicyPattern,
					} : {}),
					...(policy.permissionRequest ? {
						permissionRequest: policy.permissionRequest,
					} : {}),
					...(preparation?.mutationGuard ? {
						preparedMutationGuard: preparation.mutationGuard,
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
					...(pending.permissionRequest ? {
						permissionRequest: pending.permissionRequest,
					} : {}),
					...fileMutationApprovalPreview(pending.call),
				});
				const running = this.#runningTurn(pending.clientTurnId);
				await this.#options.writeTerminalSnapshot?.(running);
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

			if (policy?.kind === "deny" || blockedByHook) {
				const earlierSuspension = await flushParallelCalls();
				if (earlierSuspension) return earlierSuspension;
				await this.#emitFileMutationStarted(
					executionCall,
					sameToolCall(call, executionCall) ? policy?.preview : undefined,
					context,
				);
				const result = policy?.kind === "deny"
					? policyDeniedResult(call, policy)
					: blockedByHook!;
				const suspended = await this.#applyToolExecutionResult({
					context,
					batch,
					accumulatedUsage,
					deferredContextItems,
					index,
					call,
					executionCall,
					result,
					executed: false,
					allowClarification: true,
				});
				if (suspended) return suspended;
				continue;
			}

			const sandboxOverrideApproved = policy?.kind === "allow"
				&& policy.sandboxOverrideApproved === true
				&& sameToolCall(call, executionCall);
			if (this.#supportsParallelToolCall(executionCall, context.turnId)) {
				await this.#emitFileMutationStarted(
					executionCall,
					sameToolCall(call, executionCall) ? policy?.preview : undefined,
					context,
					sandboxOverrideApproved,
				);
				pendingParallelCalls.push({
					index,
					call,
					executionCall,
					sandboxOverrideApproved,
				});
				continue;
			}

			const earlierSuspension = await flushParallelCalls();
			if (earlierSuspension) return earlierSuspension;
			const preparation = await this.#emitFileMutationStarted(
				executionCall,
				sameToolCall(call, executionCall) ? policy?.preview : undefined,
				context,
				sandboxOverrideApproved,
			);
			const result = await this.#executeTool(
				executionCall,
				context,
				sandboxOverrideApproved,
				preparation?.mutationGuard,
			);
			const suspended = await this.#applyToolExecutionResult({
				context,
				batch,
				accumulatedUsage,
				deferredContextItems,
				index,
				call,
				executionCall,
				result,
				executed: true,
				allowClarification: true,
			});
			if (suspended) return suspended;
		}
		const trailingSuspension = await flushParallelCalls();
		if (trailingSuspension) return trailingSuspension;
		this.#persistDeferredContextItems(deferredContextItems, signal);
		return undefined;
	}

	async #emitFileMutationStarted(
		call: CanonicalToolCall,
		preview: string | undefined,
		context: ToolBatchRuntimeContext,
		sandboxOverrideApproved = false,
	): Promise<PreparedToolCall | undefined> {
		const details = fileMutationApprovalPreview(call);
		const sandboxOverridePolicy = sandboxOverrideApproved
			? this.#options.sandboxOverrideProfile?.()
			: undefined;
		const previewOptions = {
			signal: context.signal,
			ownerTurnId: context.turnId,
			...(context.executionPolicy ? { executionPolicy: context.executionPolicy } : {}),
			...(sandboxOverrideApproved ? { sandboxOverrideApproved: true } : {}),
			...(sandboxOverridePolicy ? { sandboxOverridePolicy } : {}),
		};
		const prepared: PreparedToolCall = this.#options.toolRouter?.prepare
			? await this.#options.toolRouter.prepare(call, previewOptions)
			: Object.freeze({
				fileChanges: await this.#options.toolRouter?.preview?.(call, previewOptions)
					?? Object.freeze([]),
			});
		const fileChanges = prepared.fileChanges;
		if (details.contentPreview === undefined && details.diff === undefined && fileChanges.length === 0) {
			return prepared.mutationGuard ? prepared : undefined;
		}
		context.emit({
			type: "file_mutation_started",
			clientTurnId: context.submission.clientTurnId,
			turnId: context.turnId,
			callId: boundedCallId(call.callId),
			toolName: boundedToolName(call.name),
			preview: (preview?.trim() || boundedToolName(call.name)).slice(0, 512),
			...details,
			...(fileChanges.length > 0 ? { fileChanges } : {}),
		});
		return prepared;
	}

	#supportsParallelToolCall(call: CanonicalToolCall, turnId: string): boolean {
		try {
			return this.#options.toolRouter?.supportsParallelToolCalls?.(call, turnId) === true;
		} catch {
			return false;
		}
	}

	async #executeParallelToolPhase(
		phase: readonly PreparedParallelToolCall[],
		context: ToolBatchRuntimeContext,
	): Promise<readonly ToolExecutionResult[]> {
		const controller = new AbortController();
		const phaseContext = Object.freeze({
			...context,
			signal: AbortSignal.any([context.signal, controller.signal]),
		});
		try {
			const outcomes = await Promise.all(phase.map(async (prepared) => (
				await this.#runTool(
					prepared.executionCall,
					phaseContext,
					prepared.sandboxOverrideApproved,
				)
			)));
			if (outcomes.some((outcome) => clarificationRequest(outcome.result) !== undefined)) {
				throw new ProviderFailure({
					code: "tool_protocol_error",
					message: "parallel tool requested clarification",
				});
			}
			for (const outcome of outcomes) {
				this.#options.activeTools.complete(outcome.active, outcome.result, context.emit);
			}
			return outcomes.map((outcome) => outcome.result);
		} catch (error) {
			controller.abort();
			this.#options.activeTools.interruptTurn(context.turnId, context.emit);
			throw error;
		}
	}

	async #applyToolExecutionResult(input: {
		readonly context: ToolBatchRuntimeContext;
		readonly batch: PendingToolBatch;
		readonly accumulatedUsage: ProviderUsage;
		readonly deferredContextItems: Array<Omit<AppendContextItemInput, "sessionId">>;
		readonly index: number;
		readonly call: CanonicalToolCall;
		readonly executionCall: CanonicalToolCall;
		readonly result: ToolExecutionResult;
		readonly executed: boolean;
		readonly allowClarification: boolean;
	}): Promise<RuntimeTurnRecord | undefined> {
		const {
			context,
			batch,
			accumulatedUsage,
			deferredContextItems,
			index,
			call,
			executionCall,
			result,
			executed,
			allowClarification,
		} = input;
		const { submission, turnId, config, emit, signal } = context;
		if (!executed) emitToolResult(result, 0, emit);
		const clarification = clarificationRequest(result);
		if (clarification) {
			if (!allowClarification) {
				throw new ProviderFailure({
					code: "tool_protocol_error",
					message: "parallel tool requested clarification",
				});
			}
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
				runSnapshot: context.runSnapshot,
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
			await this.#options.writeTerminalSnapshot?.(running);
			return running;
		}

		const contextItem = this.#persistToolResult(submission.clientTurnId, turnId, result);
		if (contextItem) deferredContextItems.push(contextItem);
		if (executed) {
			this.#options.approvalPolicy?.recordResult?.(
				executionCall,
				result,
				context.executionPolicy,
				turnId,
			);
		}
		if (result.success && result.planUpdate) {
			emit({
				type: "plan_updated",
				...(result.planUpdate.explanation
					? { explanation: result.planUpdate.explanation }
					: {}),
				items: result.planUpdate.items,
			});
		}
		if (executed) {
			this.#options.agentCheckpoint?.({
				kind: "tool_call",
				committed: true,
				turnId,
				callId: executionCall.callId,
				mutating: this.#options.isMutatingTool?.(executionCall.name) ?? true,
			});
			const after = await context.hookCoordinator?.afterTool(executionCall, result, signal);
			if (after) {
				context.hookContexts.append({
					point: "post_tool_use",
					contexts: after.contexts,
				});
			}
		}
		assertNotAborted(signal);
		return undefined;
	}

	async #executeTool(
		call: CanonicalToolCall,
		context: ToolBatchRuntimeContext,
		sandboxOverrideApproved = false,
		preparedMutationGuard?: PreparedMutationGuard,
	): Promise<ToolExecutionResult> {
		const outcome = await this.#runTool(
			call,
			context,
			sandboxOverrideApproved,
			preparedMutationGuard,
		);
		this.#options.activeTools.complete(outcome.active, outcome.result, context.emit);
		return outcome.result;
	}

	async #runTool(
		call: CanonicalToolCall,
		context: ToolBatchRuntimeContext,
		sandboxOverrideApproved = false,
		preparedMutationGuard?: PreparedMutationGuard,
	): Promise<PendingToolExecutionResult> {
		const { emit, signal } = context;
		const router = this.#options.toolRouter;
		if (!router) throw new ProviderFailure({
			code: "unsupported_capability",
			message: "tool execution is not configured",
		});
		assertNotAborted(signal);
		const mutating = this.#options.isMutatingTool?.(call.name) ?? true;
		this.#options.agentCheckpoint?.({
			kind: "tool_call",
			committed: false,
			turnId: context.turnId,
			callId: call.callId,
			mutating,
		});
		const activeTool = this.#options.activeTools.begin({
			turnId: context.turnId,
			callId: call.callId,
			toolName: call.name,
			interruptErrorKind: mutating ? "effect_outcome_unknown" : "tool_interrupted",
		}, emit);
		const executionSignal = AbortSignal.any([signal, activeTool.signal]);
		let result: ToolExecutionResult;
		try {
			const sandboxOverridePolicy = sandboxOverrideApproved
				? this.#options.sandboxOverrideProfile?.()
				: undefined;
			const execute = async (): Promise<ToolExecutionResult> => await router.execute(call, {
				signal: executionSignal,
				ownerSessionId: this.#options.sessionId,
				ownerTurnId: context.turnId,
				callId: call.callId,
				publishLifecycle: this.#options.publishLifecycle,
				...(context.executionPolicy ? { executionPolicy: context.executionPolicy } : {}),
				...(sandboxOverrideApproved ? { sandboxOverrideApproved: true } : {}),
				...(sandboxOverridePolicy ? { sandboxOverridePolicy } : {}),
				...(preparedMutationGuard ? { preparedMutationGuard } : {}),
			});
			result = this.#options.executeToolEffect
				? await this.#options.executeToolEffect({
					turnId: context.turnId,
					call,
					mutating,
					version: this.#options.budget.toolCallCount(),
				}, execute)
				: await execute();
			assertNotAborted(executionSignal);
		} catch (error) {
			if (executionSignal.aborted || (error instanceof Error && error.name === "AbortError")) {
				this.#options.activeTools.interrupt(activeTool, emit);
				throw error;
			}
			this.#options.activeTools.fail(activeTool, "tool_execution_failed", emit);
			throw new ProviderFailure({
				code: "provider_error",
				message: "tool execution failed",
				diagnostics: { tool_name: boundedToolName(call.name) },
			});
		}
		return { active: activeTool, result };
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
}

function sameToolCall(left: CanonicalToolCall, right: CanonicalToolCall): boolean {
	return left.callId === right.callId
		&& left.name === right.name
		&& left.argumentsJson === right.argumentsJson;
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

function policyDeniedResult(
	call: CanonicalToolCall,
	decision: Extract<ApprovalPolicyDecision, { readonly kind: "deny" }>,
): ToolExecutionResult {
	const toolName = boundedToolName(call.name) || "Tool";
	const errorKind = decision.errorKind ?? (decision.reason.includes("outside the workspace")
		? "workspace_escape"
		: "approval_rejected");
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

function unsupportedToolResult(call: CanonicalToolCall): ToolExecutionResult {
	const toolName = boundedToolName(call.name);
	return Object.freeze({
		callId: call.callId,
		toolName: call.name,
		success: false,
		modelOutput: `unsupported call: ${toolName}`,
		summary: `${toolName} unsupported`,
		errorKind: "unsupported_tool",
		metadata: Object.freeze({}),
	});
}

function planModeUpdatePlanResult(call: CanonicalToolCall): ToolExecutionResult {
	return Object.freeze({
		callId: call.callId,
		toolName: call.name,
		success: false,
		modelOutput: "update_plan is a TODO/checklist tool and is not allowed in Plan mode",
		summary: "update_plan blocked in Plan mode",
		errorKind: "tool_not_allowed_in_plan_mode",
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

function toCanonicalResult(result: ToolExecutionResult) {
	return {
		callId: result.callId,
		toolName: result.toolName,
		output: result.modelOutput,
		success: result.success,
	};
}

function assertNotAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		const error = new Error("interrupted: turn aborted");
		error.name = "AbortError";
		throw error;
	}
}
