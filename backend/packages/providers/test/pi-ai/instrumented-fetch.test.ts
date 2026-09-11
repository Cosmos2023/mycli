import assert from "node:assert/strict";
import test from "node:test";
import type { ProtocolId } from "@mycli/core";
import { instrumentedFetch, type ProviderAttemptEvidence } from "../../src/pi-ai/instrumented-fetch.ts";

test("fetch instrumentation preserves bytes, backpressure, response metadata, and cancellation", async () => {
	const evidence: ProviderAttemptEvidence = {};
	let reads = 0;
	let cancelled: unknown;
	const bytes = new Uint8Array([0, 255, 128, 10]);
	const response = new Response(new ReadableStream<Uint8Array>({
		pull(controller): void { reads += 1; controller.enqueue(bytes); },
		cancel(reason: unknown): void { cancelled = reason; },
	}, { highWaterMark: 0 }), {
		status: 201, statusText: "Created", headers: { "content-type": "application/octet-stream", "x-request-id": "req-body" },
	});
	Object.defineProperties(response, { url: { value: "https://offline.invalid/final" }, redirected: { value: true } });
	const observed = await instrumentedFetch(evidence, async () => response)("https://offline.invalid");
	assert.equal(reads, 0);
	assert.equal(observed.status, 201);
	assert.equal(observed.statusText, "Created");
	assert.equal(observed.url, response.url);
	assert.equal(observed.redirected, true);
	assert.equal(observed.type, response.type);
	assert.equal(observed.headers.get("content-type"), "application/octet-stream");
	const reader = observed.body!.getReader();
	assert.deepEqual((await reader.read()).value, bytes);
	assert.equal(reads, 1);
	await reader.cancel("consumer stopped");
	reader.releaseLock();
	assert.equal(cancelled, "consumer stopped");
	assert.equal(response.body!.locked, false);
	assert.equal(evidence.transportError, undefined);
});

test("fetch instrumentation retains read causes for body helpers and releases locks", async () => {
	const evidence: ProviderAttemptEvidence = {};
	const error = new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } });
	const response = new Response(new ReadableStream<Uint8Array>({
		pull(controller): void { controller.error(error); },
	}, { highWaterMark: 0 }));
	const observed = await instrumentedFetch(evidence, async () => response)("https://offline.invalid");
	await assert.rejects(observed.text(), (actual: unknown) => actual === error);
	assert.equal(evidence.transportError, error);
	assert.equal(response.body!.locked, false);
});

test("fetch instrumentation leaves bodyless responses and successful JSON reads intact", async () => {
	const response = new Response(null, { status: 204 });
	assert.equal(await instrumentedFetch({}, async () => response)("https://offline.invalid"), response);
	const json = await instrumentedFetch({}, async () => Response.json({ ok: true }))("https://offline.invalid");
	const cloned = json.clone();
	assert.deepEqual(await cloned.json(), { ok: true });
	assert.deepEqual(await json.json(), { ok: true });
});

test("SSE framing is limited to successful bodies with a known protocol", async (context) => {
	const bytes = 'data: {"type":"response.completed","response":{"id":"resp-test"}}\n\n: trailing comment\n\n';
	const cases: readonly [ProtocolId | undefined, number, string, boolean][] = [
		["responses", 200, "text/event-stream; charset=utf-8", true],
		["responses", 400, "text/event-stream", false],
		["responses", 200, "application/json", false],
		[undefined, 200, "text/event-stream", false],
	];
	for (const [protocol, status, contentType, framed] of cases) {
		await context.test(`${protocol} ${status} ${contentType}`, async () => {
			const response = new Response(bytes, { status, headers: {
				"content-type": contentType, "content-length": String(Buffer.byteLength(bytes)),
			} });
			const observed = await instrumentedFetch({}, async () => response, protocol)("https://offline.invalid");
			assert.equal(await observed.text(), framed ? bytes.slice(0, bytes.indexOf(": trailing")) : bytes);
			assert.equal(observed.headers.get("content-length"), framed ? null : String(Buffer.byteLength(bytes)));
		});
	}
});

test("Chat and Anthropic framing retain first structured errors and close without remote EOF", async (context) => {
	for (const protocol of ["chat_completions", "anthropic_messages"] as const) {
		await context.test(protocol, async () => {
			const first = 'event: error\ndata: {"type":"error","error":{"type":"authentication_error","message":"invalid credential token=private-key"}}\n\n';
			const trailing = 'event: error\ndata: {"error":{"code":"server_error"}}\n\n';
			const evidence: ProviderAttemptEvidence = {};
			let cancelled = false;
			const response = new Response(new ReadableStream<Uint8Array>({
				start(controller): void { controller.enqueue(new TextEncoder().encode(first + trailing)); },
				cancel(): Promise<void> { cancelled = true; return new Promise(() => {}); },
			}), { headers: { "content-type": "text/event-stream", "x-request-id": "req-first" } });
			const observed = await instrumentedFetch(evidence, async () => response, protocol)("https://offline.invalid");
			assert.equal(await observed.text(), first);
			assert.equal(cancelled, true);
			assert.equal(evidence.responseStreamFailure?.code, "auth_error");
			assert.equal(evidence.responseStreamFailure?.retryable, false);
			assert.equal(evidence.responseStreamFailure?.diagnostics.request_id, "req-first");
			assert.doesNotMatch(JSON.stringify(evidence), /private-key|server_error/u);
		});
	}
});

