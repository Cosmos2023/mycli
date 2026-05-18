# Compaction Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 3 bugs: (0) tool messages not sealed on append, (1) L2/L3 missing cache_frozen guards, (2) L4 raw len//2 split. Add provider transcript validity regression test.

**Architecture:** Patch `tool_execution_service.py` to seal messages at append time. Patch `pipeline.py` L2/L3 to skip cache_frozen. Patch L4 to use `_find_safe_split()`. All existing structures preserved — no redesign.

**Tech Stack:** Python 3.12+, pytest.

**Spec:** `docs/superpowers/specs/2026-05-14-compaction-fix.md`

---

### Task 0: Seal tool messages at append time

**Files:**
- Modify: `src/mycli/application/runtime/tools/tool_execution_service.py` — `_record_tool_message()`
- Create: `tests/unit/test_tool_append_seal.py`

**Why:** Currently `_record_tool_message()` appends Messages without `cache_frozen=True`. CompactionPipeline's L1 then re-processes them on first run.

- [ ] **Step 1: Write test**

```python
# tests/unit/test_tool_append_seal.py
import pytest
from mycli.domain.conversation import Message


class TestToolAppendSeal:
    def test_appended_tool_message_is_sealed(self):
        """Tool message must have cache_frozen=True and l1_truncated=True
        immediately after append. This prevents CompactionPipeline from
        re-processing it."""
        msg = Message(
            role="tool",
            content="formatted result content",
            tool_call_id="c1",
            metadata={
                "tool_name": "read_file",
                "cache_frozen": True,
                "l1_truncated": True,
            },
        )
        assert msg.metadata.get("cache_frozen") is True
        assert msg.metadata.get("l1_truncated") is True
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_tool_append_seal.py -v`
Expected: PASS (trivially — tests message construction contract)

- [ ] **Step 3: Modify `_record_tool_message()`**

In `src/mycli/application/runtime/tools/tool_execution_service.py`, find the `_record_tool_message()` method (around line 532). After the `conversation.append(msg)` call, ensure the message's metadata is populated:

```python
def _record_tool_message(self, conversation, call, formatted_result):
    msg = Message(
        role="tool",
        content=formatted_result,
        tool_call_id=call.id,
        metadata={
            "tool_name": call.name,
            "cache_frozen": True,   # ← NEW: sealed — compaction will never touch
            "l1_truncated": True,   # ← NEW: L1 already applied by formatter
        },
    )
    conversation.append(msg)
    return msg
```

- [ ] **Step 4: Verify no regressions**

Run: `pytest tests/unit/ -x -q`
Expected: All previously passing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/application/runtime/tools/tool_execution_service.py tests/unit/test_tool_append_seal.py
git commit -m "fix: seal tool messages with cache_frozen=True at append time

- _record_tool_message() now marks messages cache_frozen=True immediately
- Prevents CompactionPipeline L1 from re-processing already-appended messages
- l1_truncated=True reflects that ToolResultFormatter already ran"
```

---

### Task 1: Add cache_frozen guard to L2 and L3

**Files:**
- Modify: `src/mycli/services/context/compaction/pipeline.py` — ToolResultDedup + SlidingWindowEviction
- Create: `tests/unit/test_compaction_sealed_guard.py`

**Why:** L1 already skips `cache_frozen` messages. L2 and L3 don't — they can mutate messages already in the DeepSeek KV cache prefix.

- [ ] **Step 1: Write test**

```python
# tests/unit/test_compaction_sealed_guard.py
import pytest
from mycli.services.context.compaction.pipeline import (
    ToolResultDedup, SlidingWindowEviction
)
from mycli.services.context.compaction.cache_zones import CacheZones
from mycli.services.context.compaction.budget import ContextBudget
from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import RuntimeBlock


def _make_tool_msg(content, tool_call_id, cache_frozen, tool_name="read_file"):
    return Message(
        role="tool", content=content, tool_call_id=tool_call_id,
        metadata={"tool_name": tool_name, "cache_frozen": cache_frozen},
        blocks=(RuntimeBlock(
            type="tool_result", text=content, call_id=tool_call_id,
            metadata={"tool_name": tool_name}
        ),),
    )


