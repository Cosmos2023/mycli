import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ProviderEvent, ProviderRequest, WebSearchAction } from "@mycli/core";
import { ProviderFailure } from "../../src/errors.ts";
import { PiAiProvider } from "../../src/pi-ai/pi-ai-provider.ts";

const request: ProviderRequest = {
	provider: "compatible", protocol: "responses", model: "fixture-model",
	instructions: "fixture", messages: [{ role: "user", content: "search" }],
	tools: [], webSearchMode: "live",
};

test("hosted search starts before the provider sends any assistant text", { timeout: 3_000 }, async (t) => {
	const abort = new AbortController();
	t.after(() => abort.abort());
	let body!: ReadableStreamDefaultController<Uint8Array>;
	const provider = providerWithFetch(async (_input, init) => {
		init?.signal?.addEventListener("abort", () => body.error(init.signal?.reason), { once: true });
		return new Response(new ReadableStream<Uint8Array>({ start(controller): void {
			body = controller;
			controller.enqueue(bytes(created() + searchAdded("ws-live")));
		} }), { headers: { "content-type": "text/event-stream" } });
	});
	const stream = provider.stream(request, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1_500)]) });
	const iterator = stream[Symbol.asyncIterator]();
	t.after(() => iterator.return?.(undefined));
	assert.deepEqual(await iterator.next(), { done: false, value: { type: "web_search_started", callId: "ws-live" } });
	body.enqueue(bytes(searchDone("ws-live", { type: "search", query: "latest release" })
		+ text("msg-final", "Found it.", 1) + completed()));
	body.close();
	const events = await collect(stream);
	assert.deepEqual(events[0], {
		type: "web_search_completed", call: { callId: "ws-live", action: { type: "search", query: "latest release" } },
	});
	assert.equal(events.at(-1)?.type, "completed");
});

test("hosted search preserves text order, deduplicates wire notifications, and handles split UTF-8", async (t) => {
	for (const chunkSize of [1, Infinity]) {
		await t.test(`chunk size ${chunkSize}`, async () => {
			const action = { type: "search" as const, queries: ["mycli", "\u4e2d\u6587\u641c\u7d22"] };
			const item = { type: "web_search_call", id: "ws-order", status: "completed", action };
			const frames = created() + text("msg-before", "Before", 0)
				+ searchAdded(item.id, 1)
				+ sse({ type: "response.web_search_call.in_progress", item_id: item.id, output_index: 1 })
				+ sse({ type: "response.web_search_call.searching", item_id: item.id, output_index: 1 })
				+ sse({ type: "response.web_search_call.completed", item_id: item.id, output_index: 1 })
				+ searchDone(item.id, action, 1) + searchDone(item.id, action, 1)
				+ text("msg-after", "After", 2) + completed([item]);
			const events = await collect(providerWithFetch(async () => response(frames, chunkSize))
				.stream(request, { signal: AbortSignal.timeout(3_000) }), true);
			assert.deepEqual(visibleEvents(events), [
				{ type: "text_delta", text: "Before" },
				{ type: "web_search_started", callId: item.id },
				{ type: "web_search_completed", call: { callId: item.id, action } },
				{ type: "text_delta", text: "After" },
			]);
		});
	}
});

test("hosted search cannot overtake adjacent deltas in an unfinished assistant message", async () => {
	const native = { type: "web_search_call", id: "ws-adjacent", status: "completed", action: { type: "search", query: "docs" } };
	const message = { type: "message", id: "msg-adjacent", role: "assistant", status: "in_progress", content: [] };
	const frames = created() + [
		{ type: "response.output_item.added", output_index: 0, item: message },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Before" },
		{ type: "response.output_item.added", output_index: 1, item: { ...native, status: "in_progress" } },
		{ type: "response.output_item.done", output_index: 1, item: native },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "After" },
		{ type: "response.output_item.done", output_index: 0,
			item: { ...message, status: "completed", content: [{ type: "output_text", text: "BeforeAfter", annotations: [] }] } },
	].map(sse).join("") + completed();
	const events = await collect(providerWithFetch(async () => response(frames))
		.stream(request, { signal: AbortSignal.timeout(3_000) }), true);
	assert.deepEqual(visibleEvents(events), [
		{ type: "text_delta", text: "Before" },
		{ type: "web_search_started", callId: native.id },
		{ type: "web_search_completed", call: { callId: native.id, action: native.action } },
		{ type: "text_delta", text: "After" },
	]);
});

