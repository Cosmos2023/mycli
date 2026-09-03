import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
	Usage,
} from "@earendil-works/pi-ai";
import type {
	ProviderEvent,
	ProviderRequest,
	ProviderUsage,
} from "@mycli/core";
import {
	classifyProviderError,
	ProviderFailure,
} from "./errors.ts";
import {
	instrumentedFetch,
	recordProviderResponse,
	type ProviderAttemptEvidence,
} from "./instrumented-fetch.ts";
import { serializeJsonObject } from "./json-object.ts";
import type { ModelProvider, ProviderStreamOptions } from "./model-provider.ts";
import { toPiAiContext } from "./pi-ai-context.ts";
import {
	createPiAiSnapshot,
	piAiRequestModel,
	piAiStreamOptions,
	type PiAiApi,
	type PiAiModelConfig,
} from "./pi-ai-model.ts";
import { piAiPayloadTransform } from "./pi-ai-payload.ts";
import {
	canonicalToolCallId,
	piAiReplayTransportIdentity,
	piAiProviderStateEvent,
} from "./pi-ai-replay.ts";

export interface PiAiStreamFactory {
	(
		model: Model<PiAiApi>,
		context: Context,
		options: SimpleStreamOptions,
	): AsyncIterable<AssistantMessageEvent>;
}

export interface PiAiProviderOptions {
	readonly config: PiAiModelConfig;
	readonly fetch?: typeof globalThis.fetch;
	readonly streamFactory?: PiAiStreamFactory;
}

export class PiAiProvider implements ModelProvider {
	readonly #config: PiAiModelConfig;
	readonly #fetch: typeof globalThis.fetch;
	#snapshot: Promise<Awaited<ReturnType<typeof createPiAiSnapshot>>> | undefined;
	readonly #streamFactory: PiAiStreamFactory;

	constructor(options: PiAiProviderOptions) {
		this.#config = Object.freeze({ ...options.config });
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#streamFactory = options.streamFactory ?? ((model, context, streamOptions) => {
			const snapshot = this.#snapshot;
			if (!snapshot) throw new Error("pi-ai snapshot is unavailable");
			return asyncIterableFromSnapshot(snapshot, model, context, streamOptions);
		});
	}

	async *stream(
		request: ProviderRequest,
		options: ProviderStreamOptions,
	): AsyncIterable<ProviderEvent> {
		assertRequestMatchesConfig(request, this.#config);
		if (options.signal.aborted) throw interruptedFailure();
		const snapshot = await this.#resolveSnapshot();
		const consumer = new AbortController();
		const upstreamSignal = AbortSignal.any([options.signal, consumer.signal]);
		const evidence: ProviderAttemptEvidence = {};
		let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
		let upstreamExhausted = false;
		let sawOutput = false;
		try {
			const requestModel = piAiRequestModel(snapshot, request);
			const replayTransport = piAiReplayTransportIdentity({
				routeId: this.#config.provider,
				...(snapshot.catalogProviderId === undefined
					? {}
					: { catalogProviderId: snapshot.catalogProviderId }),
				api: snapshot.api,
				model: request.model,
				apiBaseUrl: this.#config.apiBaseUrl,
			});
			const projection = toPiAiContext(
				request,
				snapshot.api,
				snapshot.model.provider,
				replayTransport,
			);
			const onPayload = piAiPayloadTransform(request, snapshot.api);
			const streamOptions: SimpleStreamOptions = {
				...piAiStreamOptions(this.#config, request, requestModel, upstreamSignal),
				fetch: instrumentedFetch(evidence, this.#fetch),
				...(onPayload === undefined ? {} : { onPayload }),
				onResponse: (response) => {
					recordProviderResponse(evidence, response.status, response.headers);
				},
			};
			const events = this.#streamFactory(
				requestModel.model,
				projection.context,
				streamOptions,
			);
			iterator = events[Symbol.asyncIterator]();
			let terminal: Extract<AssistantMessageEvent, { type: "done" | "error" }> | undefined;
			while (true) {
				const result = await iterator.next();
				if (result.done) {
					upstreamExhausted = true;
					break;
				}
				if (terminal) {
					throw new ProviderFailure({
						code: "provider_error",
						message: "pi-ai emitted an event after terminal completion",
					});
				}
				const event = result.value;
				switch (event.type) {
					case "text_delta":
						if (event.delta) {
							sawOutput = true;
							yield { type: "text_delta", text: event.delta };
						}
						break;
					case "thinking_delta":
						if (event.delta) {
							sawOutput = true;
							yield { type: "reasoning_delta", text: event.delta };
						}
						break;
					case "done":
					case "error":
						terminal = event;
						break;
					case "start":
					case "text_start":
					case "text_end":
					case "thinking_start":
					case "thinking_end":
					case "toolcall_start":
					case "toolcall_delta":
					case "toolcall_end":
						break;
				}
			}
			if (!terminal) {
				throw new ProviderFailure({
					code: "response_stream_error",
					message: "pi-ai stream ended without a terminal event",
					retryable: true,
				});
			}
			if (terminal.type === "error") {
				throw piAiFailure(
					terminal.error.errorMessage,
					evidence,
					options.signal,
					sawOutput,
				);
			}
			for (const event of completedEvents(
				request,
				terminal.message,
				replayTransport,
			)) yield event;
		} catch (error) {
			if (options.signal.aborted) throw interruptedFailure();
			throw classifyPiAiThrownFailure(error, evidence, options.signal, sawOutput);
		} finally {
			consumer.abort("pi-ai stream consumer stopped");
			if (!upstreamExhausted && iterator?.return) {
				try {
					await iterator.return(undefined);
				} catch {
					// The abort signal already owns upstream termination.
				}
			}
		}
	}

	#resolveSnapshot(): Promise<Awaited<ReturnType<typeof createPiAiSnapshot>>> {
		return this.#snapshot ??= createPiAiSnapshot(this.#config);
	}
}

