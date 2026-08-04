import type { NodeRuntimeConfig } from "@mycli/config";
import {
	fingerprintSubmission,
	projectProviderRequest,
} from "@mycli/core";
import type {
	CanonicalConversationItem,
	CanonicalToolCall,
	ProviderRequest,
	ProviderUsage,
	ReasoningEffort,
	RuntimeErrorCode,
	RuntimeEvent,
	ToolDefinition,
} from "@mycli/core";
import {
	ProviderFailure,
} from "@mycli/providers";
import type { ModelProvider } from "@mycli/providers";
import type {
	ToolExecutionResult,
	ToolRouterContract,
} from "@mycli/tools";
import {
	StorageFailure,
} from "@mycli/storage";
import type { SessionStore, TurnReservation } from "@mycli/storage";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import {
	decideRetry,
	sleepWithSignal,
} from "./retry-policy.ts";

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
	readonly store: SessionStore;
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
	readonly planTools?: () => readonly ToolDefinition[];
	readonly toolRouter?: ToolRouterContract;
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
}

export class NodeTurnRuntime {
	readonly #options: NodeTurnRuntimeOptions;

	constructor(options: NodeTurnRuntimeOptions) {
		this.#options = options;
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

		if ((submission.localImages?.length ?? 0) > 0) {
			return this.#finalizeFailure(submission, {
				code: "unsupported_capability",
				message: "local images are not supported by the Node runtime",
				retryable: false,
			}, emit);
		}

		let config: NodeRuntimeConfig;
		let provider: ModelProvider;
		let tools: readonly ToolDefinition[];
		try {
			assertNotAborted(options.signal);
			config = await this.#options.resolveConfig(submission);
			if (config.sessionId !== this.#options.sessionId) {
				throw configFailure("resolved session does not match runtime session");
			}
			provider = this.#options.createProvider(config);
			tools = this.#options.planTools?.() ?? [];
		} catch (error) {
			return this.#finalizeFailure(
				submission,
				normalizeFailure(error, options.signal, "config_error"),
				emit,
			);
		}

		const requestConfig = {
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
		};
		let history: readonly CanonicalConversationItem[];
		try {
			history = this.#conversationForCurrentSubmission(submission.message);
		} catch (error) {
			return this.#finalizeFailure(
				submission,
				normalizeFailure(error, options.signal, "config_error"),
				emit,
			);
		}

		let previousResponseId: string | undefined;
		let accumulatedUsage: ProviderUsage = {};
		while (true) {
			const request = projectProviderRequest({
				config: requestConfig,
				instructions: this.#options.instructions,
				history,
				tools,
				...(previousResponseId ? { previousResponseId } : {}),
			});
			const stepResult = await this.#streamWithRetry(
				provider,
				request,
				config.streamMaxRetries,
				emit,
				options.signal,
				Boolean(this.#options.toolRouter),
			);
			if ("failure" in stepResult) {
				return this.#finalizeFailure(submission, stepResult.failure, emit);
			}
			accumulatedUsage = addUsage(accumulatedUsage, stepResult.usage);

			if (stepResult.toolCalls.length === 0) {
				return this.#completeTurn(
					submission,
					stepResult.assistantText,
					accumulatedUsage,
					stepResult.responseId,
					emit,
					options.signal,
				);
			}
			if (!hasUniqueCallIds(stepResult.toolCalls)) {
				return this.#finalizeFailure(submission, toolProtocolFailure(), emit);
			}

			if (config.protocol === "responses" && !stepResult.responseId) {
				return this.#finalizeFailure(submission, toolProtocolFailure(), emit);
			}

			const router = this.#options.toolRouter;
			if (!router) {
				return this.#finalizeFailure(submission, unsupportedToolFailure(), emit);
			}

			try {
				assertNotAborted(options.signal);
				this.#options.store.appendAssistantToolCalls({
					sessionId: this.#options.sessionId,
					clientTurnId: submission.clientTurnId,
					assistantText: stepResult.assistantText,
					calls: stepResult.toolCalls,
					...(stepResult.responseId ? { responseId: stepResult.responseId } : {}),
				});
				assertNotAborted(options.signal);
				for (const call of stepResult.toolCalls) {
					emit({
						type: "tool_call_accepted",
						callId: boundedCallId(call.callId),
						toolName: boundedToolName(call.name),
					});
				}
				for (const call of stepResult.toolCalls) {
					assertNotAborted(options.signal);
					const startedAt = this.#options.monotonicClock?.() ?? performance.now();
					emit({
						type: "tool_execution_started",
						callId: boundedCallId(call.callId),
						toolName: boundedToolName(call.name),
					});
					let result: ToolExecutionResult;
					try {
						result = await router.execute(call, { signal: options.signal });
					} catch (error) {
						if (error instanceof Error && error.name === "AbortError") {
							throw error;
						}
						assertNotAborted(options.signal);
						throw new ProviderFailure({
							code: "provider_error",
							message: "tool execution failed",
							diagnostics: { tool_name: boundedToolName(call.name) },
						});
					}
					const finishedAt = this.#options.monotonicClock?.() ?? performance.now();
					emitToolResult(result, boundedDurationMs(startedAt, finishedAt), emit);
					this.#options.store.appendToolResult({
						sessionId: this.#options.sessionId,
						clientTurnId: submission.clientTurnId,
						result: toCanonicalResult(result),
						summary: result.summary,
						...(result.errorKind ? { errorKind: result.errorKind } : {}),
					});
					assertNotAborted(options.signal);
				}
				history = this.#options.store.loadConversationItems(this.#options.sessionId);
				assertNotAborted(options.signal);
			} catch (error) {
				return this.#finalizeFailure(
					submission,
					normalizeFailure(error, options.signal, "persistence_error"),
					emit,
				);
			}
			previousResponseId = stepResult.responseId;
		}
	}

	async #streamWithRetry(
		provider: ModelProvider,
		request: ProviderRequest,
		maxRetries: number,
		emit: (event: RuntimeEvent) => void,
		signal: AbortSignal,
		toolCallsAllowed: boolean,
	): Promise<ProviderStepResult | { readonly failure: NormalizedFailure }> {
		let retriesUsed = 0;
		while (true) {
			let eventsObserved = 0;
			let assistantText = "";
			let usage: ProviderUsage = {};
			let responseId: string | undefined;
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
					return { failure: normalizeFailure(sleepError, signal, "interrupted") };
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

	#completeTurn(
		submission: TurnSubmission,
		assistantText: string,
		usage: ProviderUsage,
		responseId: string | undefined,
		emit: (event: RuntimeEvent) => void,
		signal: AbortSignal,
	): RuntimeTurnRecord {
		try {
			assertNotAborted(signal);
			const completed = this.#options.store.completeTurn({
				sessionId: this.#options.sessionId,
				clientTurnId: submission.clientTurnId,
				assistantText,
				usage,
				...(responseId ? { responseId } : {}),
				completedAt: this.#options.clock(),
			});
			emit({ type: "turn_completed", assistantText, usage });
			return completed;
		} catch (error) {
			return this.#finalizeFailure(
				submission,
				normalizeFailure(error, signal, "persistence_error"),
				emit,
			);
		}
	}

	#finalizeFailure(
		submission: TurnSubmission,
		failure: NormalizedFailure,
		emit: (event: RuntimeEvent) => void,
	): RuntimeTurnRecord {
		try {
			const failed = this.#options.store.failTurn({
				sessionId: this.#options.sessionId,
				clientTurnId: submission.clientTurnId,
				code: failure.code,
				message: failure.message,
				completedAt: this.#options.clock(),
			});
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
