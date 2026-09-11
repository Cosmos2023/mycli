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
- Slash command: `/trace export` renders `TurnService.export_trace_jsonl()` with
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
  - `../traces/<safe-session-id>-trace.jsonl`: bounded runtime-only diagnostic
    rows consumed by `/trace` and `trace.export`.
- Per-session runtime trace JSONL rotates at 5 MiB to one `.1` backup before
  appending the next sanitized row. Trace inspection reads only the active file,
  so it remains bounded even after high-frequency provider/tool diagnostics.
- `agent.log`, `errors.log`, and `model-events.jsonl` use size-based rotation
  from `WorkspaceLogService` before append. The default active-file cap is
  5 MiB with 3 numbered backups (`.1`, `.2`, `.3`). Rotation is per file, has
  no time dimension, and does not apply to `model-raw/<session>/*.json`
  payloads.
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
- ExecPolicy diagnostics are local runtime policy evidence. They may include
  only bounded rule metadata such as decision, source, rule index, pattern
  hash, pattern length, and shell argument count. They must not include raw
  command text, raw rule pattern tokens, raw argument values, stdout/stderr,
  file contents, headers, or secret-like values.
- Shell runtime enforcement diagnostics are local runtime evidence. They may
  include bounded filesystem/network/shell lanes, env policy, env key names,
  timeout caps, output limits, and cwd. They must not include raw environment
  values, raw command text, raw arguments, stdout/stderr bodies, file contents,
  headers, or secret-like values.
- Shell process lifecycle diagnostics are local runtime evidence. Background
  shell registry, `BashOutput`, `KillShell`, doctor, and lifecycle trace rows may
  include bounded fields such as shell id, process state, terminal state,
  command hash, command length, sanitized command pattern, timeout, cwd,
  output character counters, truncation flags, and cleanup result. They must not
  include raw command text, raw environment values, raw arguments,
  stdout/stderr bodies, file contents, headers, provider payload bodies, or
  secret-like values.
- Shell backend diagnostics are local runtime evidence. They may include backend
  id, availability, isolation label, and bounded capability booleans such as
  background and interrupt-cleanup support. They must not include raw command
  text, raw environment values, stdout/stderr bodies, file contents, headers,
  provider payload bodies, or secret-like values.
- Background job diagnostics are local runtime evidence. They may include job
  id, owner kind, lifecycle state, owner turn id, started/completed/last-event
  timestamps, timeout seconds, terminal summary, and output character counts.
  They must not include raw commands, raw prompts, raw sub-agent reports, raw
  tool output bodies, environment values, headers, provider payload bodies, or
  secret-like values.
- Sandbox policy diagnostics are local runtime evidence. They may include only
  bounded policy names, decision/reason codes, sandbox lanes, argument keys and
  counts, and effect summary fields (`filesystem`, `network`, `process`). They
  must not include raw argument values, raw command text, raw URLs,
  stdout/stderr previews or bodies, file contents, headers, provider payload
  bodies, or secret-like values.
- Shell `tool_execution` trace rows may expose argument key/count metadata and
  output character/truncation counters only. They must redact argument values
  and set stdout/stderr previews to empty even when the underlying tool result
  contains command text or output bodies for transcript rendering.
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
- Approval recovery diagnostics may append local `approval_recovery` trace rows
  and workspace log entries when runtime rebuilds a pending approval from
  structured suspended-turn state or detects unrecoverable approval state.
  Payloads may include bounded result/status fields, state booleans, tool name,
  call id, option count, and command pattern presence. They must not include raw
  command text, raw tool arguments, raw user prompts, raw tool output, headers,
  provider payload bodies, or secrets.
- Clarification resolution diagnostics may append local
  `clarification_resolution` trace rows and workspace log entries for answered,
  blank, no-pending, or request-id-mismatch clarification responses. Payloads
  may include bounded request/tool identifiers and `response_chars`, but must
  not include raw user response text or provider transcript content.
- Interrupted turn diagnostics append local `turn_interrupted` trace rows and
  warning-level workspace log entries after suspended runtime state is saved.
  These diagnostics explain that resume state exists; they must not be used as
  provider transcript content.
- Accepted gateway interrupt requests append local `turn_interrupt_requested`
  trace rows and warning-level workspace log entries before any later runtime
  finalization. These diagnostics explain that control-plane interruption was
  requested; they must not include raw user messages, provider payloads, tool
  output, headers, or secrets.
- Failed turn diagnostics append local `turn_failed` trace rows and error-level
  workspace log entries from runtime failure finalizers. Payloads include
  bounded failure taxonomy fields such as `stop_reason`, `phase`, `error_type`,
  and optional `error_path`; they must not include raw exception messages,
  tracebacks, provider payloads, user text, tool output, headers, or
  secret-like values.
