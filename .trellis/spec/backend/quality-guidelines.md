# Quality Guidelines

> Code quality standards for backend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

<!-- Patterns that should never be used and why -->

(To be filled by the team)

---

## Required Patterns

<!-- Patterns that must always be used -->

(To be filled by the team)

---

## Testing Requirements

### Scenario: Read-only Doctor Diagnostics

#### 1. Scope / Trigger
- Trigger: Any change to `mycli doctor`, local runtime diagnostics, or health
  checks for config, storage, logs, FileHistory, TUI, or MCP setup.
- The command crosses CLI, services, config, storage layout, and integration
  boundaries, but must stay outside model/runtime execution.

#### 2. Signatures
- CLI command: `mycli doctor`
- Service API:
  `DoctorService(workspace_root: Path, home_dir: Path, env: Mapping[str, str], ...).run() -> DoctorReport`
- Rendering API: `render_doctor_report(report: DoctorReport) -> tuple[str, ...]`
- Result fields: `DoctorCheck.name`, `DoctorCheck.status`,
  `DoctorCheck.message`, optional `DoctorCheck.detail`; status values are
  `ok`, `warning`, and `failed`.

#### 3. Contracts
- Doctor is read-only. It must not create config files, sessions DBs, log
  files, file-history indexes, or MCP server processes.
- Default doctor must not perform a real provider/model request.
- Output is human-readable text headed by `mycli doctor` and ending with a
  summary count.
- API keys, bearer tokens, and secret-like values must never be printed; report
  presence only, for example `api_key: present`.
- Warnings return exit code `0`; one or more failed checks return exit code `1`.

#### 4. Validation & Error Matrix
- Config resolves -> report provider, protocol, model, and base URL.
- Config parse/validation fails -> `config=failed`; keep checking other areas.
- API key missing -> `api_key=warning`.
- `~/.mycli/sessions.db` missing -> `sessions_db=warning`.
- Sessions DB exists but is not openable or lacks required tables -> failed.
- Sessions DB `schema_version` table is missing, empty, invalid, or does not
  match the current `SQLiteSessionStore.SCHEMA_VERSION` -> `sessions_db=failed`
  with expected/current version detail.
- Sessions DB local search FTS table/triggers for `conversation_messages` are
  missing -> `sessions_db=failed` with bounded object names. Doctor must not
  open the write-path store or repair the objects while checking.
- Sessions DB critical recovery rows in `session_state` for `pending_decision`,
  `suspended_turn`, `turn_record`, or `responses_continuation_state` contain
  invalid JSON, non-object JSON, or malformed nested approval/clarification
  objects -> `sessions_db=failed` with bounded `session_id:state_key`
  references. Doctor must not print raw `payload_json`.
- Sessions DB contains a `pending_decision` but no valid `suspended_turn`,
  waiting-approval `turn_record` with user message, or waiting-approval
  rollout plus matching user history item -> `sessions_db=failed` with bounded
  session ids. Doctor must not repair or clear the pending decision.
- Sessions DB contains a `suspended_turn.pending_clarification` but no non-blank
  suspended `user_message`, waiting-clarification `turn_record` with user
  message, or waiting-clarification rollout plus matching user history item ->
  `sessions_db=failed` with bounded session ids. Doctor must not repair or
  clear the suspended turn.
- Session maintenance diagnostics must not classify runtime-only sessions as
  empty. `history_items`, `turn_rollouts`, and `session_state` rows count as
  durable session content even when legacy `conversation_messages` is empty.
- `/session-maintenance` is read-only by default. Empty-session cleanup requires
  the explicit `/session-maintenance --apply-empty` form, must recompute
  candidates at apply time, and must only delete workspace-scoped sessions that
  still have no conversation messages, summaries, history items, turn rollouts,
  or session state.
- Empty-session cleanup must preserve sessions that participate in conversation
  lineage as forked children or as parents of other sessions. Lineage pruning
  requires a separate explicit policy.
