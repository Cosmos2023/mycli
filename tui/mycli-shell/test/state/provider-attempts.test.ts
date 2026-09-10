import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { TURN_INTERRUPTED_NOTICE, turnInterruptedNoticeId, type ProviderAttemptRecord } from "@mycli/contracts";
import {
	initialRuntimeState,
	type RuntimeShellState,
} from "../../src/state/runtime-state-model.ts";
import {
	projectRuntimeState,
} from "../../src/state/runtime-projection.ts";
import {
	reduceRuntimeEvent,
} from "../../src/state/runtime-event-reducer.ts";
import {
	runtimeStateFromTranscript,
} from "../../src/state/transcript-history.ts";
import { ProviderAttemptComponent } from "../../src/components/transcript/provider-attempt.ts";
import { turnActivityHeaderText } from "../../src/components/transcript/turn-activity-label.ts";
import {
	MycliShellRuntime,
} from "../../src/application/shell-runtime.ts";
import {
	renderTranscriptBlocks,
} from "../../src/components/transcript/transcript-renderer.ts";
import { visibleWidth } from "../../src/tui-core/utils.ts";
import { HeadlessTerminal } from "../support/headless-terminal.ts";
import type { MycliShellTranscriptBlock } from "../../src/model.ts";

test("durable retry state deduplicates compatibility notifications and restores the same history", () => {
	const records = chain();
	let live = activeState();
	for (const record of records.slice(0, 3)) live = deliver(live, record);
	assert.equal(live.liveStatus?.retryAt, records[2]!.retryAt);
	assert.equal(live.liveStatus?.text, "Retry attempt 2");
	const compatible = reduceRuntimeEvent(live, "stream.retrying", {
		turn_id: "turn-1", client_turn_id: "client-1", text: "legacy duplicate", attempt: 1, max_retries: 3, delay_seconds: 2,
	});
	assert.equal(compatible.liveStatus, live.liveStatus);
	assert.equal(compatible.transcript, live.transcript);
	live = deliver(live, records[3]!);
	assert.equal(live.liveStatus?.retryAt, undefined);
	assert.equal(live.liveStatus?.text, "Attempt 2 started");
	live = deliver(live, records[4]!);
	assert.equal(live.liveStatus?.kind, "running");
	live = reduceRuntimeEvent(live, "turn.completed", { turn_id: "turn-1", client_turn_id: "client-1" });
	assert.equal(live.turnRunning, false);
	const resumed = runtimeStateFromTranscript({ ...initialRuntimeState(), sessionId: "session-1" }, {
		session_id: "session-1", items: [], next_before: null, provider_attempts: records,
	});
	assert.deepEqual(attemptBlocks(resumed), attemptBlocks(live));
	assert.equal(resumed.turnRunning, false);
	assert.equal(attemptBlocks(resumed).length, 1);
});

test("stale attempt records cannot restart completed turns or replace newer retry state", () => {
	let state = activeState();
	for (const record of chain().slice(0, 4)) state = deliver(state, record);
	const current = state;
	state = deliver(state, chain()[2]!);
	assert.equal(state.transcript, current.transcript);
	assert.equal(state.liveStatus, current.liveStatus);
	state = deliver(state, { ...chain()[4]!, sessionId: "other-session" });
	assert.equal(state, current);
	state = deliver(state, { ...chain()[4]!, turnId: "other-turn" });
	assert.equal(state, current);
	state = reduceRuntimeEvent(state, "turn.failed", {
		turn_id: "turn-1", client_turn_id: "client-1", code: "retry_exhausted", message: "Retry budget exhausted",
	});
	const terminal = state;
	state = deliver(state, chain()[4]!);
	assert.equal(state, terminal);
	assert.equal(projectRuntimeState(state).messages.filter((message) => message.role === "error").length, 1);
	assert.equal(state.turnRunning, false);
	assert.equal(state.liveStatus?.retryAt, undefined);
});

test("pending records restored without a running turn are paused and never create a countdown", () => {
	const state = runtimeStateFromTranscript({ ...initialRuntimeState(), sessionId: "session-1" }, {
		session_id: "session-1", items: [], provider_attempts: chain().slice(0, 3),
	});
	assert.equal(state.turnRunning, false);
	assert.equal(state.liveStatus?.retryAt, undefined);
	const block = attemptBlocks(state)[0]!;
	assert.match(new ProviderAttemptComponent(block.providerAttempt).render(60).join("\n"), /Recovery paused/u);
});

