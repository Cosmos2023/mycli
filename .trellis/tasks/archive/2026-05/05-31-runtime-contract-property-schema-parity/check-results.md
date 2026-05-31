# Check Results

## Red

- `npm --prefix tui/node test -- client.test.ts`
  - Failed before implementation because `GATEWAY_EVENT_PAYLOAD_CONTRACTS`
    did not expose `properties` or enum metadata.

## Green

- `npm --prefix tui/node test -- client.test.ts`
  - Passed.
- `npm --prefix tui/node test`
  - Passed: 128 tests.
- `npm --prefix tui/node run typecheck`
  - Passed.
- `uv run pytest tests/unit/services/test_extension_manifest.py tests/unit/services/test_doctor_service.py::test_doctor_service_fails_runtime_contract_manifest_mismatch tests/unit/services/test_doctor_service.py::test_doctor_service_fails_runtime_contract_missing_payload_schema tests/unit/services/test_doctor_service.py::test_doctor_service_fails_runtime_contract_payload_schema_name_drift tests/unit/cli/node_tui/test_gateway.py::test_extension_manifest_advertises_only_supported_gateway_methods tests/unit/cli/node_tui/test_gateway.py::test_extension_manifest_advertises_only_supported_event_streams -q`
  - Passed: 9 tests.

## Notes

- This slice intentionally keeps schema parity as a test-time contract, not a
  hot-path runtime validator.
