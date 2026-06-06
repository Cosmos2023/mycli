# Prefix Cache Context Assembly P2

## Problem

P1 made request shape, cache-shape diagnostics, doctor, and provider-free smoke
aware of static, dynamic, and ephemeral context boundaries. The provider wire
payloads still do not use those boundaries to apply provider cache hints. As a
result, the canonical timeline can prove a stable prefix exists, but OpenAI
Responses, OpenAI-compatible Chat Completions, and Anthropic Messages do not yet
receive the best available request-level or block-level cache hint.

## Goal

Implement provider adapter wire-layer cache policy using P1 request-shape
metadata. The canonical timeline remains the source of truth; provider cache
hints are generated at projection time, sent only in wire/request payloads, and
must not be persisted into conversation messages, request fragments, transcripts,
or runtime history.

## In Scope

- Define a provider-agnostic request policy object for:
  - OpenAI `prompt_cache_key` candidates.
  - Anthropic `cache_control` breakpoint candidates.
  - Provider projection lane metadata.
  - Wire-only hint names and bounded diagnostics.
- Preserve cache policy metadata from `RequestShape` to provider adapters without
  changing canonical message content.
- Add OpenAI Responses `prompt_cache_key` support as a request option.
- Add OpenAI-compatible Chat Completions `prompt_cache_key` support when the
  projection policy enables it.
- Add Anthropic Messages wire-only `cache_control` on payload copies at stable
  prefix and dynamic boundary breakpoints.
- Sanitize Chat Completions payloads so provider-private fields from Responses or
  Anthropic lanes never leak into chat messages.
- Extend trace/doctor visibility with bounded cache-hint diagnostics:
  - hint enabled/disabled.
  - prompt cache key hash/preview.
  - Anthropic breakpoint count.
  - provider cached-token usage aligned with the internal prefix hash.
- Add provider-free adapter smoke for Responses, Chat Completions, and Anthropic
  projection behavior.

## Out of Scope

- Merging to main.
- New third-party dependencies.
- Copying Hermes-agent or Codex source code.
- ACP, remote agent, swarm, or multi-platform gateway productization.
- Full memory system, background maintenance, or multimodal tool result envelope.
- Provider-specific compact engines. All providers continue using the canonical
  compact engine by default.
- `/responses/compact` as a default path; it remains a future experiment.

## Requirements

1. `RequestShape` exposes provider request policy diagnostics derived from
   provider, model, protocol, system hash, tool schema hash, and cacheable prefix
   hash.
2. `prompt_cache_key` is stable when only ephemeral/current intent changes, and
   changes when the stable prefix changes.
3. OpenAI Responses payloads include `prompt_cache_key` only as a request-level
   option.
4. OpenAI-compatible Chat Completions payloads include `prompt_cache_key` only as
   a request-level option and do not include provider-private message fields.
5. Anthropic Messages payloads add `cache_control: {"type": "ephemeral"}` only
   to serialized wire content blocks, never to canonical runtime blocks or
   request fragments.
6. Anthropic breakpoint candidates protect the system/static prefix and the
   dynamic boundary when available.
7. Diagnostics and doctor output use counts, booleans, hashes, and bounded
   previews only. No raw user text, context content, tool output, headers, or
   secrets.
8. Existing P1 context cache smoke and context/subagent/MCP/plugin/hook smokes
   do not regress.

## Acceptance

- Unit tests cover provider request policy generation, Anthropic wire-only
  cache control, OpenAI prompt cache key propagation, Chat sanitize/projection,
  trace/cache diagnostics, and doctor reporting.
- Provider-free adapter smoke passes.
- Existing P1 context smoke passes.
- context/subagent/MCP/plugin/hook smokes pass.
- `uv run ruff check .`, `uv run mypy src/mycli`, and full
  `uv run pytest -q` pass.
- Final report includes branch, commit, completed content, test results,
  remaining Hermes/Codex cache gaps, and next recommendations.
