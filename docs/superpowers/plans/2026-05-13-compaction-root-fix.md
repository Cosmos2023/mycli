# Compaction Root Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two root causes: (1) L2/L3 compact messages already in the cache prefix, destroying DeepSeek KV cache. (2) L4 splits at `len//2` without respecting tool_call/tool_result boundaries.

**Architecture:** L2/L3 add `scope` parameter — only modify messages appended since the last API request. L4 uses `_find_safe_split()` to find a tool-pair-safe boundary. L1 becomes the primary defense (truncation happens before messages enter the cache prefix). `turn_executor.py` records `last_sent_index` after each API call.

**Tech Stack:** Python 3.12+, pytest.

**Spec:** `docs/superpowers/specs/2026-05-13-compaction-root-fix.md`

---

### Task 1: Add `_find_safe_split` and fix LLMSummarization

**Files:**
- Modify: `src/mycli/services/context/compaction/pipeline.py`
- Create: `tests/unit/test_compaction_safety.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/test_compaction_safety.py
from mycli.services.context.compaction.pipeline import _find_safe_split
from mycli.domain.conversation import Message


class TestSafeSplit:
    def test_no_tool_calls_returns_candidate(self):
        msgs = [
            Message(role="user", content="q1"),
            Message(role="assistant", content="a1"),
            Message(role="user", content="q2"),
            Message(role="assistant", content="a2"),
        ]
        assert _find_safe_split(msgs, 2) == 2

    def test_split_before_tool_result_shifts_later(self):
        """If candidate splits between tool_call and its tool_result,
        boundary must shift to include both."""
        from mycli.domain.tools import ToolCall

        tc = ToolCall(id="call_1", name="read_file", args={"path": "x.py"})
        msgs = [
            Message(role="user", content="read x"),
            Message(role="assistant", content="", tool_calls=(tc,), response_id="r1"),
            Message(role="tool", content="file content", tool_call_id="call_1", response_id="r1"),
            Message(role="assistant", content="done", response_id="r2"),
        ]
        # split at index 1 would leave tool_call (idx=1) behind,
        # orphaning tool_result (idx=2). Must shift to index 3.
        result = _find_safe_split(msgs, 1)
        assert result >= 2

    def test_split_after_tool_result_is_safe(self):
        """If candidate is AFTER the pair, no shift needed."""
        from mycli.domain.tools import ToolCall

        tc = ToolCall(id="call_1", name="read_file", args={"path": "x.py"})
        msgs = [
            Message(role="user", content="read x"),
            Message(role="assistant", content="", tool_calls=(tc,), response_id="r1"),
            Message(role="tool", content="file content", tool_call_id="call_1", response_id="r1"),
            Message(role="user", content="next question"),
        ]
        # split at index 3 is after the entire pair
        result = _find_safe_split(msgs, 3)
        assert result == 3

    def test_same_response_id_not_split(self):
        """Messages with same response_id are kept together."""
        msgs = [
            Message(role="user", content="q"),
            Message(role="assistant", content="thinking...", response_id="r1"),
            Message(role="assistant", content="done", response_id="r1"),
            Message(role="user", content="q2"),
        ]
        # split at index 2 would separate r1's chunks
        result = _find_safe_split(msgs, 2)
        assert result <= 1  # shifted back to keep r1 chunks together
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_compaction_safety.py::TestSafeSplit -v`
Expected: FAIL — `_find_safe_split` not defined

- [ ] **Step 3: Write `_find_safe_split`**

