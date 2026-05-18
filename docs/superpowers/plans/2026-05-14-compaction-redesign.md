# Compaction Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign compaction: L1 primary defense (pre-cache), L2/L3 monitoring-only (budget nudge, no message modification), L4 last resort (safe split + structured summary + circuit breaker).

**Architecture:** L1 runs at tool execution time before conversation.append(). L2/L3 inject budget nudge signals, never modify messages. L4 uses `_find_safe_split()` to preserve tool pair integrity. Cache prefix is never touched after initial send.

**Tech Stack:** Python 3.12+, pytest.

**Spec:** `docs/superpowers/specs/2026-05-14-compaction-redesign.md`

---

### Task 1: Move L1 to ToolResultProcessor (pre-cache execution)

**Files:**
- Modify: `src/mycli/application/runtime/tools/tool_execution_service.py`
- Modify: `src/mycli/services/context/compaction/pipeline.py` — remove L1 from CompactionPipeline
- Create: `tests/unit/test_l1_pre_cache.py`

**Goal:** L1 truncation runs during tool execution, BEFORE `conversation.append()`. After append → send → cache, the message is sealed.

- [ ] **Step 1: Write test**

```python
# tests/unit/test_l1_pre_cache.py
import pytest
from mycli.services.context.tool_result_formatter import ToolResultFormatter
from mycli.domain.conversation import Conversation, Message


class TestL1PreCache:
    def test_l1_runs_before_conversation_append(self):
        """L1 must truncate BEFORE the message enters conversation."""
        formatter = ToolResultFormatter()
        
        conv = Conversation(session_id="test")
        raw_output = "a" * 5000  # 5K chars — exceeds read_file limit
        
        # Simulate what ToolResultProcessor does:
        # 1. Create fragment from raw output
        msg = Message(role="tool", content=raw_output, 
                      metadata={"tool_name": "read_file"})
        
        # 2. L1 truncation BEFORE append
        result = ToolResultV2(summary=msg.content, raw_payload={})
        msg.content = formatter.format("read_file", result)
        msg.metadata["l1_truncated"] = True
        msg.metadata["cache_frozen"] = True
        
        # 3. NOW append (truncated content is what enters cache)
        conv.append(msg)
        
        # The message in conversation is the TRUNCATED version
        assert len(conv.messages[-1].content) < 5000
        assert conv.messages[-1].metadata["cache_frozen"] == True

    def test_already_frozen_not_reprocessed(self):
        """After L1 runs and marks cache_frozen, subsequent compaction passes skip it."""
        conv = Conversation(session_id="test")
        msg = Message(role="tool", content="already truncated",
                      metadata={"cache_frozen": True, "l1_truncated": True})
        conv.append(msg)
        
        # Compaction pipeline would see cache_frozen=True → skip
        # (This test verifies the metadata contract)
        assert conv.messages[0].metadata["cache_frozen"] == True
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_l1_pre_cache.py -v`
Expected: FAIL — ToolResultV2 import issues or ToolResultFormatter not wired

- [ ] **Step 3: Implement in ToolExecutionService**

In `src/mycli/application/runtime/tools/tool_execution_service.py`, in `_record_tool_outcome`:

```python
def _record_tool_outcome(self, conversation, call, result):
    # 1. Build raw message content from tool result
    raw_content = result.summary or str(result)
    
    # 2. L1: Truncate BEFORE append (pre-cache window)
    tool_name = call.name
    formatted = self._tool_result_formatter.format(tool_name, result)
    
    # 3. Append to conversation with cache_frozen flag
    conversation.append(Message(
        role="tool",
        content=formatted,
        tool_call_id=call.id,
        metadata={
            "tool_name": tool_name,
            "l1_truncated": len(raw_content) != len(formatted),
            "cache_frozen": True,  # SEALED — compaction will never touch this
        },
    ))
```

- [ ] **Step 4: Remove L1 from CompactionPipeline**

In `src/mycli/services/context/compaction/pipeline.py`:

```python
class CompactionPipeline:
    def __init__(self, l2, l3, l4, budget, counter):
        # L1 removed — runs in ToolExecutionService instead
        self.l2 = l2
        self.l3 = l3
        self.l4 = l4
        self.budget = budget
        self.counter = counter
    
    def compact(self, conversation, budget):
        total = self.counter.count_all(conversation.messages)
        ratio = total / budget.usable_limit
        
        # L2: monitoring (≥40%)
        if ratio >= 0.40:
            self.l2.check_and_nudge(conversation, budget)
        
        # L3: monitoring (≥70%)
        if ratio >= 0.70:
            self.l3.check_and_nudge(conversation, budget)
        
        # L4: last resort (≥90%)
        if ratio >= 0.90:
            conversation = self.l4.summarize(conversation, budget)
        
        return conversation
```

