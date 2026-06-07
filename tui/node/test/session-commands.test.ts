import assert from "node:assert/strict";
import test from "node:test";
import {
  runtimeCommandDispatch,
  sessionListOverlayLines,
  sessionResumeOverlayLines,
} from "../src/state/sessionCommands.ts";

test("runtime command dispatch uses typed session RPCs", () => {
  assert.deepEqual(runtimeCommandDispatch("/sessions"), { kind: "session.list" });
  assert.deepEqual(runtimeCommandDispatch("/resume branch"), {
    kind: "session.resume",
    sessionId: "branch",
  });
  assert.deepEqual(runtimeCommandDispatch("/resume"), {
    kind: "invalid",
    command: "/resume",
    lines: ["Usage: /resume <session_id>", "Run /sessions to inspect resumable sessions."],
  });
  assert.deepEqual(runtimeCommandDispatch("/title New title"), {
    kind: "command.run",
    command: "/title New title",
  });
});

test("session overlays render bounded readable summaries", () => {
  assert.deepEqual(
    sessionListOverlayLines({
      sessions: [
        {
          id: "root",
          last_active: "2026-06-07T01:00:00Z",
          message_count: 4,
          current: true,
        },
        {
          id: "branch",
          last_active: "2026-06-07T02:00:00Z",
          message_count: 12,
          current: false,
        },
      ],
    }),
    [
      " 1. root current",
      "    2026-06-07T01:00:00Z · 4 messages",
      " 2. branch",
      "    2026-06-07T02:00:00Z · 12 messages",
    ],
  );
  assert.deepEqual(
    sessionResumeOverlayLines({ session_id: "branch", lines: ["[session] resumed branch"] }),
    ["Active session: branch", "[session] resumed branch"],
  );
});
