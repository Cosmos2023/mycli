import { randomUUID } from "node:crypto";
import { UserTurnCancellation } from "../abort.ts";
import type {
	CanonicalToolCall,
	ProviderReplayState,
	ProviderRequest,
	ProviderEvent,
	ProviderUsage,
	RuntimeEvent,
	WebSearchCall,
} from "@mycli/core";
import {
	canonicalRuntimeFailureMessage,
	createErrorContext,
	errorOccurrence,
	errorSummary,
	legacyRuntimeReason,
	providerAttemptId,
	parseProviderAttemptUpdate,
	runtimeErrorPublicMessage,
} from "@mycli/contracts";
import type { FailureScope, ProviderAttemptUpdate, RuntimeFailure } from "@mycli/contracts";
import type { ModelProvider } from "@mycli/providers";
import {
	ProviderFailure,
	providerFailureToRuntimeFailure,
} from "@mycli/providers";
import {
	decideRetry,
	sleepWithSignal,
} from "./retry-policy.ts";
import {
	publishProviderStreamDiagnostics,
} from "../runtime-observability.ts";
import type { ProviderStreamDiagnostics } from "../runtime-observability.ts";
import { providerAttemptRetryAllowed } from "../errors/recovery.ts";

export type ProviderAgentLoopFailure = RuntimeFailure;

export interface ProviderAgentLoopStepResult {
	readonly assistantText: string;
	readonly usage: ProviderUsage;
	readonly responseId?: string;
	readonly toolCalls: readonly CanonicalToolCall[];
	readonly webSearchCalls: readonly WebSearchCall[];
	readonly providerState?: ProviderReplayState;
}

export type ProviderAgentLoopResult = ProviderAgentLoopStepResult | {
	readonly failure: ProviderAgentLoopFailure;
	readonly eventsObserved: number;
};

export interface ProviderAgentLoopInput {
	readonly requestId?: string;
	readonly errorContextVersion?: 1;
	readonly provider: ModelProvider;
	readonly request: ProviderRequest;
	readonly requestMaxRetries: number;
	readonly maxRetries: number;
	readonly signal: AbortSignal;
	readonly toolCallsAllowed: boolean;
	readonly emit: (event: RuntimeEvent) => void;
	readonly recordDiagnostic?: (diagnostic: ProviderStreamDiagnostics) => void;
	readonly normalizeFailure: (error: unknown) => ProviderAgentLoopFailure;
	readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
	readonly random?: () => number;
	readonly monotonicClock?: () => number;
	readonly clock?: () => string;
	readonly attemptState?: ProviderAttemptUpdate;
	readonly recordAttempt?: (update: ProviderAttemptUpdate) => Promise<void>;
	readonly recordUsage?: (usage: ProviderUsage, attempt: number) => Promise<void>;
}

