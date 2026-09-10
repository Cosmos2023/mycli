import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { GatewayParams, ProviderAttemptRecord } from "@mycli/contracts";
import { loadEarlierProviderAttemptHistory } from "../../src/state/provider-attempt-history.ts";
import {
	initialRuntimeState,
} from "../../src/state/runtime-state-model.ts";
import {
	projectRuntimeState,
} from "../../src/state/runtime-projection.ts";
import {
	runtimeStateFromOlderTranscriptPage,
	runtimeStateFromTranscript,
} from "../../src/state/transcript-history.ts";
import { ProviderAttemptComponent } from "../../src/components/transcript/provider-attempt.ts";
import { TranscriptViewerComponent } from "../../src/components/transcript/transcript-viewer.ts";
import { visibleWidth } from "../../src/tui-core/utils.ts";
import type { RuntimeShellState } from "../../src/state/runtime-state-model.ts";
import {
	MycliShellRuntime,
} from "../../src/application/shell-runtime.ts";
import { HeadlessTerminal } from "../support/headless-terminal.ts";

test("older transcript loading restores retry failures hidden behind more than 200 later events", async () => {
	const old = recoveryChain();
	const later = Array.from({ length: 240 }, (_, index) => record({
		eventId: `later-${index}`, requestId: `later-request-${Math.floor(index / 2)}`,
		retryChainId: `later-request-${Math.floor(index / 2)}`, attemptId: `later-attempt-${Math.floor(index / 2)}`,
		turnId: "later-turn", sequence: index % 2 + 1, state: index % 2 ? "completed" : "started",
		observedAt: new Date(Date.parse("2026-09-07T09:00:00Z") + index * 1000).toISOString(),
	}));
	const records = [...old, ...later];
	const newest = records.slice(-200);
	let state = runtimeStateFromTranscript({ ...initialRuntimeState(), sessionId: "session-1" }, {
		session_id: "session-1", items: [{ id: "recent", type: "assistant_final", text: "recent", created_at: "2026-09-07T09:05:00Z" }],
		next_before: "older-transcript", provider_attempts: newest, provider_attempts_truncated: true,
		provider_attempts_next_before: newest[0]!.eventId,
	});
	assert.equal(state.transcript.some((item) => item.providerAttempts?.some((attempt) => attempt.requestId === "old-request")), false);
	state = runtimeStateFromOlderTranscriptPage(state, {
		session_id: "session-1", items: [{ id: "old-user", type: "user", text: "old", created_at: "2026-09-07T07:59:00Z" }], next_before: null,
	});
	await loadEarlierProviderAttemptHistory({ current: () => state, update: (next) => { state = next; }, load: pagedLoader(records), force: true });
	const restored = state.transcript.find((item) => item.id === "provider-attempt:old-request");
	assert.deepEqual(restored?.providerAttempts?.map((attempt) => attempt.state), ["started", "failed", "scheduled", "started", "recovered"]);
	assert.equal(state.providerAttemptsNextBefore, null);
	const block = projectRuntimeState(state).transcript?.find((item) => item.id === restored?.id);
	assert.equal(block?.kind, "provider_attempt");
	if (block?.kind !== "provider_attempt") assert.fail();
	for (const width of [28, 60, 120]) {
		const lines = new ProviderAttemptComponent({ ...block.providerAttempt, expanded: true }).render(width).map(stripVTControlCharacters);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines.join(" "), /original-stream-failure/u);
		assert.match(lines.join(" "), /Recovered/u);
	}
});

test("a single request retains earlier loaded events beyond 200 and the full viewer exposes them", async () => {
	const records = longRecoveryChain(82);
	const newest = records.slice(-200);
	let state = runtimeStateFromTranscript({ ...initialRuntimeState(), sessionId: "session-1" }, {
		session_id: "session-1", items: [], provider_attempts: newest,
		provider_attempts_truncated: true, provider_attempts_next_before: newest[0]!.eventId,
	});
	await loadEarlierProviderAttemptHistory({ current: () => state, update: (next) => { state = next; }, load: pagedLoader(records), force: true });
	assert.equal(state.transcript[0]?.providerAttempts?.length, records.length);
	const viewer = new TranscriptViewerComponent({ blocks: projectRuntimeState(state).transcript ?? [], rows: () => 24,
		hasOlderHistory: true, hasOlderAttempts: true, onClose: () => undefined });
	viewer.render(60);
	viewer.handleInput("g");
	const lines = viewer.render(60).map(stripVTControlCharacters);
	assert.match(lines.join(" "), /first-retained-failure/u);
	assert.match(lines.join(" "), /Earlier retries: Home/u);
	assert.ok(lines.every((line) => visibleWidth(line) <= 60));
});

