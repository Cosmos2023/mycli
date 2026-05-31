# Logging Guidelines

> How logging is done in this project.

---

## Overview

`mycli` keeps operational diagnostics separate from structured session state.
Session data lives in SQLite; logs and model-provider debug payloads live under
the local log root and must never become provider transcript inputs.

## Scenario: Runtime Workspace Logging

### 1. Scope / Trigger
- Trigger: Any change that writes operational logs, model-provider debug
  payloads, runtime error details, or user-facing log inspection output.
- These files are local diagnostics only. They must not affect prompt text,
  tool schema ordering, transcript replay, request-shape hashes, or session DB
  persistence.

### 2. Signatures
- `WorkspaceLogService(workspace_root: Path, logs_root: Path | None = None, session_id: str | None = None, now_provider: Callable[[], datetime] | None = None)`
- `WorkspaceLogService.set_session_id(session_id: str | None) -> None`
- `WorkspaceLogService.log(level: LogLevel, event: str, message: str, context: dict[str, Any] | None = None) -> None`
- `WorkspaceLogService.log_model_event(event: ModelLogEvent) -> None`
- `WorkspaceLogService.write_raw_model_payload(kind: str, payload: Any, session_id: str, turn_id: str) -> Path`
- `WorkspaceLogService.inspect_logs(tail: int = 20) -> tuple[str, ...]`
- Slash command: `/logs` renders `TurnService.inspect_logs()` with `[log]` prefixes.
- Slash command: `/trace-jsonl` renders `TurnService.export_trace_jsonl()` with
  `[trace-jsonl]` prefixes for machine-readable runtime trace rows.
- Node gateway RPC: `trace.export` renders the same rows without slash-command
  prefixes for external/extension clients.

### 3. Contracts
- CLI/runtime injection uses `MycliStorageLayout.from_home_dir(home_dir).logs_dir`,
  so user-level logs are rooted at `~/.mycli/logs`.
- Compatibility/test callers that pass only `workspace_root` use
  `<workspace_root>/log`.
- File layout:
  - `agent.log`: info/warning/error operational log lines.
  - `errors.log`: warning/error operational log lines.
  - `model-events.jsonl`: one redacted model event JSON object per line.
  - `model-raw/<safe-session-id>/*.json`: redacted raw request/response/error
    payloads bucketed by session.
- Operational log lines include the active session tag when known, for example
  `2026-05-29T12:00:00Z INFO [demo] turn_started ...`.
- Runtime session changes must call `WorkspaceLogService.set_session_id()` from
  the rebind path so `/resume` and `/fork` diagnostics follow the active
  session tip/branch.
- Runtime safety diagnostics may append local trace/log events that explain why
  a risky action was allowed. For example, `approval_auto_allowed` records a
  later risky tool call that matched a prior session-scoped approval allowance.
  This event is diagnostic-only; it is not a gateway stream event and must not
  be replayed into provider-visible transcript messages.
- Approval resolution diagnostics may append local `approval_resolution` trace
  rows and workspace log entries for rejected, invalid, duplicate, or otherwise
  blocked approval responses. These diagnostics explain why a pending approval
  did or did not resume a tool; they must not alter provider transcript replay
  or request-shape inputs.
- Interrupted turn diagnostics append local `turn_interrupted` trace rows and
  warning-level workspace log entries after suspended runtime state is saved.
  These diagnostics explain that resume state exists; they must not be used as
  provider transcript content.
- Secret-bearing text and JSON fields must be redacted before disk write.
  Common sensitive keys include `authorization`, `api_key`, `token`, `secret`,
  and `password`.

### 4. Validation & Error Matrix
- `logs_root=None` -> write under `<workspace_root>/log`.
- `logs_root=<home>/.mycli/logs` -> write global operational logs under that
  directory and raw payloads under `model-raw/<session>/`.
- Session IDs containing path separators or unsafe characters -> sanitize for
  paths, but keep the original value in the visible log tag.
- Missing log files during `/logs` inspection -> return paths and no tail lines;
  do not raise.
- Warning/error event -> append to both `agent.log` and `errors.log`.
- Secret-like text in message/context/raw payload -> redact before persistence.
- Risky tool call matches a session-scoped approval allowance -> append an
  `approval_auto_allowed` runtime trace row and an info-level workspace log
  entry with `source=session_allowance`, `tool_name`, `call_id`,
  `decision_id`, `command_pattern`, and `reason`.
