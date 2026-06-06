# Prefix Cache Context Assembly P6

## Problem

P5 made selected model-visible context durable and replayable, but the provider
adapters still need a stricter projection contract. Responses, OpenAI-compatible
Chat Completions, and Anthropic Messages must all consume the same canonical
runtime/timeline state without leaking provider-private fields across lanes or
silently producing unsupported wire payloads.

## Goal

Implement Provider Adapter / Replay Hardening so provider-private state is
replayed only by compatible same-issuer adapters, unsupported provider fields are
deterministically stripped, and fallback ids remain stable. P6 should harden
projection boundaries without implementing compact or recovery workflows.

## In Scope

- Responses lane replay support for same-issuer provider-private state:
  - `codex_reasoning_items`
  - `codex_message_items`
- Foreign issuer encrypted reasoning filtering before request serialization.
- Chat Completions lane schema sanitization for Responses / Anthropic /
  underscore-prefixed provider-private fields.
- Explicit developer role downgrade behavior for providers that do not support
  `developer` role.
- Anthropic lane schema isolation:
  - no Responses-private fields in Anthropic wire content.
  - `cache_control` only on serialized wire copies.
- Deterministic fallback ids for tool calls / response item ids when provider
  state lacks a stable id.
- Focused diagnostics or metadata counters if useful for tests, but bounded and
  redacted.

## Out of Scope

- Merging to main.
- New third-party dependencies.
- Real external provider API calls.
- P7 compact/pruning/rehydration lifecycle.
- P8 error recovery, retry policy, CLI productization, or benchmark reporting.
- Full memory system, background maintenance, or multimodal envelope.
- Provider-specific compact engines or `/responses/compact`.

## Requirements

1. Responses serialization can include same-issuer `codex_reasoning_items`
   without flattening encrypted reasoning into text.
2. Responses serialization filters foreign-issuer encrypted reasoning state.
3. Responses serialization can replay same-shape `codex_message_items` while
   preserving provider ids/status/phase fields only for supported items.
4. Chat provider adapters strip Responses-private fields, Anthropic
   `cache_control`/thinking fields, internal `_` keys, and provider-only
   metadata before sending wire messages.
5. Chat developer-role downgrade remains explicit and tested for providers such
   as DeepSeek that map developer to system.
6. Anthropic serialization renders the same canonical runtime context without
   mutating runtime items and without leaking Responses-private fields.
7. `cache_control` stays wire-only in Anthropic lane.
8. Fallback ids are deterministic for identical missing-id inputs.
9. Existing P1-P5 cache stability, redaction, and provider-free smokes do not
   regress.

## Acceptance

- Unit tests cover Responses same-issuer encrypted reasoning replay.
- Unit tests cover Responses foreign issuer encrypted reasoning filtering.
- Unit tests cover Responses same-shape message item replay.
- Unit tests cover Chat schema sanitization and developer-role downgrade.
- Unit tests cover Anthropic wire-only `cache_control` and provider-private
  field isolation.
- Unit tests cover deterministic fallback ids.
- Provider-free cache smoke passes.
- P1-P5 request-shape/cache policy regression tests pass.
- `uv run ruff check .`, `uv run mypy src/mycli`, and full
  `uv run pytest -q` pass before P6 archive.
- Trellis research, PRD, implementation, tests, archive, and journal are
  complete for P6.
