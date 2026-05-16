# Append-Only Context Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace misleading `cache_frozen` and no-op L2/L3 compaction with explicit `append_only` transcript semantics and context-window pressure metrics.

**Architecture:** L1 remains the only tool-result budgeting layer. Former L2/L3 behavior becomes a read-only `ContextWindowAnalyzer` that emits metrics for visualization/debugging. L4 remains the only actual compaction layer in the request pipeline and triggers only when the current request context-window usage reaches its configured threshold.

**Tech Stack:** Python 3.13, dataclasses, pytest, ruff, mypy.

---

## Files

- Modify: `src/mycli/application/runtime/tools/tool_execution_service.py`
  - New tool messages write `append_only=True` instead of `cache_frozen=True`.
- Modify: `src/mycli/services/context/compaction/pipeline.py`
  - Add `ContextWindowMetrics`.
  - Add `ContextWindowAnalyzer`.
  - Replace `ToolResultDedup` and `SlidingWindowEviction` from runtime path.
  - Add `_is_append_only()` legacy-compatible helper.
- Modify: `src/mycli/services/context/compaction/__init__.py`
  - Export new analyzer/metrics and stop exporting old mutation strategies.
- Modify: `src/mycli/application/runtime/agent_runtime.py`
  - Build `CompactionPipeline` with `context_window_analyzer`.
  - Recompute current-window budget after L1 before L4 threshold evaluation.
  - Record latest analyzer metrics into observability.
- Modify: `src/mycli/services/observability/metrics.py`
  - Add latest context-window metrics to registry snapshot.
- Modify: `tests/unit/test_tool_append_seal.py`
  - Rename expectations from `cache_frozen` to `append_only`.
- Modify: `tests/unit/services/context/compaction/test_pipeline.py`
  - Replace L2/L3 mutation tests with analyzer metrics tests.
- Modify: `tests/unit/test_compaction_sealed_guard.py`
  - Replace sealed guard tests with append-only analyzer invariants.
- Modify: `tests/unit/test_compaction_transcript_validity.py`
  - Update helper metadata from `cache_frozen` to `append_only`.
- Modify: `tests/unit/services/test_observability.py`
  - Assert metrics snapshot exposes context-window fields.

## Task 1: Rename Tool Message Metadata To Append-Only

**Files:**
- Modify: `tests/unit/test_tool_append_seal.py`
- Modify: `src/mycli/application/runtime/tools/tool_execution_service.py`

- [x] **Step 1: Write the failing test**

Change `tests/unit/test_tool_append_seal.py`:

```python
def test_record_tool_message_marks_appended_tool_message_append_only(tmp_path) -> None:
    service = ToolExecutionService(
        session_id="test",
        context_manager=ContextManager(),
        trace_service=TraceService(home_dir=tmp_path / "home"),
        append_turn_item=lambda **_: None,
        append_lifecycle_events=lambda **_: None,
        apply_tool_effects=lambda **kwargs: kwargs["plan_state"],
        normalize_tool_call=lambda call: call,
    )
    conversation = Conversation(session_id="test")

    service._record_tool_message(
        conversation,
        tool_name="Read",
        content="formatted result content",
        success=True,
        summary="Read file",
        error=None,
        raw_payload={"path": "/tmp/example.py"},
        tool_call_id="call_1",
    )

    message = conversation.messages[-1]
    assert message.role == "tool"
    assert message.metadata["tool_name"] == "Read"
    assert message.metadata["append_only"] is True
    assert "cache_frozen" not in message.metadata
    assert message.metadata["l1_truncated"] is True
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
uv run pytest tests/unit/test_tool_append_seal.py -q
```

Expected: FAIL because appended messages still contain `cache_frozen` and do not contain `append_only`.

- [x] **Step 3: Implement metadata write**

In `src/mycli/application/runtime/tools/tool_execution_service.py`, change `_record_tool_message()` metadata to:

```python
metadata={
    "tool_name": tool_name,
    "append_only": True,
    "l1_truncated": True,
},
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
uv run pytest tests/unit/test_tool_append_seal.py -q
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add tests/unit/test_tool_append_seal.py src/mycli/application/runtime/tools/tool_execution_service.py
git commit -m "Make transcript immutability append-only

Tool results are immutable because they have been appended to the
provider transcript, not because a provider cache implementation owns
them. The metadata now names that invariant directly.

Constraint: DeepSeek cache stability depends on not rewriting replayed history
Rejected: Keep cache_frozen alias as the primary write path | it encodes the wrong abstraction
Confidence: high
Scope-risk: narrow
Tested: uv run pytest tests/unit/test_tool_append_seal.py -q"
```

## Task 2: Convert L2/L3 Mutation Into Context Window Metrics

**Files:**
- Modify: `tests/unit/services/context/compaction/test_pipeline.py`
- Modify: `tests/unit/test_compaction_sealed_guard.py`
- Modify: `src/mycli/services/context/compaction/pipeline.py`

- [x] **Step 1: Replace L2/L3 tests with analyzer tests**

In `tests/unit/services/context/compaction/test_pipeline.py`, remove `TestToolResultDedup` and `TestSlidingWindowEviction`. Add:

```python
from mycli.services.context.compaction.pipeline import ContextWindowAnalyzer


class TestContextWindowAnalyzer:
    def test_records_duplicate_tool_pressure_without_modifying_messages(self) -> None:
        analyzer = ContextWindowAnalyzer(dedup_trigger_ratio=0.1, eviction_trigger_ratio=0.9)
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 500})
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="hi", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg("c1", path="/a.py", content="same result"),
                _tool_msg("c2", path="/a.py", content="same result"),
            ],
        )

        result = analyzer.apply(conversation, _zones(conversation), budget)

        assert result is conversation
        assert analyzer.last_metrics is not None
        assert analyzer.last_metrics.duplicate_tool_result_count == 1
        assert analyzer.last_metrics.duplicate_tool_result_tokens > 0
        assert conversation.messages[2].content == "same result"

    def test_records_evictable_tool_pressure_without_archiving_messages(self) -> None:
        analyzer = ContextWindowAnalyzer(
            dedup_trigger_ratio=0.9,
            eviction_trigger_ratio=0.1,
            keep_recent_tool_results=2,
        )
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 800})
        messages = [Message(role="user", content="hi", metadata={"cache_policy": "DYNAMIC"})]
        for index in range(5):
            messages.append(_tool_msg(f"c{index}", content=f"result {index}"))
        conversation = Conversation(session_id="test", messages=messages)

        result = analyzer.apply(conversation, _zones(conversation), budget)

        assert result is conversation
        assert analyzer.last_metrics is not None
        assert analyzer.last_metrics.evictable_tool_result_count == 3
        assert analyzer.last_metrics.evictable_tool_result_tokens > 0
        assert conversation.messages[1].content == "result 0"
        assert conversation.messages[3].content == "result 2"
```

Replace `tests/unit/test_compaction_sealed_guard.py` with:

```python
from __future__ import annotations

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import RuntimeBlock
from mycli.services.context.compaction.budget import ContextBudget
from mycli.services.context.compaction.cache_zones import CacheZones
from mycli.services.context.compaction.pipeline import ContextWindowAnalyzer


def _make_tool_msg(
    content: str,
    tool_call_id: str,
    *,
    append_only: bool,
    tool_name: str = "read_file",
) -> Message:
    return Message(
        role="tool",
        content=content,
        tool_call_id=tool_call_id,
        metadata={"tool_name": tool_name, "append_only": append_only},
        blocks=(
            RuntimeBlock(
                type="tool_result",
                text=content,
                call_id=tool_call_id,
                metadata={"tool_name": tool_name, "summary": "Read file", "path": "/tmp/a.py"},
            ),
        ),
    )


def _budget_above_threshold() -> ContextBudget:
    budget = ContextBudget(max_tokens=200_000)
    budget.record({"total_tokens": 100_000})
    return budget


class TestAppendOnlyWindowMetrics:
    def test_analyzer_leaves_append_only_duplicates_byte_level_unchanged(self) -> None:
        analyzer = ContextWindowAnalyzer(dedup_trigger_ratio=0.1, eviction_trigger_ratio=0.9)
        conv = Conversation(
            session_id="test",
            messages=[
                Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
                _make_tool_msg("sealed result v1", "old1", append_only=True),
                _make_tool_msg("sealed result v1", "old2", append_only=True),
            ],
        )

        result = analyzer.apply(conv, CacheZones.from_conversation(conv), _budget_above_threshold())

        assert result is conv
        assert result.messages[1].content == "sealed result v1"
        assert result.messages[2].content == "sealed result v1"
        assert analyzer.last_metrics is not None
        assert analyzer.last_metrics.duplicate_tool_result_count == 1

    def test_analyzer_reports_evictable_pressure_without_archiving(self) -> None:
        analyzer = ContextWindowAnalyzer(
            dedup_trigger_ratio=0.9,
            eviction_trigger_ratio=0.1,
            keep_recent_tool_results=1,
        )
        budget = ContextBudget(max_tokens=200_000)
        budget.record({"total_tokens": 150_000})
        conv = Conversation(
            session_id="test",
            messages=[
                Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
                _make_tool_msg("old 1", "s1", append_only=True),
                _make_tool_msg("old 2", "s2", append_only=True),
                _make_tool_msg("recent", "s3", append_only=True),
            ],
        )

        result = analyzer.apply(conv, CacheZones.from_conversation(conv), budget)

        assert result is conv
        assert [message.content for message in result.messages[1:]] == ["old 1", "old 2", "recent"]
        assert analyzer.last_metrics is not None
        assert analyzer.last_metrics.evictable_tool_result_count == 2
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```bash
uv run pytest tests/unit/services/context/compaction/test_pipeline.py tests/unit/test_compaction_sealed_guard.py -q
```

Expected: FAIL because `ContextWindowAnalyzer` does not exist and old L2/L3 imports may fail after test edits.

- [x] **Step 3: Add metrics dataclass and analyzer**

In `src/mycli/services/context/compaction/pipeline.py`, add:

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

    def to_dict(self) -> dict[str, int | float]:
        return {
            "total_tokens": self.total_tokens,
            "max_tokens": self.max_tokens,
            "usage_ratio": self.usage_ratio,
            "remaining_tokens": self.remaining_tokens,
            "fresh_message_count": self.fresh_message_count,
            "fresh_tokens": self.fresh_tokens,
            "tool_result_count": self.tool_result_count,
            "tool_result_tokens": self.tool_result_tokens,
            "append_only_tool_result_count": self.append_only_tool_result_count,
            "append_only_tool_result_tokens": self.append_only_tool_result_tokens,
            "duplicate_tool_result_count": self.duplicate_tool_result_count,
            "duplicate_tool_result_tokens": self.duplicate_tool_result_tokens,
            "evictable_tool_result_count": self.evictable_tool_result_count,
            "evictable_tool_result_tokens": self.evictable_tool_result_tokens,
        }
```

Add:

```python
class ContextWindowAnalyzer:
    def __init__(
        self,
        *,
        dedup_trigger_ratio: float = 0.4,
        eviction_trigger_ratio: float = 0.7,
        keep_recent_tool_results: int = 8,
    ) -> None:
        self._dedup_trigger_ratio = dedup_trigger_ratio
        self._eviction_trigger_ratio = eviction_trigger_ratio
        self._keep_recent_tool_results = keep_recent_tool_results
        self._last_metrics: ContextWindowMetrics | None = None

    @property
    def last_metrics(self) -> ContextWindowMetrics | None:
        return self._last_metrics

    def apply(
        self,
        conversation: Conversation,
        zones: CacheZones,
        budget: ContextBudget,
    ) -> Conversation:
        fresh_messages = conversation.messages[zones.fresh_start :]
        tool_messages = [message for message in fresh_messages if message.role == "tool"]
        tool_tokens = {id(message): _estimate_message_tokens(message) for message in tool_messages}
        append_only_messages = [message for message in tool_messages if _is_append_only(message)]
        duplicate_count = 0
        duplicate_tokens = 0
        if budget.usage_ratio >= self._dedup_trigger_ratio:
            seen: set[str] = set()
            for message in tool_messages:
                signature = _tool_result_signature(message)
                if signature is None:
                    continue
                if signature in seen:
                    duplicate_count += 1
                    duplicate_tokens += tool_tokens[id(message)]
                    continue
                seen.add(signature)
        evictable_messages: list[Message] = []
        if budget.usage_ratio >= self._eviction_trigger_ratio:
            evictable_messages = tool_messages[: -self._keep_recent_tool_results]
            if self._keep_recent_tool_results <= 0:
                evictable_messages = tool_messages
        self._last_metrics = ContextWindowMetrics(
            total_tokens=budget.total_tokens,
            max_tokens=budget.max_tokens,
            usage_ratio=budget.usage_ratio,
            remaining_tokens=budget.remaining,
            fresh_message_count=len(fresh_messages),
            fresh_tokens=sum(_estimate_message_tokens(message) for message in fresh_messages),
            tool_result_count=len(tool_messages),
            tool_result_tokens=sum(tool_tokens.values()),
            append_only_tool_result_count=len(append_only_messages),
            append_only_tool_result_tokens=sum(tool_tokens[id(message)] for message in append_only_messages),
            duplicate_tool_result_count=duplicate_count,
            duplicate_tool_result_tokens=duplicate_tokens,
            evictable_tool_result_count=len(evictable_messages),
            evictable_tool_result_tokens=sum(tool_tokens[id(message)] for message in evictable_messages),
        )
        return conversation
```

