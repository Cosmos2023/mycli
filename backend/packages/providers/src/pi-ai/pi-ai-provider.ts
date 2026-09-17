import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
	Usage,
} from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type {
	ProviderEvent,
	ProviderRequest,
	ProviderUsage,
} from "@mycli/core";
import { ProviderFailure } from "../errors.ts";
import {
	instrumentedFetch,
	recordProviderResponse,
	type ProviderAttemptEvidence,
} from "./instrumented-fetch.ts";
import { serializeJsonObject } from "./json-object.ts";
import type { ModelProvider, ProviderCapabilities, ProviderStreamOptions, ProviderStreamPhase } from "../model-provider.ts";
import { toPiAiContext } from "./pi-ai-context.ts";
import {
	classifyPiAiThrownFailure,
	interruptedFailure,
	invalidPiAiToolArguments,
	piAiFailure,
} from "./pi-ai-failure.ts";
import {
	createPiAiSnapshot,
	piAiRequestModel,
	piAiStreamOptions,
	type PiAiApi,
	type PiAiModelConfig,
} from "./pi-ai-model.ts";
import { piAiPayloadTransform } from "./pi-ai-payload.ts";
import { PiAiWebSearchStream, type PiAiStreamEvent } from "./pi-ai-web-search.ts";
import { createPiAiRequestModels, piAiAuthFailure } from "./pi-ai-auth.ts";
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
	readonly #streamFactory: PiAiStreamFactory | undefined;

	constructor(options: PiAiProviderOptions) {
		this.#config = Object.freeze({ ...options.config });
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#streamFactory = options.streamFactory;
	}

	async resolveCapabilities(): Promise<ProviderCapabilities> {
		const snapshot = await this.#resolveSnapshot();
		return Object.freeze({
			supportsImages: snapshot.model.input.includes("image"),
			maxOutputTokens: snapshot.model.maxTokens,
			contextWindowTokens: snapshot.model.contextWindow,
			...(snapshot.catalogued ? { reasoningEfforts: Object.freeze(
				getSupportedThinkingLevels(snapshot.model).map((level) => level === "off" ? "none" as const : level),
			) } : {}),
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
		let iterator: AsyncIterator<AssistantMessageEvent | PiAiStreamEvent> | undefined;
		let upstreamExhausted = false;
		let sawOutput = false;
		const reportPhase = (phase: ProviderStreamPhase): void => {
			try { options.onPhase?.(phase); } catch { /* Timing cannot change provider outcomes. */ }
		};
		try {
			const requestModel = piAiRequestModel(snapshot, request);
			if (!requestModel.model.input.includes("image") && request.items?.some((item) =>
				(item.type === "user" || item.type === "tool_result") && (item.images?.length ?? 0) > 0)) {
				throw new ProviderFailure({
					code: "unsupported_capability",
					message: "The selected model does not support image input.",
					errorReason: { reason: "capability.image_input_unsupported", details: {
						provider: request.provider, model: request.model,
						input_origin: request.items?.some((item) => item.type === "tool_result" && item.images?.length) ? "tool" : "history",
					} },
					outcome: { state: "not_started", effects: "none" },
				});
			}
			const replayTransport = piAiReplayTransportIdentity({
				routeId: this.#config.provider,
				...(snapshot.catalogProviderId === undefined
					? {}
					: { catalogProviderId: snapshot.catalogProviderId }),
				api: snapshot.api,
				model: request.model,
				apiBaseUrl: this.#config.apiBaseUrl,
				...(snapshot.nativeTransport ? { nativeTransport: snapshot.nativeTransport } : {}),
			});
			const projection = toPiAiContext(
				request,
				snapshot.api,
				snapshot.model.provider,
				replayTransport,
			);
			const onPayload = piAiPayloadTransform(request, snapshot.api);
			const webSearch = request.webSearchMode === "live" ? new PiAiWebSearchStream() : undefined;
			const streamOptions: SimpleStreamOptions = {
				...piAiStreamOptions(this.#config, request, requestModel, upstreamSignal),
				fetch: instrumentedFetch(evidence, this.#fetch, request.protocol,
					requestModel.model.compat && "supportsFinishReason" in requestModel.model.compat
						? requestModel.model.compat?.supportsFinishReason : undefined,
					() => reportPhase("response_terminal"),
					webSearch ? (event) => webSearch.observe(event) : undefined),
				...(onPayload === undefined ? {} : { onPayload }),
				onResponse: (response) => {
					recordProviderResponse(evidence, response.status, response.headers);
				},
			};
			const events = this.#streamFactory ? this.#streamFactory(
				requestModel.model,
				projection.context,
				streamOptions,
			) : asyncIterableFromSnapshot(snapshot, requestModel.model, projection.context,
				streamOptions, this.#config, (failure) => { evidence.authFailure ??= failure ?? piAiAuthFailure(); });
			iterator = (webSearch ? webSearch.merge(events, upstreamSignal) : events)[Symbol.asyncIterator]();
			let terminal: Extract<AssistantMessageEvent, { type: "done" | "error" }> | undefined;
			while (!terminal) {
				const result = await iterator.next();
				if (result.done) {
					upstreamExhausted = true;
					break;
				}
				const event = result.value;
				switch (event.type) {
					case "web_search_started":
					case "web_search_completed":
						sawOutput = true;
						yield event;
						break;
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
						reportPhase("sdk_terminal");
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
			if (options.signal.aborted) throw interruptedFailure();

			let completionEvents: readonly ProviderEvent[];
			try {
				if (evidence.authFailure) throw evidence.authFailure;
				if (evidence.responseStreamFailure) throw evidence.responseStreamFailure;
				if (evidence.httpResponseFailure) throw evidence.httpResponseFailure;
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
				completionEvents = completedEvents(
					request,
					terminal.message,
					replayTransport,
					requestModel.model.maxTokens,
				);
			} catch (error) {
				// Validation must not discard billable usage from a truncated response.
				const message = terminal?.type === "done" ? terminal.message : terminal?.error;
				if (message && !options.signal.aborted) {
					const usage = canonicalUsage(request.protocol, message.usage);
					if (Object.values(usage).some((count) => count !== 0)) yield { type: "usage", usage };
					else if (terminal?.type === "done") yield { type: "usage", usage: {} };
				}
				throw error;
			}
			for (const event of completionEvents) yield event;
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

function asyncIterableFromSnapshot(
	snapshot: Awaited<ReturnType<typeof createPiAiSnapshot>>,
	model: Model<PiAiApi>,
	context: Context,
	options: SimpleStreamOptions,
	config: PiAiModelConfig,
	onAuthFailure: (failure?: ProviderFailure) => void,
): AsyncIterable<AssistantMessageEvent> {
	const provider = snapshot.models.getProvider(model.provider);
	if (!provider) throw new ProviderFailure({ code: "config_error", message: "pi-ai provider snapshot is unavailable" });
	return createPiAiRequestModels(provider, config, onAuthFailure).streamSimple(model, context, options);
}

function completedEvents(
	request: ProviderRequest,
	message: AssistantMessage,
	replayTransport: ReturnType<typeof piAiReplayTransportIdentity>,
	maxOutputTokens: number,
): readonly ProviderEvent[] {
	if (message.stopReason === "length") {
		throw new ProviderFailure({
			code: "provider_error",
			message: "provider output token limit reached",
			publicDetail: "Output token limit reached before the response completed.",
			errorReason: { reason: "provider.output_limit", details: { finish_reason: "length",
				max_output_tokens: maxOutputTokens } },
		});
	}
	if (message.stopReason === "pending" || message.stopReason === "deferred") {
		throw new ProviderFailure({
			code: "unsupported_capability",
			message: "provider returned an unsupported deferred response",
			errorReason: { reason: "capability.deferred_response_unsupported", details: { provider: request.provider, model: request.model } },
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
			publicDetail: "The provider returned no answer or tool call.",
			errorReason: { reason: "provider.empty_response", details: { finish_reason: message.stopReason } },
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
	throw invalidPiAiToolArguments();
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
