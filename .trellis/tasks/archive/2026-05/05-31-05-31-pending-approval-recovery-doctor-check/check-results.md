# Check Results

## Commands

- `uv run pytest tests/unit/services/test_doctor_service.py -q`
- `uv run ruff check src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py`

## Result

- 39 doctor tests passed.
- Ruff passed.

## Acceptance Evidence

- Doctor fails when `pending_decision` has no valid resume evidence.
- Doctor accepts explicit valid `suspended_turn` state via existing recovery
  payload checks.
- Doctor accepts waiting approval `turn_record` with user message.
- Doctor accepts waiting approval rollout with matching user history item.
- Diagnostic output reports bounded session ids and does not print raw
  `payload_json`.