- Model stream diagnostics append local `model_stream_diagnostics` trace rows
  and workspace log entries after each real streaming model request attempt.
  Retries therefore produce separate rows with increasing `attempt` values.
  Payloads include bounded operational counters such as `ttfb_ms`, `ttft_ms`,
  average `tbt_ms`, `max_tbt_ms`, text-delta interval count, `elapsed_ms`,
  provider/reasoning/text/state/tool/usage/completed event counts, UTF-8
  `reasoning_bytes`/`text_bytes`, `success`, and optional canonical failure kind.
  TBT is derived only from intervals between consecutive non-empty text deltas;
  a stream with fewer than two non-empty text deltas omits TBT. These diagnostics
  are local observability only and must not alter provider-visible transcript
  content.
- Completion-tail fields are optional, finite milliseconds bounded to 24 hours:
  `last_text_delta_ms`, `response_terminal_ms`, `sdk_terminal_ms`,
  `completed_event_ms`, and `stream_settled_ms` are offsets from the attempt's
  monotonic start. `terminal_persist_ms` is the duration of committing the
  terminal attempt update (including Worker acknowledgement); `text_tail_ms`
  spans the last nonempty text delta through diagnostic finalization. Fields
  reset on retry. Missing observations are omitted, never synthesized as zero.
- Worker execution opts into completion timings with `streamDiagnosticsVersion: 1`.
  An absent version selects the fixed pre-timing diagnostic field allowlist, so
  an in-memory older coordinator can accept a newly loaded Worker after a rebuild.
  Do not add new diagnostic fields to a negotiated version without a compatibility
  decision; TypeScript optionality does not relax an older strict wire parser.
- Diagnostic delivery remains advisory across Worker RPC. Validate message size,
  the exact envelope, request/lease/generation identity, and contiguous sequence
  before considering its payload. Invalid advisory content is dropped without
  publishing raw data or failing a provider result, and its received sequence is
  consumed. Invalid envelopes or fences, and invalid event/result/attempt data,
  remain fatal. A sender advances its sequence only after validation and sending,
  so a contained diagnostic serialization failure cannot create a sequence gap.
- `ModelProvider.stream` accepts optional `onPhase(response_terminal | sdk_terminal)`.
  Pi-ai observes the first parsed terminal SSE event before delivering it to the
  SDK, and SDK `done`/`error` before canonical normalization. Chat may complete at
  a valid clean EOF. Native/non-SSE routes retain SDK/runtime timing but omit
  unobservable transport timing. Callback failures cannot change outcomes.
  The transport offset is observation at the body-reader boundary, not socket
  arrival; buffered frames can place it before the SDK's last text delta.
- Successful turn completion also emits `turn_completion_diagnostics` with
  `commit_ms`, `continuation_ms`, `snapshot_ms`, `publish_ms`, `elapsed_ms`, and
  `snapshot_written`. Durations cover synchronous canonical terminalization,
  continuation persistence, awaited snapshot work, and terminal event emission,
  respectively. Publication is measured at the runtime callback, not client
  receipt/rendering. The event is published after the completion notification
  and before auxiliary memory work; it never changes completion ordering.
- Failed model attempts also retain bounded `retryable`, `retry_after_seconds`,
  `additional_details`, `status`, `request_id`, `provider_error_code`, `provider_error_type`,
  `transport_error_code`, `transport_error_name`, and `error_source` (`http`, `response_stream`, or
  `transport`). The detail is the same sanitized public reason, not an exception message or raw body.
  Both trace writes and reads apply this allowlist; legacy rows without these fields remain valid.
  The attempt's original failure stays intact even if the final turn becomes `retry_exhausted`.
- Tool execution diagnostics append local `tool_execution` rows at the actual
  execution terminal boundary. Payloads contain only bounded call/tool ids,
  duration, success, model-output character count, truncation state, and optional
  failure kind. They must not contain tool arguments, summaries, paths, file
  contents, stdout/stderr, or model-output bodies.
- Compaction diagnostics append local `compaction` rows for automatic pre-turn,
  mid-turn, context-overflow, and explicit `/compact` attempts. Payloads contain source/status,
  before/after/max token counts, and duration only. Compaction summaries and
  rehydrated file content are forbidden.
- Subagent lifecycle diagnostics append local `subagent_lifecycle` rows for
  started and terminal child states. Payloads contain bounded child thread id,
  status, and wall-clock duration only. Prompts, progress summaries, reports,
  mailbox content, and provider output are forbidden.
- Runtime diagnostic callbacks and local trace writes are best-effort. A sink
  failure must be swallowed at the diagnostic boundary and must not fail a
  provider request, tool, compaction, subagent, turn, or Worker lease.
- Runtime diagnostic rows must never be written to canonical session SQLite,
  provider replay/model-input ledgers, gateway live events, or TUI transcript
  projections. They are available only through local logs and explicit trace
  inspection/export.
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
- Configured local hooks append `hook_execution` trace rows with bounded
  payload fields: `execution_id`, `hook_id`, `hook_name`, `hook_point`,
  `status`, `action`, `duration_ms`, optional `exit_code`, output character
  counts, and sanitized message. These rows must not include raw hook stdin,
  raw tool arguments, file content, inherited environment, full stdout/stderr,
  or full command output.
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