test("late history pages cannot alter a replacement session or regress a newer cursor", async () => {
	const records = recoveryChain();
	let state: RuntimeShellState = { ...initialRuntimeState(), sessionId: "session-1", providerAttemptsNextBefore: records[4]!.eventId };
	const waiting = Promise.withResolvers<unknown>();
	const result = loadEarlierProviderAttemptHistory({ current: () => state, update: (next) => { state = next; }, load: () => waiting.promise, force: true });
	state = { ...state, sessionId: "other-session", sessionGeneration: 2 };
	waiting.resolve({ session_id: "session-1", records: records.slice(0, 4), has_more: false, next_before_event_id: null });
	await result;
	assert.equal(state.transcript.length, 0);
	assert.equal(state.sessionId, "other-session");
});

test("the existing older-history action remains available when only retry pages remain", async () => {
	const state: RuntimeShellState = { ...initialRuntimeState(), sessionId: "session-1",
		providerAttemptsNextBefore: "older-event", transcriptNextBefore: null };
	const terminal = new HeadlessTerminal({ columns: 60, rows: 24 });
	const requested: string[] = [];
	const waiting = Promise.withResolvers<void>();
	const runtime = new MycliShellRuntime({ initialState: projectRuntimeState(state), terminal,
		onTranscriptHistoryLoad: (before) => { requested.push(before); return waiting.promise; } });
	try {
		runtime.start();
		runtime.showTranscriptViewer();
		terminal.sendInput("g");
		assert.deepEqual(requested, [""]);
		terminal.sendInput("g");
		assert.equal(requested.length, 1);
		waiting.resolve();
		await waiting.promise;
	} finally {
		waiting.resolve();
		await runtime.shutdown();
		await terminal.flush();
	}
});

function pagedLoader(records: readonly ProviderAttemptRecord[]): (params: GatewayParams<"provider.attempts.load">) => Promise<unknown> {
	return async (params) => {
		const end = records.findIndex((entry) => entry.eventId === params.before_event_id);
		assert.ok(end >= 0);
		const start = Math.max(0, end - (params.limit ?? 200));
		return { session_id: "session-1", records: records.slice(start, end), has_more: start > 0,
			next_before_event_id: start > 0 ? records[start]!.eventId : null };
	};
}

function recoveryChain(): ProviderAttemptRecord[] {
	return (["started", "failed", "scheduled", "started", "recovered"] as const).map((state, index) => record({
		sequence: index + 1, eventId: `old-event-${index}`, state, attempt: index < 2 ? 1 : 2,
		requestRetriesUsed: index < 2 ? 0 : 1,
		...(state === "failed" || state === "scheduled" ? { failure: { code: "provider_error", message: "Provider request failed.",
			retryable: true, additionalDetails: "original-stream-failure" } } : {}),
		...(state === "scheduled" ? { recoveryKind: "request", retryAt: "2026-09-07T08:00:01Z" } : {}),
	}));
}

function longRecoveryChain(retries: number): ProviderAttemptRecord[] {
	const policy = { requestMaxRetries: 100, streamMaxRetries: 0 };
	const records = [record({ policy })];
	const append = (update: Partial<ProviderAttemptRecord>): void => {
		records.push(record({ policy, sequence: records.length + 1, eventId: `event-${records.length}`, ...update }));
	};
	for (let retry = 1; retry <= retries; retry += 1) {
		const failure = { code: "provider_error" as const, message: "Provider request failed.", retryable: true,
			additionalDetails: retry === 1 ? "first-retained-failure" : `failure-${retry}` };
		append({ state: "failed", attempt: retry, requestRetriesUsed: retry - 1, failure });
		append({ state: "scheduled", attempt: retry + 1, requestRetriesUsed: retry,
			failure, recoveryKind: "request", retryAt: "2026-09-07T08:00:01Z" });
		append({ state: "started", attempt: retry + 1, requestRetriesUsed: retry });
	}
	append({ state: "recovered", attempt: retries + 1, requestRetriesUsed: retries });
	return records;
}

function record(overrides: Partial<ProviderAttemptRecord> = {}): ProviderAttemptRecord {
	return { eventId: "old-event", requestId: "old-request", retryChainId: "old-request", attemptId: "old-attempt",
		sessionId: "session-1", turnId: "old-turn", provider: "openai", model: "test-model", source: "worker",
		state: "started", attempt: 1, sequence: 1, requestRetriesUsed: 0, streamRetriesUsed: 0,
		policy: { requestMaxRetries: 2, streamMaxRetries: 2 },
		observedAt: "2026-09-07T08:00:00Z", committedAt: "2026-09-07T08:00:00Z", ...overrides };
}
