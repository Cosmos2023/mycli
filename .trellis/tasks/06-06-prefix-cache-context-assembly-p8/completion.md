# Prefix Cache Context Assembly P8 Completion

## Summary

Implemented Recovery / Productized Observability P8:

- Added centralized P8 recovery taxonomy and policy in `recovery.py`.
- Integrated invalid encrypted reasoning replay recovery into runtime turns:
  clear Responses continuation state, clear active adapter continuation state,
  retry once, and emit bounded `recovery_diagnostic` trace rows.
- Kept existing context-overflow drain/reactive-compact behavior while routing
  it through the centralized classifier and bounded recovery metadata.
- Added provider-free dry-run recovery fields: `recovery_counts` and
  `latest_recovery`.
- Extended doctor context diagnostics with bounded recovery counts, action
  counts, retry counts, and latest recovery status.
- Updated provider cache policy smoke with P8 recovery fields.
- Updated `.trellis/spec/backend/context-management-contract.md` with the
  recovery diagnostics and provider replay recovery contract.
- Updated `docs/prefix-cache-context-assembly-goals.md` so the current roadmap
  entry point reflects P5-P7b completion and P8 in-progress status.

## Verification

- `uv run pytest tests/unit/application/test_turn_recovery_and_budget.py tests/unit/services/test_provider_payload_snapshot.py tests/unit/services/test_doctor_service.py::test_doctor_service_reports_recovery_diagnostics_without_raw_provider_text -q`
  - 25 passed
- `uv run pytest tests/unit/application/test_turn_recovery_and_budget.py tests/unit/services/test_provider_payload_snapshot.py tests/unit/services/test_cache_shape_diagnostics.py tests/unit/services/test_doctor_service.py::test_doctor_service_reports_recovery_diagnostics_without_raw_provider_text tests/unit/services/test_doctor_service.py::test_doctor_service_reports_cache_policy_validation_states -q`
  - 37 passed
- `uv run pytest tests/unit/services/test_request_shape_builder.py tests/unit/services/test_cache_stability_regressions.py tests/unit/services/test_provider_payload_snapshot.py tests/unit/services/test_cache_shape_diagnostics.py tests/unit/application/test_turn_recovery_and_budget.py -q`
  - 72 passed
- `uv run pytest tests/unit/services/context/compaction tests/unit/test_l4_summarizer.py tests/unit/test_l4_rehydration.py tests/unit/test_l4_safe_split.py tests/unit/application/test_agent_runtime_l4.py -q`
  - 75 passed
- `uv run pytest tests/unit/services/test_doctor_service.py -q`
  - 81 passed
- `uv run ruff check .`
  - passed
- `uv run mypy src/mycli`
  - passed
- `uv run pytest -q`
  - 1423 passed
- `uv run python evaluation/provider_cache_policy_smoke.py`
  - passed; output includes P8 `dry_run_recovery_counts` and
    `dry_run_latest_recovery`
- `uv run python evaluation/context_smoke.py`
  - ok=true
- `uv run python evaluation/subagent_smoke.py`
  - success=true
- `uv run python evaluation/mcp_smoke.py`
  - success=true
- `uv run python evaluation/plugin_runtime_smoke.py`
  - ok=true
- `uv run python evaluation/hook_smoke.py`
  - success=true

## Remaining

- Real provider cache telemetry remains out of scope and unverified against live
  APIs.
- `schema_rejected` deterministic sanitize repair is represented in policy but
  no provider-specific repair implementation is enabled by default.
- Full memory system, background maintenance, multimodal envelope, and
  provider-specific compact engines remain deferred tracks.
- `/responses/compact` remains a future experiment, not a default path.