export class ProviderAgentLoop {
	async runStep(input: ProviderAgentLoopInput): Promise<ProviderAgentLoopResult> {
		const restored = input.attemptState ? parseProviderAttemptUpdate(input.attemptState) : undefined;
		const policy = Object.freeze(restored?.policy ?? {
			requestMaxRetries: retryLimit(input.requestMaxRetries),
			streamMaxRetries: retryLimit(input.maxRetries),
		});
		let requestRetriesUsed = restored?.requestRetriesUsed ?? 0;
		let streamRetriesUsed = restored?.streamRetriesUsed ?? 0;
		let retried = requestRetriesUsed + streamRetriesUsed > 0;
		let attempt = restored?.attempt ?? 1;
		let sequence = restored?.sequence ?? 0;
		const requestId = input.requestId ?? randomUUID();
		const attemptScope = (): Readonly<FailureScope> => ({ kind: "provider_attempt", id: providerAttemptId(requestId, attempt) });
		const clock = input.clock ?? (() => new Date().toISOString());
		const recordAttempt = async (
			state: ProviderAttemptUpdate["state"],
			details: Pick<ProviderAttemptUpdate, "failure" | "recoveryKind" | "retryAt" | "resetOutput"> = {},
			observedAt?: string,
		): Promise<void> => {
			if (!input.recordAttempt) return;
			try {
				await input.recordAttempt(parseProviderAttemptUpdate({
					sequence: sequence + 1, attempt, state, policy, requestRetriesUsed, streamRetriesUsed,
					observedAt: observedAt ?? clock(), ...details,
				}));
				sequence += 1;
			} catch {
				throw new ProviderFailure({ code: "persistence_error", message: "provider attempt could not be committed" });
			}
		};
		const scheduleRetry = async (
			failure: ProviderAgentLoopFailure,
			recoveryKind: "request" | "stream",
			delayMs: number,
			resetOutput: boolean,
		): Promise<number> => {
			if (!input.recordAttempt) return delayMs;
			const scheduledAt = clock();
			const retryAt = new Date(Date.parse(scheduledAt) + delayMs).toISOString();
			await recordAttempt("scheduled", { failure, recoveryKind, resetOutput, retryAt }, scheduledAt);
			return Math.max(0, Date.parse(retryAt) - Date.parse(clock()));
		};
		if (restored) {
			if (restored.state !== "scheduled" || !providerAttemptRetryAllowed(restored.failure!, {
				completed: false, cancelled: input.signal.aborted, effectsDispatched: false,
			})) {
				// Loading an uncertain or terminal attempt never grants dispatch authority.
				return { failure: { code: "interrupted", message: runtimeErrorPublicMessage("interrupted"), retryable: false }, eventsObserved: 0 };
			}
			const interrupted = await waitBeforeRetry(input, restored.failure!, {
				shouldRetry: true,
				attempt: restored.recoveryKind === "request" ? requestRetriesUsed : streamRetriesUsed,
				delayMs: Math.max(0, Date.parse(restored.retryAt!) - Date.parse(clock())),
			}, {
				recoveryKind: restored.recoveryKind!, resetOutput: restored.resetOutput ?? false,
				maxRetries: restored.recoveryKind === "request" ? policy.requestMaxRetries : policy.streamMaxRetries,
			}, attemptScope());
			if (interrupted) {
				await recordAttempt("cancelled", { failure: interrupted });
				return { failure: interrupted, eventsObserved: 0 };
			}
		}
		while (true) {
			await recordAttempt("started");
			const diagnostics = beginProviderDiagnostics(
				attempt,
				input.monotonicClock?.() ?? performance.now(),
			);
			let eventsObserved = 0;
			let assistantText = "";
			let usage: ProviderUsage = {};
			let usageObserved = false;
			let responseId: string | undefined;
			let providerState: ProviderReplayState | undefined;
			const toolCalls: CanonicalToolCall[] = [];
			const webSearchCalls = new Map<string, WebSearchCall>();
			let completed = false;
			const now = (): number => input.monotonicClock?.() ?? performance.now();
			const recordUsage = async (): Promise<void> => {
				try {
					await input.recordUsage?.(usage, attempt);
					usageObserved = true;
				} catch {
					throw new ProviderFailure({ code: "persistence_error", message: "provider usage could not be committed" });
				}
			};
			const recordTerminalAttempt = async (
				state: "completed" | "recovered" | "cancelled" | "failed",
				failure?: ProviderAgentLoopFailure,
			): Promise<void> => {
				// Successful responses and interrupted output with no usage are unknown, not free.
				if (!usageObserved && eventsObserved > 0) await recordUsage();
				if (!input.recordAttempt) return;
				const startedAt = now();
				try {
					await recordAttempt(state, failure ? { failure } : {});
				} finally {
					diagnostics.terminalPersistMs = elapsedMs(startedAt, now());
				}
			};
			try {
				input.signal.throwIfAborted();
				for await (const event of input.provider.stream(input.request, {
					signal: input.signal,
					onPhase: (phase) => {
						if (phase === "response_terminal") diagnostics.responseTerminalMs ??= elapsedMs(diagnostics.startedAt, now());
						if (phase === "sdk_terminal") diagnostics.sdkTerminalMs ??= elapsedMs(diagnostics.startedAt, now());
					},
				})) {
					input.signal.throwIfAborted();
					eventsObserved += 1;
					observeProviderEvent(
						diagnostics,
						event,
						input.monotonicClock?.() ?? performance.now(),
					);
					if (completed) throw providerProtocolFailure("provider emitted an event after completion");
					switch (event.type) {
						case "reasoning_delta":
							input.emit(event);
							break;
						case "text_delta":
							assistantText += event.text;
							input.emit(event);
							break;
						case "provider_state":
							if (providerState || event.state.provider !== input.request.provider) {
								throw providerProtocolFailure("invalid provider replay state");
							}
							providerState = event.state;
							break;
						case "usage":
							usage = { ...usage, ...event.usage };
							await recordUsage();
							break;
						case "completed":
							completed = true;
							responseId = event.responseId;
							input.emit({
								type: "message_complete",
								...(event.responseId ? { responseId: event.responseId } : {}),
							});
							break;
						case "tool_call":
							if (!input.toolCallsAllowed) throw unsupportedToolFailure();
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
							break;
						case "web_search_started":
							input.emit({ type: "web_search_started", callId: event.callId });
							break;
						case "web_search_completed":
							webSearchCalls.set(event.call.callId, event.call);
							input.emit({ type: "web_search_completed", call: event.call });
					}
				}
				diagnostics.streamSettledMs = elapsedMs(diagnostics.startedAt, now());
				if (!completed) throw incompleteStreamFailure();
				await recordTerminalAttempt(retried ? "recovered" : "completed");
				if (retried) input.emit({ type: "stream_recovered" });
				publishProviderStreamDiagnostics(
					input.recordDiagnostic,
					finishProviderDiagnostics(
						diagnostics,
						input.monotonicClock?.() ?? performance.now(),
						true,
					),
				);
				return {
					assistantText,
					usage,
					toolCalls,
					webSearchCalls: Object.freeze([...webSearchCalls.values()]),
					...(responseId ? { responseId } : {}),
					...(providerState ? { providerState } : {}),
				};
			} catch (error) {
				diagnostics.streamSettledMs ??= elapsedMs(diagnostics.startedAt, now());
				if (error instanceof ProviderFailure && error.code === "persistence_error") throw error;
				const failure = failureForAttempt(
					normalizeAttemptFailure(input, error, attemptScope()),
					eventsObserved,
					completed,
				);
				await recordTerminalAttempt(failure.code === "interrupted" ? "cancelled" : "failed", failure);
				publishProviderStreamDiagnostics(
					input.recordDiagnostic,
					finishProviderDiagnostics(
						diagnostics,
						input.monotonicClock?.() ?? performance.now(),
						false,
						failure,
					),
				);
				const retryAllowed = providerAttemptRetryAllowed(failure, {
					completed, cancelled: input.signal.aborted, effectsDispatched: false,
				});
				const requestDecision = decideRetry({
					retryable: retryAllowed && requestRetryable(failure),
					eventsObserved,
					retriesUsed: requestRetriesUsed,
					maxRetries: policy.requestMaxRetries,
					...(failure.retryAfterSeconds === undefined
						? {}
						: { retryAfterSeconds: failure.retryAfterSeconds }),
					random: input.random ?? Math.random,
				});
				if (requestDecision.shouldRetry) {
					requestRetriesUsed += 1;
					attempt += 1;
					const delayMs = await scheduleRetry(failure, "request", requestDecision.delayMs, false);
					const interrupted = await waitBeforeRetry(input, failure, {
						...requestDecision, delayMs,
					}, {
						recoveryKind: "request",
						resetOutput: false,
						maxRetries: policy.requestMaxRetries,
					}, attemptScope());
					if (interrupted) {
						await recordAttempt("cancelled", { failure: interrupted });
						return { failure: interrupted, eventsObserved };
					}
					retried = true;
					continue;
				}

				const streamDecision = decideRetry({
					retryable: retryAllowed,
					eventsObserved,
					allowAfterEvents: true,
					retriesUsed: streamRetriesUsed,
					maxRetries: policy.streamMaxRetries,
					...(failure.retryAfterSeconds === undefined
						? {}
						: { retryAfterSeconds: failure.retryAfterSeconds }),
					random: input.random ?? Math.random,
				});
				if (!streamDecision.shouldRetry) {
					if (retryAllowed) await recordAttempt("exhausted", { failure });
					return {
						failure: retryAllowed && retryBudgetExhausted({
							failure,
							completed,
							requestEligible: requestRetryable(failure),
							requestRetriesUsed,
							requestMaxRetries: policy.requestMaxRetries,
							streamRetriesUsed,
							streamMaxRetries: policy.streamMaxRetries,
						})
							? exhaustedFailure(failure, {
								code: "retry_exhausted",
									message: failure.message === runtimeErrorPublicMessage(failure.code)
										? "provider retry budget exhausted"
										: `provider retry budget exhausted: ${failure.message}`,
									...(failure.additionalDetails
										? { additionalDetails: failure.additionalDetails }
										: {}),
									retryable: false,
								...(failure.diagnostics ? { diagnostics: failure.diagnostics } : {}),
								})
							: failure,
						eventsObserved,
					};
				}
				streamRetriesUsed += 1;
				attempt += 1;
				const delayMs = await scheduleRetry(failure, "stream", streamDecision.delayMs, eventsObserved > 0);
				const interrupted = await waitBeforeRetry(input, failure, {
					...streamDecision, delayMs,
				}, {
					recoveryKind: "stream",
					resetOutput: eventsObserved > 0,
					maxRetries: policy.streamMaxRetries,
				}, attemptScope());
				if (interrupted) {
					await recordAttempt("cancelled", { failure: interrupted });
					return { failure: interrupted, eventsObserved };
				}
				retried = true;
			}
		}
	}
}

