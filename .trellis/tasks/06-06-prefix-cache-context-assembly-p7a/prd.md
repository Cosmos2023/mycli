# Prefix Cache Context Assembly P7a

## Problem

P5/P6 established durable model-visible context and safe provider adapter
projection, but long conversations can still carry old dynamic replay content
at full size until L4 summarization runs. The current compaction pipeline has
tool-result formatting and LLM summarization, but it lacks a deterministic cheap
pruning layer that shrinks old dynamic replay while preserving the frozen
prefix and latest tail.

## Goal

Implement Compact Cheap Pruning / Tail Protection Foundation for the existing
`services/context/compaction` pipeline. P7a should provide deterministic,
provider-free pruning before summary generation, with stable-prefix safety and
tool-call group protection.

## In Scope

- Add a cheap pruning strategy to the existing compaction package.
- Prune only dynamic/fresh replay messages after the static/frozen boundary.
- Preserve the latest protected tail without byte-level rewrites.
- Protect assistant tool-call / tool-result groups from being split by pruning.
- Convert older large text / structured text tool results to compact summaries.
- Replace older duplicate tool results with deterministic back-reference
  messages.
- Truncate large tool-call arguments recursively while keeping dict/list
  structure valid.
- Recompute compaction/analyzer diagnostics after cheap pruning.
- Add focused unit tests and keep existing cache/request-shape regressions green.

## Out of Scope

- Merging to main.
- New third-party dependencies.
- Real external provider API calls.
- P7b canonical summary replacement, durable/turn rehydration lifecycle, or
  lineage management.
- P8 recovery policy, CLI productization, benchmark reporting, or real provider
  telemetry.
- Memory system, background maintenance, multimodal tool result envelope.
- Provider-specific compact engines or `/responses/compact`.

## Requirements

1. Static/frozen messages must remain byte-for-byte unchanged.
2. Cheap pruning must only target dynamic/fresh replay messages.
3. The newest protected tail must remain byte-for-byte unchanged.
4. Tail protection must expand to avoid orphaning tool results or assistant
   tool-call messages.
5. Duplicate old tool results must be replaced by a deterministic
   back-reference that preserves tool name, path/summary metadata when present,
   and original call id.
6. Large old tool results must be replaced by structured summaries bounded by a
   configurable character limit.
7. Large tool-call arguments must be truncated inside dict/list values without
   converting the full arguments payload into invalid JSON text.
8. Existing append-only/cache-frozen messages must not be rewritten.
9. Pruning must update bounded metadata such as `cheap_pruned`,
   `cheap_pruning_kind`, and referenced hashes without storing raw secrets or
   full provider wire payloads.
10. Pruning must not change `CacheZones.frozen_fingerprint` or request-shape
    `cacheable_prefix_hash` for static fragments.

## Acceptance

- Unit tests cover static prefix invariant.
- Unit tests cover protected tail remains unchanged.
- Unit tests cover assistant tool-call / tool-result group protection.
- Unit tests cover repeated old tool result back-references.
- Unit tests cover large tool result structured summary pruning.
- Unit tests cover recursive tool-call argument truncation with dict/list
  structure preserved.
- Existing compaction transcript validity tests pass.
- P1-P6 request-shape/cache policy regression tests pass.
- `uv run ruff check .` passes.
- `uv run mypy src/mycli` passes.

## Notes

P7a is a foundation phase. It may expose pruning metrics through strategy
metadata or existing analyzer surfaces, but canonical compact summary,
rehydration item selection, and session lineage replacement belong to P7b.
