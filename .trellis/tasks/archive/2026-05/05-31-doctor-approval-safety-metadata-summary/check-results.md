# Check Results

## Passed

- `uv run pytest tests/unit/services/test_doctor_service.py::test_doctor_service_summarizes_successful_approval_diagnostics tests/unit/services/test_doctor_service.py::test_doctor_service_warns_for_problem_approval_diagnostics_without_raw_payload -q`
  - `2 passed`
- `uv run ruff check src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py`
  - `All checks passed!`
- `uv run mypy src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py`
  - `Success: no issues found in 2 source files`
- `uv run pytest tests/unit/services/test_doctor_service.py -q`
  - `63 passed`
- `uv run pytest tests/unit/services/test_safety_policy.py tests/unit/services/test_approval_service.py tests/unit/services/test_doctor_service.py tests/integration/test_turn_service.py -q`
  - `98 passed`
- `uv run pytest -q`
  - `1177 passed`
- `npm --prefix tui/node test -- --runInBand`
  - `135 passed`

## Notes

- Doctor now summarizes approval `safety_metadata` with aggregate counts only.
- Doctor output remains bounded and does not render raw command patterns,
  reasons, tool arguments, local paths, or secret-like values from nested trace
  payloads.