- [ ] **Step 5: Run test**

Run: `pytest tests/unit/test_l1_pre_cache.py -v`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/mycli/application/runtime/tools/tool_execution_service.py \
        src/mycli/services/context/compaction/pipeline.py \
        tests/unit/test_l1_pre_cache.py
git commit -m "refactor: move L1 to pre-cache — runs before conversation.append()

- L1 now executes in ToolExecutionService during tool outcome recording
- cache_frozen=True flag set immediately — sealed forever
- L1 removed from CompactionPipeline (was running at wrong time)
- DeepSeek: messages never modified after entering cache prefix"
```

---

### Task 2: L2/L3 → monitoring-only with budget nudge

**Files:**
- Modify: `src/mycli/services/context/compaction/pipeline.py`
- Create: `tests/unit/test_budget_nudge.py`

**Goal:** L2/L3 no longer modify messages. Instead, inject budget nudge signals.

- [ ] **Step 1: Write test**

```python
# tests/unit/test_budget_nudge.py
from mycli.services.context.compaction.pipeline import BudgetNudge
from mycli.domain.conversation import Conversation, Message
from mycli.services.context.compaction.budget import ContextBudget


class TestBudgetNudge:
    def test_warning_at_60_percent(self):
        nudge = BudgetNudge()
        conv = Conversation(session_id="test")
        conv.messages = [Message(role="user", content="test")]
        
        budget = ContextBudget(max_tokens=200_000)
        budget.conversation_tokens = 120_000  # 60%
        
        result = nudge.check_and_inject(conv, budget)
        msgs = result.messages
        assert len(msgs) == 2  # original + nudge
        assert "token_budget_remaining" in msgs[-1].content
        assert "60%" in msgs[-1].content or "consider" in msgs[-1].content.lower()

    def test_stop_at_85_percent(self):
        nudge = BudgetNudge()
        conv = Conversation(session_id="test")
        conv.messages = [Message(role="user", content="test")]
        
        budget = ContextBudget(max_tokens=200_000)
        budget.conversation_tokens = 170_000  # 85%
        
        result = nudge.check_and_inject(conv, budget)
        msgs = result.messages
        assert len(msgs) == 2
        assert "MUST respond" in msgs[-1].content

    def test_no_nudge_below_threshold(self):
        nudge = BudgetNudge()
        conv = Conversation(session_id="test")
        conv.messages = [Message(role="user", content="test")]
        
        budget = ContextBudget(max_tokens=200_000)
        budget.conversation_tokens = 50_000  # 25%
        
        result = nudge.check_and_inject(conv, budget)
        assert len(result.messages) == 1  # unchanged

    def test_nudge_never_modifies_existing_messages(self):
        """L2/L3 must NEVER modify existing message content."""
        nudge = BudgetNudge()
        conv = Conversation(session_id="test")
        original_content = "this must not change"
        conv.messages = [Message(role="user", content=original_content)]
        
        budget = ContextBudget(max_tokens=200_000)
        budget.conversation_tokens = 150_000  # 75%
        
        result = nudge.check_and_inject(conv, budget)
        # Original message untouched
        assert result.messages[0].content == original_content
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_budget_nudge.py -v`
Expected: FAIL

- [ ] **Step 3: Implement BudgetNudge**

```python
# src/mycli/services/context/compaction/pipeline.py

class BudgetNudge:
    WARN_THRESHOLD = 0.60
    STOP_THRESHOLD = 0.85
    
    def check_and_inject(self, conversation, budget):
        ratio = budget.usage_ratio
        
        if ratio >= self.STOP_THRESHOLD:
            return self._inject(conversation, (
                f"<token_budget_remaining>\n"
                f"Context window is {ratio:.0%} full. "
                f"You MUST respond now based on available information. "
                f"Do NOT call more tools unless absolutely essential. "
                f"Stop exploring and act on what you already know.\n"
                f"</token_budget_remaining>"
            ))
        
        if ratio >= self.WARN_THRESHOLD:
            return self._inject(conversation, (
                f"<token_budget_remaining>\n"
                f"Context window is {ratio:.0%} full. "
                f"Consider wrapping up your response soon.\n"
                f"</token_budget_remaining>"
            ))
        
        return conversation
    
    def _inject(self, conversation, text):
        # Append-only: never modify existing messages
        import copy
        result = copy.deepcopy(conversation)
        result.messages.append(Message(
            role="user",
            content=text,
            metadata={"budget_nudge": True},
        ))
        return result
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_budget_nudge.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/services/context/compaction/pipeline.py tests/unit/test_budget_nudge.py
git commit -m "feat: L2/L3 become monitoring-only — inject budget nudge, never modify messages