test("attempt diagnostics remain bounded, redacted and readable on narrow and wide terminals", () => {
	let state = activeState();
	for (const record of chain()) state = deliver(state, record);
	const block = attemptBlocks(state)[0]!;
	for (const width of [28, 60, 120]) {
		const lines = new ProviderAttemptComponent({ ...block.providerAttempt, expanded: true }).render(width)
			.map(stripVTControlCharacters);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
		const text = lines.join(" ").replace(/\s+/gu, " ");
		assert.match(text, /Recovered/u);
		assert.match(text, /quota|stream_read_error/u);
		assert.match(text, /request_id/u);
		assert.doesNotMatch(text, /private-credential|private\/source/u);
		assert.match(text, /REDACTED/u);
	}
});

test("existing details key expands retry history and terminal status stops retry activity", async () => {
	let state = activeState();
	for (const record of chain().slice(0, 3)) state = deliver(state, record);
	const terminal = new HeadlessTerminal({ columns: 60, rows: 30 });
	const runtime = new MycliShellRuntime({ initialState: projectRuntimeState(state), terminal });
	try {
		runtime.start();
		assert.doesNotMatch(stripVTControlCharacters(runtime.chatContainer.render(60).join("\n")), /provider_error_code/u);
		terminal.sendInput("\x0f");
		assert.match(stripVTControlCharacters(runtime.chatContainer.render(60).join("\n")), /provider_error_code/u);
		state = reduceRuntimeEvent(state, "turn.interrupted", { turn_id: "turn-1", client_turn_id: "client-1" });
		runtime.setState(projectRuntimeState(state));
		assert.equal(runtime.getState().footer.turnRunning, false);
		assert.equal(runtime.getState().footer.liveRetryAt, undefined);
	} finally {
		await runtime.shutdown();
		await terminal.flush();
	}
});

test("retry countdown derives from durable retryAt and stops at zero", () => {
	const options = { text: "Retry attempt 2", kind: "reconnecting", variantKey: "turn", retryAt: "2026-09-07T08:00:05Z" };
	assert.equal(turnActivityHeaderText({ ...options, nowMs: Date.parse("2026-09-07T08:00:02Z") }), "Retry attempt 2 in 3s");
	assert.equal(turnActivityHeaderText({ ...options, nowMs: Date.parse("2026-09-07T08:00:07Z") }), "Retry attempt 2 in 0s");
});

test("first-attempt cancellation renders only the turn warning live and after resume", async () => {
	const records = cancelledFirstAttempt();
	const user = { id: "user-1", type: "user", text: "same input", created_at: "2026-09-07T07:59:59Z" };
	for (const mode of ["live", "resumed", "terminal-only"] as const) {
		let state: RuntimeShellState;
		if (mode === "live") {
			state = runtimeStateFromTranscript(activeState(), { session_id: "session-1", items: [user] });
			for (const record of records) state = deliver(state, record);
			for (let duplicate = 0; duplicate < 2; duplicate++) {
				state = reduceRuntimeEvent(state, "turn.interrupted", { turn_id: "turn-1", client_turn_id: "client-1" });
			}
		} else {
			state = runtimeStateFromTranscript({ ...initialRuntimeState(), sessionId: "session-1" }, {
				session_id: "session-1", items: [user, {
					id: turnInterruptedNoticeId("turn-1"), type: "warning", text: TURN_INTERRUPTED_NOTICE,
					created_at: "2026-09-07T08:00:02Z",
				}], provider_attempts: mode === "terminal-only" ? records.slice(-1) : records,
			});
		}
		assert.equal(attemptBlocks(state).length, 0, mode);
		assert.equal(state.transcript.flatMap((item) => item.providerAttempts ?? []).length,
			mode === "terminal-only" ? 1 : 2, "attempt diagnostics remain available in state");
		const shell = projectRuntimeState(state);
		assert.deepEqual(shell.messages.map((message) => message.text), ["same input", TURN_INTERRUPTED_NOTICE]);
		for (const width of [60, 100]) {
			const terminal = new HeadlessTerminal({ columns: width, rows: 20 });
			try {
				terminal.write(renderTranscriptBlocks(shell.transcript ?? [], width).join("\r\n"));
				await terminal.flush();
				const text = terminal.visibleLines().join("\n");
				assert.equal(text.match(/Turn interrupted\./gu)?.length, 1, `${mode}, width ${width}`);
				assert.doesNotMatch(text, /Retry cancelled|request 0\/4|stream 0\/5/u);
			} finally {
				terminal.dispose();
			}
		}
	}
});

test("partial attempt history still shows cancellation after request or stream retry scheduling", () => {
	for (const [requestRetriesUsed, streamRetriesUsed] of [[1, 0], [0, 1]] as const) {
		const record: ProviderAttemptRecord = {
			...cancelledFirstAttempt()[1]!, attempt: 2, attemptId: "request-1:2", requestRetriesUsed, streamRetriesUsed,
		};
		const state = runtimeStateFromTranscript({ ...initialRuntimeState(), sessionId: "session-1" }, {
			session_id: "session-1", items: [], provider_attempts: [record],
		});
		const blocks = attemptBlocks(state);
		assert.equal(blocks.length, 1);
		assert.match(new ProviderAttemptComponent(blocks[0]!.providerAttempt).render(100).join(" "), /Retry cancelled/u);
	}
});

