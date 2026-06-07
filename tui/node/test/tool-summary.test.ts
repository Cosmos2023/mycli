import assert from "node:assert/strict";
import test from "node:test";
import { formatToolSummary } from "../src/state/toolSummary.ts";

test("formats Read tool path from metadata", () => {
  assert.deepEqual(
    formatToolSummary({
      tool_name: "Read",
      metadata: { path: "pyproject.toml", duration_ms: 82 },
    }),
    { verb: "read", target: "pyproject.toml", status: "done", detail: "82ms" },
  );
});

test("formats Read tool path from streamed arguments metadata", () => {
  assert.deepEqual(
    formatToolSummary({
      tool_name: "Read",
      metadata: { arguments: { file_path: "pyproject.toml" } },
    }),
    { verb: "read", target: "pyproject.toml", status: "done" },
  );
});

test("formats Edit diff counts from metadata", () => {
  assert.deepEqual(
    formatToolSummary({
      tool_name: "Edit",
      metadata: { path: "src/app.tsx", additions: 14, deletions: 3 },
    }),
    { verb: "edit", target: "src/app.tsx", status: "done", detail: "+14 -3" },
  );
});

test("formats file change metadata into compact changed-file summary", () => {
  assert.deepEqual(
    formatToolSummary({
      tool_name: "Write",
      metadata: {
        path: "src/app.tsx",
        file_changes: [
          { kind: "write", path: "src/app.tsx" },
          { kind: "edit", path: "src/theme.ts" },
          { kind: "delete", path: "tmp/out.txt" },
          { kind: "edit", path: "tests/app.test.tsx" },
        ],
      },
    }),
    {
      verb: "write",
      target: "src/app.tsx",
      status: "done",
      changes: "4 files changed (add:1 delete:1 modify:2): src/app.tsx, src/theme.ts, tmp/out.txt +1",
    },
  );
});

test("formats Bash command and exit code", () => {
  assert.deepEqual(
    formatToolSummary({
      tool_name: "Bash",
      metadata: { command: "pytest -q", exit_code: 0 },
    }),
    { verb: "bash", target: "pytest -q", status: "done", detail: "exit 0" },
  );
});

test("formats Grep query and match count", () => {
  assert.deepEqual(
    formatToolSummary({
      tool_name: "Grep",
      metadata: { query: "NodeTuiGateway", matches: 8 },
    }),
    { verb: "grep", target: "NodeTuiGateway", status: "done", detail: "8 matches" },
  );
});

test("formats lifecycle running tool from context and seconds duration", () => {
  assert.deepEqual(
    formatToolSummary({
      tool_name: "Read",
      metadata: {
        status: "running",
        context: "pyproject.toml",
        args_preview: "file_path=pyproject.toml",
      },
    }),
    { verb: "read", target: "pyproject.toml", status: "running" },
  );

  assert.deepEqual(
    formatToolSummary({
      tool_name: "Read",
      metadata: {
        status: "done",
        summary: "Read pyproject.toml",
        duration_s: 0.125,
        success: true,
      },
    }),
    { verb: "read", target: "Read pyproject.toml", status: "done", detail: "125ms" },
  );
});

test("formats lifecycle failed tool from summary and error", () => {
  assert.deepEqual(
    formatToolSummary({
      tool_name: "Write",
      metadata: {
        status: "failed",
        summary: "Tool Write could not run.",
        error: "Missing required arguments: content",
        duration_s: 0.002,
        success: false,
      },
    }),
    {
      verb: "write",
      target: "Tool Write could not run.",
      status: "failed",
      detail: "2ms",
      reason: "Missing required arguments: content",
    },
  );
});

test("formats failed Bash tool with reason side-effect and log hints", () => {
  assert.deepEqual(
    formatToolSummary({
      tool_name: "Bash",
      metadata: {
        command: "pytest -q",
        duration_s: 14,
        exit_code: 1,
        files_changed: 0,
        log_ref: "/logs",
      },
    }),
    {
      verb: "bash",
      target: "pytest -q",
      status: "failed",
      detail: "14.0s",
      reason: "exit 1",
      hint: "no files changed · details: /logs",
    },
  );
});

test("uses file change metadata as failed tool side-effect hint", () => {
  assert.deepEqual(
    formatToolSummary({
      tool_name: "Bash",
      metadata: {
        command: "npm test",
        exit_code: 1,
        file_changes: [{ kind: "edit", path: "package.json" }],
        log_ref: "/logs",
      },
    }),
    {
      verb: "bash",
      target: "npm test",
      status: "failed",
      reason: "exit 1",
      hint: "1 file changed (modify:1): package.json · details: /logs",
    },
  );
});

test("falls back for unknown tools without throwing", () => {
  assert.deepEqual(
    formatToolSummary({ tool_name: "CustomTool", text: "custom target", metadata: {} }),
    { verb: "customtool", target: "custom target", status: "unknown" },
  );
});
