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
	runtimeErrorPublicMessage,
} from "@mycli/contracts";
import type { RuntimeFailure } from "@mycli/contracts";
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
} from "./runtime-observability.ts";
import type { ProviderStreamDiagnostics } from "./runtime-observability.ts";

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
}

export class ProviderAgentLoop {
	async runStep(input: ProviderAgentLoopInput): Promise<ProviderAgentLoopResult> {
		let requestRetriesUsed = 0;
		let streamRetriesUsed = 0;
		let retried = false;
		let attempt = 0;
		while (true) {
			attempt += 1;
			const diagnostics = beginProviderDiagnostics(
				attempt,
				input.monotonicClock?.() ?? performance.now(),
			);
			let eventsObserved = 0;
			let assistantText = "";
			let usage: ProviderUsage = {};
			let responseId: string | undefined;
			let providerState: ProviderReplayState | undefined;
			const toolCalls: CanonicalToolCall[] = [];
			const webSearchCalls = new Map<string, WebSearchCall>();
			let completed = false;
			try {
				input.signal.throwIfAborted();
				for await (const event of input.provider.stream(input.request, { signal: input.signal })) {
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
				if (!completed) throw incompleteStreamFailure();
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
				const failure = failureForAttempt(
					input.normalizeFailure(error),
					eventsObserved,
					completed,
				);
				publishProviderStreamDiagnostics(
					input.recordDiagnostic,
					finishProviderDiagnostics(
						diagnostics,
						input.monotonicClock?.() ?? performance.now(),
						false,
						failure.code,
					),
				);
				const requestDecision = decideRetry({
					retryable: requestRetryable(failure),
					eventsObserved,
					retriesUsed: requestRetriesUsed,
					maxRetries: input.requestMaxRetries,
					random: input.random ?? Math.random,
				});
				if (requestDecision.shouldRetry) {
					const interrupted = await waitBeforeRetry(input, failure, requestDecision, {
						recoveryKind: "request",
						resetOutput: false,
						maxRetries: input.requestMaxRetries,
					});
					if (interrupted) return { failure: interrupted, eventsObserved };
					requestRetriesUsed += 1;
					retried = true;
					continue;
				}

				const streamDecision = decideRetry({
					retryable: failure.retryable && !completed,
					eventsObserved,
					allowAfterEvents: true,
					retriesUsed: streamRetriesUsed,
					maxRetries: input.maxRetries,
					...(failure.retryAfterSeconds === undefined
						? {}
						: { retryAfterSeconds: failure.retryAfterSeconds }),
					random: input.random ?? Math.random,
				});
				if (!streamDecision.shouldRetry) {
					return {
						failure: retryBudgetExhausted({
							failure,
							completed,
							requestEligible: requestRetryable(failure),
							requestRetriesUsed,
							requestMaxRetries: input.requestMaxRetries,
							streamRetriesUsed,
							streamMaxRetries: input.maxRetries,
						})
							? {
								code: "retry_exhausted",
									message: failure.message === runtimeErrorPublicMessage(failure.code)
										? "provider retry budget exhausted"
										: `provider retry budget exhausted: ${failure.message}`,
									...(failure.additionalDetails
										? { additionalDetails: failure.additionalDetails }
										: {}),
									retryable: false,
								...(failure.diagnostics ? { diagnostics: failure.diagnostics } : {}),
							}
							: failure,
						eventsObserved,
					};
				}
				const interrupted = await waitBeforeRetry(input, failure, streamDecision, {
					recoveryKind: "stream",
					resetOutput: eventsObserved > 0,
					maxRetries: input.maxRetries,
				});
				if (interrupted) return { failure: interrupted, eventsObserved };
				streamRetriesUsed += 1;
				requestRetriesUsed = 0;
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
	}
}

function finishProviderDiagnostics(
	diagnostics: MutableProviderStreamDiagnostics,
	finishedAt: number,
	success: boolean,
	failureKind?: ProviderAgentLoopFailure["code"],
): ProviderStreamDiagnostics {
	return Object.freeze({
		attempt: diagnostics.attempt,
		elapsedMs: elapsedMs(diagnostics.startedAt, finishedAt),
		...(diagnostics.ttfbMs === undefined ? {} : { ttfbMs: diagnostics.ttfbMs }),
		...(diagnostics.ttftMs === undefined ? {} : { ttftMs: diagnostics.ttftMs }),
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
		...(failureKind ? { failureKind } : {}),
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
		return input.normalizeFailure(sleepError);
	}
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
		message: runtimeErrorPublicMessage("unsupported_capability"),
	});
}