test("first-attempt failures, recovery cancellations, and unknown outcomes remain visible without retries", () => {
	for (const terminalState of ["failed", "cancelled", "unknown"] as const) {
		const record: ProviderAttemptRecord = {
			...cancelledFirstAttempt()[0]!, sequence: 2, state: terminalState,
			...(terminalState !== "unknown" ? { failure: { code: "provider_error", message: "Provider failed", retryable: false } } : {}),
		};
		const state = runtimeStateFromTranscript({ ...initialRuntimeState(), sessionId: "session-1" }, {
			session_id: "session-1", items: [], provider_attempts: [record],
		});
		assert.equal(attemptBlocks(state).length, 1, terminalState);
	}
});

test("cancellation labels distinguish the first request from a charged retry", () => {
	const records = cancelledFirstAttempt();
	const view = { records, active: false, expanded: true };
	const text = new ProviderAttemptComponent(view).render(100).join(" ");
	assert.match(text, /Request cancelled/u);
	assert.doesNotMatch(text, /Retry cancelled/u);
});

test("exhausted and cancelled attempts keep one failure notice and no terminal retry countdown", () => {
	for (const terminalState of ["exhausted", "cancelled", "unknown"] as const) {
		let state = activeState();
		const records = chain();
		for (const record of records.slice(0, 4)) state = deliver(state, record);
		state = deliver(state, { ...records[4]!, state: terminalState,
			...(terminalState === "exhausted" ? { failure: records[1]!.failure } : {}),
		});
		assert.equal(state.liveStatus?.retryAt, undefined);
		state = reduceRuntimeEvent(state, "turn.failed", {
			turn_id: "turn-1", client_turn_id: "client-1", code: "retry_exhausted", message: "Retry budget exhausted",
		});
		assert.equal(projectRuntimeState(state).messages.filter((message) => message.role === "error").length, 1);
		assert.equal(state.turnRunning, false);
		const text = new ProviderAttemptComponent(attemptBlocks(state)[0]!.providerAttempt).render(60).join(" ");
		assert.match(text, /Retries exhausted|Retry cancelled|Attempt outcome unknown/u);
	}
});

test("restored attempt history keeps chronological placement around assistant output", () => {
	const payload = {
		session_id: "session-1", items: [
			{ id: "user", type: "user", text: "hello", created_at: "2026-09-07T07:59:59.000Z" },
			{ id: "assistant", type: "assistant_final", text: "done", created_at: "2026-09-07T08:00:04.100Z" },
		], provider_attempts: chain(),
	};
	const state = runtimeStateFromTranscript({ ...initialRuntimeState(), sessionId: "session-1" }, payload);
	assert.deepEqual(state.transcript.map((item) => item.id), ["user", "provider-attempt:request-1", "assistant"]);
	const liveBeforeHistory = deliver(activeState(), chain()[0]!);
	const attached = runtimeStateFromTranscript(liveBeforeHistory, payload);
	assert.deepEqual(attached.transcript.map((item) => item.id), state.transcript.map((item) => item.id));
});

test("attempts stay in their own turn when recovered notices have later timestamps", () => {
	const items = [1, 2].flatMap((turn) => [
		{ id: `user-${turn}`, turn_id: `turn-${turn}`, type: "user", text: "same input",
			created_at: `2026-09-07T08:00:${turn === 1 ? "00" : "10"}Z` },
		{ id: `warning-${turn}`, turn_id: `turn-${turn}`, type: "warning", text: TURN_INTERRUPTED_NOTICE,
			created_at: "2026-09-07T08:02:00Z" },
	]);
	const record = { ...chain()[0]!, turnId: "turn-2", requestId: "request-2",
		attemptId: "request-2:1", observedAt: "2026-09-07T08:00:11Z" };
	for (const visibleItems of [items, items.slice(2), items.slice(3)]) {
		const state = runtimeStateFromTranscript({ ...initialRuntimeState(), sessionId: "session-1" }, {
			session_id: "session-1", items: visibleItems, provider_attempts: [record],
		});
		const ids = state.transcript.map((item) => item.id);
		assert.equal(ids.indexOf("provider-attempt:request-2"), ids.indexOf("warning-2") - 1);
		assert.ok(ids.indexOf("provider-attempt:request-2") > ids.indexOf("user-2"));
	}
});

test("live attempts follow the current user when local messages have no timestamp yet", () => {
	const state = { ...activeState(), transcript: [
		{ id: "previous-user", type: "user", text: "old message" },
		{ id: "previous-warning", turn_id: "old-turn", type: "warning", text: TURN_INTERRUPTED_NOTICE },
		{ id: "current-user", type: "user", text: "new message" },
	] };
	assert.deepEqual(deliver(state, chain()[0]!).transcript.map((item) => item.id), [
		"previous-user", "previous-warning", "current-user", "provider-attempt:request-1",
	]);
});

