# Prefix Cache Context Assembly P5 Completion

## Summary

Implemented the canonical timeline / persistence contract for P5. Model-visible
context now carries explicit durability and scope metadata through
`TurnContextSection`, `InstructionFragment`, request-shape fragments, and
bounded summaries. `api_only` context is excluded before model-visible request
assembly, selected memory/plan context can persist through the session
baseline, and resume-time assembly can rehydrate sparse memory/plan context from
that baseline.

## Main Changes

- Added `CanonicalTimelineItem` with role, kind, content, source, durability,
  scope, cache class, metadata, and provider state fields.
- Added section-level `durability` and `scope` metadata to turn context
  assembly.
- Propagated persistence metadata through instruction contracts and request
  shape fragments.
- Redacted raw `provider_state` from request-shape metadata, exposing only
  `provider_state_keys`.
- Updated runtime ledger baseline persistence to store only model-visible
  replayable fragments and to strip wire-only/provider-private metadata.
- Added resume fallback for baseline memory/plan context when live runtime
  stores are sparse.
- Updated backend context-management spec with the canonical timeline
  persistence contract.

## Verification

- `uv run ruff check .`
- `uv run mypy src/mycli`
- `uv run pytest -q` (`1403 passed`)
- `uv run python evaluation/provider_cache_policy_smoke.py`
- `uv run python evaluation/context_smoke.py`
- `uv run python evaluation/subagent_smoke.py`
- `uv run python evaluation/mcp_smoke.py`
- `uv run python evaluation/plugin_runtime_smoke.py`
- `uv run python evaluation/hook_smoke.py`

## Remaining Scope

- P6 still owns provider adapter replay hardening for Responses / Chat /
  Anthropic and encrypted reasoning state.
- P7 still owns cheap pruning, canonical compact summary, rehydration lifecycle,
  and tail protection.
- P8 still owns recovery policy, productized diagnostics, and benchmark
  reporting.
