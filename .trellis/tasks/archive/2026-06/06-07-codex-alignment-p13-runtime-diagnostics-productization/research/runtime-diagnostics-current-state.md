# Runtime Diagnostics Current State

## Read Sources

- `docs/parity/codex-alignment-phases-p9-p13.md`
- `.trellis/spec/backend/quality-guidelines.md`
- `.trellis/spec/backend/context-management-contract.md`
- `src/mycli/application/runtime/request/provider_request_dry_run.py`
- `src/mycli/application/runtime/tools/runtime_policy.py`
- `src/mycli/domain/runtime/execution_policy.py`
- `src/mycli/services/diagnostics/doctor.py`
- `src/mycli/application/turn_service.py`
- `evaluation/provider_cache_policy_smoke.py`
- `tests/unit/services/test_provider_payload_snapshot.py`
- `tests/unit/application/test_tool_execution_service.py`
- `tests/unit/services/test_doctor_service.py`

## Existing Runtime Diagnostics

- Runtime policy:
  - trace kind `runtime_policy_decision`;
  - payload includes bounded `decision`, `policy`, `risk_level`, argument key/count, and `sandbox`;
  - doctor check `runtime_policy_diagnostics` summarizes allowed / needs_approval / denied counts.
- Tool lifecycle:
  - trace kind `tool_runtime_lifecycle`;
  - payload includes bounded phase/status, tool id/name/call id, argument key/count, duration, error kind;
  - doctor check `tool_lifecycle_diagnostics` detects missing terminal, terminal-without-start, duplicate terminal, malformed phase/status.
- Session continuity:
  - trace kind `session_continuity`;
  - payload includes bounded resume/fork fields;
  - doctor check `session_continuity` summarizes events, resume/fork counts, lineage switching, pending state, and results.
- Request-shape dry-run:
  - `ProviderRequestDryRunRenderer` returns provider lane, cache hash stability, prompt cache key hash stability, wire hint state, snapshot counts, and bounded recovery diagnostics.

## P13 Design Implication

P13 should add a small reusable runtime dry-run diagnostic contract around existing data instead of reworking runtime execution.

Recommended implementation:

- Add a `RuntimeDryRunDiagnostics` helper near `provider_request_dry_run.py`.
- Accept exposed tool names, optional runtime policy trace payloads, optional lifecycle/continuity trace payloads, and provider request dry-run output.
- Return bounded dictionaries suitable for doctor/smoke/CLI surfaces.
- Extend `ProviderRequestDryRunRenderer.render()` with an optional `runtime_diagnostics` argument so existing provider dry-run behavior remains backward compatible.
- Extend provider-free smoke to emit P13 runtime fields.

## Redaction Boundary

Allowed:

- tool count and sorted tool names;
- policy decisions, risk levels, policy names;
- sandbox filesystem/network/shell shape;
- approval lane state (`not_required`, `needs_approval`, `denied`);
- lifecycle and continuity bounded counts;
- request-shape summaries already redacted by provider dry-run.

Forbidden:

- raw user prompt;
- raw tool output;
- raw tool argument values;
- raw command text;
- provider request/response payload body;
- provider keys or secrets;
- full `prompt_cache_key`.
