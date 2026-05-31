# Check Results

## Verification

- `node --import tsx --test test/client.test.ts`
  - Passed: `7 passed`
- `uv run pytest tests/unit/domain/runtime/test_gateway_contract.py tests/unit/services/test_extension_manifest.py -q`
  - Passed: `7 passed`
- `node --import tsx --test test/client.test.ts test/protocol.test.ts test/reducer.test.ts`
  - Passed: `40 passed`
- `npm --prefix tui/node run typecheck`
  - Passed
- `uv run ruff check tests/unit/domain/runtime/test_gateway_contract.py tests/unit/services/test_extension_manifest.py`
  - Passed
- `npm --prefix tui/node test`
  - Passed: `133 passed`
- `uv run pytest tests/unit/services/test_doctor_service.py::test_doctor_service_reports_local_runtime_health_without_leaking_secrets tests/unit/services/test_doctor_service.py::test_doctor_service_fails_runtime_contract_manifest_mismatch tests/unit/services/test_doctor_service.py::test_doctor_service_fails_runtime_contract_missing_payload_schema tests/unit/services/test_doctor_service.py::test_doctor_service_fails_runtime_contract_payload_schema_name_drift -q`
  - Passed: `4 passed`

## Notes

- Two attempted `pytest` commands referenced non-existent doctor test names.
  They were command-selection mistakes; the existing runtime contract doctor
  tests listed above were run successfully.
