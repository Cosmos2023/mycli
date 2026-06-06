# Prefix Cache Context Assembly P7a Completion

## Summary

Completed Compact Cheap Pruning / Tail Protection Foundation P7a. The existing
context compaction pipeline now has a deterministic cheap pruning stage before
context-window analysis and LLM summarization. The strategy shrinks old dynamic
replay while preserving frozen/static prefix content, append-only items, and the
latest protected tail.

## Main Changes

- Added `CheapPruning` strategy to `src/mycli/services/context/compaction/pipeline.py`.
- Integrated cheap pruning into `CompactionPipeline.apply()` between L1 tool
  result formatting and analyzer/L4 summarization.
- Added semantic tail protection for assistant tool-call / tool-result groups
  and shared `response_id` groups.
- Added deterministic duplicate old tool-result back-references.
- Added bounded old tool-result summary pruning.
- Added recursive tool-call argument truncation that preserves dict/list
  structure.
- Exported `CheapPruning` from `mycli.services.context.compaction`.
- Updated backend context-management spec with the P7a cheap pruning contract.

## Verification

- `uv run pytest tests/unit/services/context/compaction/test_pipeline.py -q`
- `uv run pytest tests/unit/services/context/compaction tests/unit/test_compaction_transcript_validity.py tests/unit/test_compaction_sealed_guard.py tests/unit/services/test_cache_stability_regressions.py tests/unit/services/test_request_shape_builder.py -q` (`81 passed`)
- `uv run ruff check .`
- `uv run mypy src/mycli`
- `uv run python evaluation/provider_cache_policy_smoke.py`
- `uv run python evaluation/context_smoke.py`
- `uv run python evaluation/plugin_runtime_smoke.py`
- `uv run python evaluation/hook_smoke.py`

## Remaining Scope

- P7b owns canonical compact summary replacement, durable/turn rehydration,
  lineage switching, and compact failure safety.
- P8 owns recovery policy and productized observability.
- Full `uv run pytest -q` should be run before final P8 closeout or if later
  changes expand the blast radius.