- Orphan child-row cleanup requires the explicit
  `/session-maintenance --apply-orphans` form. It may delete only known child
  table rows whose `session_id` is absent from `sessions`; it must not delete
  sessions, repair lineage parent references, or run `VACUUM`.
- SQLite vacuum requires the explicit `/session-maintenance --apply-vacuum`
  form. It must report bounded before/after storage metrics, preserve sessions
  and child rows, and must not run from doctor, the default dry-run report,
  empty-session cleanup, or orphan cleanup.
- Logs or FileHistory missing -> warning, not failure.
- Reserved trace/artifact directories missing -> `storage_layout=ok`; doctor
  must not create them because runtime writers create parents lazily.
- Reserved trace/artifact path exists as a non-directory -> `storage_layout=failed`.
- Reserved trace/artifact directory exists without write bits ->
  `storage_layout=failed`.
- Trace diagnostics check:
  - Missing `~/.mycli/traces/` -> `traces=ok`; doctor must not create it.
  - Existing empty `traces/` -> `traces=ok`.
  - Existing readable `*.jsonl` trace files with valid runtime trace rows ->
    `traces=ok` with bounded file/row counts.
  - Existing trace files with invalid JSONL rows, non-object rows, or rows that
    cannot decode as runtime trace events -> `traces=warning`; runtime loading
    skips bad rows, but doctor must surface degraded diagnostics.
  - Existing trace files that cannot be opened/read -> `traces=failed`.
  - Trace doctor output must report counts and bounded file/line references, not
    raw trace payload content.
- Stream diagnostics check:
  - Missing `~/.mycli/traces/` or no `model_stream_diagnostics` trace rows ->
    `stream_diagnostics=ok` with `no stream diagnostics found`; doctor must not
    create the trace directory.
  - Successful stream diagnostics rows -> `stream_diagnostics=ok` with bounded
    stream count, failure count, max TTFB, max elapsed time, and total text
    bytes.
  - Failed stream diagnostics rows -> `stream_diagnostics=warning` with bounded
    failure-kind counts. Doctor must not print raw trace payloads or
    `failure_message` values.
- Approval diagnostics check:
  - Missing `~/.mycli/traces/` or no approval diagnostic trace rows ->
    `approval_diagnostics=ok` with `no approval diagnostics found`; doctor must
    not create the trace directory.
  - Approval diagnostic rows include `approval_resolution`,
    `approval_allowance`, and `approval_auto_allowed`.
  - Successful approval diagnostics -> `approval_diagnostics=ok` with bounded
    total, per-kind counts, and `approval_resolution` result counts.
  - Problem approval-resolution results such as `no_pending_decision`,
    `invalid_choice`, `allow_session_unavailable`, `missing_suspended_turn`, or
    unknown non-empty results -> `approval_diagnostics=warning` with bounded
    result counts. Doctor must not print raw trace payloads, command patterns,
    reasons, user text, headers, or secret-like values.
- Clarification diagnostics check:
  - Missing `~/.mycli/traces/` or no `clarification_resolution` trace rows ->
    `clarification_diagnostics=ok` with `no clarification diagnostics found`;
    doctor must not create the trace directory.
  - Successful answered rows -> `clarification_diagnostics=ok` with bounded
    total and result counts.
  - Problem clarification-resolution results such as `blank_response`,
    `no_pending_clarification`, `request_id_mismatch`, or unknown non-empty
    results -> `clarification_diagnostics=warning` with bounded result counts.
    Doctor must not print raw response text, user text, request payloads,
    provider transcript content, headers, or secret-like values.
- Tool execution diagnostics check:
  - Missing `~/.mycli/traces/` or no `tool_execution` trace rows ->
    `tool_execution_diagnostics=ok` with
    `no tool execution diagnostics found`; doctor must not create the trace
    directory.
  - Successful-only tool execution rows -> `tool_execution_diagnostics=ok`
    with bounded total/failure/interruption/denial/truncation/write-diagnostic
    counts.
  - Failed tool execution rows -> `tool_execution_diagnostics=warning` with
    bounded counts and allowlisted `error_kind` counts. Doctor must not print
    raw tool arguments, stdout, stderr, summaries, file contents, local paths,
    user text, headers, or secret-like values.
