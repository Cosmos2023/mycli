# Check Results

## Commands

- `uv run pytest tests/unit/services/test_doctor_service.py -q`
- `uv run ruff check src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py`
- `uv run mypy src/mycli/services/diagnostics/doctor.py`

## Result

- `46 passed in 0.33s`
- `All checks passed!`
- `Success: no issues found in 1 source file`

## Notes

- Verified missing trace directory remains read-only and reports no stream diagnostics.
- Verified successful stream diagnostics summarize count, max TTFB, max elapsed time, and total text bytes.
- Verified failed stream diagnostics report bounded failure-kind counts without raw failure messages.
