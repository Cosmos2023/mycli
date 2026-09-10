import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent, ProviderRequest } from "@mycli/core";
import { ProviderFailure } from "../../src/errors.ts";
import { PiAiProvider } from "../../src/pi-ai/pi-ai-provider.ts";
import type { ProviderStreamOptions, ProviderStreamPhase } from "../../src/model-provider.ts";

test("Responses completes and releases the body without upstream EOF or cancellation acknowledgement", { timeout: 5_000 }, async () => {
	const source = controlledResponse(() => new Promise(() => undefined));
	const events: ProviderEvent[] = [];
	const phases: ProviderStreamPhase[] = [];
	const result = collect(provider(source.response), events, (phase) => { phases.push(phase); });
	try {
		for (const frame of responseFrames()) source.send(sse(frame));
		await result;
		assert.deepEqual(phases, ["response_terminal", "sdk_terminal"]);
		assert.equal(source.cancelled, true);
		assert.equal(source.response.body?.locked, false);
		assert.deepEqual(events.find((event) => event.type === "text_delta"), {
			type: "text_delta", text: "done",
		});
		assert.deepEqual(events.find((event) => event.type === "usage"), {
			type: "usage", usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6, cached_tokens: 1 },
		});
		assert.deepEqual(events.at(-1), { type: "completed", responseId: "resp-test" });
	} finally {
		source.close();
		await result.catch(() => undefined);
	}
});

test("Responses ignores events after completion in the same network chunk", async () => {
	const frames = responseFrames();
	const source = controlledResponse();
	source.send(frames.map(sse).join("") + sse({
		type: "error", code: "server_error", message: "late transport event",
	}));
	source.close();
	const events: ProviderEvent[] = [];
	await collect(provider(source.response), events);
	assert.deepEqual(events.at(-1), { type: "completed", responseId: "resp-test" });
});

test("Responses preserves split UTF-8, CRLF, and multiline SSE data", { timeout: 5_000 }, async () => {
	const source = controlledResponse();
	const events: ProviderEvent[] = [];
	const result = collect(provider(source.response), events);
	try {
		const text = "done \u4f60\u597d";
		const frames = responseFrames(text).map((frame) =>
			`: keepalive\r\nevent: ${frame.type}\r\n${JSON.stringify(frame, null, 2)
				.split("\n").map((line) => `data: ${line}\r\n`).join("")}\r\n`,
		).join("");
		for (const byte of new TextEncoder().encode(frames)) source.send(new Uint8Array([byte]));
		await result;
		assert.equal(source.cancelled, true);
		assert.equal(events.filter((event) => event.type === "text_delta").map((event) => event.text).join(""), text);
		assert.equal(events.at(-1)?.type, "completed");
	} finally {
		source.close();
		await result.catch(() => undefined);
	}
});

test("Responses requires a complete response event before releasing tool calls", { timeout: 5_000 }, async () => {
	const source = controlledResponse();
	const events: ProviderEvent[] = [];
	const reachedRead = Promise.withResolvers<void>();
	source.onRead = () => reachedRead.resolve();
	const item = {
		type: "function_call", id: "fc-test", call_id: "call-test", name: "Read",
		arguments: '{"file_path":"README.md"}', status: "completed",
	};
	const completed = sse({
		type: "response.completed",
		response: { id: "resp-test", status: "completed", output: [item] },
	});
	source.send(sse({ type: "response.output_item.done", output_index: 0, item }));
	source.send(completed.slice(0, -1));
	const result = collect(provider(source.response), events);
	try {
		await reachedRead.promise;
		assert.equal(events.some((event) => event.type === "tool_call" || event.type === "completed"), false);
		source.send("\n");
		await result;
		assert.deepEqual(events.find((event) => event.type === "tool_call"), {
			type: "tool_call", callId: "call-test", name: "Read", argumentsJson: item.arguments,
		});
		assert.equal(events.at(-1)?.type, "completed");
		assert.equal(source.cancelled, true);
	} finally {
		source.close();
		await result.catch(() => undefined);
	}
});

test("Responses EOF without completion is retryable and never releases tools", async () => {
	const source = controlledResponse();
	source.send(sse({ type: "response.output_item.done", output_index: 0, item: {
		type: "function_call", id: "fc-test", call_id: "call-test", name: "Read", arguments: "{}",
	} }));
	source.close();
	const events: ProviderEvent[] = [];
	await assert.rejects(collect(provider(source.response), events), (error: unknown) => {
		assert(error instanceof ProviderFailure);
		assert.equal(error.code, "response_stream_error");
		assert.equal(error.retryable, true);
		return true;
	});
	assert.equal(events.some((event) => event.type === "tool_call" || event.type === "completed"), false);
});

