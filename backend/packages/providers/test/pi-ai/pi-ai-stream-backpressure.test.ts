import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { ProviderFailure } from "../../src/errors.ts";
import { PiAiWebSearchStream } from "../../src/pi-ai/pi-ai-web-search.ts";
import { PiAiStreamQueue, PI_AI_STREAM_MAX_BYTES, PI_AI_STREAM_MAX_EVENTS } from "../../src/pi-ai/pi-ai-stream-queue.ts";

const message: AssistantMessage = {
	role: "assistant", content: [], api: "openai-responses", provider: "openai", model: "fixture", timestamp: 0,
	stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};

function delta(text: string): AssistantMessageEvent {
	return { type: "text_delta", contentIndex: 0, delta: text, partial: message };
}

function overflow(error: unknown): boolean {
	return error instanceof ProviderFailure && error.code === "response_stream_error"
		&& error.publicDetail === "Response stream exceeded its buffering limit.";
}

test("a slow bridge consumer does not drain the SDK and receives every delta in order", async () => {
	let produced = 0;
	let closed = false;
	const source = (async function* (): AsyncGenerator<AssistantMessageEvent> {
		try { for (let i = 0; i < 1_000; i += 1) { produced += 1; yield delta(String(i)); } }
		finally { closed = true; }
	})();
	const stream = new PiAiWebSearchStream().merge(source, new AbortController().signal);
	assert.deepEqual((await stream.next()).value, { type: "text_delta", delta: "0" });
	await tick();
	assert(produced <= 2, `read ${produced} SDK events after consuming one`);
	let received = 1;
	for await (const event of stream) {
		assert.deepEqual(event, { type: "text_delta", delta: String(received++) });
		if (received % 100 === 0) await tick();
	}
	assert.equal(received, 1_000);
	assert.equal(closed, true);
});

test("the bridge rejects an oversized UTF-8 delta and releases its SDK iterator", async () => {
	let closed = false;
	const source = (async function* (): AsyncGenerator<AssistantMessageEvent> {
		try { yield delta("界".repeat(Math.ceil(PI_AI_STREAM_MAX_BYTES / 3))); }
		finally { closed = true; }
	})();
	const stream = new PiAiWebSearchStream().merge(source, new AbortController().signal);
	await assert.rejects(stream.next(), overflow);
	await tick();
	assert.equal(closed, true);
});

test("native search bursts fail explicitly on the event count limit", async () => {
	const bridge = new PiAiWebSearchStream();
	const source: AsyncIterable<AssistantMessageEvent> = {
		[Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: async () => ({ done: true, value: undefined }) }),
	};
	const stream = bridge.merge(source, new AbortController().signal);
	const read = assert.rejects(stream.next(), overflow);
	const output = Array.from({ length: PI_AI_STREAM_MAX_EVENTS / 2 + 1 }, (_, index) => ({
		type: "web_search_call", id: `search-${index}`, status: "completed", action: { type: "search", query: "docs" },
	}));
	await assert.rejects(bridge.observe({ type: "response.completed", response: { output } }), overflow);
	await read;
});

test("queued UTF-8 payloads share the byte budget and consuming them releases capacity", async () => {
	const queue = new PiAiStreamQueue<{ readonly delta: string }>();
	const event = { delta: "界".repeat(Math.floor(PI_AI_STREAM_MAX_BYTES / 9)) };
	queue.push(event);
	queue.push(event);
	await queue.take();
	queue.push(event);
	assert.throws(() => queue.push(event), overflow);
	await assert.rejects(queue.take(), overflow);
});

test("cancellation and early return release pending reads even if the SDK ignores cancellation", { timeout: 2_000 }, async (t) => {
	for (const pending of [false, true]) {
		await t.test(pending ? "pending read" : "consumer return", async () => {
			let returned = false;
			let reads = 0;
			const source: AsyncIterable<AssistantMessageEvent> = { [Symbol.asyncIterator]: () => ({
				next: async () => {
					if (reads++ === 0) return { done: false as const, value: delta("first") };
					return new Promise<IteratorResult<AssistantMessageEvent>>(() => {});
				},
				return: async () => {
					returned = true;
					if (!pending) return new Promise<IteratorResult<AssistantMessageEvent>>(() => {});
					return { done: true, value: undefined };
				},
			}) };
			const controller = new AbortController();
			const stream = new PiAiWebSearchStream().merge(source, controller.signal);
			await stream.next();
			await tick();
			if (pending) {
				const read = stream.next();
				controller.abort();
				assert.equal((await read).done, true);
			} else await stream.return(undefined);
			assert.equal(returned, true);
		});
	}
});
