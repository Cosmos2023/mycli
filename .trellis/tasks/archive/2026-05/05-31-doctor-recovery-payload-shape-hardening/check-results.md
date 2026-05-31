# Check Results

Checked at: 2026-05-31 20:22:36 CST

## Commands

- `uv run pytest tests/unit/services/test_doctor_service.py::test_doctor_service_fails_session_db_malformed_suspended_turn_recovery_state tests/unit/services/test_doctor_service.py::test_doctor_service_fails_session_db_malformed_pending_decision_shape tests/unit/services/test_doctor_service.py::test_doctor_service_fails_session_db_malformed_pending_clarification_shape tests/unit/services/test_doctor_service.py::test_doctor_service_fails_unresumable_pending_approval_state tests/unit/services/test_doctor_service.py::test_doctor_service_accepts_pending_approval_with_waiting_turn_record tests/unit/services/test_doctor_service.py::test_doctor_service_accepts_pending_approval_with_rollout_history_evidence tests/unit/services/test_doctor_service.py::test_doctor_service_fails_unresumable_pending_clarification_state tests/unit/services/test_doctor_service.py::test_doctor_service_accepts_pending_clarification_with_waiting_turn_record tests/unit/services/test_doctor_service.py::test_doctor_service_accepts_pending_clarification_with_rollout_history_evidence -q`
  - Result: passed, 9 tests
- `uv run ruff check src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py`
  - Result: passed
- `uv run mypy src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py`
  - Result: passed
- `uv run pytest tests/unit/services/test_doctor_service.py -q`
  - Result: passed, 63 tests
- `uv run pytest -q`
  - Result: passed, 1177 tests

## Notes

- New tests first reproduced malformed-but-JSON-valid recovery payloads that
  doctor previously misclassified or missed.
- Doctor now validates required pending decision, pending approval, pending
  clarification, and nested tool call fields without printing raw payload
  content.