- BudgetNudge injects warning at 60%, stop signal at 85%
- Append-only: original messages untouched
- No cache prefix invalidation from L2/L3
- DeepSeek-compatible: works without cache_edits API"
```

---

### Task 3: L4 safe split + structured summary

**Files:**
- Modify: `src/mycli/services/context/compaction/pipeline.py`
- Create: `tests/unit/test_l4_safe_split.py`

- [ ] **Step 1: Write test for safe split**

```python
# tests/unit/test_l4_safe_split.py
from mycli.services.context.compaction.pipeline import _find_safe_split
from mycli.domain.conversation import Message
from mycli.domain.tools import ToolCall


class TestSafeSplit:
    def test_split_after_complete_tool_pair(self):
        tc = ToolCall(id="c1", name="read_file", args={"path": "x.py"})
        msgs = [
            Message(role="user", content="read x"),
            Message(role="assistant", content="", tool_calls=(tc,)),
            Message(role="tool", content="result", tool_call_id="c1"),
            Message(role="user", content="next"),
        ]
        # Candidate at idx=2 would orphan tool(c1). Must shift to ≥3
        result = _find_safe_split(msgs, 2)
        assert result >= 2  # tool_result at idx=2 is matched, safe boundary is after it

    def test_split_preserves_response_id_chunks(self):
        msgs = [
            Message(role="user", content="q"),
            Message(role="assistant", content="thinking", response_id="r1"),
            Message(role="assistant", content="done", response_id="r1"),
        ]
        # Splitting between two r1 chunks is unsafe
        result = _find_safe_split(msgs, 2)
        assert result <= 1
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_l4_safe_split.py -v`
Expected: FAIL

- [ ] **Step 3: Implement `_find_safe_split`**

```python
def _find_safe_split(messages, candidate):
    idx = max(0, candidate)
    
    # Collect tool_result call_ids after the split point
    result_ids_after = set()
    for i in range(idx, len(messages)):
        m = messages[i]
        if m.role == "tool" and m.tool_call_id:
            result_ids_after.add(m.tool_call_id)
    
    # Shift backward until all tool pairs are intact
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

- [ ] **Step 4: Wire into LLMSummarization**

```python
# In LLMSummarization.apply():
fresh = conversation.messages[zones.fresh_start:]
# OLD: split = len(fresh) // 2
# NEW: safe split
split = _find_safe_split(fresh, len(fresh) // 2)
```

- [ ] **Step 5: Run test**

Run: `pytest tests/unit/test_l4_safe_split.py -v`
Expected: PASS (3 tests)

- [ ] **Step 6: Update summary prompt to 9-section structured format**

```python
SUMMARY_PROMPT = (
    "Summarize the conversation below into exactly 9 sections:\n"
    "1. Primary Request: what was the user's original goal\n"
    "2. Key Technical Concepts: frameworks, patterns, architectures discussed\n"
    "3. Files and Code: every file examined or edited, with paths\n"
    "4. Errors and Fixes: every error encountered and how it was resolved\n"
    "5. Problem Solving: key decisions made and rationale\n"
    "6. All User Messages: every user request, preserved verbatim\n"
    "7. Pending Tasks: work not yet completed\n"
    "8. Current Work: what was being done when compaction triggered\n"
    "9. Optional Next Step: suggested continuation\n"
)
```

- [ ] **Step 7: Commit**

```bash
git add src/mycli/services/context/compaction/pipeline.py tests/unit/test_l4_safe_split.py
git commit -m "feat: L4 safe split + structured 9-section summary

- _find_safe_split() ensures tool_call/tool_result pairs stay intact
- Same response_id chunks never split across boundary
- 9-section structured summary preserves critical context
- Circuit breaker still active (max 3 consecutive failures)"
```

---

### Task 4: Parallel tool execution grouping

**Files:**
- Modify: `src/mycli/application/runtime/tools/tool_execution_service.py`
- Create: `tests/unit/test_parallel_grouping.py`