interface MutableProviderStreamDiagnostics {
	readonly attempt: number;
	readonly startedAt: number;
	ttfbMs?: number;
	ttftMs?: number;
	lastTextDeltaAt?: number;
	responseTerminalMs?: number;
	sdkTerminalMs?: number;
	completedEventMs?: number;
	streamSettledMs?: number;
	terminalPersistMs?: number;
	tbtTotalMs: number;
	maxTbtMs: number;
	textDeltaIntervalCount: number;
	providerEventCount: number;
	reasoningEventCount: number;
	textEventCount: number;
	providerStateEventCount: number;
	toolCallEventCount: number;
	usageEventCount: number;
	completedEventCount: number;
	reasoningBytes: number;
	textBytes: number;
}

function beginProviderDiagnostics(
	attempt: number,
	startedAt: number,
): MutableProviderStreamDiagnostics {
	return {
		attempt,
		startedAt,
		providerEventCount: 0,
		tbtTotalMs: 0,
		maxTbtMs: 0,
		textDeltaIntervalCount: 0,
		reasoningEventCount: 0,
		textEventCount: 0,
		providerStateEventCount: 0,
		toolCallEventCount: 0,
		usageEventCount: 0,
		completedEventCount: 0,
		reasoningBytes: 0,
		textBytes: 0,
	};
}

