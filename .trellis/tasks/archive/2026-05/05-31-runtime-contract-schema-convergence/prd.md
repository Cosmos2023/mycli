# PRD: Runtime Contract Schema Convergence

## Summary

Strengthen the Hermes-like runtime/TUI gateway contract by adding machine-readable event payload schema discovery to the extension manifest and doctor validation.

## Requirements

1. Python runtime contract code exposes payload schemas for every supported gateway event stream.
2. `extension.manifest.event_streams` includes a `payload_schema` object for each event stream.
3. `mycli doctor` validates that manifest event schema names match supported event streams and that every event stream has an object payload schema.
4. Unit tests cover:
   - manifest event stream schemas exist for all supported events
   - key Hermes-like events expose meaningful required fields
   - doctor fails when an advertised event is missing `payload_schema`
   - doctor fails when schema/event names diverge
5. Runtime behavior remains backward compatible. Existing event names, RPC method names, and capabilities are not removed.

## Non-goals

- Do not implement full JSON Schema validation of runtime events.
- Do not generate TypeScript types from Python schemas in this slice.
- Do not productize MCP, skills, subagent/multi-agent, or ACP.
- Do not merge to `main`.

## Acceptance

- `uv run pytest tests/unit/services/test_extension_manifest.py tests/unit/services/test_doctor_service.py tests/unit/cli/node_tui/test_gateway.py -q` passes.
- `npm --prefix tui/node test -- client.test.ts` or the full Node test suite passes for event-name consistency.
- `npm --prefix tui/node run typecheck` passes if TypeScript protocol files are touched.
- `uv run ruff check src/mycli/domain/runtime/gateway_contract.py src/mycli/services/extensions/manifest.py src/mycli/services/diagnostics/doctor.py tests/unit/services/test_extension_manifest.py tests/unit/services/test_doctor_service.py` passes.
- Trellis task is archived and the slice is committed on the feature branch only.