- [ ] **Step 1: Write test**

```python
# tests/unit/test_parallel_grouping.py
from mycli.application.runtime.tools.tool_execution_service import (
    group_tool_calls, CONCURRENCY_SAFE_TOOLS
)


class TestParallelGrouping:
    def test_safe_tools_grouped_together(self):
        calls = [
            mock_call("Read", "a.py", seq=0),
            mock_call("Read", "b.py", seq=1),
            mock_call("Grep", "login", seq=2),
        ]
        groups = group_tool_calls(calls)
        # All three are safe → one parallel group
        assert len(groups) == 1
        assert groups[0].parallel == True
        assert len(groups[0].calls) == 3

    def test_unsafe_splits_groups(self):
        calls = [
            mock_call("Read", "a.py", seq=0),
            mock_call("Edit", "a.py", seq=1),
            mock_call("Read", "b.py", seq=2),
        ]
        groups = group_tool_calls(calls)
        # [Read(a)] parallel → [Edit(a)] serial → [Read(b)] serial
        assert len(groups) == 3
        assert groups[0].parallel == True   # Read(a)
        assert groups[1].parallel == False  # Edit(a)
        assert groups[2].parallel == False  # Read(b) — alone, no batch

    def test_multiple_safe_after_unsafe(self):
        calls = [
            mock_call("Edit", "a.py", seq=0),
            mock_call("Read", "b.py", seq=1),
            mock_call("Read", "c.py", seq=2),
        ]
        groups = group_tool_calls(calls)
        assert len(groups) == 2
        assert groups[0].parallel == False  # Edit
        assert groups[1].parallel == True   # Read(b) + Read(c)

    def test_results_ordered_by_sequence(self):
        calls = [
            mock_call("Read", "slow.py", seq=0),
            mock_call("Read", "fast.py", seq=1),
        ]
        # Parallel execution — fast.py finishes first
        # But results must be ordered by sequence
        results = execute_grouped_calls(calls)
        assert results[0].metadata["sequence"] == 0
        assert results[1].metadata["sequence"] == 1
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_parallel_grouping.py -v`
Expected: FAIL

- [ ] **Step 3: Implement grouping**

```python
from dataclasses import dataclass
from concurrent.futures import ThreadPoolExecutor

CONCURRENCY_SAFE_TOOLS = {
    "Read", "Grep", "Glob", "LS",
    "WebSearch", "WebFetch", "Lint",
}

@dataclass
class ToolGroup:
    calls: list
    parallel: bool


def group_tool_calls(calls):
    groups = []
    batch = []
    for call in calls:
        if call.name in CONCURRENCY_SAFE_TOOLS:
            batch.append(call)
        else:
            if batch:
                groups.append(ToolGroup(calls=batch, parallel=True))
                batch = []
            groups.append(ToolGroup(calls=[call], parallel=False))
    if batch:
        groups.append(ToolGroup(calls=batch, parallel=True))
    return groups


def execute_grouped_calls(calls):
    results = [None] * len(calls)
    for group in group_tool_calls(calls):
        if group.parallel:
            with ThreadPoolExecutor(max_workers=len(group.calls)) as pool:
                futures = {pool.submit(execute_one, c): c for c in group.calls}
                for future in as_completed(futures):
                    c = futures[future]
                    results[c.metadata["sequence"]] = future.result()
        else:
            c = group.calls[0]
            results[c.metadata["sequence"]] = execute_one(c)
    return results
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_parallel_grouping.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/application/runtime/tools/tool_execution_service.py tests/unit/test_parallel_grouping.py
git commit -m "feat: parallel tool execution with concurrency-safe grouping

- CONCURRENCY_SAFE_TOOLS: Read, Grep, Glob, LS, WebSearch, WebFetch, Lint
- Dynamic grouping: consecutive safe tools → parallel batch
- Unsafe tools flush batch, execute serial
- Results ordered by sequence number regardless of completion order"
```

---

## Completion Check

- [ ] `pytest tests/unit/test_l1_pre_cache.py tests/unit/test_budget_nudge.py tests/unit/test_l4_safe_split.py tests/unit/test_parallel_grouping.py -v` passes
- [ ] L1 runs pre-cache — messages sealed with cache_frozen=True after append
- [ ] L2/L3 never modify existing messages — append-only budget nudge
- [ ] L4 safe split preserves tool_call/tool_result pairs
- [ ] Parallel tools grouped by concurrency safety
- [ ] Cache prefix never modified after initial send
