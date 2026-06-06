# Prefix Cache Context Assembly P5

## Problem

P1-P4 established cache-aware request shape, provider wire cache policy,
redacted diagnostics, and runtime capability adoption. The remaining gap for P5
is canonical persistence: selected context that the model sees can still be
represented only as request-context fragments without an explicit durability
contract. That makes it easy to accidentally send agent-visible hook, plugin,
memory, plan, or rehydration context once without making it replayable after a
continuation, resume, or later debugging pass.

## Goal

Define and propagate a canonical timeline persistence contract so model-visible
context has an explicit source, durability, cache class, scope, and provider
state boundary. P5 should make agent-visible selected context durable by default
while keeping transport/cache/debug-only hints out of model-visible replay.

## In Scope

- Add a provider-agnostic canonical timeline item/domain contract with:
  - role/kind
  - source
  - durability
  - cache class
  - scope
  - metadata
  - provider state
- Add explicit section-level durability/scope metadata to request-context
  assembly.
- Exclude `api_only` context sections from model-visible instruction fragments
  and request shape fragments.
- Preserve durable selected memory/plan/context sections as replayable
  developer/context fragments.
- Preserve compact rehydration scope metadata:
  - durable rehydration can replay later.
  - turn-scoped rehydration is visible only for the current continuation.
- Ensure request-shape summaries or metadata expose bounded persistence
  information without raw prompt text.
- Ensure wire-only provider cache hints remain outside canonical timeline
  persistence.

## Out of Scope

- Merging to main.
- New third-party dependencies.
- Real external provider API calls.
- Full memory provider lifecycle, memory extraction, session search, or
  background maintenance.
- Multimodal tool result envelope.
- Provider-specific compact engine or `/responses/compact`.
- P6 provider-private replay hardening.
- P7 compact summary/rehydration implementation.
- P8 recovery/CLI/benchmark productization.

## Requirements

1. A typed canonical persistence contract exists in the runtime domain layer.
2. `TurnContextSection` or equivalent request-context input can classify content
   as persistent, turn-scoped, session-scoped, transcript-scoped, or `api_only`.
3. `api_only` content is not projected into model-visible instruction fragments
   or provider request shape fragments.
4. Selected memory and plan context can be marked durable and appears in request
   shape replay/dynamic fragments with persistence metadata.
5. Compaction rehydration can be marked durable or turn-scoped, and this scope
   survives request-shape metadata.
6. Current user input remains the final model-visible user intent.
7. Full `prompt_cache_key` and Anthropic `cache_control` are not persisted into
   canonical timeline metadata.
8. Existing P1-P4 cache stability and provider-free smokes do not regress.

## Acceptance

- Unit tests cover canonical timeline item serialization and validation.
- Unit tests cover `api_only` context exclusion from instruction contracts.
- Unit tests cover durable memory/plan context metadata in request shape
  fragments.
- Unit tests cover durable vs turn-scoped compaction rehydration metadata.
- Unit tests prove current user input remains last after P5 metadata changes.
- Provider-free cache smoke passes.
- Relevant P1-P4 request-shape/cache policy regression tests pass.
- `uv run ruff check .`, `uv run mypy src/mycli`, and full
  `uv run pytest -q` pass before final P5 archive.
- Trellis research, PRD, implementation, tests, archive, and journal are
  complete for P5.