async function* asyncIterableFromSnapshot(
	snapshot: Promise<Awaited<ReturnType<typeof createPiAiSnapshot>>>,
	model: Model<PiAiApi>,
	context: Context,
	options: SimpleStreamOptions,
): AsyncIterable<AssistantMessageEvent> {
	const resolved = await snapshot;
	yield* resolved.models.streamSimple(model, context, options);
}

function completedEvents(
	request: ProviderRequest,
	message: AssistantMessage,
	replayTransport: ReturnType<typeof piAiReplayTransportIdentity>,
): readonly ProviderEvent[] {
	if (message.stopReason === "length") {
		throw new ProviderFailure({
			code: "provider_error",
			message: "provider output token limit reached",
		});
	}
	if (message.stopReason === "pending" || message.stopReason === "deferred") {
		throw new ProviderFailure({
			code: "unsupported_capability",
			message: "provider returned an unsupported deferred response",
		});
	}
	if (message.stopReason !== "stop" && message.stopReason !== "toolUse") {
		throw new ProviderFailure({
			code: "provider_error",
			message: "provider returned an unsuccessful terminal response",
		});
	}
	const toolCalls = message.content.filter((block) => block.type === "toolCall");
	const text = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	if (!text && toolCalls.length === 0) {
		throw new ProviderFailure({
			code: "provider_error",
			message: "provider returned an empty successful response",
		});
	}
	const events: ProviderEvent[] = [];
	const state = piAiProviderStateEvent(message, request.provider, replayTransport);
	if (state) events.push(state);
	for (const toolCall of toolCalls) {
		const callId = canonicalToolCallId(toolCall.id);
		if (!callId || !toolCall.name) {
			throw new ProviderFailure({
				code: "tool_protocol_error",
				message: "pi-ai tool call is missing an id or name",
			});
		}
		events.push({
			type: "tool_call",
			callId,
			name: toolCall.name,
			argumentsJson: serializeToolArguments(toolCall.arguments),
		});
	}
	const usage = canonicalUsage(request.protocol, message.usage);
	if (Object.values(usage).some((value) => value !== 0)) {
		events.push({ type: "usage", usage });
	}
	events.push({
		type: "completed",
		...(message.responseId ? { responseId: message.responseId } : {}),
	});
	return Object.freeze(events);
}

function serializeToolArguments(value: unknown): string {
	const serialized = serializeJsonObject(value);
	if (serialized) return serialized;
	throw invalidToolArguments();
}

function invalidToolArguments(): ProviderFailure {
	return new ProviderFailure({
		code: "tool_protocol_error",
		message: "pi-ai tool arguments must be a JSON object",
	});
}