function observeProviderEvent(
	diagnostics: MutableProviderStreamDiagnostics,
	event: ProviderEvent,
	observedAt: number,
): void {
	diagnostics.providerEventCount += 1;
	diagnostics.ttfbMs ??= elapsedMs(diagnostics.startedAt, observedAt);
	switch (event.type) {
		case "reasoning_delta":
			diagnostics.reasoningEventCount += 1;
			diagnostics.reasoningBytes += Buffer.byteLength(event.text, "utf8");
			break;
		case "text_delta":
			diagnostics.textEventCount += 1;
			diagnostics.textBytes += Buffer.byteLength(event.text, "utf8");
			if (event.text.length > 0) {
				diagnostics.ttftMs ??= elapsedMs(diagnostics.startedAt, observedAt);
				if (diagnostics.lastTextDeltaAt !== undefined) {
					const interval = elapsedMs(diagnostics.lastTextDeltaAt, observedAt);
					diagnostics.tbtTotalMs += interval;
					diagnostics.maxTbtMs = Math.max(diagnostics.maxTbtMs, interval);
					diagnostics.textDeltaIntervalCount += 1;
				}
				diagnostics.lastTextDeltaAt = observedAt;
			}
			break;
		case "provider_state":
			diagnostics.providerStateEventCount += 1;
			break;
		case "tool_call":
			diagnostics.toolCallEventCount += 1;
			break;
		case "web_search_started":
		case "web_search_completed":
			break;
		case "usage":
			diagnostics.usageEventCount += 1;
			break;
		case "completed":
			diagnostics.completedEventCount += 1;
			diagnostics.completedEventMs ??= elapsedMs(diagnostics.startedAt, observedAt);
	}
}

