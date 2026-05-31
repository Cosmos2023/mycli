# Check Results

Checked at: 2026-05-31 19:51:49 CST

## Commands

- `uv run ruff check src/mycli/domain/runtime/gateway_contract.py tests/unit/domain/runtime/test_gateway_contract.py`
  - Result: passed
- `uv run mypy src/mycli/domain/runtime/gateway_contract.py tests/unit/domain/runtime/test_gateway_contract.py`
  - Result: passed
- `uv run pytest tests/unit/domain/runtime/test_gateway_contract.py tests/unit/services/test_extension_manifest.py tests/unit/services/test_doctor_service.py::test_doctor_service_reports_local_runtime_health_without_leaking_secrets tests/unit/services/test_doctor_service.py::test_doctor_service_fails_runtime_contract_manifest_mismatch tests/unit/services/test_doctor_service.py::test_doctor_service_fails_runtime_contract_missing_payload_schema tests/unit/services/test_doctor_service.py::test_doctor_service_fails_runtime_contract_payload_schema_name_drift -q`
  - Result: passed, 12 tests
- `node --import tsx --test test/client.test.ts`
  - Result: passed, 7 tests
- `npm run typecheck`
  - Working directory: `tui/node`
  - Result: passed

## Notes

- A first attempted Node command used the wrong npm prefix from inside
  `tui/node`; the corrected package-local command passed.
- The Python manifest schema and TypeScript payload contract now expose the
  `status.changed` runtime snapshot shape.
