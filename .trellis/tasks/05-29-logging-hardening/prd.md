# Logging Hardening PRD

## Background

`mycli` already persists session state in SQLite and writes model debug artifacts through `WorkspaceLogService`, but the current log layout is split by per-session directories and runtime fallback paths. This makes operational diagnostics harder than necessary, and session rebinding after `/resume` or `/fork` can leave logging context tied to the old session.

Hermes separates structured session state, operational logs, and request/debug dumps. This task adopts the useful parts of that model without changing model-visible prompts, tool schemas, provider request shapes, trace semantics, or session database behavior.

## Goals

- Regularize runtime logs under the user home layout:
  - `~/.mycli/logs/agent.log`
  - `~/.mycli/logs/errors.log`
  - `~/.mycli/logs/model-events.jsonl`
  - `~/.mycli/logs/model-raw/<session-id>/...json`
- Preserve the existing model raw payload logging capability for provider debugging.
- Ensure text log lines and model event records carry the active session context.
- Ensure warning/error entries are duplicated to `errors.log`; info/warning/error operational entries are written to `agent.log`.
- Ensure `/resume` and `/fork` rebind logging context to the active session tip/branch, including raw payload bucket selection.
- Add a `/logs` slash command that shows log locations and recent operational lines without exposing secrets.
- Redact API keys, bearer tokens, and common secret-like values from text logs and JSON raw payloads before disk write.

## Non-Goals

- Do not implement Hermes' full logging feature set such as gateway-specific logs, memory monitor lines, or streaming performance dashboards.
- Do not change prompt rendering, tool schema order, provider transcript replay, request-shape hashes, traces, or session DB schema.
- Do not introduce a new dependency or external log aggregation backend.
- Do not migrate old log files.

## Requirements

1. CLI bootstrap must inject a `WorkspaceLogService` rooted at `MycliStorageLayout.logs_dir`, not a per-session subdirectory.
2. `WorkspaceLogService` must still support current tests and standalone callers that pass only `workspace_root`; that compatibility path may keep using `<workspace_root>/log`.
3. `WorkspaceLogService` must expose a safe way to update the current `session_id`.
4. Runtime session rebinding must update the logging service context when sessions change.
5. Model raw payload files must be written under a session-specific subdirectory beneath `model-raw`.
6. Text logs, event JSONL entries, and raw payload JSON files must be redacted before persistence.
7. `/logs` must be available in REPL help and command routing, and should report paths plus a bounded tail of recent log lines.

## Acceptance Checks

- Unit tests cover the new global log layout and compatibility layout.
- Unit tests cover redaction for text and nested JSON payloads.
- Unit tests cover session rebinding changing the raw payload directory.
- Runtime tests cover `AgentRuntime.rebind_session()` updating log context.
- CLI tests cover `/logs` routing and user-visible output shape.
- `uv run pytest`, `uv run ruff check src tests`, and `uv run mypy` pass.