test("Responses framing propagates cancellation during a pending read and releases its source", async () => {
	const reachedRead = Promise.withResolvers<void>();
	let cancelled: unknown;
	const response = new Response(new ReadableStream<Uint8Array>({
		pull(): void { reachedRead.resolve(); },
		cancel(reason: unknown): void { cancelled = reason; },
	}, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
	const evidence: ProviderAttemptEvidence = {};
	const observed = await instrumentedFetch(evidence, async () => response, "responses")("https://offline.invalid");
	const reader = observed.body!.getReader();
	const pending = reader.read();
	await reachedRead.promise;
	await reader.cancel("user stopped");
	assert.equal((await pending).done, true);
	reader.releaseLock();
	assert.equal(cancelled, "user stopped");
	assert.equal(response.body?.locked, false);
	assert.equal(evidence.transportError, undefined);
});

test("Responses records only the first terminal failure as bounded, redacted evidence", async () => {
	const first = `data: ${JSON.stringify({
		type: "error", sequence_number: 0,
		error: { code: "stream_read_error", type: "upstream_error",
			message: `stream_read_error token=private-key\n    at fn (/private/source.ts:1:2)\n${"x".repeat(2_000)}`,
			private_payload: "must-not-retain" },
	})}\n\n`;
	const trailing = `event: response.failed\ndata: ${JSON.stringify({
		type: "response.failed", response: { error: { code: "invalid_api_key", message: "late failure" } },
	})}\n\n`;
	const evidence: ProviderAttemptEvidence = {};
	let cancelled = false;
	const response = new Response(new ReadableStream<Uint8Array>({
		start(controller): void { controller.enqueue(new TextEncoder().encode(first + trailing)); },
		cancel(): Promise<void> { cancelled = true; return new Promise(() => {}); },
	}), { headers: { "content-type": "text/event-stream", "x-request-id": "req-first" } });
	const observed = await instrumentedFetch(evidence, async () => response, "responses")("https://offline.invalid");
	assert.equal(await observed.text(), first);
	assert.equal(cancelled, true, "remote cleanup must not delay the terminal outcome");
	const failure = evidence.responseStreamFailure;
	assert.equal(failure?.retryable, true);
	assert.equal(failure?.diagnostics.provider_error_code, "stream_read_error");
	assert.equal(failure?.diagnostics.provider_error_type, "upstream_error");
	assert.equal(failure?.diagnostics.request_id, "req-first");
	assert.ok((failure?.publicDetail?.length ?? Infinity) <= 1_000);
	assert.match(failure?.publicDetail ?? "", /stream_read_error token=\[REDACTED\]/u);
	assert.doesNotMatch(JSON.stringify(evidence), /private-key|source\.ts|private_payload|must-not-retain|late failure/u);
});

test("Responses ignores trailing failure evidence after successful completion", async () => {
	const evidence: ProviderAttemptEvidence = {};
	const first = 'data: {"type":"response.completed","response":{"id":"resp-test"}}\n\n';
	const response = new Response(`${first}data: {"type":"error","error":{"code":"server_error"}}\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
	const observed = await instrumentedFetch(evidence, async () => response, "responses")("https://offline.invalid");
	assert.equal(await observed.text(), first);
	assert.equal(evidence.responseStreamFailure, undefined);
});

test("HTTP errors preserve structured fatal evidence before SDK formatting and redact secrets", async () => {
	const evidence: ProviderAttemptEvidence = {};
	const payload = { error: { code: "insufficient_quota", type: "quota_exceeded", message: "token=private-quota" } };
	const observed = await instrumentedFetch(evidence, async () => Response.json(payload, {
		status: 429, headers: { "retry-after": "1", "x-request-id": "req-http-error" },
	}))("https://offline.invalid");
	assert.equal(Object.hasOwn(evidence, "httpResponseFailure"), false);
	assert.deepEqual(await observed.json(), payload);
	assert.equal(evidence.httpResponseFailure?.code, "quota_exceeded");
	assert.equal(evidence.httpResponseFailure?.retryable, false);
	assert.equal(evidence.httpResponseFailure?.diagnostics.request_id, "req-http-error");
	assert.doesNotMatch(JSON.stringify(evidence), /private-quota/u);
});

test("HTTP evidence ignores incomplete and oversized JSON without changing body bytes", async () => {
	for (const body of ['{"error":', JSON.stringify({ error: { message: "x".repeat(65_536) } })]) {
		const evidence: ProviderAttemptEvidence = {};
		const observed = await instrumentedFetch(evidence, async () => new Response(body, { status: 500 }))("https://offline.invalid");
		assert.equal(await observed.text(), body);
		assert.equal(evidence.httpResponseFailure, undefined);
	}
});