Add helpers:

```python
def _is_append_only(message: Message) -> bool:
    return bool(message.metadata.get("append_only") or message.metadata.get("cache_frozen"))


def _tool_result_signature(message: Message) -> str | None:
    tool_name = None
    path = None
    summary = None
    for block in message.blocks:
        if block.type != "tool_result":
            continue
        tool_name = block.metadata.get("tool_name")
        path = block.metadata.get("path")
        summary = block.metadata.get("summary")
        break
    if tool_name is None:
        return None
    return json.dumps(
        {"path": path, "summary": summary, "tool_name": tool_name},
        ensure_ascii=False,
        sort_keys=True,
    )
```

Remove `ToolResultDedup` and `SlidingWindowEviction` from the production runtime path. Production code must not import, export, or construct them after this task. If keeping the class definitions temporarily reduces migration risk, mark them private or leave them unexported and unused.

- [x] **Step 4: Make L1 use append-only helper**

In `ToolResultBudget.apply()`:

```python
if _is_append_only(message):
    continue
```

When replacing a legacy/unsealed tool message:

```python
metadata_updates={
    "append_only": True,
    "l1_truncated": True,
},
```

Update `_replace_tool_message()` so newly created replacement messages do not carry the legacy key:

```python
message_metadata = dict(message.metadata)
message_metadata.pop("cache_frozen", None)
if metadata_updates:
    message_metadata.update(metadata_updates)
```

- [x] **Step 5: Run tests to verify they pass**

Run:

```bash
uv run pytest tests/unit/services/context/compaction/test_pipeline.py tests/unit/test_compaction_sealed_guard.py -q
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add tests/unit/services/context/compaction/test_pipeline.py tests/unit/test_compaction_sealed_guard.py src/mycli/services/context/compaction/pipeline.py
git commit -m "Turn stale compaction passes into window pressure metrics

L2/L3 no longer rewrite transcript messages. They now report duplicate
and evictable tool-result pressure so UI and diagnostics can explain
window usage without breaking append-only history.

Constraint: Provider replay history must remain append-only between requests
Rejected: Keep L2/L3 as mutation strategies guarded by append_only | guarded mutation still presents the wrong runtime model
Confidence: medium
Scope-risk: moderate
Tested: uv run pytest tests/unit/services/context/compaction/test_pipeline.py tests/unit/test_compaction_sealed_guard.py -q"
```

## Task 3: Wire Analyzer Into Pipeline And Observability

**Files:**
- Modify: `src/mycli/services/context/compaction/pipeline.py`
- Modify: `src/mycli/services/context/compaction/__init__.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/services/observability/metrics.py`
- Modify: `tests/unit/services/test_observability.py`
- Modify: `tests/unit/application/test_agent_runtime.py`

- [x] **Step 1: Write observability failing test**

In `tests/unit/services/test_observability.py`, add:

```python
def test_metrics_registry_records_latest_context_window_metrics() -> None:
    registry = MetricsRegistry()

    registry.record_context_window(
        {
            "total_tokens": 900,
            "max_tokens": 1000,
            "usage_ratio": 0.9,
            "remaining_tokens": 100,
            "fresh_message_count": 5,
            "fresh_tokens": 700,
            "tool_result_count": 3,
            "tool_result_tokens": 400,
            "append_only_tool_result_count": 3,
            "append_only_tool_result_tokens": 400,
            "duplicate_tool_result_count": 1,
            "duplicate_tool_result_tokens": 120,
            "evictable_tool_result_count": 2,
            "evictable_tool_result_tokens": 250,
        }
    )

    snapshot = registry.snapshot()

    assert snapshot.context_window["usage_ratio"] == 0.9
    assert snapshot.context_window["duplicate_tool_result_count"] == 1
    assert snapshot.to_dict()["context_window"]["evictable_tool_result_tokens"] == 250
```

- [x] **Step 2: Run observability test to verify it fails**

Run:

```bash
uv run pytest tests/unit/services/test_observability.py::test_metrics_registry_records_latest_context_window_metrics -q
```

Expected: FAIL because `record_context_window` and `context_window` do not exist.

- [x] **Step 3: Write L4 current-window threshold test**

In `tests/unit/services/context/compaction/test_pipeline.py`, add the import near the existing imports:

```python
from mycli.services.context.token_counter import TokenCounter
```

Then add this method inside `class TestCompactionPipeline`:

```python

def test_pipeline_recomputes_budget_after_l1_before_l4_threshold() -> None:
    pipeline = CompactionPipeline(
        tool_result_budget=ToolResultBudget(ToolResultFormatter(read_file_max_chars=80)),
        context_window_analyzer=ContextWindowAnalyzer(
            dedup_trigger_ratio=0.1,
            eviction_trigger_ratio=0.1,
            keep_recent_tool_results=2,
        ),
        llm_summarization=LLMSummarization(trigger_ratio=0.6),
        token_counter=TokenCounter(),
    )
    stale_budget = ContextBudget(max_tokens=200)
    stale_budget.record({"total_tokens": 190})
    conversation = Conversation(
        session_id="test",
        messages=[
            Message(role="user", content="inspect", metadata={"cache_policy": "DYNAMIC"}),
            _tool_msg(
                "c1",
                tool_name="read_file",
                path="/big.py",
                content="x = 1\n" * 400,
                summary="Read big.py",
            ),
            Message(role="assistant", content="done", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="user", content="continue", metadata={"cache_policy": "DYNAMIC"}),
        ],
    )

    result = pipeline.apply(conversation, stale_budget)

    assert all(message.metadata.get("compaction") is not True for message in result.messages)
    assert pipeline.last_context_window_metrics is not None
    assert pipeline.last_context_window_metrics.total_tokens < stale_budget.total_tokens
```

Expected behavior: a stale pre-L1 budget says the request is above the L4 threshold, but after L1 truncates the large tool result the current-window budget falls below threshold, so L4 does not summarize.

- [x] **Step 4: Run L4 current-window threshold test to verify it fails**

Run:

```bash
uv run pytest tests/unit/services/context/compaction/test_pipeline.py::TestCompactionPipeline::test_pipeline_recomputes_budget_after_l1_before_l4_threshold -q
```

Expected: FAIL because the pipeline still passes the stale pre-L1 budget into L4.

- [x] **Step 5: Implement metrics registry support**

In `src/mycli/services/observability/metrics.py`, add `context_window` to `MetricsSnapshot`, `to_dict()`, registry state, `record_context_window()`, and `snapshot()`.

Use type:

```python
context_window: dict[str, int | float]
```

Implementation:

```python
_context_window: dict[str, int | float] = field(default_factory=dict)

def record_context_window(self, metrics: dict[str, int | float]) -> None:
    self._context_window = dict(metrics)
```

- [x] **Step 6: Update pipeline constructor and apply order**

In `CompactionPipeline.__init__()`, replace `tool_result_dedup` and `sliding_window_eviction` parameters with:

```python
context_window_analyzer: ContextWindowAnalyzer
```

Also accept a token counter:

```python
token_counter: TokenCounter | None = None
```

Store:

```python
self._token_counter = token_counter or TokenCounter()
```

In `CompactionPipeline.apply()`, recompute budget after L1 and use the recomputed current-window budget for analyzer metrics and L4:

