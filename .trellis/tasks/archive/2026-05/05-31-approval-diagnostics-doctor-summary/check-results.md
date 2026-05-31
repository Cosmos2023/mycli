# Check Results

Checked at: 2026-05-31 17:43:42 CST

## Scope

- Read-only `approval_diagnostics` doctor check.
- Bounded trace summaries for `approval_resolution`, `approval_allowance`, and
  `approval_auto_allowed` rows.

## Verification

- `uv run pytest tests/unit/services/test_doctor_service.py -q`
  - Result: passed, 50 tests.
- `uv run ruff check src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py`
  - Result: passed.
- `uv run mypy src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py`
  - Result: passed.
- `uv run mypy src tests`
  - Result: failed on pre-existing broad test-suite typing debt unrelated to
    this slice, including untyped legacy tests and existing protocol fixture
    incompatibilities. Targeted mypy for changed files passed.

## Acceptance Criteria

- Missing traces and traces without approval rows report
  `approval_diagnostics=ok` without creating trace directories.
- Successful approval diagnostics summarize total rows, resolution rows,
  allowance rows, auto-allowed rows, and successful result counts.
- Problem approval-resolution results produce `warning` with bounded result
  counts.
- Doctor output does not print raw approval payloads, command patterns, reasons,
  user text, or secret-like values.
- Backend quality and logging specs document the new doctor check.

## Remaining Risk

- The check summarizes existing trace rows only; it does not persist new trace
  data or repair approval/session state.
- Full repository mypy remains blocked by existing type debt outside this
  slice.
