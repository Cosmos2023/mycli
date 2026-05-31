# Check Results

Date: 2026-05-31

## Passed

- `uv run pytest tests/unit/services/test_doctor_service.py -q`
  - Result: `23 passed in 0.10s`
- `uv run pytest tests/unit/services/test_doctor_service.py tests/unit/services/test_workspace_log_service.py -q`
  - Result: `30 passed in 0.09s`
- `uv run ruff check src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py`
  - Result: `All checks passed!`
- `uv run mycli doctor`
  - Result: exited `0`
  - Redaction check: `[OK] logs_redaction: scanned 10 log file(s) for obvious secrets`

## Behavior Evidence

- Clean redacted logs report `logs_redaction=ok`.
- A leaked API key in `agent.log` reports `logs_redaction=failed` without
  printing the secret.
- A leaked nested token in `model-raw/**/*.json` reports
  `logs_redaction=failed` without printing the secret.
- Missing logs directory does not create a separate redaction failure.
- Bounded scanning covers human logs, model events JSONL, and a limited number
  of raw model payload files.

## Residual Risk

- This slice detects likely leaked secrets but does not repair, redact in place,
  rotate, or delete unsafe logs.
- The scanner is intentionally pattern-based and bounded; it is not a complete
  secret detection engine.