test("partial attempt histories stay before terminal notices even when recorded after recovery", () => {
	const warningId = turnInterruptedNoticeId("turn-1");
	const state = runtimeStateFromTranscript({ ...initialRuntimeState(), sessionId: "session-1" }, {
		session_id: "session-1", items: [
			{ id: "user-1", turn_id: "turn-1", type: "user", text: "hello", created_at: "2026-09-07T08:00:00Z" },
			{ id: warningId, turn_id: "turn-1", type: "warning", text: TURN_INTERRUPTED_NOTICE,
				created_at: "2026-09-07T08:01:00Z" },
		], provider_attempts: [{ ...chain()[4]!, state: "unknown", observedAt: "2026-09-07T08:02:00Z" }],
	});
	assert.deepEqual(state.transcript.map((item) => item.id), ["user-1", "provider-attempt:request-1", warningId]);
});

test("legacy attempts use user boundaries when interruption timestamps are delayed", () => {
	const items = [1, 2].flatMap((turn) => [
		{ id: `user-${turn}`, type: "user", text: "same input",
			created_at: `2026-09-07T08:00:${turn === 1 ? "00" : "10"}Z` },
		{ id: `warning-${turn}`, type: "warning", text: TURN_INTERRUPTED_NOTICE,
			created_at: "2026-09-07T08:02:00Z" },
	]);
	const state = runtimeStateFromTranscript({ ...initialRuntimeState(), sessionId: "session-1" }, {
		session_id: "session-1", items, provider_attempts: [{ ...chain()[0]!, observedAt: "2026-09-07T08:00:11Z" }],
	});
	assert.deepEqual(state.transcript.map((item) => item.id), [
		"user-1", "warning-1", "user-2", "provider-attempt:request-1", "warning-2",
	]);
});

function activeState(): RuntimeShellState {
	return reduceRuntimeEvent({ ...initialRuntimeState(), sessionId: "session-1" }, "turn.started", {
		session_id: "session-1", turn_id: "turn-1", client_turn_id: "client-1",
	});
}

function deliver(state: RuntimeShellState, record: ProviderAttemptRecord): RuntimeShellState {
	return reduceRuntimeEvent(state, "provider.attempt.updated", {
		session_id: record.sessionId, turn_id: record.turnId, client_turn_id: "client-1", record,
	});
}

function attemptBlocks(state: RuntimeShellState): Extract<MycliShellTranscriptBlock, { kind: "provider_attempt" }>[] {
	return projectRuntimeState(state).transcript?.filter((block) => block.kind === "provider_attempt") ?? [];
}

function cancelledFirstAttempt(): ProviderAttemptRecord[] {
	const started: ProviderAttemptRecord = {
		...chain()[0]!, provider: "openai", model: "gpt-5.6-sol",
		policy: { requestMaxRetries: 4, streamMaxRetries: 5 },
	};
	return [started, {
		...started, eventId: "cancelled-1", sequence: 2, state: "cancelled",
		committedAt: "2026-09-07T08:00:01Z", observedAt: "2026-09-07T08:00:01Z",
		failure: { code: "interrupted", message: "turn interrupted", retryable: false },
	}];
}

function chain(): ProviderAttemptRecord[] {
	const failure = {
		code: "provider_error" as const, message: "Provider request failed.", retryable: true,
		additionalDetails: "stream_read_error token=private-credential \u4e0a\u6e38\u6682\u65f6\u4e0d\u53ef\u7528",
		diagnostics: { status: 200, provider_error_code: "stream_read_error", provider_error_type: "server_error",
			request_id: "req-safe", secret: "private/source" },
	};
	return (["started", "failed", "scheduled", "started", "recovered"] as const).map((state, index) => ({
		eventId: `event-${index}`, attemptId: `request-1:${index < 2 ? 1 : 2}`, retryChainId: "request-1",
		sessionId: "session-1", turnId: "turn-1", requestId: "request-1", provider: "deepseek", model: "deepseek-chat",
		source: "worker", committedAt: `2026-09-07T08:00:0${index}Z`, observedAt: `2026-09-07T08:00:0${index}Z`,
		sequence: index + 1, attempt: index < 2 ? 1 : 2, state,
		policy: { requestMaxRetries: 3, streamMaxRetries: 4 }, requestRetriesUsed: 0, streamRetriesUsed: index < 2 ? 0 : 1,
		...(state === "failed" || state === "scheduled" ? { failure } : {}),
		...(state === "scheduled" ? { retryAt: "2026-09-07T08:00:05Z", recoveryKind: "stream" as const, resetOutput: true } : {}),
	}));
}
