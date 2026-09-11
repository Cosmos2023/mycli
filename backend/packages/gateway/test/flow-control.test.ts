import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
	GatewayFrameDecoder, GatewayFrameReader, GatewayFlowControlError,
	GatewayRequestBudget, GatewayWriteQueue, gatewayLimits,
} from "../src/flow-control/index.ts";

test("framing preserves split UTF-8, CRLF, and a final unterminated frame", () => {
	const lines: string[] = [];
	const decoder = new GatewayFrameDecoder(32, (line) => lines.push(line));
	const wire = Buffer.from('"\u4e2d\u6587"\r\nlast');
	for (const byte of wire) decoder.push(Buffer.from([byte]));
	decoder.end();
	assert.deepEqual(lines, ['"\u4e2d\u6587"', "last"]);
});

test("framing rejects an oversized fragment before a newline and stops parsing the chunk on close", () => {
	const lines: string[] = [];
	const decoder = new GatewayFrameDecoder(4, (line) => lines.push(line));
	decoder.push("1234");
	assert.throws(() => decoder.push("5"), { code: "gateway_message_too_large" });
	decoder.push("\nnext\n");
	assert.equal(lines.length, 0);
	const stopped = new GatewayFrameDecoder(4, (line) => { lines.push(line); stopped.close(); });
	stopped.push("one\ntwo\n");
	assert.deepEqual(lines, ["one"]);
});

test("framing bounds each frame independently in a large chunk and detaches all owned listeners", async () => {
	const input = new PassThrough();
	const lines: string[] = [];
	const reader = new GatewayFrameReader({
		input, maxFrameBytes: 3, onLine: (line) => lines.push(line), onError: assert.fail,
	});
	input.end("abc\ndef\nghi\n");
	await delay(0);
	assert.deepEqual(lines, ["abc", "def", "ghi"]);
	reader.stop();
	for (const event of ["data", "end", "close", "error"]) assert.equal(input.listenerCount(event), 0);
});

test("request admission bounds bytes and counts while reserving lifecycle capacity", () => {
	const budget = new GatewayRequestBudget(gatewayLimits({
		maxPendingRequests: 2, maxPendingRequestBytes: 10, controlReserveRequests: 1, controlReserveBytes: 5,
	}));
	const first = budget.acquire("turn.submit", 10)!;
	assert.equal(budget.acquire("turn.submit", 1), undefined);
	const control = budget.acquire("turn.interrupt", 5)!;
	assert.equal(typeof control, "function");
	assert.equal(budget.acquire("shutdown", 1), undefined);
	first(); first(); control();
	const second = budget.acquire("hold", 1)!;
	const third = budget.acquire("hold", 1)!;
	assert.equal(budget.acquire("hold", 1), undefined);
	assert.equal(typeof budget.acquire("approval.respond", 1), "function");
	second(); third();
});

test("writer waits for drain, counts in-flight bytes, and flushes ordered frames before end", async () => {
	const written: string[] = [];
	const callbacks: (() => void)[] = [];
	const output = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, callback): void {
		written.push(chunk.toString()); callbacks.push(callback);
	} });
	const writer = new GatewayWriteQueue(output, gatewayLimits({ maxQueuedBytes: 4, maxQueuedMessages: 2 }), assert.fail);
	writer.enqueue("a\n");
	writer.enqueue("b\n");
	assert.throws(() => writer.enqueue("c\n"), { code: "gateway_overloaded" });
	assert.deepEqual(written, ["a\n"]);
	let ended = false;
	const drained = writer.end().then((result) => { ended = true; return result; });
	await delay(0);
	assert.equal(ended, false);
	callbacks.shift()!();
	assert.deepEqual(written, ["a\n", "b\n"]);
	callbacks.shift()!();
	assert.equal(await drained, true);
	assert.equal(output.writableEnded, true);
	for (const event of ["drain", "error", "close"]) assert.equal(output.listenerCount(event), 0);
});