- Turn failure diagnostics check:
  - Missing `~/.mycli/traces/` or no `turn_failed` trace rows ->
    `turn_failure_diagnostics=ok` with `no turn failure diagnostics found`;
    doctor must not create the trace directory.
  - Any `turn_failed` rows -> `turn_failure_diagnostics=warning` with bounded
    total, `stop_reason`, and `phase` counts. Doctor must not print raw
    exception messages, tracebacks, provider payloads, request payloads, user
    text, tool output, headers, or secret-like values.
- Redaction diagnostics check:
  - `logs_redaction` scans `agent.log`, `errors.log`, `model-events.jsonl`,
    `model-raw/<session>/*.json`, and bounded `traces/*.jsonl` files for
    obvious unredacted secret shapes.
  - Secret findings in traces must report bounded references such as
    `traces/demo-trace.jsonl:1:$.payload.headers.Authorization`, not raw trace
    payloads or secret values.
- `errors.log` missing by itself -> OK when `agent.log`, `model-events.jsonl`,
  and `model-raw/` exist; `errors.log` is created on first warning/error.
- FileHistory `index.json` exists but cannot parse -> failed.
- MCP config load fails -> failed; do not start servers.
- Node/npm or Python TUI unavailable -> warning unless a stricter command is
  explicitly introduced later.
- Node TUI source exists but `tui/node/node_modules/.bin/tsx` is missing ->
  `node_tui_dependencies=warning` with remediation text
  `npm --prefix tui/node install`; do not create `node_modules` or run npm.
- Node-side TUI verification should run a dependency-free preflight before
  commands that import `tsx`, and should print missing markers plus the
  remediation `npm --prefix tui/node ci`.
- Node TUI source is missing -> report the existing `node_tui` warning and skip
  dependency-marker checks, because missing source is the actionable root cause.
- Runtime gateway discovery contract mismatch between `extension.manifest` and
  the advertised Python gateway RPC/event stream sets -> `runtime_contract=failed`
  with bounded missing/extra names. Doctor must not run a turn, call a model, or
  start Node to validate this contract.
- Node protocol contract mismatch between TypeScript
  `GATEWAY_EVENT_PAYLOAD_CONTRACTS` and Python manifest
  `event_streams[].payload_schema` required fields, property names, or enum
  values -> Node protocol tests fail. Keep this as a test-time cross-language
  check, not a hot-path validator.

#### 5. Good/Base/Bad Cases
- Good: `uv run mycli doctor` reports local health, redacts API keys, and exits
  `0` with only warnings.
- Good: A fresh machine without `~/.mycli/traces` or `~/.mycli/artifacts`
  reports `storage_layout=ok` without creating those directories.
- Base: A fresh machine with no prior sessions gets missing-storage warnings but
  no model request.
- Bad: Creating `traces/` or `artifacts/` just to check doctor health.
- Bad: Calling `build_turn_service()` for doctor, because that can require an
  API key and initialize runtime dependencies unrelated to diagnostics.
- Bad: Printing `sk-...` or MCP environment secret values in remediation text.

#### 6. Tests Required
- Unit test service success with config/storage/logs/history/MCP fixtures.
- Unit test warning-only conditions such as missing sessions DB and history.
- Unit test malformed critical `session_state` recovery payloads, including
  invalid JSON, non-object JSON, and nested suspended-turn approval or
  clarification payloads that cannot be recovered.
- Unit test failed MCP or storage parse/open behavior.
- Unit test storage layout reserved directories missing, present, path-conflict,
  and non-writable cases.
- Unit test trace doctor cases for missing directory, valid trace files, invalid
  rows, and bounded scan reporting.
- Unit test stream diagnostics doctor cases for missing directory, no stream
  rows, successful summary, and failed-summary redaction.
