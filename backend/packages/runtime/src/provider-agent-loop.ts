import type {
	CanonicalToolCall,
	ProviderReplayState,
	ProviderRequest,
	ProviderUsage,
	RuntimeErrorCode,
	RuntimeEvent,
} from "@mycli/core";
import type { ModelProvider } from "@mycli/providers";
import { ProviderFailure } from "@mycli/providers";
import {
	decideRetry,
	sleepWithSignal,
} from "./retry-policy.ts";

export interface ProviderAgentLoopFailure {
	readonly code: RuntimeErrorCode;
	readonly message: string;
	readonly retryable: boolean;
	readonly retryAfterSeconds?: number;
	readonly diagnostics?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ProviderAgentLoopStepResult {
	readonly assistantText: string;
	readonly usage: ProviderUsage;
	readonly responseId?: string;
	readonly toolCalls: readonly CanonicalToolCall[];
	readonly providerState?: ProviderReplayState;
}

export type ProviderAgentLoopResult = ProviderAgentLoopStepResult | {
	readonly failure: ProviderAgentLoopFailure;
	readonly eventsObserved: number;
};

export interface ProviderAgentLoopInput {
	readonly provider: ModelProvider;
	readonly request: ProviderRequest;
	readonly maxRetries: number;
	readonly signal: AbortSignal;
	readonly toolCallsAllowed: boolean;
	readonly emit: (event: RuntimeEvent) => void;
	readonly normalizeFailure: (error: unknown) => ProviderAgentLoopFailure;
	readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
	readonly random?: () => number;
}

export class ProviderAgentLoop {
	async runStep(input: ProviderAgentLoopInput): Promise<ProviderAgentLoopResult> {
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
				input.signal.throwIfAborted();
				for await (const event of input.provider.stream(input.request, { signal: input.signal })) {
					input.signal.throwIfAborted();
					eventsObserved += 1;
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
					}
				}
				if (!completed) throw providerProtocolFailure("provider stream ended without completion");
				if (retriesUsed > 0) input.emit({ type: "stream_recovered" });
				return {
					assistantText,
					usage,
					toolCalls,
					...(responseId ? { responseId } : {}),
					...(providerState ? { providerState } : {}),
				};
			} catch (error) {
				const failure = input.normalizeFailure(error);
				const decision = decideRetry({
					retryable: failure.retryable,
					eventsObserved,
					retriesUsed,
					maxRetries: input.maxRetries,
					...(failure.retryAfterSeconds === undefined
						? {}
						: { retryAfterSeconds: failure.retryAfterSeconds }),
					random: input.random ?? Math.random,
				});
				if (!decision.shouldRetry) {
					const retryLimit = Math.max(0, Math.min(100, Math.trunc(input.maxRetries)));
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
				input.emit({
					type: "stream_retrying",
					attempt: decision.attempt,
					delayMs: decision.delayMs,
				});
				try {
					input.signal.throwIfAborted();
					await (input.sleep ?? sleepWithSignal)(decision.delayMs, input.signal);
					input.signal.throwIfAborted();
				} catch (sleepError) {
					return {
						failure: input.normalizeFailure(sleepError),
						eventsObserved,
					};
				}
				retriesUsed += 1;
			}
		}
	}
}

export function normalizeProviderAgentLoopFailure(
	error: unknown,
	signal: AbortSignal,
): ProviderAgentLoopFailure {
	if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
		return { code: "interrupted", message: "turn interrupted", retryable: false };
	}
	if (error instanceof ProviderFailure) {
		return {
			code: error.code,
			message: publicProviderMessage(error.code),
			retryable: error.retryable,
			...(Object.keys(error.diagnostics).length > 0 ? { diagnostics: error.diagnostics } : {}),
			...(error.retryAfterSeconds === undefined
				? {}
				: { retryAfterSeconds: error.retryAfterSeconds }),
		};
	}
	return { code: "provider_error", message: "provider request failed", retryable: false };
}

function providerProtocolFailure(message: string): ProviderFailure {
	return new ProviderFailure({ code: "provider_error", message });
}

function unsupportedToolFailure(): ProviderFailure {
	return new ProviderFailure({
		code: "unsupported_capability",
		message: "provider requested an unsupported capability",
	});
}

function publicProviderMessage(code: ProviderAgentLoopFailure["code"]): string {
	switch (code) {
		case "auth_error":
			return "provider authentication failed";
		case "rate_limited":
			return "provider rate limit exceeded";
		case "context_window_exceeded":
			return "provider context window exceeded";
		case "retry_exhausted":
			return "provider retry budget exhausted";
		case "interrupted":
			return "turn interrupted";
		case "unsupported_capability":
			return "provider requested an unsupported capability";
		case "tool_protocol_error":
			return "provider tool protocol failed";
		default:
			return "provider request failed";
	}
}