test("writer has bounded shutdown even when a consumer or finalizer never completes", async () => {
	for (const finalizing of [false, true]) {
		const failures: Error[] = [];
		const output = new Writable({
			write(_chunk, _encoding, callback): void { if (finalizing) callback(); },
			final(): void {},
		});
		const writer = new GatewayWriteQueue(output, gatewayLimits({ writeStallTimeoutMs: 10 }), (error) => failures.push(error));
		writer.enqueue("a\n");
		const drained = writer.end();
		await delay(30);
		assert.equal(await drained, false);
		assert.equal(failures.length, 1);
		assert.ok(failures[0] instanceof GatewayFlowControlError);
		assert.equal(failures[0].code, "gateway_output_stalled");
		output.destroy();
	}
});

test("writer coalesces only unsent frames, preserves ordering, and accounts for replacement bytes", async () => {
	const written: string[] = [];
	const callbacks: (() => void)[] = [];
	let acknowledged = 0;
	const output = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, callback): void {
		written.push(chunk.toString()); callbacks.push(callback);
	} });
	const writer = new GatewayWriteQueue(output, gatewayLimits({ maxQueuedMessages: 3, maxQueuedBytes: 8 }), assert.fail);
	const coalesce = { key: "output", merge: (previous: string, next: string): string => previous + next };
	writer.enqueue("a", { coalesce });
	writer.enqueue("b", { coalesce });
	writer.enqueue("!", { onWritten: () => { acknowledged++; } });
	writer.enqueue("c", { coalesce });
	assert.throws(() => writer.enqueue("x".repeat(8), { coalesce }), { code: "gateway_overloaded" });
	writer.enqueue("d", { coalesce });
	assert.deepEqual(written, ["a"]);
	const drained = writer.end();
	callbacks.shift()!();
	assert.deepEqual(written, ["a", "!"]);
	callbacks.shift()!();
	assert.deepEqual(written, ["a", "!", "bcd"]);
	assert.equal(acknowledged, 1);
	callbacks.shift()!();
	assert.equal(await drained, true);
});

test("coalescing respects frame limits and cannot reset a stalled writer's deadline", async () => {
	const failures: Error[] = [];
	const output = new Writable({ highWaterMark: 1, write(): void {} });
	const writer = new GatewayWriteQueue(output,
		gatewayLimits({ maxFrameBytes: 4, maxQueuedMessages: 2, writeStallTimeoutMs: 10 }),
		(error) => failures.push(error));
	const coalesce = { key: "output", merge: (previous: string, next: string): string => previous + next };
	writer.enqueue("a");
	writer.enqueue("b", { coalesce });
	assert.throws(() => writer.enqueue("12345", { coalesce }), { code: "gateway_message_too_large" });
	writer.enqueue("c", { coalesce });
	await delay(30);
	assert.equal(await writer.end(), false);
	assert.deepEqual(failures.map((error) => (error as GatewayFlowControlError).code), ["gateway_output_stalled"]);
	output.destroy();
});

test("writer contains asynchronous write errors and never writes queued frames afterward", async () => {
	let count = 0;
	let failWrite!: (error: Error) => void;
	const failure = new Error("write failed");
	const failures: Error[] = [];
	const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback): void {
		count++; failWrite = callback;
	} });
	const writer = new GatewayWriteQueue(output, gatewayLimits(), (error) => failures.push(error));
	writer.enqueue("a\n"); writer.enqueue("b\n");
	const drained = writer.end();
	failWrite(failure);
	await delay(0);
	assert.equal(await drained, false);
	assert.deepEqual(failures, [failure]);
	assert.equal(count, 1);
});

