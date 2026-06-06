# P7b Summary / Rehydration Lifecycle Research

## Sources Read

- `docs/prefix-cache-context-assembly-goals.md`
- `docs/prefix-cache-context-assembly-roadmap.md`
- `.trellis/spec/backend/context-management-contract.md`
- `src/mycli/services/context/compaction/pipeline.py`
- `src/mycli/services/context/compaction/rehydration.py`
- `src/mycli/domain/runtime/compaction_rehydration.py`
- `src/mycli/application/runtime/agent_runtime.py`
- `src/mycli/application/runtime/context/runtime_context_builder.py`
- `src/mycli/services/context/turn_context_assembler.py`
- `tests/unit/services/context/compaction/test_pipeline.py`
- `tests/unit/services/context/compaction/test_rehydration.py`
- `tests/unit/test_compaction_transcript_validity.py`
- `tests/unit/application/test_agent_runtime.py`

## Existing Capabilities

- `LLMSummarization` already performs summary replacement in the existing
  `CompactionPipeline` when the configured threshold is exceeded.
- `LLMSummarization` already preserves frozen prefix messages, uses
  `_find_safe_split()`, and inserts an assistant message with
  `metadata["compaction"] = True`.
- Summary failure currently returns the original conversation and increments a
  failure count; it does not delete history.
- `FullContextSnapshot` can provide full request context to the summarizer.
- `AgentRuntime._persist_compaction_summaries()` persists assistant compaction
  summaries into memory/session summaries and traces bounded persistence counts.
- `CompactionRehydrationService` can select and render file/skill rehydration
  from recent file paths and invoked skill snapshots.
- `RuntimeContextBuilder` can accept `CompactionRehydrationContext` and
  `TurnContextAssembler` renders it as a dynamic reference fence.

## Gaps For P7b

- Summary replacement currently returns `summary + continuation marker + tail`,
  but metadata does not explicitly record lifecycle lineage, split boundary, or
  protected tail counts.
- Runtime rehydration exists, but tests should prove that after a compacted
  request the next model context includes dynamic rehydration before current
  user input and keeps current user input last.
- Trace visibility for before/after compact lifecycle is incomplete. P7b should
  add bounded trace events, not raw summary or raw tool output.
- Tail protection should be explicitly tested for recent user message and
  assistant tool-call/tool-result groups.
- Provider-private reasoning state must not be included in fallback summary
  text.

## Recommended Implementation

- Keep using the canonical `CompactionPipeline`; do not add provider-specific
  compact engines.
- Extend `LLMSummarization` metadata for summary and continuation messages:
  lineage id, split index, protected tail count, summarized message count,
  source, and cost metrics.
- Ensure summary fallback ignores reasoning-only/provider-private messages.
- Add bounded trace events in `AgentRuntime` around compaction window changes:
  `before_compact` and `after_compact` with token counts, message counts,
  summary count, and lineage id only.
- Add tests that prove:
  - compact output is `static prefix + summary + continuation + protected tail`.
  - newest user tail survives compaction.
  - tool-call/tool-result groups are not orphaned.
  - compaction failure returns original conversation.
  - runtime rehydration is rendered as dynamic context and current user remains
    last in request shape.

## Risks

- If P7b rewrites static prefix, prefix-cache hit rate drops.
- If summary includes provider-private reasoning content, opaque provider state
  leaks into natural language.
- If runtime trace emits raw summary/tool output, redaction boundaries are
  violated.
- If rehydration is persisted incorrectly, turn-scoped context can leak across
  unrelated future turns.