```python
compacted = self.tool_result_budget.apply(conversation, zones, budget)
current_budget = ContextBudget.from_estimate(
    max_tokens=budget.max_tokens,
    estimated_input_tokens=sum(
        self._token_counter.count_message(message)
        for message in compacted.messages
    ),
)
current_zones = CacheZones.from_conversation(compacted)
self.context_window_analyzer.apply(compacted, current_zones, current_budget)
return self.llm_summarization.apply(compacted, current_zones, current_budget)
```

Add:

```python
@property
def last_context_window_metrics(self) -> ContextWindowMetrics | None:
    return self.context_window_analyzer.last_metrics
```

- [x] **Step 7: Update exports and runtime construction**

In `src/mycli/services/context/compaction/__init__.py`, export:

```python
ContextWindowAnalyzer
ContextWindowMetrics
```

Stop exporting:

```python
ToolResultDedup
SlidingWindowEviction
```

In `src/mycli/application/runtime/agent_runtime.py`, import `ContextWindowAnalyzer` and construct:

```python
self._compaction_pipeline = CompactionPipeline(
    tool_result_budget=ToolResultBudget(self._tool_result_formatter),
    context_window_analyzer=ContextWindowAnalyzer(
        dedup_trigger_ratio=0.4,
        eviction_trigger_ratio=0.7,
        keep_recent_tool_results=8,
    ),
    llm_summarization=LLMSummarization(
        trigger_ratio=config.compaction_l4_trigger_ratio,
        model_name=config.model,
        trigger_ratios_by_model=config.compaction_l4_trigger_ratios_by_model,
        cost_profile=CompactionCostProfile(
            input_cost_per_1k=config.compaction_l4_input_cost_per_1k,
            output_cost_per_1k=config.compaction_l4_output_cost_per_1k,
            carry_cost_per_1k=config.compaction_l4_carry_cost_per_1k,
            expected_summary_tokens=config.compaction_l4_expected_summary_tokens,
            min_savings_ratio=config.compaction_l4_min_savings_ratio,
            carry_turns=config.compaction_l4_carry_turns,
        ),
    ),
    token_counter=self._token_counter,
    hook_manager=self._hook_manager,
)
```

- [x] **Step 8: Record analyzer metrics after pipeline apply**

Add this helper to `AgentRuntime`:

```python
def _record_context_window_metrics(self) -> None:
    metrics = self._compaction_pipeline.last_context_window_metrics
    if metrics is None:
        return
    self._observability_service.metrics.record_context_window(metrics.to_dict())
```

Call it in `TurnExecutor._run_turn_loop()` immediately after `runtime._record_compaction_metric(...)`:

```python
runtime._record_context_window_metrics()
```

- [x] **Step 9: Run focused tests**

Run:

```bash
uv run pytest tests/unit/services/test_observability.py tests/unit/services/context/compaction/test_pipeline.py tests/unit/application/test_agent_runtime.py -q
```

Expected: PASS.

- [x] **Step 10: Commit**

```bash
git add src/mycli/services/observability/metrics.py src/mycli/services/context/compaction/__init__.py src/mycli/services/context/compaction/pipeline.py src/mycli/application/runtime/agent_runtime.py src/mycli/application/runtime/turn_executor.py tests/unit/services/test_observability.py tests/unit/services/context/compaction/test_pipeline.py tests/unit/application/test_agent_runtime.py
git commit -m "Expose context window pressure as metrics

The runtime now records the latest analyzer snapshot separately from
compaction metrics. This makes window usage visible without pretending
deduplication or sliding-window eviction changed the transcript.

Constraint: Window visualization needs numbers, not transcript rewrites
Rejected: Reuse compaction_levels for L2/L3 pressure | compaction metrics imply token removal
Confidence: medium
Scope-risk: moderate
Tested: uv run pytest tests/unit/services/test_observability.py tests/unit/services/context/compaction/test_pipeline.py tests/unit/application/test_agent_runtime.py -q"
```

## Task 4: Update Append-Only References In Transcript Tests

**Files:**
- Modify: `tests/unit/test_compaction_transcript_validity.py`
- Modify: `tests/unit/services/context/compaction/test_pipeline.py`
- Modify: any remaining production references found by `rg "cache_frozen" src tests -S`

- [x] **Step 1: Replace test helper metadata**

