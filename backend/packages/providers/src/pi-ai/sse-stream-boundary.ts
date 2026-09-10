import { createParser, type EventSourceParser } from "eventsource-parser";
import type { ProtocolId } from "@mycli/core";
import { ProviderFailure } from "../errors.ts";

export interface SseStreamBoundaryOptions {
	readonly protocol: ProtocolId;
	readonly supportsFinishReason?: boolean;
	readonly onFailure: (error: unknown) => void;
	readonly onTerminal?: () => void;
	readonly onEvent?: (event: Readonly<Record<string, unknown>>) => void;
}

interface SseFrame {
	readonly bytes: Uint8Array;
	readonly event: Readonly<Record<string, unknown>> | undefined;
}

export function sseStreamUntilTerminal(
	source: ReadableStream<Uint8Array>,
	options: SseStreamBoundaryOptions,
): ReadableStream<Uint8Array> {
	const reader = source.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let parser: EventSourceParser;
	let stopped = false;
	let emitted = false;
	let checkingEof = false;
	let sawChatChunk = false;
	let sawFinishReason = false;
	let terminalReported = false;

	function reportTerminal(): void {
		if (terminalReported) return;
		terminalReported = true;
		try { options.onTerminal?.(); } catch { /* Timing cannot change stream semantics. */ }
	}

	function isTerminalEvent(event: Readonly<Record<string, unknown>> | undefined, name: string | undefined): boolean {
		if (event === undefined) {
			if (options.protocol !== "chat_completions") return false;
			if (!chatCanComplete()) throw prematureStream();
			return true;
		}
		if (name === "error" || event.type === "error" || event.error != null) {
			options.onFailure(isRecord(event.error) ? event.error : {
				code: event.code, message: event.message,
				...(event.type === "error" ? {} : { type: event.type }),
			});
			return true;
		}
		switch (options.protocol) {
			case "responses":
				return responsesTerminal(event, options.onFailure);
			case "anthropic_messages":
				return event.type === "message_stop";
			case "chat_completions": {
				const choice: unknown = Array.isArray(event.choices) ? event.choices[0] : undefined;
				if (isRecord(choice)) {
					sawChatChunk = true;
					if (typeof choice.finish_reason === "string" && choice.finish_reason) {
						sawFinishReason = true;
						if (choice.finish_reason === "content_filter") {
							options.onFailure({ code: "content_policy_violation", message: "Provider rejected the response due to its content policy." });
							return true;
						}
						if (choice.finish_reason === "network_error") {
							options.onFailure(prematureStream());
							return true;
						}
					}
				}
				// Usage may follow finish_reason. Wait for DONE or a clean EOF.
				return false;
			}
		}
	}

	function chatCanComplete(): boolean {
		return sawFinishReason || (options.supportsFinishReason === false && sawChatChunk);
	}

	function cancelSource(reason: unknown): Promise<void> {
		const cancelled = reader.cancel(reason);
		reader.releaseLock();
		return cancelled;
	}

	const frames = new ReadableStream<SseFrame>({
		start(controller): void {
			parser = createParser({
				maxBufferSize: 32 * 1_024 * 1_024,
				onError(error): void {
					if (!stopped && error.type === "max-buffer-size-exceeded") throw invalidStreamEvent();
				},
				onEvent(event): void {
					if (stopped) return;
					if (checkingEof && !(options.protocol === "chat_completions"
						&& event.data === "[DONE]" && chatCanComplete())) throw prematureStream();
					const payload = parseEventData(event.data);
					const terminal = isTerminalEvent(payload, event.event);
					if (terminal) reportTerminal();
					const name = event.event === undefined ? "" : `event: ${event.event}\n`;
					const data = event.data.split("\n").map((line) => `data: ${line}\n`).join("");
					controller.enqueue({ bytes: encoder.encode(`${name}${data}\n`), event: options.onEvent ? payload : undefined });
					emitted = true;
					stopped = terminal;
				},
			});
		},
		async pull(controller): Promise<void> {
			emitted = false;
			try {
				while (!emitted) {
					const result = await reader.read();
					if (stopped) return;
					if (result.done) {
						parser.feed(decoder.decode());
						// Detect buffered event data without accepting a synthetic terminal frame.
						checkingEof = true;
						parser.feed("\n\n");
						parser.reset();
						if (!stopped && !(options.protocol === "chat_completions" && chatCanComplete())) {
							throw prematureStream();
						}
						stopped = true;
						reportTerminal();
						controller.close();
						reader.releaseLock();
						return;
					}
					parser.feed(decoder.decode(result.value, { stream: true }));
				}
				if (stopped) {
					parser.reset();
					controller.close();
					// Pi-ai still validates the terminal payload; remote cleanup must not delay it.
					void cancelSource("Provider terminal event received").catch(() => undefined);
				}
			} catch (error) {
				if (stopped) return;
				if (error instanceof ProviderFailure) options.onFailure(error);
				stopped = true;
				parser.reset();
				controller.error(error);
				void cancelSource(error).catch(() => undefined);
			}
		},
		cancel(reason: unknown): Promise<void> {
			stopped = true;
			parser.reset();
			return cancelSource(reason);
		},
	}, { highWaterMark: 0 });
	return forwardFrames(frames, options.onEvent);
}

