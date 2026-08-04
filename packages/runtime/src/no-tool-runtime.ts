import type { NodeRuntimeConfig } from "@mycli/config";
import {
	fingerprintSubmission,
	projectNoToolRequest,
} from "@mycli/core";
import type {
	ProviderEvent,
	ProviderUsage,
	ReasoningEffort,
	RuntimeErrorCode,
	RuntimeEvent,
} from "@mycli/core";
import {
	ProviderFailure,
} from "@mycli/providers";
import type { ModelProvider } from "@mycli/providers";
import {
	StorageFailure,
} from "@mycli/storage";
import type { SessionStore, TurnReservation } from "@mycli/storage";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import {
	decideRetry,
	sleepWithSignal,
} from "./retry-policy.ts";

export interface NoToolSubmission {
	readonly clientTurnId: string;
	readonly turnId?: string;
	readonly message: string;
	readonly localImages?: readonly string[];
	readonly modelOverride?: string;
	readonly reasoningEffort?: ReasoningEffort;
}

export interface NoToolRuntimeOptions {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly instructions: string;
	readonly store: SessionStore;
	readonly resolveConfig: (
		submission: NoToolSubmission,
	) => NodeRuntimeConfig | Promise<NodeRuntimeConfig>;
	readonly createProvider: (config: NodeRuntimeConfig) => ModelProvider;
	readonly createTurnId: () => string;
	readonly clock: () => string;
	readonly maxOutputTokens?: number;
	readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
	readonly random?: () => number;
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

interface StreamResult {
	readonly assistantText: string;
	readonly usage: ProviderUsage;
	readonly responseId?: string;
}

export class NoToolRuntime {
	readonly #options: NoToolRuntimeOptions;

	constructor(options: NoToolRuntimeOptions) {
		this.#options = options;
	}

	reserve(submission: NoToolSubmission): TurnReservation {
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
		submission: NoToolSubmission,
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
				message: "local images are not supported by the Node no-tool runtime",
				retryable: false,
			}, emit);
		}

		let config: NodeRuntimeConfig;
		let provider: ModelProvider;
		try {
			assertNotAborted(options.signal);
			config = await this.#options.resolveConfig(submission);
			if (config.sessionId !== this.#options.sessionId) {
				throw configFailure("resolved session does not match runtime session");
			}
			provider = this.#options.createProvider(config);
		} catch (error) {
			return this.#finalizeFailure(
				submission,
				normalizeFailure(error, options.signal, "config_error"),
				emit,
			);
		}

		let request: ReturnType<typeof projectNoToolRequest>;
		try {
			const history = this.#historyBeforeCurrentSubmission(submission.message);
			request = projectNoToolRequest({
				config: {
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
				instructions: this.#options.instructions,
				history,
				userText: submission.message,
			});
		} catch (error) {
			return this.#finalizeFailure(
				submission,
				normalizeFailure(error, options.signal, "config_error"),
				emit,
			);
		}

		const streamResult = await this.#streamWithRetry(
			provider,
			request,
			config.streamMaxRetries,
			emit,
			options.signal,
		);
		if ("failure" in streamResult) {
			return this.#finalizeFailure(submission, streamResult.failure, emit);
		}

		try {
			assertNotAborted(options.signal);
			const completed = this.#options.store.completeTurn({
				sessionId: this.#options.sessionId,
				clientTurnId: submission.clientTurnId,
				assistantText: streamResult.assistantText,
				usage: streamResult.usage,
				...(streamResult.responseId ? { responseId: streamResult.responseId } : {}),
				completedAt: this.#options.clock(),
			});
			emit({
				type: "turn_completed",
				assistantText: streamResult.assistantText,
				usage: streamResult.usage,
			});
			return completed;
		} catch (error) {
			return this.#finalizeFailure(
				submission,
				normalizeFailure(error, options.signal, "persistence_error"),
				emit,
			);
		}
	}

	async #streamWithRetry(
		provider: ModelProvider,
		request: Parameters<ModelProvider["stream"]>[0],
		maxRetries: number,
		emit: (event: RuntimeEvent) => void,
		signal: AbortSignal,
	): Promise<StreamResult | { readonly failure: NormalizedFailure }> {
		let retriesUsed = 0;
		while (true) {
			let eventsObserved = 0;
			let assistantText = "";
			let usage: ProviderUsage = {};
			let responseId: string | undefined;
			let completed = false;
			try {
				assertNotAborted(signal);
				for await (const event of provider.stream(request, { signal })) {
					assertNotAborted(signal);
					eventsObserved += 1;
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
							if (completed) {
								throw providerProtocolFailure("provider emitted multiple completions");
							}
							completed = true;
							responseId = event.responseId;
							emit({
								type: "message_complete",
								...(event.responseId ? { responseId: event.responseId } : {}),
							});
							break;
						case "tool_call":
							throw unsupportedToolFailure(event);
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

	#historyBeforeCurrentSubmission(userText: string) {
		const conversation = this.#options.store.loadConversation(this.#options.sessionId);
		const current = conversation.at(-1);
		if (!current || current.role !== "user" || current.content !== userText) {
			throw new StorageFailure("reserved user message is missing from canonical history");
		}
		return conversation.slice(0, -1);
	}

	#finalizeFailure(
		submission: NoToolSubmission,
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

function unsupportedToolFailure(event: Extract<ProviderEvent, { type: "tool_call" }>): ProviderFailure {
	return new ProviderFailure({
		code: "unsupported_capability",
		message: "provider requested a tool in a no-tool turn",
		diagnostics: {
			tool_name: event.name.slice(0, 128),
			call_id_present: Boolean(event.callId),
		},
	});
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
]);