- Unit test approval diagnostics doctor cases for missing directory, no approval
  rows, successful summary, and warning-summary redaction.
- Unit test clarification diagnostics doctor cases for missing directory, no
  clarification rows, successful summary, and warning-summary redaction.
- Unit test tool execution diagnostics doctor cases for missing directory, no
  tool rows, successful summary, failed/interrupted/denied/truncated/write
  diagnostic summary, and warning-summary redaction.
- Unit test turn failure diagnostics doctor cases for missing directory, no
  failed-turn rows, warning summary, and raw message/traceback/request/secret
  redaction.
- Unit test Node TUI dependency marker OK and missing-warning cases without
  creating `node_modules`.
- Unit test session maintenance cleanup for workspace-scoped empty sessions,
  runtime-state protection, lineage protection, bounded apply limits, and CLI
  routing through `/session-maintenance --apply-empty`.
- Unit test explicit orphan child-row cleanup for multi-table orphan deletion,
  valid-row preservation, empty-session separation, and CLI/gateway routing
  through `/session-maintenance --apply-orphans`.
- Unit test explicit vacuum maintenance for before/after storage metrics,
  session preservation, cleanup-path separation, and CLI/gateway routing through
  `/session-maintenance --apply-vacuum`.
- Node protocol test for event method plus required-field, property-name, and
  enum-value parity with Python gateway contract/manifest.
- CLI test for `mycli doctor` command parsing and no secret leakage.
- Full lint, type-check, and pytest must pass because doctor touches CLI
  startup paths.

#### 7. Wrong vs Correct

Wrong:
```python
service = build_turn_service(args, cwd=cwd, home=home, env=env)
service.handle_user_turn("diagnose my setup")
```

Correct:
```python
report = DoctorService(workspace_root=cwd, home_dir=home, env=env).run()
for line in render_doctor_report(report):
    output_func(line)
```

### Scenario: Cache-aware Runtime Diagnostics

#### 1. Scope / Trigger
- Trigger: Any runtime safety, diagnostics, observability, checkpoint, rollback, or tool-effect feature that records metadata around tool execution.
- These features are cross-layer because data can move through tool execution, turn item metadata, trace payloads, provider transcript messages, and request-shape hashing.

#### 2. Signatures
- `ToolExecutionService(..., write_diagnostics_runner: Callable[[tuple[str, ...]], dict[str, object]] | None = None)`
- `WriteDiagnosticsService(workspace_root: Path).run(paths: tuple[str, ...]) -> dict[str, object]`
- Trace event kind remains `tool_execution`.

#### 3. Contracts
- Allowed cache-volatile/local fields:
  - turn item metadata such as `write_diagnostics`
  - trace payload fields such as `write_diagnostics_count` and `write_diagnostics_error`
  - post-execution tool result `raw_payload` fields
- Forbidden stable-surface changes unless the actual user-visible contract changes:
  - stable system prompt text
  - model-visible `ToolSpec`
  - deterministic tool ordering
  - previous provider transcript messages
- Diagnostic failures are best-effort: they may record an error string but must not convert a successful write into a failed write.

#### 4. Validation & Error Matrix
- Successful structured file write -> run bounded diagnostics for changed paths.
- Failed validation or failed tool execution -> do not run diagnostics.
- No-op write -> do not run diagnostics.
- Diagnostic runner exception -> record diagnostic error; preserve original tool success.
- Missing diagnostic runner -> preserve existing behavior.
- Checkpoint/guardrail exit -> append a local `guardrail` trace event with bounded trigger diagnostics.

#### 5. Good/Base/Bad Cases
- Good: `Write` succeeds, `write_diagnostics` appears in turn metadata and trace count is available.
- Base: No diagnostic runner is configured and tool execution output is unchanged.
- Bad: A diagnostic warning is inserted into stable system instructions or model-visible tool schema.