test("writer batches a burst losslessly into bounded writes for a slow consumer", async () => {
	const frames = Array.from({ length: 4_740 }, (_, index) => `${JSON.stringify({ index, text: "\u4e2d\u6587\uD83D\uDE00" })}\n`);
	const chunks: Buffer[] = [];
	const output = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, callback): void {
		chunks.push(chunk); setImmediate(callback);
	} });
	const writer = new GatewayWriteQueue(output, gatewayLimits({ maxQueuedMessages: 4 }), assert.fail);
	for (const frame of frames) writer.enqueue(frame, { batch: true });
	assert.equal(await writer.end(), true);
	await finished(output);
	assert.equal(Buffer.concat(chunks).toString(), frames.join(""));
	assert.ok(chunks.length <= 4);
	assert.ok(chunks.every((chunk) => chunk.byteLength <= 64 * 1024));
});

test("batches preserve barriers and never absorb an in-flight write or its acknowledgement", async () => {
	const written: string[] = [];
	const callbacks: (() => void)[] = [];
	let acknowledged = 0;
	const output = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, callback): void {
		written.push(chunk.toString()); callbacks.push(callback);
	} });
	const writer = new GatewayWriteQueue(output, gatewayLimits({ maxQueuedMessages: 3 }), assert.fail);
	writer.enqueue("a\n", { batch: true });
	writer.enqueue("b\n", { batch: true });
	writer.enqueue("reply\n", { onWritten: () => { acknowledged++; } });
	writer.enqueue("c\n", { batch: true });
	writer.enqueue("d\n", { batch: true });
	assert.deepEqual(written, ["a\nb\n"]);
	const drained = writer.end();
	callbacks.shift()!();
	assert.deepEqual(written, ["a\nb\n", "reply\n"]);
	assert.equal(acknowledged, 0);
	callbacks.shift()!();
	assert.equal(acknowledged, 1);
	assert.deepEqual(written, ["a\nb\n", "reply\n", "c\nd\n"]);
	callbacks.shift()!();
	assert.equal(await drained, true);
});

test("batching retains frame, byte, and pending-write limits without changing the accepted prefix", async () => {
	const chunks: string[] = [];
	const output = new Writable({ write(chunk: Buffer, _encoding, callback): void {
		chunks.push(chunk.toString()); callback();
	} });
	const writer = new GatewayWriteQueue(output, gatewayLimits({ maxFrameBytes: 4, maxQueuedBytes: 8, maxQueuedMessages: 2 }), assert.fail);
	writer.enqueue("a\n", { batch: true });
	writer.enqueue("b\n", { batch: true });
	writer.enqueue("c\n", { batch: true });
	writer.enqueue("d\n", { batch: true });
	assert.throws(() => writer.enqueue("e\n", { batch: true }), { code: "gateway_overloaded" });
	assert.throws(() => writer.enqueue("12345\n", { batch: true }), { code: "gateway_message_too_large" });
	assert.equal(await writer.end(), true);
	assert.deepEqual(chunks, ["a\nb\n", "c\nd\n"]);
});

test("batch replacement cannot extend the write-stall deadline and disposal cancels pending flushes", async () => {
	const failures: Error[] = [];
	let written = 0;
	const output = new Writable({ highWaterMark: 1, write(): void { written++; } });
	const writer = new GatewayWriteQueue(output, gatewayLimits({ writeStallTimeoutMs: 10 }), (error) => failures.push(error));
	writer.enqueue("a\n", { batch: true });
	await new Promise<void>((resolve) => setImmediate(resolve));
	writer.enqueue("b\n", { batch: true });
	writer.enqueue("c\n", { batch: true });
	await delay(30);
	assert.equal(await writer.end(), false);
	assert.equal(written, 1);
	assert.deepEqual(failures.map((error) => (error as GatewayFlowControlError).code), ["gateway_output_stalled"]);
	output.destroy();
	const disposedOutput = new Writable({ write(): void { assert.fail("disposed batch was written"); } });
	const disposedWriter = new GatewayWriteQueue(disposedOutput, gatewayLimits(), assert.fail);
	disposedWriter.enqueue("pending\n", { batch: true });
	disposedWriter.dispose();
	await new Promise<void>((resolve) => setImmediate(resolve));
	disposedOutput.destroy();
});