In transcript tests, change helper parameter names:

```python
append_only: bool = False
```

and metadata:

```python
metadata={"tool_name": tool_name, "append_only": append_only}
```

Update call sites from:

```python
cache_frozen=True
```

to:

```python
append_only=True
```

- [x] **Step 2: Search for stale production writes**

Run:

```bash
rg -n '"cache_frozen"|cache_frozen' src tests -S
rg -n "ToolResultDedup|SlidingWindowEviction" src tests -S
```

Expected:
- only migration compatibility reads in `_is_append_only()` are allowed for `cache_frozen` under `src/`
- no runtime imports or construction paths reference `ToolResultDedup` or `SlidingWindowEviction`
- tests may include one focused legacy compatibility assertion for `cache_frozen`

- [x] **Step 3: Add legacy compatibility test**

In `tests/unit/services/context/compaction/test_pipeline.py`, add:

```python
def test_l1_treats_legacy_cache_frozen_as_append_only(self) -> None:
    strategy = ToolResultBudget(ToolResultFormatter(read_file_max_chars=120))
    budget = ContextBudget(max_tokens=1000)
    conversation = Conversation(
        session_id="test",
        messages=[
            Message(role="user", content="inspect", metadata={"cache_policy": "DYNAMIC"}),
            _tool_msg("c1", content="x = 1\n" * 400),
        ],
    )
    conversation.messages[1].metadata["cache_frozen"] = True

    result = strategy.apply(conversation, _zones(conversation), budget)

    assert result.messages[1].content == conversation.messages[1].content
```

- [x] **Step 4: Run transcript and pipeline tests**

Run:

```bash
uv run pytest tests/unit/test_compaction_transcript_validity.py tests/unit/services/context/compaction/test_pipeline.py -q
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add tests/unit/test_compaction_transcript_validity.py tests/unit/services/context/compaction/test_pipeline.py
git commit -m "Migrate compaction tests to append-only terminology

Tests now describe the transcript invariant directly. A narrow legacy
compatibility assertion remains so old sessions with cache_frozen
metadata are still protected from rewrite.

Constraint: Existing persisted sessions may still contain cache_frozen metadata
Rejected: Remove all cache_frozen reads immediately | old histories could be rewritten by L1
Confidence: high
Scope-risk: narrow
Tested: uv run pytest tests/unit/test_compaction_transcript_validity.py tests/unit/services/context/compaction/test_pipeline.py -q"
```

## Task 5: Final Verification

**Files:**
- No new source files expected.

- [x] **Step 1: Run full tests**

Run:

```bash
uv run pytest tests/ -q
```

Expected: PASS.

- [x] **Step 2: Run lint**

Run:

```bash
uv run ruff check src tests
```

Expected: PASS.

- [x] **Step 3: Run typecheck**

Run:

```bash
uv run mypy src/mycli
```

Expected: PASS.

- [x] **Step 4: Run a real mycli smoke task**

Run a bounded task with a fresh session id:

```bash
printf '%s\n/quit\n' 'Inspect src/mycli/services/context/compaction/pipeline.py and src/mycli/services/observability/metrics.py. Explain how append_only, context-window metrics, and L4 compaction interact. Use tools if needed, then answer concisely.' | uv run mycli --session append-only-window-smoke
```

Actual:
- Initial smoke exposed a repeated-tool-use behavior and hit the 25 tool-call cap before final answer.
- Continuation on the same session completed with `stop_reason=assistant_completed`.
- No context-window exceeded error occurred.
- Trace file: `/Users/cosmos/.mycli/sessions/append-only-window-smoke-trace.jsonl`.
- Trace/code evidence includes `append_only` tool result metadata and `context_window` metrics.

- [x] **Step 5: Final status**

Report:
- changed files
- commits created
- verification commands and results
- whether the real smoke completed
- any remaining risks, especially that L4 is still request-time rather than durable session compaction

## Self-Review

- Spec coverage: append-only metadata, L2/L3 metrics conversion, L4-only compaction, observability, compatibility, and verification are covered.
- Placeholder scan: no TBD/TODO/fill-later placeholders.
- Type consistency: `ContextWindowMetrics`, `ContextWindowAnalyzer`, `append_only`, and `record_context_window()` names are consistent across tasks.
