# Doctor Trace Current State

## Existing Doctor Behavior

- `DoctorService.run()` currently aggregates config, sessions DB, logs, storage layout, file history, TUI, and MCP checks.
- Doctor checks are service-level and read-only; they report `DoctorCheck` records rendered by `render_doctor_report()`.
- The storage layout check already validates reserved `traces/` and `artifacts/` paths:
  - missing reserved directories are OK;
  - path conflicts are failed;
  - existing non-writable directories are failed.

## Existing Trace Behavior

- `TraceService.append(session_id, event)` writes to `MycliStorageLayout.trace_path(session_id)`, which resolves to `~/.mycli/traces/{session_id}-trace.jsonl`.
- `TraceService.load(session_id)` prefers the new `traces/` path and falls back to legacy `~/.mycli/sessions/{session_id}-trace.jsonl` only when the new file is missing.
- Trace loading skips corrupt JSONL rows, non-object payloads, and invalid runtime trace payloads.
- `RuntimeTraceEvent.from_dict()` requires `kind` and `turn_id`; `payload` defaults to `{}` when not a dict.

## Design Choice

The doctor trace check should mirror loader tolerance without hiding diagnostics:

- Missing `traces/` is OK to avoid warning on fresh installs.
- Invalid rows are warnings, not failures, because runtime loading skips them and valid rows remain usable.
- Open/read errors are failures because the local diagnostics cannot be inspected.
- Output should include only counts and bounded file/line references, not raw trace payloads.

## Relevant Specs

- `.trellis/spec/backend/quality-guidelines.md`
- `.trellis/spec/backend/logging-guidelines.md`
- `.trellis/spec/backend/database-guidelines.md`
