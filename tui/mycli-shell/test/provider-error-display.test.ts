import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { turnFailedNoticeId } from "@mycli/contracts";
import {
	initialRuntimeState,
} from "../src/state/runtime-state-model.ts";
import {
	projectRuntimeState,
} from "../src/state/runtime-projection.ts";
import {
	reduceRuntimeEvent,
} from "../src/state/runtime-event-reducer.ts";
import {
	runtimeStateFromTranscript,
} from "../src/state/transcript-history.ts";
import { NoticeMessageComponent } from "../src/components/transcript/notice-message.ts";
import { visibleWidth } from "../src/tui-core/utils.ts";
import {
	renderMycliShell,
} from "../src/application/shell-app.ts";

test("upstream error details remain visible in live and resumed terminal notices", () => {
	const additionalDetails = "stream_read_error token=private-key (status 200, request id: req-stream)";
	const live = reduceRuntimeEvent(initialRuntimeState(), "turn.failed", {
		turn_id: "turn-stream", client_turn_id: "client-stream",
		code: "retry_exhausted", message: "provider retry budget exhausted", additional_details: additionalDetails,
	});
	const resumed = runtimeStateFromTranscript(initialRuntimeState(), {
		items: [{
			id: turnFailedNoticeId("turn-stream"), type: "error", text: "Provider retry budget exhausted.",
			metadata: {
				event_kind: "turn_failed", failed_turn_id: "turn-stream", source: "runtime", status: "failed",
				code: "retry_exhausted", additional_details: additionalDetails,
			},
		}],
	});
	const liveNotices = projectRuntimeState(live).messages.filter((message) => message.role === "error");
	assert.equal(liveNotices.length, 1);
	assert.deepEqual(projectRuntimeState(resumed).messages.filter((message) => message.role === "error"), liveNotices);
	const notice = liveNotices[0];
	assert.ok(notice?.role === "error");
	for (const width of [40, 80, 120]) {
		const lines = new NoticeMessageComponent(notice).render(width).map(stripVTControlCharacters);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		const text = lines.join(" ").replace(/\s+/gu, " ");
		assert.match(text, /Provider retry budget exhausted\./u);
		assert.match(text, /stream_read_error/u);
		assert.match(text, /req-stream/u);
		assert.match(text, /\[REDACTED\]/u);
		assert.doesNotMatch(text, /private-key/u);
	}
});

test("compaction failure details render safely without an assistant answer", () => {
	const state = reduceRuntimeEvent(initialRuntimeState(), "compaction.completed", {
		client_turn_id: "compact-client", source: "pre_turn", status: "failed",
		before_tokens: 4000, after_tokens: 4000, max_tokens: 5000, duration_s: 1,
		failure: { code: "retry_exhausted", message: "Provider retry budget exhausted.", retryable: false,
			additionalDetails: "stream_read_error token=synthetic-secret (request id: req-summary)" },
	});
	assert.equal(state.transcript.some((item) => item.type === "assistant"), false);
	const projected = projectRuntimeState(state);
	for (const width of [40, 80, 120]) {
		const lines = renderMycliShell(projected, width).map(stripVTControlCharacters);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		const text = lines.join(" ").replace(/\s+/gu, " ");
		assert.match(text, /stream_read_error/u);
		assert.match(text, /req-summary/u);
		assert.doesNotMatch(text, /synthetic-secret/u);
	}
});
