# Prefix Cache Context Assembly P1

## Problem

`mycli` needs a provider-aware request assembly foundation that keeps long-running
coding-agent turns cache friendly without dropping context the model can use.
The runtime already has context sections, request-shape diagnostics, compaction,
doctor, traces, and multiple provider protocols, but the cache contract must be
made explicit and testable across those layers.

## Goals

- Preserve a stable provider-visible prefix for static instructions, tool schema,
  workspace guidance, and stable catalogs.
- Keep dynamic replay, compaction rehydration, memory, plan, and environment
  context after the stable prefix and before current-turn intent.
- Keep current user intent and runtime reminders in an ephemeral tail so normal
  turn-to-turn changes do not change `cacheable_prefix_hash`.
- Expose provider projection contracts for Responses, Chat Completions, and
  Anthropic Messages without duplicating compact semantics by provider.
- Make request-shape boundaries visible in trace, doctor diagnostics, and
  provider-free smoke tests.

## Non-Goals

- Do not merge to main.
- Do not add third-party dependencies.
- Do not implement ACP, remote agents, swarm, multi-platform gateway
  productization, full memory lifecycle, background maintenance, or multimodal
  tool result envelopes.
- Do not copy Hermes-agent or Codex code. Use them only as semantic references.
- Do not add provider-specific compact engines. `/responses/compact` remains a
  future optimization unless separately proven against canonical invariants.

## Requirements

1. `RequestShapeBuilder` remains the authority for provider-visible ordering:
   stable prefix, dynamic replay/rehydration, then ephemeral intent.
2. Request fragments carry `source`, `cache_class`, and `section_hash` metadata.
3. `RequestShape.summary()` includes section boundaries, provider projection
   summary, compact policy summary, prefix hash, and cacheable prefix estimates.
4. Cache diagnostics report first changed fragment, first changed cache class,
   provider usage cache tokens when available, and metadata completeness.
5. Provider projection contract distinguishes:
   - Responses: canonical timeline projection with optional future
     `prompt_cache_key` wire-only hint.
   - Chat Completions: transcript projection with stable transcript prefix.
   - Anthropic Messages: canonical projection with future wire-only
     `cache_control` breakpoint candidates.
6. Canonical compact policy is shared by all providers. Cheap pruning is allowed
   only in dynamic replay; stable prefix must remain protected.
7. Doctor context diagnostics include request-shape and cache-shape trace row
   availability without printing raw context or user content.
8. Provider-free context smoke proves static prefix hash stability when only
   ephemeral/current intent changes.
9. Existing context, subagent, MCP, plugin, and hook smokes must not regress.

## Acceptance

- Unit tests cover request shape, cache policy metadata, provider projection,
  trace/doctor visibility, and smoke-level cache stability.
- Provider-free cache smoke passes.
- Context / subagent / MCP / plugin / hook smoke pass.
- `mypy`, focused `ruff`, and full `pytest` pass. Full-repo `ruff check .` may
  be reported separately if pre-existing generated files fail.

