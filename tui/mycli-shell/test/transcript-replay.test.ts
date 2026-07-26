import assert from "node:assert/strict";
import test from "node:test";
import { resolveTranscriptReplayMaxRows } from "../src/transcript-replay.ts";

test("transcript replay row caps follow terminal-specific Codex defaults", () => {
	assert.equal(resolveTranscriptReplayMaxRows({ TERM_PROGRAM: "vscode" }), 1_000);
	assert.equal(resolveTranscriptReplayMaxRows({ TERM_PROGRAM: "WezTerm" }), 3_500);
	assert.equal(resolveTranscriptReplayMaxRows({ WT_SESSION: "active" }), 9_001);
	assert.equal(resolveTranscriptReplayMaxRows({ TERM_PROGRAM: "Alacritty" }), 10_000);
	assert.equal(resolveTranscriptReplayMaxRows({ TERM_PROGRAM: "Apple_Terminal" }), 1_000);
});

test("transcript replay row cap supports explicit limits and disabling", () => {
	assert.equal(resolveTranscriptReplayMaxRows({ MYCLI_TUI_TRANSCRIPT_REPLAY_MAX_ROWS: "2400" }), 2_400);
	assert.equal(resolveTranscriptReplayMaxRows({ MYCLI_TUI_TRANSCRIPT_REPLAY_MAX_ROWS: "0" }), undefined);
	assert.equal(resolveTranscriptReplayMaxRows({ MYCLI_TUI_TRANSCRIPT_REPLAY_MAX_ROWS: "invalid" }), 1_000);
});