- Optional provider timing is absent -> omit it through Worker parsing and trace export.
- Invalid timing (negative, nonfinite, nonnumeric, or over 24 hours) -> Worker
  rejects the frame; trace readers/writers drop the field. Unknown raw content
  is never serialized. Older traces remain readable without the new fields.
- Timing observer throws -> preserve the provider/turn outcome and cleanup.
- Truncated stream or cancellation without a terminal -> do not fabricate a
  transport/SDK terminal observation. Stream settlement still measures cleanup.
- `logs_root=None` -> write under `<workspace_root>/log`.
- `logs_root=<home>/.mycli/logs` -> write global operational logs under that
  directory and raw payloads under `model-raw/<session>/`.
- Session IDs containing path separators or unsafe characters -> sanitize for
  paths, but keep the original value in the visible log tag.
- Missing log files during `/logs` inspection -> return paths and no tail lines;
  do not raise.
- Warning/error event -> append to both `agent.log` and `errors.log`.
- A log append that would exceed the active file cap -> rotate numbered
  backups before writing the redacted line. Backup count `0` truncates the
  active file on overflow without retaining backups.
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
- Gateway accepts `turn.interrupt` while a turn is running -> append a
  `turn_interrupt_requested` runtime trace row and warning-level workspace log
  entry with bounded `session_id`, `client_turn_id`, `requested`, and `source`.
- Runtime turn is finalized as failed by model or runtime error finalizers ->
  append a `turn_failed` runtime trace row and error-level workspace log entry
  with bounded `session_id`, `turn_id`, `stop_reason`, `phase`, `error_type`,
  and `error_path` when available.
- Streaming model request completes -> append one
	`model_stream_diagnostics` runtime trace row and info-level workspace log
	entry.
- Streaming model request is retried -> append one terminal diagnostic for the
	failed attempt before retry backoff and a separate diagnostic for each later
	real provider request; do not count the backoff itself as an attempt.
- Streaming model request yields malformed/unsupported provider events ->
  append one `model_stream_diagnostics` runtime trace row and warning-level
  workspace log entry before re-raising the original model response error.
- Ordinary safe auto approval -> do not emit `approval_auto_allowed`, because no
  prior user allowance was consumed.
- `/trace export` -> return bounded sanitized JSONL rows from the current
  session trace without mutating trace files.
- `trace.export` -> return the same bounded sanitized JSONL rows as raw row
	strings, not prefixed command output.
- Diagnostic sink or trace append fails -> preserve the original runtime result
	and do not emit a gateway/TUI error for the observability failure.

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

- Fake-clock provider tests separate terminal delivery, SDK normalization,
  iterator cleanup and attempt persistence on failure and retry. SSE tests
  cover terminal success/error, missing terminals, clean Chat EOF, delayed
  remote cancellation acknowledgement, and throwing timing observers.
- Fake-clock turn tests hold snapshot persistence open, retain existing
  completion ordering, and measure publication separately from snapshot work.
- Worker round trips accept each optional timing field and reject invalid
  values. Backend Worker/loopback-SSE tests export real timing rows; trace
  write/read tests verify allowlisting and no model-visible history changes.
- Unit test global and compatibility log roots.
- Unit test `agent.log`, `errors.log`, `model-events.jsonl`, and
  `model-raw/<session>/` paths.
- Unit test text and nested JSON redaction.
- Unit test `set_session_id()` / runtime `rebind_session()` changes the active
  log tag and raw payload bucket.
- CLI/REPL tests for `/logs` help, completion, and command routing.
- CLI/REPL tests for `/trace export` completion, command routing, and JSONL
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
  malformed provider events, retry-attempt separation, TTFB/TTFT/TBT timing,
  UTF-8 byte counts, sink failure isolation, and non-streaming adapter behavior.
- Worker RPC tests must accept bounded stream diagnostic frames and reject
  unknown fields, negative/non-finite values, and unknown failure kinds.
- Runtime tests must cover provider, tool, and compaction diagnostic projection
  without copying tool content into the diagnostic payload.
- Integration/runtime test proving `model_stream_diagnostics` reaches runtime
  trace and workspace logs for a streaming turn without entering the transcript.
- Integration tests must cover explicit `/compact`, subagent started/terminal
  diagnostics, sensitive-field allowlisting, and per-session trace rotation.
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
```typescript
const logsRoot = join(homeDir, ".mycli", "logs", sessionId);
const logger = createWorkspaceLogger({ workspaceRoot, logsRoot });
```

Correct:
```typescript
const logsRoot = join(homeDir, ".mycli", "logs");
const logger = createWorkspaceLogger({ workspaceRoot, logsRoot, sessionId });
```

Wrong:
```typescript
await writeJson(path, providerPayload);
```

Correct:
```typescript
await writeJson(path, redactPayload(providerPayload));
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
