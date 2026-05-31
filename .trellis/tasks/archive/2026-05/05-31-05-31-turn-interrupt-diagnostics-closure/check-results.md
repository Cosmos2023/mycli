# Check Results

## Verification

- Focused interrupt diagnostics tests:
  - `uv run pytest tests/unit/cli/node_tui/test_gateway.py::test_gateway_turn_interrupt_reports_running_state tests/unit/cli/node_tui/test_gateway.py::test_gateway_turn_interrupt_keeps_fake_services_without_diagnostic_hook_compatible tests/unit/application/test_agent_runtime.py::test_turn_service_records_turn_interrupt_request_diagnostics tests/unit/services/test_doctor_service.py::test_doctor_service_reports_missing_turn_interrupt_diagnostics_as_ok tests/unit/services/test_doctor_service.py::test_doctor_service_summarizes_turn_interrupt_diagnostics_without_raw_payload -q`
  - Passed: 5 tests.
- `uv run ruff check src/mycli/application/turn_service.py src/mycli/cli/node_tui/gateway.py src/mycli/services/diagnostics/doctor.py tests/unit/cli/node_tui/test_gateway.py tests/unit/application/test_agent_runtime.py tests/unit/services/test_doctor_service.py`
  - Passed.
- `uv run mypy src/mycli/application/turn_service.py src/mycli/cli/node_tui/gateway.py src/mycli/services/diagnostics/doctor.py`
  - Passed.
- `uv run pytest tests/unit/cli/node_tui/test_gateway.py tests/unit/application/test_agent_runtime.py tests/unit/services/test_doctor_service.py tests/integration/test_node_tui_gateway.py::test_run_node_tui_gateway_with_real_node_scripted_client_interrupted_turn -q`
  - Passed: 194 tests.
- `npm --prefix tui/node run typecheck`
  - Passed.
- `uv run pytest -q`
  - Passed: 1196 tests.
- `npm --prefix tui/node test -- --runInBand`
  - Passed: 135 tests.

## Acceptance

- Accepted running-turn interrupts record `turn_interrupt_requested` trace rows.
- Accepted running-turn interrupts write bounded workspace log diagnostics.
- Idle interrupts remain `{"interrupted": false}` and do not record diagnostics.
- Gateway remains compatible with fake services that lack initialized runtime
  diagnostics.
- Doctor reports `turn_interrupt_diagnostics` summary without raw payloads.
- Existing Node scripted interrupted-turn smoke still passes.