- Approval response is rejected, invalid, duplicated after clearing, or cannot
  resume a suspended turn -> append an `approval_resolution` runtime trace row
  and info-level workspace log entry with bounded `result`, `choice`,
  `tool_name`, `call_id`, `decision_id`, `command_pattern`, and `reason` when a
  decision is available.
- Runtime turn is finalized as interrupted -> append a `turn_interrupted`
  runtime trace row and warning-level workspace log entry with bounded
  `session_id`, `turn_id`, `stop_reason`, `suspend_reason`, `saved_state`, and
  `message_count`.
- Ordinary safe auto approval -> do not emit `approval_auto_allowed`, because no
  prior user allowance was consumed.
- `/trace-jsonl` -> return bounded sanitized JSONL rows from the current
  session trace without mutating trace files.
- `trace.export` -> return the same bounded sanitized JSONL rows as raw row
  strings, not prefixed command output.

### 5. Good/Base/Bad Cases
- Good: `build_turn_service(..., home=home)` creates a log service rooted at
  `home/.mycli/logs`; after `/resume root` resolves to `branch`, raw payloads
  are written under `model-raw/branch/`.
- Base: A unit test creates `WorkspaceLogService(workspace_root=tmp_path)` and
  gets `tmp_path/log/agent.log`.
- Bad: Writing `~/.mycli/logs/<session>/errors.log`, because it fragments
  operational logs and makes `/logs` inspection session-dependent.
- Bad: Persisting `Authorization: Bearer sk-...` or JSON `api_key` values.
- Bad: Adding log summaries to system prompts or provider transcript replay.
- Bad: Emitting `approval_auto_allowed` for a safe built-in tool that never
  consumed a session-scoped approval allowance.
- Bad: Building external integrations by scraping human `/trace` prose when a
  JSONL export is available.
- Bad: Building extension/ACP integrations by stripping `[trace-jsonl]`
  prefixes when the gateway `trace.export` RPC is available.

### 6. Tests Required
- Unit test global and compatibility log roots.
- Unit test `agent.log`, `errors.log`, `model-events.jsonl`, and
  `model-raw/<session>/` paths.
- Unit test text and nested JSON redaction.
- Unit test `set_session_id()` / runtime `rebind_session()` changes the active
  log tag and raw payload bucket.
- CLI/REPL tests for `/logs` help, completion, and command routing.
- CLI/REPL tests for `/trace-jsonl` completion, command routing, and JSONL
  export sanitization.
- Gateway tests for `trace.export` raw rows and tail bounding.
- Integration test for session allowance hits proving `approval_auto_allowed`
  appears in runtime trace and workspace logs while the turn still avoids a new
  pending approval.
- Integration test for approval resolution diagnostics proving invalid choices,
  rejections, and duplicate/no-pending responses appear in runtime trace and
  workspace logs without changing pending-decision behavior.
- Unit or integration test for interrupted turn diagnostics proving
  `turn_interrupted` appears in runtime trace and workspace logs while
  suspended turn state remains resumable.
- Full request-shape/cache tests must continue passing when logs change.

### 7. Wrong vs Correct

Wrong:
```python
WorkspaceLogService(
    workspace_root=workspace_root,
    logs_root=home_dir / ".mycli" / "logs" / session_id,
)
```

Correct:
```python
layout = MycliStorageLayout.from_home_dir(home_dir)
WorkspaceLogService(
    workspace_root=workspace_root,
    logs_root=layout.logs_dir,
    session_id=config.session_id,
)
```

Wrong:
```python
write_json(path, provider_payload)
```

Correct:
```python
write_json(path, redact_payload(provider_payload))
```

## Log Levels

- `INFO`: normal runtime milestones such as context assembly, model request
  start/end, and ignored provider items.
- `WARNING`: recoverable diagnostics that should also appear in `errors.log`.
- `ERROR`: runtime/provider failures and error payload references.

## What to Log

- Bounded operational events, session and turn identifiers, provider/model
  names, relative/absolute paths to local diagnostic payloads, and error types.
- Raw provider payloads only through `WorkspaceLogService.write_raw_model_payload`
  so path bucketing and redaction stay centralized.

## What NOT to Log

- API keys, bearer tokens, auth headers, passwords, or secret-like values.
- Full local file contents as operational log context.
- Any diagnostic content that changes stable model-visible prompt/tool/request
  surfaces unless the user-visible contract intentionally changes.