test("hosted search recovers completed output items and terminal-only activities", async (t) => {
	for (const action of [
		{ type: "search", query: "mycli" },
		{ type: "open_page", url: "https://example.com/docs" },
		{ type: "find_in_page", url: "https://example.com/docs", pattern: "install" },
		{ type: "other" },
	] satisfies WebSearchAction[]) {
		for (const terminalOnly of [false, true]) {
			await t.test(`${action.type}, terminal-only=${terminalOnly}`, async () => {
				const item = { type: "web_search_call", id: "ws-result", status: "completed", action };
				const frames = created() + text("msg-final", "Found it.", 1)
					+ (terminalOnly ? "" : searchDone(item.id, action)) + completed([item]);
				const events = await collect(providerWithFetch(async () => response(frames))
					.stream(request, { signal: AbortSignal.timeout(3_000) }));
				assert.deepEqual(events.filter((event) => event.type.startsWith("web_search")), [
					{ type: "web_search_started", callId: item.id },
					{ type: "web_search_completed", call: { callId: item.id, action } },
				]);
			});
		}
	}
});

test("hosted search does not fabricate calls or mark unfinished searches complete", async (t) => {
	for (const started of [false, true]) {
		await t.test(`started=${started}`, async () => {
			const frames = created() + (started ? searchAdded("ws-unfinished") : "")
				+ text("msg-final", "Done.", 1) + completed();
			const events = await collect(providerWithFetch(async () => response(frames))
				.stream(request, { signal: AbortSignal.timeout(3_000) }));
			assert.deepEqual(events.filter((event) => event.type.startsWith("web_search")),
				started ? [{ type: "web_search_started", callId: "ws-unfinished" }] : []);
		});
	}
});

test("cancelling a live hosted search stops the source without completing it", { timeout: 3_000 }, async (t) => {
	const abort = new AbortController();
	t.after(() => abort.abort());
	let cancelled = false;
	const provider = providerWithFetch(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
		start(controller): void {
			controller.enqueue(bytes(created() + searchAdded("ws-cancel")));
			init?.signal?.addEventListener("abort", () => {
				cancelled = true;
				controller.error(init.signal?.reason);
			}, { once: true });
		},
		cancel(): void { cancelled = true; },
	}), { headers: { "content-type": "text/event-stream" } }));
	const stream = provider.stream(request, {
		signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1_500)]),
	})[Symbol.asyncIterator]();
	assert.equal((await stream.next()).value?.type, "web_search_started");
	abort.abort();
	await assert.rejects(stream.next(), (error: unknown) => error instanceof ProviderFailure && error.code === "interrupted");
	assert.equal(cancelled, true);
});

test("stopping a hosted-search consumer aborts its pending SDK read", { timeout: 3_000 }, async () => {
	let aborted = false;
	const provider = providerWithFetch(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
		start(controller): void {
			controller.enqueue(bytes(created() + searchAdded("ws-stop")));
			init?.signal?.addEventListener("abort", () => {
				aborted = true;
				controller.error(init.signal?.reason);
			}, { once: true });
		},
	}), { headers: { "content-type": "text/event-stream" } }));
	for await (const event of provider.stream(request, { signal: AbortSignal.timeout(2_000) })) {
		assert.equal(event.type, "web_search_started");
		break;
	}
	assert.equal(aborted, true);
});

test("hosted search completes without remote EOF and ignores trailing activities", { timeout: 3_000 }, async () => {
	let cancelled = false;
	const action: WebSearchAction = { type: "search", query: "mycli" };
	const frames = created() + searchAdded("ws-terminal") + searchDone("ws-terminal", action)
		+ text("msg-final", "Done.", 1) + completed() + searchAdded("ws-after-terminal");
	const provider = providerWithFetch(async () => new Response(new ReadableStream<Uint8Array>({
		start(controller): void { controller.enqueue(bytes(frames)); },
		cancel(): Promise<void> { cancelled = true; return new Promise(() => {}); },
	}), { headers: { "content-type": "text/event-stream" } }));
	const events = await collect(provider.stream(request, { signal: AbortSignal.timeout(2_000) }));
	assert.equal(cancelled, true);
	assert.equal(events.at(-1)?.type, "completed");
	assert.deepEqual(events.filter((event) => event.type.startsWith("web_search")), [
		{ type: "web_search_started", callId: "ws-terminal" },
		{ type: "web_search_completed", call: { callId: "ws-terminal", action } },
	]);
});