#### 6. Tests Required
- Unit test successful write diagnostics metadata and trace payload.
- Unit test failed validation and no-op write skip diagnostics.
- Unit test diagnostic exceptions do not fail the write.
- Unit test interrupted tool execution emits failed lifecycle/trace diagnostics,
  discards pending file-history snapshots, and re-raises the interrupt for
  turn-level recovery.
- Unit test guardrail trace payloads for checkpoint exits.
- Request-shape regression proving diagnostic metadata does not change stable system hash, tool schema hash, tool order hash, or replay hash when transcript content is unchanged.

#### 7. Wrong vs Correct

Wrong:
```python
contract.base_instructions += f"\nLatest diagnostics: {diagnostics}"
```

Correct:
```python
raw_payload = {**result.raw_payload, "write_diagnostics": diagnostics}
```

Keep runtime diagnostics appended after execution and outside stable request-shape inputs.

---

### Scenario: Cache-aware Session Storage Layout

#### 1. Scope / Trigger
- Trigger: Any runtime persistence, trace, log, artifact, or session lifecycle feature that writes under the user-level `.mycli` home.
- This is cache-sensitive because local persistence must not change stable prompt construction or provider transcript replay.

#### 2. Signatures
- `MycliStorageLayout.from_home_dir(home_dir: Path) -> MycliStorageLayout`
- `MycliStorageLayout.trace_path(session_id: str) -> Path`
- `MycliStorageLayout.legacy_trace_path(session_id: str) -> Path`
- `TraceService(home_dir: Path).append(session_id: str, event: RuntimeTraceEvent) -> None`
- `TraceService(home_dir: Path).load(session_id: str) -> tuple[RuntimeTraceEvent, ...]`

#### 3. Contracts
- Preferred user-home layout:
  - `~/.mycli/sessions.db` remains the session DB path.
  - `~/.mycli/traces/{session_id}-trace.jsonl` is the preferred trace path.
  - `~/.mycli/sessions/{session_id}-trace.jsonl` is legacy read-only fallback for traces.
  - `~/.mycli/artifacts/` is reserved for non-transcript payload artifacts.
  - `~/.mycli/logs/` is reserved for operational logs.
- Trace payloads are local diagnostics only. They must not be used to rebuild provider transcript messages.
- Trace payloads must store bounded previews for full-content fields such as nested `metadata.raw_payload.content` and `metadata.transcript_content`.

#### 4. Validation & Error Matrix
- Valid session ID -> append/read trace normally.
- Empty, placeholder-like, path-like, or traversal-like session ID -> raise `ValueError`; do not create a trace file.
- New trace file exists -> load from `traces/`.
- No new trace file and legacy trace exists -> load from `sessions/`.
- Corrupt JSONL row -> skip row and keep loading valid trace events.

#### 5. Good/Base/Bad Cases
- Good: `TraceService.append("demo", event)` writes `.mycli/traces/demo-trace.jsonl` and stores content previews/counts.
- Base: A user with old `.mycli/sessions/demo-trace.jsonl` can still inspect trace output.
- Bad: Creating `.mycli/sessions/<session>-trace.jsonl` or dumping full file content into a `turn_item` trace event.

#### 6. Tests Required
- Unit test new trace writes go to `traces/`, not `sessions/`.
- Unit test legacy trace fallback from `sessions/`.
- Unit test invalid session ID rejection.
- Unit test trace payload sanitization for `raw_payload.content` and `transcript_content`.
- Runtime/CLI trace rendering tests should continue to pass without provider-facing request-shape changes.

#### 7. Wrong vs Correct

Wrong:
```python
path = home_dir / ".mycli" / "sessions" / f"{session_id}-trace.jsonl"
handle.write(json.dumps(event.to_dict()))
```

Correct:
```python
layout = MycliStorageLayout.from_home_dir(home_dir)
path = layout.trace_path(session_id)
handle.write(json.dumps(sanitized_trace_payload))
```

Keep storage layout centralized and treat trace files as bounded diagnostics, not as a second full transcript store.

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)