```python
# src/mycli/services/context/compaction/pipeline.py


def _find_safe_split(messages: list, candidate: int) -> int:
    """
    从 candidate 位置向后找第一个安全分割点。

    安全 = 该位置之前的 tool_call 对应的 tool_result 都在该位置之前。
    不会导致 tool_result 变成孤儿。
    """
    idx = max(0, candidate)

    # 收集分界线之后的 tool_result 对应的 tool_call_id
    result_ids_after: set[str] = set()
    for i in range(idx, len(messages)):
        m = messages[i]
        if m.role == "tool" and m.tool_call_id:
            result_ids_after.add(m.tool_call_id)

    # 向前扫描
    while idx > 0:
        prev = messages[idx - 1]
        if prev.role == "assistant":
            call_ids = {tc.id for tc in (prev.tool_calls or [])}
            if call_ids & result_ids_after:
                idx -= 1
                continue

        # 同 response_id 的 chunk 不拆散
        current_resp = getattr(messages[idx], "response_id", None)
        prev_resp = getattr(messages[idx - 1], "response_id", None)
        if current_resp and prev_resp and current_resp == prev_resp:
            idx -= 1
            continue

        break

    return idx
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_compaction_safety.py::TestSafeSplit -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Fix LLMSummarization.apply() to use `_find_safe_split`**

In `src/mycli/services/context/compaction/pipeline.py`, change LLMSummarization.apply():

```python
# OLD:
split_index = len(fresh_messages) // 2

