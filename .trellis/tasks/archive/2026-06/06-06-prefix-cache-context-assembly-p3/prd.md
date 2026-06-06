# Prefix Cache Context Assembly P3

## Problem

P1 proved cache classes and stable prefix diagnostics. P2 projected those
classes into provider wire cache hints for Responses, Chat Completions, and
Anthropic Messages. The system still lacks a complete operational loop for
cache stability: regression coverage is spread across tests, provider payload
projection is not summarized as a reusable redacted diagnostic, doctor cannot
triage cache misses by change class distribution, and users cannot dry-run
provider cache shape comparisons without sending a model request.

## Goal

Build the P3 cache-observability loop: prove stable request shapes with focused
regressions, summarize provider payload projection safely, report cache-miss
triage through doctor, add a provider capability gate for cache hints, and expose
a provider-free dry-run summary that can compare turns without a real provider
call.

## In Scope

- Cache stability regression tests for:
  - user intent changes keeping stable prefix hash and prompt cache key stable.
  - tool schema ordering stability.
  - tool schema content changing stable prefix hash and prompt cache key.
  - workspace/static context changing stable prefix hash.
  - dynamic replay and compaction rehydration not polluting stable prefix hash.
  - Anthropic wire `cache_control` never entering canonical timeline.
- Provider payload snapshot diagnostics:
  - provider lane.
  - provider message/runtime item counts.
  - request option hint presence.
  - sanitized provider-private field count.
  - Anthropic `cache_control` block count.
  - bounded prompt cache key hash/preview.
  - no raw user text, raw tool output, secrets, or full `prompt_cache_key`.
- Doctor cache-miss triage:
  - first-changed cache class distribution.
  - stable/dynamic/ephemeral change counts.
  - provider cached-token max and latest values.
  - wire hint enabled/disabled counts and missing hint counts.
  - bounded remediation text.
- Cache policy config/capability gate:
  - safe provider wire hints enabled by default.
  - compatible providers can disable `prompt_cache_key` or auto-downgrade.
  - no new third-party dependencies.
  - legacy/fake clients remain compatible.
- Real-provider-ready dry-run surface:
  - no real request.
  - redacted provider request shape summary.
  - compare two turns by cache boundary, prompt key hash, and first changed
    cache class.
  - unit test or provider-free smoke coverage.
- Documentation/spec update for canonical timeline, wire-only hints, trace
  redaction, doctor triage, provider lane differences, and compact rehydration
  boundaries.

## Out of Scope

- Merging to main.
- New third-party dependencies.
- Copying Hermes-agent or Codex source.
- ACP, remote agent, swarm, or multi-platform gateway productization.
- Full memory system, background maintenance, or multimodal tool result
  envelope.
- Provider-specific compact engines. All providers continue using the canonical
  compact engine.
- `/responses/compact` default path.
- Real external provider API calls.

## Requirements

1. Cache stability tests make the expected stable/dynamic/ephemeral behavior
   explicit and prevent accidental prefix-cache regressions.
2. Provider payload snapshot diagnostics are reusable from tests/smoke and do
   not leak raw prompt text or full provider cache keys.
3. Doctor context diagnostics can identify likely cache-miss causes using
   bounded counts and remediation, without reading raw payload content.
4. Provider request policy can be gated by capability/config so compatible
   providers that should not receive `prompt_cache_key` do not receive it.
5. Dry-run summaries can compare two request shapes without invoking a provider.
6. P1 and P2 smokes continue to pass.

## Acceptance

- Unit tests cover cache stability, provider payload snapshot diagnostics,
  doctor cache-miss triage, cache policy capability gate, and dry-run comparison.
- Provider-free cache smoke passes.
- P1 context cache smoke passes.
- context/subagent/MCP/plugin/hook smoke passes.
- `uv run ruff check .`, `uv run mypy src/mycli`, and full
  `uv run pytest -q` pass.
- Trellis research, PRD, implementation, tests, archive, and journal are
  complete.
- Final report includes branch, commit, completed content, test results,
  remaining Hermes/Codex cache gaps, and next recommendations.
