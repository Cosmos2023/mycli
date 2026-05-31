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
- Approval and safety diagnostics may include bounded `safety_metadata` with
  stable keys such as `tool_name`, `canonical_tool_name`, `risk_level`,
  `decision_kind`, `policy`, and sanitized `command_pattern`. They must not
  include raw tool arguments, full shell commands beyond the sanitized command
  pattern, file contents, provider text, headers, or secret-like values.
- When runtime config disables medium-risk auto-approval, local mutation tools
  such as `Edit`, `Write`, and `KillShell` should produce pending approval
  decisions with `safety_metadata.policy=medium_risk_requires_approval`.
  These diagnostics are local safety evidence only and must not be replayed as
  provider-visible transcript content.
- Approval resolution diagnostics may append local `approval_resolution` trace
  rows and workspace log entries for rejected, invalid, duplicate, or otherwise
  blocked approval responses. These diagnostics explain why a pending approval
  did or did not resume a tool; they must not alter provider transcript replay
  or request-shape inputs.
- Clarification resolution diagnostics may append local
  `clarification_resolution` trace rows and workspace log entries for answered,
  blank, no-pending, or request-id-mismatch clarification responses. Payloads
  may include bounded request/tool identifiers and `response_chars`, but must
  not include raw user response text or provider transcript content.
- Interrupted turn diagnostics append local `turn_interrupted` trace rows and
  warning-level workspace log entries after suspended runtime state is saved.
  These diagnostics explain that resume state exists; they must not be used as
  provider transcript content.
- Failed turn diagnostics append local `turn_failed` trace rows and error-level
  workspace log entries from runtime failure finalizers. Payloads include
  bounded failure taxonomy fields such as `stop_reason`, `phase`, `error_type`,
  and optional `error_path`; they must not include raw exception messages,
  tracebacks, provider payloads, user text, tool output, headers, or
  secret-like values.
- Model stream diagnostics append local `model_stream_diagnostics` trace rows
  and workspace log entries after each streaming model request. Payloads include
  bounded operational counters such as `ttfb_ms`, `elapsed_ms`,
  `provider_event_count`, text/tool/completed event counts, `text_bytes`,
  `success`, and optional failure kind/message. These diagnostics are local
  observability only and must not alter provider-visible transcript content.
- Doctor may summarize `model_stream_diagnostics` trace rows with bounded
  counters and failure-kind counts. It must not print raw trace payloads or
  provider failure messages because those can contain sensitive upstream text.
- Doctor may summarize approval diagnostic trace rows with bounded counts for
  `approval_resolution`, `approval_allowance`, and `approval_auto_allowed`.
  It may expose `approval_resolution` result counts and aggregate
  `safety_metadata` counts for allowlisted `risk_level` and `policy` values,
  but must not print raw command patterns, reasons, user text, tool arguments,
  local paths, headers, or secret-like values.
- Doctor may summarize `clarification_resolution` trace rows with bounded
  result counts. It must not print raw response text, user text, request
  payloads, provider transcript content, headers, or secret-like values.
- Doctor may summarize `tool_execution` trace rows with bounded counts for
  total executions, failures, interruptions, denials, output truncation, write
  diagnostic errors, and allowlisted `error_kind` counts. It must not print raw
  tool arguments, stdout, stderr, summaries, file contents, local paths, user
  text, headers, or secret-like values.
- Doctor may summarize `turn_failed` trace rows with bounded total,
  `stop_reason`, and `phase` counts. It must not print raw exception messages,
  tracebacks, provider payloads, user text, tool output, headers, or
  secret-like values.
- Secret-bearing text and JSON fields must be redacted before disk write.
  Common sensitive keys include `authorization`, `api_key`, `token`, `secret`,
  and `password`.
- Doctor redaction diagnostics scan operational logs, model event JSONL, raw
  model payload JSON, and bounded runtime trace JSONL files. Findings must use
  relative file/line or JSON-path references and must not print secret values.

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
  `decision_id`, `command_pattern`, `reason`, and bounded `safety_metadata`.
- Approval response is rejected, invalid, duplicated after clearing, or cannot
  resume a suspended turn -> append an `approval_resolution` runtime trace row
  and info-level workspace log entry with bounded `result`, `choice`,
  `tool_name`, `call_id`, `decision_id`, `command_pattern`, and `reason` when a
  decision is available.
- Clarification response is answered, blank, duplicated after clearing, or has
  the wrong request id -> append a `clarification_resolution` runtime trace row
  and workspace log entry with bounded `result`, `request_id`, `response_chars`,
  and, when a pending clarification exists, `expected_request_id`, `tool_name`,
  and `call_id`. Do not persist raw response text in this diagnostic payload.
- Pre-tool safety hook denial -> append the same bounded `tool_execution` trace
  row used by other tool failures with `status=failed` and
  `error_kind=tool_denied_by_hook`; do not execute the underlying tool.
- Interrupted tool execution -> append the same bounded failed
  `tool_execution` trace row with `error_kind=tool_interrupted`, emit
  `tool.failed`, and re-raise the interrupt so turn-level interruption handling
  remains responsible for suspended-state recovery.
- Runtime turn is finalized as interrupted -> append a `turn_interrupted`
  runtime trace row and warning-level workspace log entry with bounded
  `session_id`, `turn_id`, `stop_reason`, `suspend_reason`, `saved_state`, and
  `message_count`.
- Runtime turn is finalized as failed by model or runtime error finalizers ->
  append a `turn_failed` runtime trace row and error-level workspace log entry
  with bounded `session_id`, `turn_id`, `stop_reason`, `phase`, `error_type`,
  and `error_path` when available.
- Streaming model request completes -> append one
  `model_stream_diagnostics` runtime trace row and info-level workspace log
  entry.
- Streaming model request yields malformed/unsupported provider events ->
  append one `model_stream_diagnostics` runtime trace row and warning-level
  workspace log entry before re-raising the original model response error.
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
- Unit or integration test for failed turn diagnostics proving `turn_failed`
  appears in runtime trace and workspace logs while existing failed-turn status
  and raw error-payload behavior remain unchanged.
- Unit tests for model stream diagnostics proving successful streams,
  malformed provider events, sink failure isolation, and non-streaming adapter
  behavior.
- Integration/runtime test proving `model_stream_diagnostics` reaches runtime
  trace and workspace logs for a streaming turn.
- Doctor unit tests for approval diagnostics summaries, including warning rows
  that include raw command patterns or secret-like reason payloads.
- Doctor unit tests for clarification diagnostics summaries, including warning
  rows whose trace payloads contain raw response/user text that must not be
  rendered.
- Doctor unit tests for tool execution diagnostics summaries, including warning
  rows whose trace payloads contain raw arguments, output, paths, or
  secret-like values that must not be rendered.
- Doctor unit tests for failed turn diagnostics summaries, including warning
  rows whose trace payloads contain raw messages, tracebacks, request payloads,
  or secret-like values that must not be rendered.
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
