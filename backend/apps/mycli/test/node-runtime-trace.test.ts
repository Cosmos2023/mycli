import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { removeFixtureDirectoryAfterTests } from "../../../packages/storage/test/fixtures/directory-cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createErrorContext } from "@mycli/contracts";
import { openRuntimeSessionStore } from "@mycli/storage";
import {
	appendNodeTrace,
	runtimeDiagnosticTraceEvent,
	nodeTraceRows,
} from "../src/node-runtime/node-runtime-trace.ts";

test("provider trace records per-request token usage and drops unsafe numbers", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "mycli-usage-trace-"));
	removeFixtureDirectoryAfterTests(t, home);
	const store = openRuntimeSessionStore({ dbPath: join(home, "sessions.db") });
	t.after(() => store.close());
	appendNodeTrace(home, "usage-session", runtimeDiagnosticTraceEvent({
		kind: "model_stream_diagnostics", turnId: "turn-1", provider: "deepseek", protocol: "chat_completions",
		model: "deepseek-chat", attempt: 1, elapsedMs: 120, textDeltaIntervalCount: 0,
		providerEventCount: 3, reasoningEventCount: 0, textEventCount: 1, providerStateEventCount: 0,
		toolCallEventCount: 0, usageEventCount: 1, completedEventCount: 1, reasoningBytes: 0,
		textBytes: 5, success: true,
		usage: {
			input_tokens: 1_200, cached_tokens: 1_100, output_tokens: 40, total_tokens: 1_240,
			// Unsafe or unknown values are dropped by the usage projection.
			cache_write_tokens: -5, prompt_tokens_details: 3,
		},
	}));
	const rows = nodeTraceRows(store, home, "usage-session");

	assert.equal(rows.length, 1);
	const payload = rows[0]!.payload as Record<string, unknown>;
	assert.equal(payload.input_tokens, 1_200);
	assert.equal(payload.cached_tokens, 1_100);
	assert.equal(payload.output_tokens, 40);
	assert.equal(payload.total_tokens, 1_240);
	assert.equal("cache_write_tokens" in payload, false);
	assert.equal("prompt_tokens_details" in payload, false);
});

test("provider trace writer and reader retain safe retry evidence without raw errors", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "mycli-failure-trace-"));
	removeFixtureDirectoryAfterTests(t, home);
	const store = openRuntimeSessionStore({ dbPath: join(home, "sessions.db") });
	t.after(() => store.close());
	appendNodeTrace(home, "session", runtimeDiagnosticTraceEvent({
		kind: "model_stream_diagnostics", turnId: "turn-1", provider: "openai", protocol: "responses",
		model: "test-model", attempt: 1, elapsedMs: 100, textDeltaIntervalCount: 0,
		providerEventCount: 1, reasoningEventCount: 0, textEventCount: 1, providerStateEventCount: 0,
		toolCallEventCount: 0, usageEventCount: 0, completedEventCount: 0, reasoningBytes: 0,
		textBytes: 7, success: false, failureKind: "provider_error",
		failure: {
			code: "provider_error", message: "private local exception", retryable: true, retryAfterSeconds: 2,
			additionalDetails: "upstream request failed token=private-key\n    at fn (/private/internal.ts:1:2)",
			diagnostics: { status: 200, request_id: "req-stream", error_source: "response_stream",
				provider_error_code: "server_error", raw_body: "private payload", authorization: "private credential" },
		},
	}));
	const raw = await readFile(join(home, ".mycli", "traces", "session-trace.jsonl"), "utf8");
	const rows = nodeTraceRows(store, home, "session");
	assert.equal(rows.length, 1);
	const payload = rows[0]!.payload as Record<string, unknown>;
	assert.equal(payload.retryable, true);
	assert.equal(payload.retry_after_seconds, 2);
	assert.equal(payload.status, 200);
	assert.equal(payload.request_id, "req-stream");
	assert.equal(payload.error_source, "response_stream");
	assert.equal(payload.provider_error_code, "server_error");
	assert.equal(payload.additional_details, "upstream request failed token=[REDACTED]");
	assert.doesNotMatch(raw + JSON.stringify(rows), /private|raw_body|authorization|internal\.ts/u);
	assert.deepEqual(store.loadHistoryItems("session"), []);
});

