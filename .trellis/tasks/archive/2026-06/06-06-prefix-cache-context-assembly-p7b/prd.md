# Prefix Cache Context Assembly P7b

## Problem

P7a added deterministic cheap pruning and tail protection, but the compact
lifecycle still needs an explicit canonical summary + rehydration contract.
Existing summary and rehydration pieces are present, but P7b must make the
lifecycle testable and traceable: compacted history becomes summary +
continuation marker + protected tail, rehydration enters dynamic context, current
user input remains last, and failures do not silently delete history.

## Goal

Complete Canonical Compact Summary / Rehydration Lifecycle on top of the
existing provider-agnostic compaction pipeline. The result should make compact
safe for long coding-agent sessions while preserving stable prefix invariants
and deferring recovery/productized observability to P8.

## In Scope

- Keep one canonical compact engine for all providers.
- Ensure compact output keeps frozen/static prefix unchanged.
- Ensure summary replacement produces `summary + continuation marker + protected
  tail` after cheap pruning.
- Add bounded lifecycle metadata to summary/continuation messages.
- Ensure provider-private reasoning state does not enter natural language
  fallback summaries.
- Ensure summary failure aborts compaction by returning the original
  conversation.
- Ensure runtime rehydration context renders as dynamic `compaction_rehydration`
  before ephemeral/current user input.
- Add bounded `before_compact` / `after_compact` trace events or equivalent
  lifecycle diagnostics.
- Add focused tests for summary replacement, tail protection, rehydration scope,
  failure safety, lineage/trace, and stable prefix invariant.

## Out of Scope

- Merging to main.
- New third-party dependencies.
- Real external provider API calls.
- P8 error classifier/recovery policy, CLI productization, benchmark reporting,
  or real provider telemetry.
- Memory system, background maintenance, multimodal tool result envelope.
- Provider-specific compact engines or `/responses/compact`.

## Requirements

1. Static/frozen prefix messages remain byte-for-byte unchanged after L4 summary.
2. Compact summary message has `metadata.compaction = True`.
3. Summary/continuation metadata includes bounded lifecycle fields such as
   lineage id, source, summarized count, and split/tail counts.
4. Protected tail includes the latest user message when it is present in the
   compact window.
5. Protected tail preserves assistant tool-call/tool-result pairs.
6. Provider-private reasoning-only messages are omitted from fallback summary
   text.
7. Summary failure returns the original conversation and records bounded failure
   cost metrics; it must not delete history.
8. Runtime compaction rehydration renders as a dynamic reference section and
   does not move current user input away from request tail.
9. Lifecycle trace payloads contain bounded counts/hashes/status only, not raw
   user prompt, tool output, provider state, or full prompt cache key.
10. P1-P7a cache/request-shape regressions remain green.

## Acceptance

- Unit tests cover summary replacement shape.
- Unit tests cover protected latest user tail.
- Unit tests cover tool-call/tool-result group protection.
- Unit tests cover summary failure safety.
- Unit tests cover provider-private reasoning omitted from fallback summary.
- Unit tests cover rehydration section ordering and current user input last.
- Unit tests cover lifecycle trace metadata is bounded.
- `uv run ruff check .` passes.
- `uv run mypy src/mycli` passes.
- Relevant compaction/request-shape tests pass.

## Notes

This phase should strengthen and test the existing lifecycle rather than replace
it wholesale. P8 will own recovery retry policy and productized doctor/CLI
observability.
