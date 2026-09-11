import assert from "node:assert/strict";
import test from "node:test";
import type { ProtocolId, ProviderEvent, ProviderRequest } from "@mycli/core";
import { ProviderFailure } from "../../src/errors.ts";
import { PiAiProvider } from "../../src/pi-ai/pi-ai-provider.ts";
import { instrumentedFetch, type ProviderAttemptEvidence } from "../../src/pi-ai/instrumented-fetch.ts";

test("terminal timing observes protocol completion once and contains observer failures", async () => {
	for (const [protocol, frames] of [
		["responses", sse({ type: "response.completed", response: { id: "resp-test" } })],
		["responses", sse({ type: "response.failed", response: { error: { code: "server_error" } } })],
		["responses", sse({ type: "error", error: { code: "stream_read_error" } })],
		["anthropic_messages", sse({ type: "message_stop" })],
		["chat_completions", chat({ content: "done" }, "stop") + "data: [DONE]\n\n"],
		["chat_completions", chat({ content: "done" }, "stop")],
	] as const) {
		let reported = 0;
		const observed = await instrumentedFetch({}, async () => response(frames), protocol, undefined, () => {
			reported += 1;
			throw new Error("private diagnostic failure");
		})("https://offline.invalid");
		assert.ok((await observed.text()).length > 0);
		assert.equal(reported, 1, protocol);
	}
});

test("premature EOF and cancellation do not fabricate terminal timing", async () => {
	let reported = 0;
	const observed = await instrumentedFetch({}, async () => response(sse({ type: "response.created" })),
		"responses", undefined, () => { reported += 1; })("https://offline.invalid");
	await assert.rejects(observed.text(), ProviderFailure);
	assert.equal(reported, 0);
	const cancelled = await instrumentedFetch({}, async () => response(""),
		"responses", undefined, () => { reported += 1; })("https://offline.invalid");
	await cancelled.body!.cancel();
	assert.equal(reported, 0);
});

test("Chat preserves final tool arguments and late usage, and finishes without remote EOF", { timeout: 5_000 }, async () => {
	const frames = [
		chat({ tool_calls: [{ index: 0, id: "tool-1", type: "function", function: { name: "Read", arguments: '{"path":' } }] }),
		chat({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, "tool_calls"),
		sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } }),
		"data: [DONE]\n\n",
		sse({ error: { type: "authentication_error" } }),
	].join("");
	let cancelled = false;
	const events = await collect("chat_completions", new Response(new ReadableStream<Uint8Array>({
		start(controller): void { controller.enqueue(new TextEncoder().encode(frames)); },
		cancel(): Promise<void> { cancelled = true; return new Promise(() => {}); },
	}), { headers: { "content-type": "text/event-stream" } }));
	assert.equal(cancelled, true);
	assert.deepEqual(events.find((event) => event.type === "tool_call"), {
		type: "tool_call", callId: "tool-1", name: "Read", argumentsJson: '{"path":"a.ts"}',
	});
	assert.deepEqual(events.find((event) => event.type === "usage"), {
		type: "usage", usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
	});
	assert.equal(events.at(-1)?.type, "completed");
});

test("Chat clean EOF and explicit finish-reason compatibility follow pi-ai semantics", async (context) => {
	for (const done of [false, true]) {
		await context.test(`normal finish and DONE=${done}`, async () => {
			const events = await collect("chat_completions", response(chat({ content: "done" }, "stop") + (done ? "data: [DONE]\n\n" : "")));
			assert.equal(events.at(-1)?.type, "completed");
		});
		await context.test(`explicit supportsFinishReason=false and DONE=${done}`, async () => {
			const events = await collect("chat_completions", response(chat({ content: "done" }) + (done ? "data: [DONE]\n\n" : "")), false);
			assert.equal(events.at(-1)?.type, "completed");
		});
		await context.test(`required finish missing and DONE=${done}`, async () => {
			await assert.rejects(collect("chat_completions", response(chat({ content: "partial" }) + (done ? "data: [DONE]\n\n" : ""))), streamFailure);
		});
	}
	for (const tail of ["data: [DONE]", "data: [DONE]\n"]) {
		const events = await collect("chat_completions", response(chat({ content: "done" }, "stop") + tail));
		assert.equal(events.at(-1)?.type, "completed");
	}
});

