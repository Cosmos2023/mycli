# Prefix Cache Context Assembly P8

## Problem

P1-P7b established stable request shape, provider cache policy projection,
canonical persistence, provider replay hardening, cheap pruning, and compact
summary/rehydration lifecycle. The remaining gap is productized recovery and
observability: provider errors still rely on scattered runtime handling, and
local diagnostics need a stronger surface for cache policy, recovery state,
trace summaries, and redaction boundaries.

## Goal

Implement Recovery / Productized Observability P8 so the prefix-cache context
assembly stack can be diagnosed and recovered locally without real provider API
calls. The work should standardize recovery classification/policy, expose
bounded doctor/dry-run/benchmark diagnostics, and verify redaction boundaries
without expanding into memory system, multimodal recovery, provider-specific
compact engines, or `/responses/compact`.

## In Scope

- Add or consolidate a provider/runtime error classifier with categories:
  `invalid_encrypted_content`, `context_overflow`, `schema_rejected`,
  `unsupported_payload`, and `image_too_large`.
- Add a recovery policy layer that maps classified errors to bounded retry
  strategies:
  - invalid encrypted content: strip encrypted reasoning replay state, disable
    encrypted reasoning replay for the session/request, retry once.
  - context overflow: compact or shrink payload, retry with bounded reminders.
  - schema rejected: retry only when deterministic adapter sanitize repair is
    available.
  - unsupported payload: surface bounded diagnostic/remediation.
  - image too large: surface only; no multimodal recovery implementation.
- Productize provider-free diagnostics through an existing or equivalent local
  dry-run/doctor/benchmark surface.
- Doctor detail should report bounded cache/recovery diagnostics:
  provider lane, cache boundary hash stability, prompt-cache-key hash stability,
  first changed cache class, wire hint state, latest/max provider cached tokens,
  missing telemetry state, and recovery classification counts.
- Benchmark/regression report should compare repeated turn shape stability,
  tool schema hash stability, internal prefix hashes, and provider cached-token
  telemetry when available from fake/local usage payloads.
- Enforce redaction boundaries for timeline persistence, tool result
  persistence, compact summary persistence, debug dumps, and future
  memory/index boundaries.
- Preserve P1-P7b invariants: full `prompt_cache_key` remains wire-only,
  Anthropic `cache_control` remains wire-only, provider-private fields stay in
  `provider_state`, compact uses the canonical engine, and current user input
  remains last.

## Out of Scope

- Merging to main.
- New third-party dependencies.
- Real external provider API calls.
- Full memory system or background maintenance.
- Multimodal tool-result envelope or image payload shrink.
- Provider-specific compact engines or default `/responses/compact`.
- ACP, remote agent, swarm, or gateway productization.

## Requirements

1. Error classification is centralized enough that runtime/recovery tests do not
   assert on scattered string matching.
2. `invalid_encrypted_content` disables encrypted reasoning replay and retries
   once without leaking encrypted content into ordinary prompt text, trace, or
   diagnostics.
3. `context_overflow` uses the existing compact/shrink path and retries within
   existing retry limits.
4. `schema_rejected` retries only when a deterministic sanitize/repair result is
   available; otherwise it surfaces a bounded failure.
5. Unsupported payload and image-too-large errors surface bounded diagnostics
   without pretending to recover unsupported provider behavior.
6. Doctor/dry-run/benchmark diagnostics do not print raw user prompt, raw tool
   output, secrets, full provider payload bodies, full `prompt_cache_key`, or
   provider-private encrypted state.
7. Provider cache usage telemetry remains normalized from fake/local Responses,
   Chat, and Anthropic-style payloads and reports missing telemetry explicitly.
8. Productized diagnostics include enough stable fields for long-term
   regression: provider lane, boundary hash stability, prompt-cache-key hash
   stability, first changed cache class, wire hint state, snapshot counts,
   latest/max cached tokens, and recovery counts.
9. P1-P7b cache/request-shape/compaction regressions remain green.

## Acceptance

- Unit tests cover error classifier categories.
- Unit tests cover recovery policy decisions and retry limits for
  invalid encrypted content, context overflow, schema rejected, unsupported
  payload, and image too large.
- Unit tests cover doctor/dry-run/benchmark diagnostics and redaction boundary.
- Provider-free cache smoke covers P8 fields without real provider calls.
- P1-P7b regression suites pass.
- `uv run ruff check .` passes.
- `uv run mypy src/mycli` passes.
- `uv run pytest -q` passes.
- Context/subagent/MCP/plugin/hook smoke commands pass.
- Trellis task is archived and journal records P8 completion.
- Final report includes branch, commits, batch completion, test results,
  remaining Hermes/Codex cache gaps, and next-step recommendations.

## Notes

Prefer extending existing abstractions before adding new ones:
`recovery.py`, `TurnExecutor`, `RequestPipeline`, `ProviderRequestDryRun`,
`ProviderPayloadSnapshot`, `CacheShapeDiagnostics`, `DoctorService`,
`TraceService`, and smoke evaluations.
