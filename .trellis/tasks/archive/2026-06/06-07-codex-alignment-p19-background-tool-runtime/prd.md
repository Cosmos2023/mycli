# P19 PRD: Background Tool Runtime Completeness

## Goal

Standardize a provider-free background job diagnostic model covering shell background processes and sub-agent background runs.

## Scope

- Add `BackgroundJobSummary` domain model.
- Add shell registry projection into background job summaries.
- Add sub-agent service projection into background job summaries.
- Add doctor background job diagnostics for running/stale/missing terminal state using bounded fields.
- Add tests for shell projection, sub-agent projection, and doctor summary redaction.

## Non-goals

- No cron/background maintenance.
- No distributed workers.
- No remote agent/swarm.
- No new provider calls.
- No compact/rehydration changes.

## Acceptance

- Shell background job summary has job id, owner kind, state, timestamps, timeout, terminal summary, and no raw command/output.
- Sub-agent background job summary has child session job id, owner turn, state, timestamps, terminal summary, and no raw prompt/output body.
- Doctor background job diagnostics summarize running/stale/missing terminal states without raw payloads.
- P17/P18 tests remain green.
- `uv run ruff check src tests evaluation`, `uv run mypy src/mycli`, and `uv run pytest -q` pass.
- Compact/rehydration diff audit remains empty.