function finishProviderDiagnostics(
	diagnostics: MutableProviderStreamDiagnostics,
	finishedAt: number,
	success: boolean,
	failure?: ProviderAgentLoopFailure,
): ProviderStreamDiagnostics {
	return Object.freeze({
		attempt: diagnostics.attempt,
		elapsedMs: elapsedMs(diagnostics.startedAt, finishedAt),
		...(diagnostics.ttfbMs === undefined ? {} : { ttfbMs: diagnostics.ttfbMs }),
		...(diagnostics.ttftMs === undefined ? {} : { ttftMs: diagnostics.ttftMs }),
		...(diagnostics.lastTextDeltaAt === undefined ? {} : {
			lastTextDeltaMs: elapsedMs(diagnostics.startedAt, diagnostics.lastTextDeltaAt),
			textTailMs: elapsedMs(diagnostics.lastTextDeltaAt, finishedAt),
		}),
		...(diagnostics.responseTerminalMs === undefined ? {} : { responseTerminalMs: diagnostics.responseTerminalMs }),
		...(diagnostics.sdkTerminalMs === undefined ? {} : { sdkTerminalMs: diagnostics.sdkTerminalMs }),
		...(diagnostics.completedEventMs === undefined ? {} : { completedEventMs: diagnostics.completedEventMs }),
		...(diagnostics.streamSettledMs === undefined ? {} : { streamSettledMs: diagnostics.streamSettledMs }),
		...(diagnostics.terminalPersistMs === undefined ? {} : { terminalPersistMs: diagnostics.terminalPersistMs }),
		...(diagnostics.textDeltaIntervalCount === 0 ? {} : {
			tbtMs: diagnostics.tbtTotalMs / diagnostics.textDeltaIntervalCount,
			maxTbtMs: diagnostics.maxTbtMs,
		}),
		textDeltaIntervalCount: diagnostics.textDeltaIntervalCount,
		providerEventCount: diagnostics.providerEventCount,
		reasoningEventCount: diagnostics.reasoningEventCount,
		textEventCount: diagnostics.textEventCount,
		providerStateEventCount: diagnostics.providerStateEventCount,
		toolCallEventCount: diagnostics.toolCallEventCount,
		usageEventCount: diagnostics.usageEventCount,
		completedEventCount: diagnostics.completedEventCount,
		reasoningBytes: diagnostics.reasoningBytes,
		textBytes: diagnostics.textBytes,
		success,
		...(failure ? { failureKind: failure.code, failure } : {}),
	});
}