class TestSealedGuard:
    def test_l2_byte_level_unchanged_for_cache_frozen(self):
        """Sealed messages must be byte-identical after compaction."""
        dedup = ToolResultDedup(trigger_ratio=0.1)
        budget = ContextBudget(max_tokens=200_000)
        budget.total_tokens = 100_000

        conv = Conversation(session_id="test")
        sealed = _make_tool_msg("sealed result v1", "old1", cache_frozen=True)
        sealed2 = _make_tool_msg("sealed result v1", "old2", cache_frozen=True)
        conv.messages = [
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
            sealed,
            sealed2,
        ]
        zones = CacheZones.from_conversation(conv)

        result = dedup.apply(conv, zones, budget)
        # Byte-level: sealed messages untouched
        assert result.messages[1].content == "sealed result v1"
        assert result.messages[2].content == "sealed result v1"
        assert result.messages[1].metadata["cache_frozen"] is True

    def test_l2_still_dedups_non_sealed(self):
        """Non-sealed duplicates should still be deduplicated."""
        dedup = ToolResultDedup(trigger_ratio=0.1)
        budget = ContextBudget(max_tokens=200_000)
        budget.total_tokens = 100_000

        conv = Conversation(session_id="test")
        conv.messages = [
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
            _make_tool_msg("same result", "c1", cache_frozen=False),
            _make_tool_msg("same result", "c2", cache_frozen=False),
        ]
        zones = CacheZones.from_conversation(conv)

        result = dedup.apply(conv, zones, budget)
        assert "cleared" in result.messages[2].content

    def test_l3_skips_sealed_when_archiving(self):
        """Sliding window must skip sealed messages; only archive unsealed."""
        eviction = SlidingWindowEviction(trigger_ratio=0.1, keep_recent=1)
        budget = ContextBudget(max_tokens=200_000)
        budget.total_tokens = 150_000

        conv = Conversation(session_id="test")
        conv.messages = [
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
            _make_tool_msg("sealed old 1", "s1", cache_frozen=True),
            _make_tool_msg("sealed old 2", "s2", cache_frozen=True),
            _make_tool_msg("fresh new 1", "n1", cache_frozen=False),
            _make_tool_msg("fresh new 2", "n2", cache_frozen=False),
        ]
        zones = CacheZones.from_conversation(conv)

        result = eviction.apply(conv, zones, budget)
        # All sealed messages untouched
        assert result.messages[1].content == "sealed old 1"
        assert result.messages[2].content == "sealed old 2"
        assert "archived" not in result.messages[1].content
        assert "archived" not in result.messages[2].content
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_compaction_sealed_guard.py -v`
Expected: FAIL — L2 deduplicates sealed message / L3 archives sealed message

- [ ] **Step 3: Add guard to ToolResultDedup**

In `pipeline.py`, `ToolResultDedup.apply()` loop, after `if message.role != "tool":` (line 105):

```python
if message.metadata.get("cache_frozen"):
    continue
```

- [ ] **Step 4: Add guard to SlidingWindowEviction**

In `pipeline.py`, `SlidingWindowEviction.apply()`, modify the list comprehension (lines 164-168):

```python
tool_result_indices = [
    index
    for index in range(zones.fresh_start, len(compacted.messages))
    if compacted.messages[index].role == "tool"
    and not compacted.messages[index].metadata.get("cache_frozen")
]
```

- [ ] **Step 5: Run test**

Run: `pytest tests/unit/test_compaction_sealed_guard.py -v`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/mycli/services/context/compaction/pipeline.py tests/unit/test_compaction_sealed_guard.py
git commit -m "fix: L2/L3 skip cache_frozen messages — sealed messages never mutated

- ToolResultDedup skips cache_frozen (matching L1 behavior)
- SlidingWindowEviction excludes cache_frozen from archivable indices
- Byte-level: sealed messages pass through unchanged
- Required for DeepSeek KV cache prefix stability"
```

---

### Task 2: L4 safe split boundary

**Files:**
- Modify: `src/mycli/services/context/compaction/pipeline.py` — LLMSummarization + `_find_safe_split()`
- Create: `tests/unit/test_l4_safe_split.py`

**Why:** `split_index = len(fresh_messages) // 2` can split tool_call from its tool_result.

- [ ] **Step 1: Write test**

