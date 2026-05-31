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
    },
  );
});

test("falls back for unknown tools without throwing", () => {
  assert.deepEqual(
    formatToolSummary({ tool_name: "CustomTool", text: "custom target", metadata: {} }),
    { verb: "customtool", target: "custom target", status: "unknown" },
  );
});