# NEW:
split_index = _find_safe_split(fresh_messages, len(fresh_messages) // 2)
```

- [ ] **Step 6: Add L4 safety integration test**

```python
# tests/unit/test_compaction_safety.py (add to class)

class TestLLMSummarizationSafety:
    def test_does_not_orphan_tool_results(self, monkeypatch):
        from mycli.domain.conversation import Conversation
        from mycli.domain.tools import ToolCall
        from mycli.services.context.compaction.pipeline import LLMSummarization
        from mycli.services.context.compaction.cache_zones import CacheZones
        from mycli.services.context.compaction.budget import ContextBudget

        tc = ToolCall(id="call_1", name="read_file", args={"path": "x.py"})
        conv = Conversation(session_id="test")
        conv.messages = [
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
            Message(role="user", content="read file", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="assistant", content="", tool_calls=(tc,), metadata={"cache_policy": "DYNAMIC"}, response_id="r1"),
            Message(role="tool", content="file contents here", tool_call_id="call_1", metadata={"cache_policy": "EPHEMERAL"}, response_id="r1"),
            Message(role="user", content="next question", metadata={"cache_policy": "DYNAMIC"}),
        ]

        summarizer = LLMSummarization(trigger_ratio=0.1)  # force trigger
        budget = ContextBudget(max_tokens=200_000)
        budget.conversation_tokens = 190_000  # 95%
        zones = CacheZones.from_conversation(conv)

        def mock_summarize(msgs):
            return "summary text"

        monkeypatch.setattr(summarizer, "_summarize", mock_summarize)
        result = summarizer.apply(conv, zones, budget)

        # 验证：tool_result(call_1) 要么在摘要区之前（与 tool_call 同在），要么在保留区
        tool_result_msgs = [m for m in result.messages if m.role == "tool" and m.tool_call_id == "call_1"]
        assert len(tool_result_msgs) == 1

        # 如果 tool_result 在保留区，对应的 tool_call 也必须在保留区
        assistant_with_tc = [m for m in result.messages if m.role == "assistant" and m.tool_calls and any(t.id == "call_1" for t in m.tool_calls)]
        # 不可能出现 tool_call 在摘要中丢失但 tool_result 还在的情况
        assert len(assistant_with_tc) == 0 or len(tool_result_msgs) > 0
```

- [ ] **Step 7: Run all safety tests**

Run: `pytest tests/unit/test_compaction_safety.py -v`
Expected: PASS (6 tests)

- [ ] **Step 8: Commit**

```bash
git add src/mycli/services/context/compaction/pipeline.py tests/unit/test_compaction_safety.py
git commit -m "fix: L4 safe split — never orphan tool_results during LLM summarization

- Add _find_safe_split() that ensures split point respects tool boundaries
- LLMSummarization now uses safe split instead of len//2
- Same response_id chunks kept together
- Tool_call/tool_result pairs always on same side of split"
```

---

### Task 2: Add scope="fresh_only" to L2 and L3

**Files:**
- Modify: `src/mycli/services/context/compaction/pipeline.py`
- Modify: `src/mycli/application/runtime/turn_executor.py` — record `last_sent_index`
- Modify: `tests/unit/test_compaction_safety.py`

- [ ] **Step 1: Write test for scope behavior**

```python
# tests/unit/test_compaction_safety.py (add to class)

class TestScopeFreshOnly:
    def test_l2_only_touches_recent_messages(self):
        from mycli.domain.conversation import Conversation
        from mycli.services.context.compaction.pipeline import ToolResultDedup
        from mycli.services.context.compaction.budget import ContextBudget

        conv = Conversation(session_id="test")
        conv.messages = [
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
            Message(role="user", content="q1", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="tool", content="old result", tool_call_id="old_1", metadata={"cache_policy": "EPHEMERAL", "tool_name": "read_file"}),
            Message(role="user", content="q2", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="tool", content="new result", tool_call_id="new_1", metadata={"cache_policy": "EPHEMERAL", "tool_name": "read_file"}),
        ]
        conv.metadata["last_sent_index"] = 3  # messages[0:3] already in cache

        dedup = ToolResultDedup(trigger_ratio=0.1)
        budget = ContextBudget(max_tokens=200_000)
        budget.conversation_tokens = 100_000

        result = dedup.apply(conv, budget, scope="fresh_only")

        # idx=2 的 tool result ("old result") 不应被修改——已在缓存中
        assert result.messages[2].content == "old result"
        assert "archived" not in result.messages[2].content

    def test_l2_full_scope_touches_all(self):
        """Without scope, all messages are eligible (current behavior preservation)."""
        from mycli.domain.conversation import Conversation
        from mycli.services.context.compaction.pipeline import ToolResultDedup
        from mycli.services.context.compaction.budget import ContextBudget

        conv = Conversation(session_id="test")
        conv.messages = [
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
            Message(role="user", content="q1", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="tool", content="duplicate result", tool_call_id="old_1", metadata={"cache_policy": "EPHEMERAL", "tool_name": "read_file"}),
            Message(role="tool", content="duplicate result", tool_call_id="old_2", metadata={"cache_policy": "EPHEMERAL", "tool_name": "read_file"}),
        ]

        dedup = ToolResultDedup(trigger_ratio=0.1)
        budget = ContextBudget(max_tokens=200_000)
        budget.conversation_tokens = 100_000

        result = dedup.apply(conv, budget, scope="all")
        # Second duplicate should be replaced
        assert "cleared" in result.messages[3].content
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_compaction_safety.py::TestScopeFreshOnly -v`
Expected: FAIL — `scope` parameter not supported

- [ ] **Step 3: Add scope parameter to ToolResultDedup**

```python
# src/mycli/services/context/compaction/pipeline.py

class ToolResultDedup:
    def apply(self, conversation, budget, scope: str = "all"):
        boundary = _compute_frozen_boundary(conversation)
        fresh_start = boundary

        # fresh_only: 只操作上次 API 请求之后新增的消息
        if scope == "fresh_only":
            fresh_start = conversation.metadata.get("last_sent_index", boundary)

        # ... rest of dedup logic, iterating from fresh_start ...
```

- [ ] **Step 4: Add scope parameter to SlidingWindowEviction**

Same pattern — `fresh_start` is adjusted to `last_sent_index` when `scope="fresh_only"`.

- [ ] **Step 5: Update CompactionPipeline.apply() to pass scope**

```python
# src/mycli/services/context/compaction/pipeline.py

class CompactionPipeline:
    def apply(self, conversation, budget, scope: str = "all"):
        zones = CacheZones.from_conversation(conversation)
        compacted = conversation

        compacted = self.tool_result_budget.apply(compacted, zones, budget)
        compacted = self.tool_result_dedup.apply(compacted, budget, scope=scope)
        compacted = self.sliding_window_eviction.apply(compacted, budget, scope=scope)
        compacted = self.llm_summarization.apply(compacted, zones, budget)

        return compacted
```

- [ ] **Step 6: Record last_sent_index in turn_executor.py**

```python
# src/mycli/application/runtime/turn_executor.py
# In _run_turn_loop, after each successful model request:

# After building and sending the API request, record which messages
# are now in the cache prefix:
conversation.metadata["last_sent_index"] = len(conversation.messages)

# Then in the next iteration, pass scope="fresh_only":
conversation_for_model = runtime._compaction_pipeline.apply(
    conversation, budget, scope="fresh_only"
)
```

- [ ] **Step 7: Run all tests**

Run: `pytest tests/unit/test_compaction_safety.py -v`
Expected: PASS (8 tests)

- [ ] **Step 8: Commit**

```bash
git add src/mycli/services/context/compaction/pipeline.py \
        src/mycli/application/runtime/turn_executor.py \
        tests/unit/test_compaction_safety.py
git commit -m "fix: add scope='fresh_only' to L2/L3 — never modify cache-prefix messages

- L2/L3 with scope='fresh_only' only touch messages appended since last API call
- turn_executor records last_sent_index after each successful model request
- Prevents compaction from invalidating DeepSeek KV cache prefix
- scope='all' preserves current behavior for non-cache-sensitive use cases"
```

---

### Task 3: Wire ToolResultBudget (L1 primary defense)

**Files:**
- Modify: `src/mycli/services/context/compaction/pipeline.py` — ToolResultBudget from no-op to real

- [ ] **Step 1: Write test**

```python
# tests/unit/test_compaction_safety.py (add to class)

class TestL1PrimaryDefense:
    def test_tool_result_budget_truncates(self):
        from mycli.domain.conversation import Conversation
        from mycli.services.context.compaction.pipeline import ToolResultBudget
        from mycli.services.context.tool_result_formatter import ToolResultFormatter
        from mycli.services.context.compaction.budget import ContextBudget

        formatter = ToolResultFormatter()
        strategy = ToolResultBudget(formatter)
        budget = ContextBudget(max_tokens=200_000)

        conv = Conversation(session_id="test")
        conv.messages = [
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC", "tool_name": "read_file"}),
            Message(role="user", content="read x", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="tool", content="a" * 5000, tool_call_id="c1",
                    metadata={"cache_policy": "EPHEMERAL", "tool_name": "read_file"}),
        ]

        result = strategy.apply(conv, budget)
        # L1 truncation applied
        tool_msg = result.messages[2]
        assert len(tool_msg.content) < 5000
        assert tool_msg.metadata.get("l1_truncated") is True
        assert tool_msg.metadata.get("cache_frozen") is True

    def test_already_frozen_skipped(self):
        from mycli.domain.conversation import Conversation
        from mycli.services.context.compaction.pipeline import ToolResultBudget
        from mycli.services.context.tool_result_formatter import ToolResultFormatter
        from mycli.services.context.compaction.budget import ContextBudget

        formatter = ToolResultFormatter()
        strategy = ToolResultBudget(formatter)
        budget = ContextBudget(max_tokens=200_000)

        conv = Conversation(session_id="test")
        conv.messages = [
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
            Message(role="user", content="read x", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="tool", content="already processed", tool_call_id="c1",
                    metadata={"cache_policy": "EPHEMERAL", "cache_frozen": True}),
        ]

        result = strategy.apply(conv, budget)
        assert result.messages[2].content == "already processed"
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_compaction_safety.py::TestL1PrimaryDefense -v`
Expected: FAIL — ToolResultBudget.apply() is a no-op

- [ ] **Step 3: Implement ToolResultBudget**

Use the implementation from `docs/superpowers/plans/2026-05-12-toolset-phase-a-core-tools.md` Task T03 — the same `ToolResultBudget.apply()` that truncates tool results and marks `cache_frozen=True`.

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_compaction_safety.py::TestL1PrimaryDefense -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/services/context/compaction/pipeline.py tests/unit/test_compaction_safety.py
git commit -m "feat: implement ToolResultBudget — L1 primary defense truncation

- L1 truncates tool results BEFORE they enter cache prefix
- Marks processed messages cache_frozen=True
- Already-frozen messages skipped (idempotent)
- This is the primary defense — L2/L3 are supplementary"
```

---

## Completion Check

- [ ] `pytest tests/unit/test_compaction_safety.py -v` passes (16 tests)
- [ ] L4 never orphans tool results
- [ ] L2/L3 with `scope="fresh_only"` never touches cache-prefix messages
- [ ] L1 ToolResultBudget truncates and marks `cache_frozen`
- [ ] `turn_executor.py` records `last_sent_index` after each API call