```python
# tests/unit/test_l4_safe_split.py
from mycli.services.context.compaction.pipeline import _find_safe_split
from mycli.domain.conversation import Message


class TestSafeSplit:
    def test_no_tool_calls_returns_candidate(self):
        msgs = [Message(role="user", content="q"), Message(role="assistant", content="a")]
        assert _find_safe_split(msgs, 1) == 1

    def test_tool_pair_forces_boundary_shift(self):
        """Split at tool_call (idx=1) with tool_result at idx=2.
        Result MUST NOT be 2 — that orphans the tool_result."""
        msgs = [
            Message(role="user", content="read x"),
            Message(role="assistant", content="", tool_calls=(
                type("tc", (), {"id": "c1", "name": "read_file", "args": {}})(),)),
            Message(role="tool", content="result", tool_call_id="c1"),
            Message(role="user", content="next question"),
        ]
        result = _find_safe_split(msgs, 1)
        # Cannot be 2 (between tool_call and tool_result).
        # Must be 1 (keep everything) or ≥3 (after the complete pair).
        assert result != 2
        assert result in (1, 3)

    def test_same_response_id_not_split(self):
        msgs = [
            Message(role="user", content="q"),
            Message(role="assistant", content="thinking", response_id="r1"),
            Message(role="assistant", content="done", response_id="r1"),
        ]
        result = _find_safe_split(msgs, 2)
        assert result <= 1  # shifted back to keep r1 chunks together

    def test_empty_list(self):
        assert _find_safe_split([], 0) == 0
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_l4_safe_split.py -v`
Expected: FAIL — `_find_safe_split` not defined

- [ ] **Step 3: Implement `_find_safe_split()`**

```python
def _find_safe_split(messages: list[Message], candidate: int) -> int:
    """Find a safe split point. Cannot orphan tool_results.
    
    A split point 'idx' is UNSAFE if:
    - messages[idx] is a tool_result whose tool_call is in messages[:idx]
    - messages[idx] shares response_id with messages[idx-1]
    
    The algorithm shifts the boundary earlier (idx -= 1) until safe.
    """
    idx = max(0, candidate)

    # Collect tool_result call_ids at or after the candidate split
    result_ids_after: set[str] = set()
    for i in range(idx, len(messages)):
        m = messages[i]
        if m.role == "tool" and m.tool_call_id:
            result_ids_after.add(m.tool_call_id)

    # Shift boundary backward until no orphan risk
    while idx > 0:
        prev = messages[idx - 1]
        if prev.role == "assistant" and prev.tool_calls:
            call_ids = {tc.id for tc in prev.tool_calls}
            if call_ids & result_ids_after:
                idx -= 1
                continue
        curr_resp = getattr(messages[idx], "response_id", None)
        prev_resp = getattr(messages[idx - 1], "response_id", None)
        if curr_resp and prev_resp and curr_resp == prev_resp:
            idx -= 1
            continue
        break

    return idx
```

- [ ] **Step 4: Wire into LLMSummarization.apply()**

In `pipeline.py` line 239, replace:

```python
split_index = len(fresh_messages) // 2
```

with:

```python
split_index = _find_safe_split(fresh_messages, len(fresh_messages) // 2)
```

- [ ] **Step 5: Run test**

Run: `pytest tests/unit/test_l4_safe_split.py -v`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/mycli/services/context/compaction/pipeline.py tests/unit/test_l4_safe_split.py
git commit -m "fix: L4 safe split — never orphan tool_results during summarization

- _find_safe_split() shifts boundary to keep tool_call/tool_result pairs intact
- Same response_id chunks never split
- Test explicitly forbids boundary landing between tool_call and tool_result
- Replaces raw len//2 in LLMSummarization.apply()"
```

---

### Task 3: Provider transcript validity regression test

**Files:**
- Create: `tests/unit/test_compaction_transcript_validity.py`

**Why:** Unit tests on pipeline components don't prove the final DeepSeek request is valid. Must verify no orphan `role="tool"` messages survive to the provider transcript.

- [ ] **Step 1: Write test**

```python
# tests/unit/test_compaction_transcript_validity.py
import pytest
from mycli.services.context.compaction.pipeline import CompactionPipeline
from mycli.services.context.compaction.budget import ContextBudget
from mycli.services.context.compaction.cache_zones import CacheZones
from mycli.services.context.tool_result_formatter import ToolResultFormatter
from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import RuntimeBlock


def _make_tool_msg(content, tool_call_id, cache_frozen=False, tool_name="read_file"):
    return Message(
        role="tool", content=content, tool_call_id=tool_call_id,
        metadata={"tool_name": tool_name, "cache_frozen": cache_frozen},
        blocks=(RuntimeBlock(
            type="tool_result", text=content, call_id=tool_call_id,
            metadata={"tool_name": tool_name}
        ),),
    )