function elapsedMs(startedAt: number, finishedAt: number): number {
	const elapsed = finishedAt - startedAt;
	return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

async function waitBeforeRetry(
	input: ProviderAgentLoopInput,
	failure: ProviderAgentLoopFailure,
	decision: Extract<ReturnType<typeof decideRetry>, { readonly shouldRetry: true }>,
	options: {
		readonly recoveryKind: "request" | "stream";
		readonly resetOutput: boolean;
		readonly maxRetries: number;
	},
	scope: Readonly<FailureScope>,
): Promise<ProviderAgentLoopFailure | undefined> {
	input.emit({
		type: "stream_retrying",
		attempt: decision.attempt,
		maxRetries: retryLimit(options.maxRetries),
		delayMs: decision.delayMs,
		recoveryKind: options.recoveryKind,
		resetOutput: options.resetOutput,
		failureKind: failure.code,
		additionalDetails: failure.additionalDetails ?? failure.message,
	});
	try {
		input.signal.throwIfAborted();
		await (input.sleep ?? sleepWithSignal)(decision.delayMs, input.signal);
		input.signal.throwIfAborted();
		return undefined;
	} catch (sleepError) {
		const interrupted = normalizeAttemptFailure(input, sleepError, scope);
		if (!interrupted.errorContext || !failure.errorContext) return interrupted;
		const errorContext = createErrorContext({ ...interrupted.errorContext,
			causes: [errorOccurrence(failure.errorContext), ...(failure.errorContext.causes ?? [])],
		});
		return { ...interrupted, errorContext, message: errorSummary(errorContext) };
	}
}

function normalizeAttemptFailure(
	input: ProviderAgentLoopInput,
	error: unknown,
	scope: Readonly<FailureScope>,
): ProviderAgentLoopFailure {
	const normalized = input.normalizeFailure(error);
	if (input.errorContextVersion !== 1) return normalized;
	if (normalized.errorContext || normalized.diagnostics?.error_context_invalid === true) return normalized;
	if (error instanceof ProviderFailure && normalized.code !== "interrupted") {
		return providerFailureToRuntimeFailure(error, { scope, errorContextVersion: 1 });
	}
	const errorContext = createErrorContext({
		reason: normalized.code === "interrupted" && input.signal.reason instanceof UserTurnCancellation
			? "runtime.user_cancelled" : legacyRuntimeReason(normalized.code), source: "provider", scope,
		outcome: { state: normalized.code === "interrupted" ? "cancelled" : "failed", effects: "none" },
	});
	return { ...normalized, errorContext, message: errorSummary(errorContext) };
}

function exhaustedFailure(cause: ProviderAgentLoopFailure, legacy: RuntimeFailure): RuntimeFailure {
	if (!cause.errorContext) return legacy;
	const errorContext = createErrorContext({ reason: "runtime.retry_exhausted", source: "runtime",
		scope: cause.errorContext.scope, outcome: cause.errorContext.outcome,
		causes: [errorOccurrence(cause.errorContext), ...(cause.errorContext.causes ?? [])],
	});
	return { ...legacy, errorContext, message: errorSummary(errorContext) };
}

function requestRetryable(failure: ProviderAgentLoopFailure): boolean {
	if (!failure.retryable
		|| failure.code === "rate_limited"
		|| failure.code === "response_stream_error") return false;
	const status = failure.diagnostics?.status;
	if (typeof status === "number") return status >= 500 && status <= 599;
	return failure.code === "connection_error"
		|| failure.code === "server_overloaded"
		|| failure.code === "provider_error";
}

function failureForAttempt(
	failure: ProviderAgentLoopFailure,
	eventsObserved: number,
	completed: boolean,
): ProviderAgentLoopFailure {
	if (completed || eventsObserved === 0 || failure.code !== "connection_error") return failure;
	const base = runtimeErrorPublicMessage("response_stream_error");
	return {
		...failure,
		code: "response_stream_error",
		message: canonicalRuntimeFailureMessage("response_stream_error", base),
		additionalDetails: failure.additionalDetails ?? failure.message,
	};
}

function retryBudgetExhausted(input: {
	readonly failure: ProviderAgentLoopFailure;
	readonly completed: boolean;
	readonly requestEligible: boolean;
	readonly requestRetriesUsed: number;
	readonly requestMaxRetries: number;
	readonly streamRetriesUsed: number;
	readonly streamMaxRetries: number;
}): boolean {
	if (!input.failure.retryable || input.completed) return false;
	const requestLimit = retryLimit(input.requestMaxRetries);
	const streamLimit = retryLimit(input.streamMaxRetries);
	return (input.requestEligible && requestLimit > 0 && input.requestRetriesUsed >= requestLimit)
		|| (streamLimit > 0 && input.streamRetriesUsed >= streamLimit);
}

function retryLimit(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.trunc(value))) : 0;
}

export function normalizeProviderAgentLoopFailure(
	error: unknown,
	signal: AbortSignal,
): ProviderAgentLoopFailure {
	if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
		return {
			code: "interrupted",
			message: runtimeErrorPublicMessage("interrupted"),
			retryable: false,
		};
	}
	if (error instanceof ProviderFailure) {
		return providerFailureToRuntimeFailure(error);
	}
	return {
		code: "provider_error",
		message: runtimeErrorPublicMessage("provider_error"),
		retryable: false,
	};
}

function providerProtocolFailure(message: string): ProviderFailure {
	return new ProviderFailure({ code: "provider_error", message });
}

function incompleteStreamFailure(): ProviderFailure {
	return new ProviderFailure({
		code: "response_stream_error",
		message: "provider stream ended without completion",
		retryable: true,
	});
}

function unsupportedToolFailure(): ProviderFailure {
	return new ProviderFailure({
		code: "unsupported_capability",
		errorReason: { reason: "capability.tool_calls_unsupported" },
		message: runtimeErrorPublicMessage("unsupported_capability"),
	});
}
