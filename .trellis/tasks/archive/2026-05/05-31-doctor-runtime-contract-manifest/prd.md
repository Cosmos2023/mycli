# Doctor Runtime Contract Manifest

## Problem

`mycli doctor` checks local config, session DB, logs, storage, traces, file
history, TUI dependencies, and MCP config, but it does not validate that the
runtime gateway discovery contract is internally consistent.

The extension manifest is a key foundation surface for Node TUI, extension, and
future ACP clients. Doctor should be able to catch a broken or stale manifest
without requiring a real runtime turn.

## Scope

In scope:

- Add a read-only `runtime_contract` doctor check.
- Validate that `ExtensionManifestService.manifest()` advertises exactly the
  gateway-supported RPC methods and event streams.
- Validate that key Hermes-like runtime event streams are present.
- Add doctor unit tests for healthy and inconsistent manifests.

Out of scope:

- Changing gateway event behavior.
- Changing extension manifest schema.
- Productizing MCP, skills, subagent/multi-agent, or ACP.
- Running Node, npm, model calls, or runtime turns from doctor.

## Requirements

- Healthy manifest/gateway contract reports `runtime_contract=ok`.
- Missing or extra RPC/event names report `runtime_contract=failed` with bounded
  names.
- Missing key Hermes-like streams report `runtime_contract=failed`.
- Doctor output must remain human-readable and must not dump full manifest JSON.

## Acceptance Criteria

- `uv run pytest tests/unit/services/test_doctor_service.py -q` passes.
- `uv run pytest tests/unit/services/test_extension_manifest.py tests/unit/cli/node_tui/test_gateway.py::test_extension_manifest_advertises_only_supported_gateway_methods tests/unit/cli/node_tui/test_gateway.py::test_extension_manifest_advertises_only_supported_event_streams -q` passes.
- `uv run ruff check src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py` passes.
- Trellis task is archived and committed.