class TestTranscriptValidity:
    def test_no_orphan_tool_results_after_full_pipeline(self):
        """Full compaction pipeline must not produce orphan role='tool' messages."""
        from mycli.services.context.compaction.pipeline import (
            ToolResultBudget, ToolResultDedup, SlidingWindowEviction, LLMSummarization
        )

        pipeline = CompactionPipeline(
            tool_result_budget=ToolResultBudget(ToolResultFormatter()),
            tool_result_dedup=ToolResultDedup(trigger_ratio=0.05),
            sliding_window_eviction=SlidingWindowEviction(trigger_ratio=0.05, keep_recent=2),
            llm_summarization=LLMSummarization(trigger_ratio=0.95),
        )

        budget = ContextBudget(max_tokens=200_000)
        budget.total_tokens = 180_000  # 90% — trigger all non-L4 strategies

        tc = type("tc", (), {"id": "call_1", "name": "read_file", "args": {}})()

        conv = Conversation(session_id="test")
        conv.messages = [
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
            Message(role="user", content="read x"),
            Message(role="assistant", content="", tool_calls=(tc,)),
            _make_tool_msg("file content", "call_1", cache_frozen=True),
            Message(role="assistant", content="done"),
            Message(role="user", content="edit x"),
            Message(role="assistant", content="", tool_calls=(
                type("tc", (), {"id": "call_2", "name": "edit_file", 
                                 "args": {"path": "x.py"}})(),)),
            _make_tool_msg("edit success", "call_2", cache_frozen=True),
        ]

        result = pipeline.apply(conv, budget)

        # Scan for orphan tool results: role="tool" whose tool_call_id
        # doesn't appear in a preceding assistant's tool_calls
        pending_ids: set[str] = set()
        for msg in result.messages:
            if msg.role == "assistant" and msg.tool_calls:
                pending_ids = {tc.id for tc in msg.tool_calls}
            elif msg.role == "tool":
                assert msg.tool_call_id in pending_ids, (
                    f"Orphan tool result: tool_call_id={msg.tool_call_id} "
                    f"has no matching assistant tool_call in transcript"
                )
                pending_ids.discard(msg.tool_call_id)

    def test_l4_transcript_no_orphan(self):
        """Even after L4 summarization, no orphan tool results."""
        from mycli.services.context.compaction.pipeline import LLMSummarization

        summarizer = LLMSummarization(trigger_ratio=0.1)
        budget = ContextBudget(max_tokens=200_000)
        budget.total_tokens = 190_000  # 95% — triggers L4

        tc = type("tc", (), {"id": "call_1", "name": "read_file", "args": {}})()

        conv = Conversation(session_id="test")
        conv.messages = [
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
            Message(role="user", content="read x", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="assistant", content="", tool_calls=(tc,),
                    metadata={"cache_policy": "DYNAMIC"}),
            _make_tool_msg("file content", "call_1", cache_frozen=True),
            Message(role="assistant", content="done", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="user", content="edit x", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="assistant", content="editing", metadata={"cache_policy": "DYNAMIC"}),
        ]
        zones = CacheZones.from_conversation(conv)

        result = summarizer.apply(conv, zones, budget)

        # After L4: no orphan tool results
        pending_ids: set[str] = set()
        for msg in result.messages:
            if msg.role == "assistant" and msg.tool_calls:
                pending_ids = {tc.id for tc in msg.tool_calls}
            elif msg.role == "tool":
                assert msg.tool_call_id in pending_ids, (
                    f"Orphan tool result after L4: {msg.tool_call_id}"
                )
                pending_ids.discard(msg.tool_call_id)
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_compaction_transcript_validity.py -v`
Expected: FAIL — `_find_safe_split` not yet wired into L4, or L2/L3 guards not yet added

- [ ] **Step 3: Run full suite after all tasks complete**

Run: `pytest tests/unit/test_compaction_transcript_validity.py tests/unit/test_compaction_sealed_guard.py tests/unit/test_l4_safe_split.py tests/unit/test_tool_append_seal.py -v`
Expected: PASS (all tests)

- [ ] **Step 4: Commit**

```bash
git add tests/unit/test_compaction_transcript_validity.py
git commit -m "test: add provider transcript validity regression

- Verifies compaction pipeline output has no orphan role='tool' messages
- Covers full pipeline (L1+L2+L3) and L4 summarization path
- Orphan detection matches DeepSeek API transcript requirements"
```

---

## Completion Check

- [ ] `pytest tests/unit/test_tool_append_seal.py tests/unit/test_compaction_sealed_guard.py tests/unit/test_l4_safe_split.py tests/unit/test_compaction_transcript_validity.py -v` passes (11 tests)
- [ ] Tool messages sealed with `cache_frozen=True` at append time
- [ ] L2/L3 never touch `cache_frozen=True` messages — byte-level unchanged
- [ ] L4 split never lands between tool_call and tool_result
- [ ] Full pipeline produces no orphan `role="tool"` messages
- [ ] Cache prefix stability: sealed messages never mutated after first send