test("Responses rejects malformed completion and truncated event frames", async (context) => {
	const terminal = sse({ type: "response.completed", response: { id: "resp-test", status: "completed" } });
	for (const [name, frame] of [
		["missing response", sse({ type: "response.completed" })],
		["missing response id", sse({ type: "response.completed", response: { status: "completed" } })],
		["malformed JSON", 'data: {"type":"response.completed","private":"payload"\n\n'],
		["unterminated SSE frame", terminal.slice(0, -1)],
	] as const) {
		await context.test(name, async () => {
			const source = controlledResponse();
			source.send(responseFrames().slice(0, -1).map(sse).join("") + frame);
			source.close();
			const events: ProviderEvent[] = [];
			await assert.rejects(collect(provider(source.response), events), (error: unknown) => {
				assert(error instanceof ProviderFailure);
				assert.equal(error.code, "response_stream_error");
				assert.equal(error.retryable, true);
				assert.doesNotMatch(JSON.stringify(error), /private|payload/u);
				return true;
			});
			assert.equal(events.some((event) => event.type === "completed"), false);
			assert.equal(source.response.body?.locked, false);
		});
	}
});

test("Responses incomplete and failed events settle without EOF and never succeed", { timeout: 5_000 }, async (context) => {
	for (const [type, response, code] of [
		["response.incomplete", { id: "resp-test", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, "provider_error"],
		["response.failed", { id: "resp-test", status: "failed", error: { code: "invalid_api_key", message: "invalid credential" } }, "auth_error"],
	] as const) {
		await context.test(type, async () => {
			const source = controlledResponse();
			const events: ProviderEvent[] = [];
			const result = collect(provider(source.response), events);
			try {
				source.send(responseFrames().slice(0, -1).map(sse).join("") + sse({ type, response }));
				await assert.rejects(result, (error: unknown) => error instanceof ProviderFailure && error.code === code);
				assert.equal(events.some((event) => event.type === "completed"), false);
				assert.equal(source.cancelled, true);
			} finally {
				source.close();
				await result.catch(() => undefined);
			}
		});
	}
});

function provider(response: Response): PiAiProvider {
	return new PiAiProvider({
		config: {
			provider: "openai", protocol: "responses", model: "gpt-test", supportsImages: false,
			apiBaseUrl: "https://offline.invalid/v1", apiKey: "test-key",
			modelContextWindowTokens: 128_000, maxOutputTokens: 16_000, maxPromptTokens: 100_000,
		},
		fetch: async () => response,
	});
}

async function collect(provider: PiAiProvider, events: ProviderEvent[], onPhase?: ProviderStreamOptions["onPhase"]): Promise<void> {
	const request: ProviderRequest = {
		provider: "openai", protocol: "responses", model: "gpt-test", instructions: "system",
		messages: [{ role: "user", content: "hello" }], tools: [],
	};
	for await (const event of provider.stream(request, {
		signal: new AbortController().signal, ...(onPhase ? { onPhase } : {}),
	})) events.push(event);
}

function responseFrames(text = "done"): readonly Readonly<Record<string, unknown>>[] {
	const item = {
		type: "message", id: "msg-test", role: "assistant", status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	return [
		{ type: "response.created", response: { id: "resp-test", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: {
			id: "resp-test", status: "completed", output: [item],
			usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6, input_tokens_details: { cached_tokens: 1 } },
		} },
	];
}

function sse(frame: Readonly<Record<string, unknown>>): string {
	return `data: ${JSON.stringify(frame)}\n\n`;
}

interface ControlledResponse {
	readonly response: Response;
	readonly cancelled: boolean;
	onRead: (() => void) | undefined;
	send(chunk: string | Uint8Array): void;
	close(): void;
}

function controlledResponse(onCancel?: () => Promise<void>): ControlledResponse {
	let controller: ReadableStreamDefaultController<Uint8Array>;
	let cancelled = false;
	let closed = false;
	const result: ControlledResponse = {
		response: new Response(new ReadableStream<Uint8Array>({
			start(value): void { controller = value; },
			pull(): void { result.onRead?.(); },
			cancel(): Promise<void> | undefined { cancelled = true; return onCancel?.(); },
		}, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }),
		get cancelled() { return cancelled; },
		onRead: undefined,
		send(chunk): void { controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk); },
		close(): void { if (!cancelled && !closed) { closed = true; controller.close(); } },
	};
	return result;
}