function canonicalUsage(
	protocol: ProviderRequest["protocol"],
	usage: Usage,
): ProviderUsage {
	switch (protocol) {
		case "responses":
			return Object.freeze({
				input_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
				output_tokens: usage.output,
				total_tokens: usage.totalTokens,
				...(usage.cacheRead > 0 ? { cached_tokens: usage.cacheRead } : {}),
				...(usage.cacheWrite > 0 ? { cache_write_tokens: usage.cacheWrite } : {}),
				...(usage.reasoning !== undefined && usage.reasoning > 0
					? { reasoning_tokens: usage.reasoning }
					: {}),
			});
		case "chat_completions":
			return Object.freeze({
				input_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
				output_tokens: usage.output,
				total_tokens: usage.totalTokens,
				...(usage.cacheRead > 0 ? { cached_tokens: usage.cacheRead } : {}),
				...(usage.reasoning !== undefined && usage.reasoning > 0
					? { reasoning_tokens: usage.reasoning }
					: {}),
			});
		case "anthropic_messages":
			return Object.freeze({
				input_tokens: usage.input,
				output_tokens: usage.output,
				cache_creation_input_tokens: usage.cacheWrite,
				cache_read_input_tokens: usage.cacheRead,
			});
	}
}

function piAiFailure(
	message: string | undefined,
	evidence: ProviderAttemptEvidence,
	callerSignal: AbortSignal,
	sawOutput: boolean,
): ProviderFailure {
	if (callerSignal.aborted) return interruptedFailure();
	if (evidence.response && evidence.response.status >= 400) {
		const parsed = structuredError(message);
		return classifyProviderError({
			...(isRecord(parsed) ? parsed : {}),
			status: evidence.response.status,
			headers: evidence.response.headers,
		});
	}
	if (evidence.transportError !== undefined) {
		return classifyProviderError(evidence.transportError);
	}
	const parsed = structuredError(message);
	if (parsed) return classifyProviderError(parsed);
	const normalized = message?.slice(0, 1_024).toLowerCase() ?? "";
	if (/\b(abort|cancel)(?:ed)?\b/u.test(normalized)) return interruptedFailure();
	if (/\b(timeout|timed out|fetch failed|network|socket|econn|enotfound|eai_again)\b/u.test(normalized)) {
		return new ProviderFailure({
			code: sawOutput ? "response_stream_error" : "connection_error",
			message: "provider transport failed",
			retryable: true,
		});
	}
	if (/\b(truncated|premature|ended before|ended without|stream ended)\b/u.test(normalized)) {
		return new ProviderFailure({
			code: "response_stream_error",
			message: "provider response stream ended prematurely",
			retryable: true,
		});
	}
	return new ProviderFailure({
		code: "provider_error",
		message: "pi-ai provider request failed",
	});
}

function classifyPiAiThrownFailure(
	error: unknown,
	evidence: ProviderAttemptEvidence,
	callerSignal: AbortSignal,
	sawOutput: boolean,
): ProviderFailure {
	if (callerSignal.aborted) return interruptedFailure();
	if (error instanceof ProviderFailure) return error;
	if (evidence.response?.status !== undefined || evidence.transportError !== undefined) {
		return piAiFailure(errorMessage(error), evidence, callerSignal, sawOutput);
	}
	const classified = classifyProviderError(error);
	if (classified.code !== "provider_error"
		|| classified.retryable
		|| Object.keys(classified.diagnostics).length > 0) {
		return classified;
	}
	return piAiFailure(errorMessage(error), evidence, callerSignal, sawOutput);
}

function errorMessage(error: unknown): string | undefined {
	return error instanceof Error
		? error.message
		: isRecord(error) && typeof error.message === "string"
			? error.message
			: undefined;
}

function structuredError(message: string | undefined): unknown | undefined {
	if (!message) return undefined;
	const start = message.indexOf("{");
	if (start === -1) return undefined;
	try {
		const parsed = JSON.parse(message.slice(start)) as unknown;
		return typeof parsed === "object" && parsed !== null ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function assertRequestMatchesConfig(
	request: ProviderRequest,
	config: PiAiModelConfig,
): void {
	if (request.provider !== config.provider
		|| request.protocol !== config.protocol
		|| request.model !== config.model) {
			throw new ProviderFailure({
				code: "config_error",
				message: "provider request does not match transport configuration",
			});
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function interruptedFailure(): ProviderFailure {
	return new ProviderFailure({
		code: "interrupted",
		message: "provider request interrupted",
	});
}
