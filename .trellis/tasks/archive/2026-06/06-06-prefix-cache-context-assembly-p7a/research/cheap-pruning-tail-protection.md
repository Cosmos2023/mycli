# P7a Cheap Pruning / Tail Protection Research

## Sources Read

- `docs/prefix-cache-context-assembly-goals.md`
- `docs/prefix-cache-context-assembly-roadmap.md`
- `.trellis/spec/backend/context-management-contract.md`
- `src/mycli/services/context/compaction/pipeline.py`
- `src/mycli/services/context/compaction/cache_zones.py`
- `src/mycli/domain/conversation.py`
- `src/mycli/domain/runtime/blocks.py`
- `src/mycli/application/runtime/request/request_shape_builder.py`
- `tests/unit/services/context/compaction/test_pipeline.py`
- `tests/unit/test_compaction_transcript_validity.py`
- `tests/unit/test_compaction_sealed_guard.py`

## Existing Shape

The current compaction implementation already has a package:
`src/mycli/services/context/compaction`.

Important pieces:

- `CacheZones` identifies the static prefix by reading `Message.metadata["cache_policy"]`.
- `ToolResultBudget` formats old tool results via `ToolResultFormatter`, but it skips
  messages marked `append_only` or legacy `cache_frozen`.
- `ContextWindowAnalyzer` reports duplicate and evictable tool pressure without
  rewriting conversation state.
- `LLMSummarization` performs summary replacement when over threshold.
- `_find_safe_split()` protects assistant tool-call / tool-result grouping for
  summary split boundaries.
- Existing tests already assert no orphan provider tool messages after summary.

## P7a Boundary

P7a should add deterministic cheap pruning before P7b summary lifecycle. It
should not replace the active canonical timeline with summary + rehydration and
should not introduce provider-specific compact engines.

Recommended implementation lane:

- Add a new strategy in `services/context/compaction/pipeline.py` or a focused
  sibling module and invoke it between `ToolResultBudget` and
  `ContextWindowAnalyzer`.
- Only mutate non-frozen dynamic/fresh messages.
- Keep all changes deterministic and local to message/block content plus bounded
  metadata.
- Reuse existing `_copy_conversation`, `_replace_tool_message`,
  `_tool_result_signature`, `_find_safe_split`, and token/budget helpers where
  reasonable.

## Required Behavior

Cheap pruning should:

- Leave frozen/static prefix byte-for-byte unchanged.
- Leave the newest protected tail unchanged.
- Avoid cutting assistant tool-call messages away from matching tool results.
- Convert old large text or structured text tool results to compact structured
  summaries.
- Deduplicate repeated old tool results by replacing older duplicates with a
  back-reference marker while preserving recent originals.
- Truncate large tool-call JSON arguments inside JSON-compatible structures
  without invalid JSON/string wire payloads.
- Recompute analyzer/budget after pruning so diagnostics reflect the pruned
  conversation.

## Tail Protection

Tail protection should be based on message groups, not raw message count alone:

- A user/assistant/tool-result tail should keep the most recent user intent.
- If the tail includes a tool result, it must include the assistant tool-call
  message that introduced that result.
- If the tail includes an assistant tool-call message, matching tool results
  should remain protected when present.
- Messages with the same `response_id` should be protected as a group.

For P7a, a conservative default such as protecting the newest 6 messages is
acceptable if group expansion is deterministic.

## Risks

- Rewriting messages marked `STATIC`, `append_only`, or `cache_frozen` would
  break prefix-cache and append-only expectations.
- Deduplicating a recent tool result can remove information the model is still
  actively using.
- Truncating tool-call arguments with string slicing can produce invalid JSON
  for Chat adapters.
- Introducing summary replacement in P7a would mix P7b scope into this phase.

## Test Targets

- Cheap pruning does not change static prefix fingerprint.
- Recent tail messages remain byte-level unchanged.
- Assistant tool-call / tool-result groups remain valid after pruning.
- Duplicate old tool results become deterministic back-references.
- Large tool-call arguments are recursively truncated while still represented as
  dictionaries in `ToolCall.arguments` and `RuntimeBlock.tool_arguments`.
- P1-P6 cache/request-shape regression tests remain green.