test("compaction traces retain typed terminal reasons and failed-attempt usage", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "mycli-compaction-trace-"));
	removeFixtureDirectoryAfterTests(t, home);
	const store = openRuntimeSessionStore({ dbPath: join(home, "sessions.db") });
	t.after(() => store.close());
	const errorContext = createErrorContext({ reason: "provider.output_limit", source: "provider", scope: { kind: "provider_attempt", id: "compaction" },
		outcome: { state: "failed", effects: "none" }, details: { finish_reason: "length", max_output_tokens: 8192 } });
	appendNodeTrace(home, "session", runtimeDiagnosticTraceEvent({ kind: "compaction", turnId: "summary", source: "user_requested",
		status: "failed", beforeTokens: 40_000, afterTokens: 40_000, maxTokens: 50_000, durationMs: 1000,
		failure: { code: "provider_error", message: "private exception", errorContext, retryable: false,
			additionalDetails: "limit reached token=private-key" }, usage: { input_tokens: 1000, output_tokens: 8192, reasoning_tokens: 8192 } }));
	const payload = nodeTraceRows(store, home, "session")[0]!.payload as Record<string, unknown>;
	assert.deepEqual(payload.error_context, errorContext);
	assert.equal(payload.output_tokens, 8192);
	assert.equal(payload.reasoning_tokens, 8192);
	assert.equal(payload.failure_kind, "provider_error");
	assert.doesNotMatch(await readFile(join(home, ".mycli", "traces", "session-trace.jsonl"), "utf8"), /private/u);
});

test("completion timing survives trace serialization while invalid and private fields are dropped", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "mycli-completion-trace-"));
	removeFixtureDirectoryAfterTests(t, home);
	const store = openRuntimeSessionStore({ dbPath: join(home, "sessions.db") });
	t.after(() => store.close());
	const model = runtimeDiagnosticTraceEvent({
		kind: "model_stream_diagnostics", turnId: "turn-1", provider: "openai", protocol: "responses",
		model: "test-model", attempt: 1, elapsedMs: 8_420, textDeltaIntervalCount: 0,
		providerEventCount: 2, reasoningEventCount: 0, textEventCount: 1, providerStateEventCount: 0,
		toolCallEventCount: 0, usageEventCount: 0, completedEventCount: 1, reasoningBytes: 0,
		textBytes: 7, success: true, lastTextDeltaMs: 10, responseTerminalMs: 8_010,
		sdkTerminalMs: 8_020, completedEventMs: 8_025, streamSettledMs: 8_120,
		terminalPersistMs: 300, textTailMs: 8_410,
	});
	const completion = runtimeDiagnosticTraceEvent({
		kind: "turn_completion_diagnostics", turnId: "turn-1", commitMs: 15,
		continuationMs: 5, snapshotMs: 350, publishMs: 2, elapsedMs: 372, snapshotWritten: true,
	});
	appendNodeTrace(home, "session", model);
	appendNodeTrace(home, "session", completion);
	assert.deepEqual(nodeTraceRows(store, home, "session"), [model, completion]);
	const tracePath = join(home, ".mycli", "traces", "session-trace.jsonl");
	assert.deepEqual((await readFile(tracePath, "utf8")).trim().split("\n").map((row) => JSON.parse(row)), [model, completion]);
	for (const write of [true, false]) {
		const invalid = { kind: "model_stream_diagnostics", turn_id: "invalid", payload: {
			last_text_delta_ms: -1, response_terminal_ms: "private", sdk_terminal_ms: 86_400_001,
			completed_event_ms: null, stream_settled_ms: [], terminal_persist_ms: -5,
			text_tail_ms: {}, prompt: "private input",
		} };
		if (write) appendNodeTrace(home, "session", invalid);
		else await appendFile(tracePath, `${JSON.stringify(invalid)}\n`);
		assert.deepEqual(nodeTraceRows(store, home, "session").at(-1)?.payload, {});
	}
	appendNodeTrace(home, "session", { kind: "turn_completion_diagnostics", turn_id: "failed-snapshot", payload: {
		commit_ms: 0, snapshot_ms: -1, elapsed_ms: 86_400_001, snapshot_written: false, raw_body: "private",
	} });
	assert.deepEqual(nodeTraceRows(store, home, "session").at(-1)?.payload, { commit_ms: 0, snapshot_written: false });
	assert.deepEqual(store.loadHistoryItems("session"), []);
});