test("metadata-free search completion waits for successful response completion", async (t) => {
	for (const success of [false, true]) {
		await t.test(`success=${success}`, async () => {
			const frames = created() + sse({ type: "response.web_search_call.completed", item_id: "ws-heartbeat", output_index: 0 })
				+ text("msg-final", "Done.", 1) + (success ? completed() : sse({ type: "error", code: "stream_read_error" }));
			const events: ProviderEvent[] = [];
			const consume = async (): Promise<void> => {
				for await (const event of providerWithFetch(async () => response(frames))
					.stream(request, { signal: AbortSignal.timeout(2_000) })) events.push(event);
			};
			if (success) await consume();
			else await assert.rejects(consume(), (error: unknown) => error instanceof ProviderFailure && error.code === "provider_error" && error.retryable);
			assert.deepEqual(events.filter((event) => event.type.startsWith("web_search")), [
				{ type: "web_search_started", callId: "ws-heartbeat" },
				...(success ? [{ type: "web_search_completed", call: { callId: "ws-heartbeat", action: { type: "other" } } }] : []),
			]);
			assert.equal(events.some((event) => event.type === "completed"), success);
		});
	}
});

function providerWithFetch(fetch: typeof globalThis.fetch): PiAiProvider {
	return new PiAiProvider({ fetch, config: {
		provider: request.provider, protocol: request.protocol, model: request.model,
		apiBaseUrl: "https://offline.invalid/v1", apiKey: "offline-key",
		supportsImages: false, routeSource: "pi_ai_declared",
	} });
}

async function collect(stream: AsyncIterable<ProviderEvent>, slow = false): Promise<ProviderEvent[]> {
	const events: ProviderEvent[] = [];
	for await (const event of stream) {
		events.push(event);
		if (slow) await delay(2);
	}
	return events;
}

function visibleEvents(events: readonly ProviderEvent[]): ProviderEvent[] {
	return events.filter((event) => event.type === "text_delta" || event.type.startsWith("web_search"));
}

function response(frames: string, chunkSize = Infinity): Response {
	const encoded = bytes(frames);
	let offset = 0;
	return new Response(new ReadableStream<Uint8Array>({ pull(controller): void {
		if (offset >= encoded.length) { controller.close(); return; }
		const end = Math.min(encoded.length, offset + chunkSize);
		controller.enqueue(encoded.slice(offset, end));
		offset = end;
	} }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
}

function bytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
function sse(value: unknown): string { return `data: ${JSON.stringify(value)}\n\n`; }
function created(): string { return sse({ type: "response.created", response: { id: "resp-search", status: "in_progress" } }); }
function completed(output: readonly unknown[] = []): string {
	return sse({ type: "response.completed", response: { id: "resp-search", status: "completed", output } });
}
function searchAdded(id: string, outputIndex = 0): string {
	return sse({ type: "response.output_item.added", output_index: outputIndex,
		item: { type: "web_search_call", id, status: "in_progress" } });
}
function searchDone(id: string, action: WebSearchAction, outputIndex = 0): string {
	return sse({ type: "response.output_item.done", output_index: outputIndex,
		item: { type: "web_search_call", id, status: "completed", action } });
}
function text(id: string, value: string, outputIndex: number): string {
	const item = { type: "message", id, role: "assistant", status: "completed",
		content: [{ type: "output_text", text: value, annotations: [] }] };
	return sse({ type: "response.output_item.added", output_index: outputIndex,
		item: { ...item, status: "in_progress", content: [] } })
		+ sse({ type: "response.output_text.delta", output_index: outputIndex, content_index: 0, delta: value })
		+ sse({ type: "response.output_item.done", output_index: outputIndex, item });
}
