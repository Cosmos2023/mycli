# Append-Only Context Window Design

## Problem

The current compaction naming and layering mix two different concerns:

- `cache_frozen` describes a cache implementation detail, but the invariant we need is broader: once a message is appended to the provider transcript, ordinary context management must not rewrite it.
- L2 `ToolResultDedup` and L3 `SlidingWindowEviction` now skip sealed tool results, so they mostly run without effect after L1 has formatted tool output at append time.
- L4 summarization remains the only layer that can materially shrink the model request by replacing old context with a summary.

This creates misleading concepts: L2/L3 look like compaction strategies, but they are effectively pressure signals. The code should make that explicit.

## Goals

- Rename the message invariant from `cache_frozen` to `append_only`.
- Keep L1 as the main tool-result size control layer.
- Replace L2/L3 mutation strategies with a context-window metrics/analyzer layer.
- Keep L4 as the actual context compaction layer, triggered only by the current request context-window usage crossing its configured threshold.
- Expose enough metrics to support context-window visualization and window pressure debugging.

## Non-Goals

- Do not add a vector store, embedding model, or semantic memory retrieval.
- Do not make L4 durable session-history compaction in this change. Durable L4 can be planned separately.
- Do not introduce new third-party dependencies.
- Do not rewrite provider adapters beyond metadata naming compatibility.

## Terminology

- **append_only**: message metadata flag meaning this message is part of append-only transcript history and must not be rewritten by L1 or window-pressure analysis.
- **L1 tool-result budgeting**: formats tool results before or at append time into bounded content.
- **Window pressure analysis**: computes context-window metrics that were formerly implied by L2/L3.
- **L4 compaction**: summarizes older fresh-zone messages when the current request context window crosses the configured threshold.

## Architecture

### L1

Tool results appended by `ToolExecutionService._record_tool_message()` must use:

```python
metadata={
    "tool_name": tool_name,
    "append_only": True,
    "l1_truncated": True,
}
```

`ToolResultBudget` should skip `append_only` messages. It may still handle legacy/unsealed messages produced by older session data or tests, and when it does, it marks the replacement as `append_only=True`.

For compatibility during migration, readers may treat existing `cache_frozen=True` as append-only, but new writes must not emit `cache_frozen`.

### Window Pressure Analysis

Replace `ToolResultDedup` and `SlidingWindowEviction` with one analyzer:

```python
@dataclass(slots=True, frozen=True)
class ContextWindowMetrics:
    total_tokens: int
    max_tokens: int
    usage_ratio: float
    remaining_tokens: int
    fresh_message_count: int
    fresh_tokens: int
    tool_result_count: int
    tool_result_tokens: int
    append_only_tool_result_count: int
    append_only_tool_result_tokens: int
    duplicate_tool_result_count: int
    duplicate_tool_result_tokens: int
    evictable_tool_result_count: int
    evictable_tool_result_tokens: int
```

The analyzer must not modify `Conversation`. It only records the latest metrics for trace/observability.

Duplicate pressure uses the same signature basis as old L2: tool name, path, and summary. Evictable pressure uses the old L3 heuristic: tool results older than `keep_recent_tool_results` within the fresh zone.

### L4

`LLMSummarization` remains the only compaction strategy after L1. It triggers when the estimated input tokens for the current model request reach the configured L4 threshold. This must be based on the current context window after L1 formatting, not cumulative prompt usage across prior requests.

It continues to use `_find_safe_split()` so provider tool-call/tool-result pairs are not orphaned.

This change keeps L4 request-time behavior as-is: it can produce `conversation_for_model` for the current request. It does not yet rewrite saved session history.

## Observability

`MetricsRegistry` should record the latest `ContextWindowMetrics` snapshot. `MetricsSnapshot.to_dict()` should include a serializable `context_window` field for UI and trace consumers.

The existing budget curve remains useful but is too coarse by itself. The new context-window metrics explain why a window is full, especially tool-result share and repeated tool output.

## Migration

- New messages use `append_only`.
- Existing code checks use a helper such as `_is_append_only(message)` that returns true for either `append_only=True` or legacy `cache_frozen=True`.
- Tests and docs for current behavior should use `append_only`.
- Historical docs can keep old terminology when describing older plans.

## Acceptance Criteria

- No production code emits `cache_frozen` for newly appended tool messages.
- L1 skips `append_only` messages and marks newly formatted legacy messages as `append_only`.
- L2/L3 classes are removed or replaced from the runtime path; no window-pressure layer rewrites message content.
- The pipeline order is L1 -> recompute current-window budget -> context-window metrics -> L4.
- L4 threshold decisions use current-window `usage_ratio`, not cumulative prompt tokens and not stale pre-L1 estimates.
- Metrics snapshot includes context-window pressure numbers.
- Provider transcript validity tests still pass.
- Full test suite, ruff, and mypy pass.
