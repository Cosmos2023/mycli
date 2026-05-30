# Doctor Trace Diagnostics

## Problem

`TraceService` now writes runtime trace JSONL files under `~/.mycli/traces/` with a legacy read fallback under `~/.mycli/sessions/`. Existing `mycli doctor` checks config, session DB, logs, storage layout, file history, TUI, and MCP, but it does not inspect existing trace files. A user can therefore have corrupt or unreadable trace diagnostics without `doctor` surfacing the issue.

## Goal

Add a read-only `mycli doctor` check for existing trace JSONL files so local runtime diagnostics are easier to troubleshoot without mutating user storage.

## Requirements

- Add a `traces` doctor check to `DoctorService.run()`.
- Missing `~/.mycli/traces/` must be `ok`, because trace writers create the directory lazily.
- An existing empty `traces/` directory must be `ok`.
- Existing readable `*.jsonl` trace files with valid trace rows must be `ok` and report bounded counts.
- Existing trace files with invalid JSONL rows, non-object rows, or rows that cannot be decoded as `RuntimeTraceEvent` must be `warning`, because `TraceService.load()` skips corrupt rows but users should be told diagnostics are degraded.
- Existing trace files that cannot be opened/read must be `failed`.
- The check must not create files or directories, start runtime/model execution, read legacy traces by default, or dump raw trace content in output.
- Keep details bounded so large trace directories do not produce unbounded doctor output.

## Non-Goals

- Do not change trace write/load semantics.
- Do not scan provider logs or model raw payloads.
- Do not add FTS, session search, or runtime contract changes in this slice.

## Acceptance

- Unit tests cover missing traces directory, valid trace files, invalid rows, and bounded scan reporting.
- `uv run pytest tests/unit/services/test_doctor_service.py` passes.
- `uv run ruff check src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py` passes.
- `uv run mypy src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py` passes.
- `git diff --check` passes.
