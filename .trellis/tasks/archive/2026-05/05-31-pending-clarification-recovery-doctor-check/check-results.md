# Check Results

## Commands

- `uv run pytest tests/unit/services/test_doctor_service.py -q`
  - Red before implementation:
    `test_doctor_service_fails_unresumable_pending_clarification_state`
    failed because `sessions_db` was `ok`.
  - Green after implementation: `42 passed`.

## Notes

- The doctor check is read-only and reports bounded session ids only.
- No raw `payload_json` content is emitted in the failure message.