function forwardFrames(
	frames: ReadableStream<SseFrame>,
	onEvent: SseStreamBoundaryOptions["onEvent"],
): ReadableStream<Uint8Array> {
	const reader = frames.getReader();
	let cancelled = false;
	let consumedEvent: Readonly<Record<string, unknown>> | undefined;
	return new ReadableStream<Uint8Array>({
		async pull(controller): Promise<void> {
			try {
				// The next read acknowledges SDK consumption of the preceding frame.
				if (consumedEvent) {
					const event = consumedEvent;
					consumedEvent = undefined;
					onEvent?.(event);
				}
				const result = await reader.read();
				if (cancelled) return;
				if (result.done) {
					controller.close();
					reader.releaseLock();
					return;
				}
				consumedEvent = result.value.event;
				controller.enqueue(result.value.bytes);
			} catch (error) {
				if (cancelled) return;
				controller.error(error);
				void reader.cancel(error).catch(() => undefined);
				reader.releaseLock();
			}
		},
		async cancel(reason: unknown): Promise<void> {
			cancelled = true;
			consumedEvent = undefined;
			try { await reader.cancel(reason); } finally { reader.releaseLock(); }
		},
	}, { highWaterMark: 0 });
}

function parseEventData(data: string): Readonly<Record<string, unknown>> | undefined {
	if (data === "[DONE]") return undefined;
	let event: unknown;
	try { event = JSON.parse(data); } catch { throw invalidStreamEvent(); }
	if (!isRecord(event)) throw invalidStreamEvent();
	return event;
}

function responsesTerminal(event: Readonly<Record<string, unknown>>, onFailure: (error: unknown) => void): boolean {
	switch (event.type) {
		case "response.completed":
		case "response.incomplete":
			if (!isRecord(event.response) || typeof event.response.id !== "string" || !event.response.id) {
				throw invalidStreamEvent();
			}
			return true;
		case "response.failed":
			onFailure(isRecord(event.response) && isRecord(event.response.error) ? event.response.error : {});
			return true;
		default:
			return false;
	}
}

function invalidStreamEvent(): ProviderFailure {
	return new ProviderFailure({
		code: "response_stream_error",
		message: "provider returned an invalid stream event",
		publicDetail: "Response stream contained an invalid event.",
		retryable: true,
	});
}

function prematureStream(): ProviderFailure {
	return new ProviderFailure({
		code: "response_stream_error",
		message: "provider response stream ended before completion",
		publicDetail: "Response stream ended before completion.",
		retryable: true,
	});
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