test("Chat rejects incomplete frames after finish_reason and never commits partial tools", async (context) => {
	for (const tail of [
		'data: {"choices":[]',
		'data: {"choices":[]}\n',
	]) {
		await context.test(tail, async () => {
			const events: ProviderEvent[] = [];
			await assert.rejects(collect("chat_completions", response(chat({ tool_calls: [{
				index: 0, id: "tool-1", type: "function", function: { name: "Read", arguments: '{"path":"a.ts"}' },
			}] }, "tool_calls") + tail), undefined, events), streamFailure);
			assert.equal(events.some((event) => event.type === "tool_call" || event.type === "completed"), false);
		});
	}
});

test("Anthropic terminal framing handles byte-split UTF-8, CRLF and multiline data", async () => {
	const bytes = new TextEncoder().encode(': keepalive\r\nevent: content_block_delta\r\ndata: {"type":"content_block_delta",\r\ndata: "delta":{"type":"text_delta","text":"\u4f60\u597d"}}\r\n\r\nevent: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n');
	let index = 0;
	const evidence: ProviderAttemptEvidence = {};
	const observed = await instrumentedFetch(evidence, async () => new Response(new ReadableStream<Uint8Array>({
		pull(controller): void {
			if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index));
			else controller.close();
		},
	}, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }), "anthropic_messages")("https://offline.invalid");
	assert.equal(await observed.text(), 'event: content_block_delta\ndata: {"type":"content_block_delta",\ndata: "delta":{"type":"text_delta","text":"\u4f60\u597d"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
	assert.equal(evidence.responseStreamFailure, undefined);
});

test("cancelling any protocol during a pending read records no synthetic stream failure", async (context) => {
	for (const protocol of ["responses", "chat_completions", "anthropic_messages"] as const) {
		await context.test(protocol, async () => {
			const reachedRead = Promise.withResolvers<void>();
			const evidence: ProviderAttemptEvidence = {};
			const body = new ReadableStream<Uint8Array>({ pull(): void { reachedRead.resolve(); } }, { highWaterMark: 0 });
			const observed = await instrumentedFetch(evidence, async () => new Response(body, {
				headers: { "content-type": "text/event-stream" },
			}), protocol)("https://offline.invalid");
			const reader = observed.body!.getReader();
			const pending = reader.read();
			await reachedRead.promise;
			await reader.cancel("cancelled");
			assert.equal((await pending).done, true);
			reader.releaseLock();
			assert.equal(body.locked, false);
			assert.equal(evidence.responseStreamFailure, undefined);
			assert.equal(evidence.transportError, undefined);
		});
	}
});

async function collect(protocol: ProtocolId, incoming: Response, supportsFinishReason?: boolean, events: ProviderEvent[] = []): Promise<readonly ProviderEvent[]> {
	const config = {
		provider: "deepseek" as const, protocol, model: "fixture-model", apiBaseUrl: "https://offline.invalid/v1",
		apiKey: "offline-key", supportsImages: false, routeSource: "pi_ai_declared" as const,
		...(supportsFinishReason === undefined ? {} : { compat: { supportsFinishReason } }),
	};
	const request: ProviderRequest = {
		provider: config.provider, protocol, model: config.model, instructions: "fixture",
		messages: [{ role: "user", content: "fixture" }],
		tools: [{ id: "Read", name: "Read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
	};
	const provider = new PiAiProvider({ config, fetch: async () => incoming });
	for await (const event of provider.stream(request, { signal: AbortSignal.timeout(4_000) })) events.push(event);
	return events;
}

function streamFailure(error: unknown): boolean {
	assert(error instanceof ProviderFailure);
	assert.equal(error.code, "response_stream_error");
	assert.equal(error.retryable, true);
	assert.equal(error.diagnostics.error_source, "response_stream");
	return true;
}

function response(body: string): Response {
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function chat(delta: unknown, finishReason: string | null = null): string {
	return sse({ choices: [{ index: 0, delta, finish_reason: finishReason }] });
}

function sse(value: unknown): string {
	return `data: ${JSON.stringify(value)}\n\n`;
}
