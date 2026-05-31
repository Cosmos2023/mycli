# Check Results

## Commands

- `npm --prefix tui/node test -- client.test.ts`
  - Red before implementation: failed because
    `GATEWAY_EVENT_PAYLOAD_CONTRACTS` was not exported.
  - Green after implementation: `128` Node tests passed.
- `npm --prefix tui/node run typecheck`
  - Green after implementation.
- `uv run pytest tests/unit/services/test_extension_manifest.py tests/unit/services/test_doctor_service.py::test_doctor_service_fails_runtime_contract_manifest_mismatch tests/unit/services/test_doctor_service.py::test_doctor_service_fails_runtime_contract_missing_payload_schema tests/unit/services/test_doctor_service.py::test_doctor_service_fails_runtime_contract_payload_schema_name_drift tests/unit/cli/node_tui/test_gateway.py::test_extension_manifest_advertises_only_supported_gateway_methods tests/unit/cli/node_tui/test_gateway.py::test_extension_manifest_advertises_only_supported_event_streams -q`
  - Green after implementation: `9 passed`.

## Notes

- The new TypeScript contract map is a test-time bridge against Python
  `ExtensionManifestService().manifest()`, not a runtime validator.
- This keeps Hermes-like event contract parity moving by making Python/Node
  required-field drift fail in the Node gate.
