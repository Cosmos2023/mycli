import type { ProtocolId } from "@mycli/core";

export type StreamFixtureScenario =
	| "healthy" | "nested_error" | "fatal_type" | "empty_error"
	| "premature_eof" | "transport_reset" | "completion_then_error"
	| "overload" | "quota_type" | "permission_type" | "context_type" | "invalid_request_type"
	| "malformed_json" | "empty_json" | "http_502" | "http_quota_429" | "transport_timeout" | "caller_abort";

interface FixtureControls {
	readonly signal?: AbortSignal;
	readonly onPendingRead?: () => void;
}

export function providerStreamFixture(
	protocol: ProtocolId,
	scenario: StreamFixtureScenario,
	controls: FixtureControls = {},
): Response {
	if (scenario === "http_502" || scenario === "http_quota_429") {
		return new Response(scenario === "http_502" ? "upstream request failed"
			: JSON.stringify({ error: { type: "insufficient_quota", message: "quota exhausted" } }), {
			status: scenario === "http_502" ? 502 : 429,
			headers: { "content-type": scenario === "http_502" ? "text/plain" : "application/json",
				"retry-after": "2", "x-request-id": "builtin-fixture-request" },
		});
	}
	const frames = protocolFrames(protocol);
	const prefix = scenario === "healthy" || scenario === "completion_then_error"
		? frames.join("")
		: frames.slice(0, protocol === "anthropic_messages" ? 3 : 2).join("");
	const failureTypes: Partial<Record<StreamFixtureScenario, string>> = {
		fatal_type: "authentication_error", overload: "overloaded_error", quota_type: "insufficient_quota",
		permission_type: "permission_error", context_type: "context_length_exceeded", invalid_request_type: "invalid_request_error",
	};
	const failureType = failureTypes[scenario];
	const error = failureType !== undefined ? { type: failureType, message: "request rejected" }
		: scenario === "empty_error" ? {}
			: { code: "stream_read_error", type: "server_error", message: "upstream stream interrupted" };
	const suffix = failureType !== undefined || ["nested_error", "empty_error", "completion_then_error"].includes(scenario)
		? sse({ type: "error", error }, protocol === "anthropic_messages" ? "error" : undefined)
		: scenario === "malformed_json" ? "data: {invalid-private-envelope\n\n"
			: scenario === "empty_json" ? "data: {}\n\n" : "";
	let sent = false;
	let removeAbort: (() => void) | undefined;
	return new Response(new ReadableStream<Uint8Array>({
		start(controller): void {
			if (scenario !== "caller_abort" || !controls.signal) return;
			const signal = controls.signal;
			const onAbort = (): void => { controller.error(signal.reason); };
			signal.addEventListener("abort", onAbort, { once: true });
			removeAbort = (): void => { signal.removeEventListener("abort", onAbort); };
		},
		pull(controller): void | Promise<void> {
			if (!sent) {
				sent = true;
				controller.enqueue(new TextEncoder().encode(prefix + suffix));
			} else if (scenario === "transport_reset" || scenario === "transport_timeout") {
				controller.error(new TypeError("terminated", {
					cause: Object.assign(new Error("transport interrupted"), {
						code: scenario === "transport_reset" ? "UND_ERR_SOCKET" : "UND_ERR_BODY_TIMEOUT",
					}),
				}));
			} else if (scenario === "caller_abort") {
				controls.onPendingRead?.();
				return new Promise(() => undefined);
			} else {
				controller.close();
			}
		},
		cancel(): void { removeAbort?.(); },
	}, { highWaterMark: 0 }), {
		headers: { "content-type": "text/event-stream", "x-request-id": "builtin-fixture-request" },
	});
}

function protocolFrames(protocol: ProtocolId): readonly string[] {
	switch (protocol) {
		case "chat_completions":
			return [
				sse({ id: "chat-fixture", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }),
				sse({ id: "chat-fixture", choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }] }),
				sse({ id: "chat-fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
				// Usage is a separate chunk after finish_reason on OpenAI-compatible streams.
				sse({ id: "chat-fixture", choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }),
				"data: [DONE]\n\n",
			];
		case "responses": {
			const item = { type: "message", id: "message-fixture", role: "assistant", status: "completed",
				content: [{ type: "output_text", text: "done", annotations: [] }] };
			return [
				sse({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }),
				sse({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "done" }),
				sse({ type: "response.output_item.done", output_index: 0, item }),
				sse({ type: "response.completed", response: { id: "response-fixture", status: "completed", output: [item],
					usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } }),
			];
		}
		case "anthropic_messages":
			return [
				sse({ type: "message_start", message: { id: "message-fixture", type: "message", role: "assistant",
					model: "fixture", content: [], stop_reason: null, stop_sequence: null,
					usage: { input_tokens: 4, output_tokens: 0 } } }, "message_start"),
				sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start"),
				sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }, "content_block_delta"),
				sse({ type: "content_block_stop", index: 0 }, "content_block_stop"),
				sse({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 2 } }, "message_delta"),
				sse({ type: "message_stop" }, "message_stop"),
			];
	}
}

function sse(data: unknown, event?: string): string {
	return `${event === undefined ? "" : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}
