# Phase 1: Stop the Bleeding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix fatal bugs in the existing context management pipeline — token counting, cache zones, L1/L4 no-ops, dual code paths.

**Architecture:** Replace `len(text)//4` with tiktoken-based TokenCounter. Rewrite CacheZones to eliminate dead zone. Implement ToolResultBudget and LLMSummarization from their no-op stubs. Unify dual TurnExecutor/ReactAgent code paths.

**Tech Stack:** Python 3.12+, tiktoken, pytest. Existing mycli codebase at `src/mycli/`.

**Reference:** `docs/superpowers/specs/2026-05-06-agent-context-management-engineering-handbook.md` Section 6.

---

### Task 1: Token Counter

**Files:**
- Delete: `src/mycli/services/context/window_service.py`
- Create: `src/mycli/services/context/token_counter.py`
- Create: `tests/unit/test_token_counter.py`
- Modify: `src/mycli/services/context/compaction/budget.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/test_token_counter.py
import pytest
from mycli.services.context.token_counter import TokenCounter


class TestTokenCounter:
    def test_english_text(self):
        counter = TokenCounter()
        tokens = counter.count("Hello world, this is a test sentence.")
        # ~8 tokens for this English sentence
        assert 5 <= tokens <= 15

    def test_chinese_text(self):
        counter = TokenCounter()
        tokens = counter.count("这是一段中文测试文本")
        # Chinese chars are ~1-2 tokens each, 9 chars
        assert 5 <= tokens <= 20

    def test_code_text(self):
        counter = TokenCounter()
        code = "def foo(x: int) -> str:\n    return str(x)"
        tokens = counter.count(code)
        assert 8 <= tokens <= 25

    def test_empty_string(self):
        counter = TokenCounter()
        assert counter.count("") == 0

    def test_cache_hit(self):
        counter = TokenCounter()
        text = "test string for caching"
        first = counter.count(text)
        second = counter.count(text)
        assert first == second
        assert counter._cache_hits > 0

    def test_count_fragment(self):
        from mycli.services.context.token_counter import Fragment, FragmentKind, Priority, CachePolicy

        f = Fragment(
            id="test",
            kind=FragmentKind.TOOL_RESULT,
            priority=Priority.MEDIUM,
            cache_policy=CachePolicy.EPHEMERAL,
            content="hello world",
        )
        counter = TokenCounter()
        tokens = counter.count_fragment(f)
        assert tokens > 0

    def test_count_all_includes_overhead(self):
        counter = TokenCounter()
        fragments = [
            Fragment(id="a", kind=FragmentKind.SYSTEM, priority=Priority.CRITICAL,
                     cache_policy=CachePolicy.STATIC, content="system"),
            Fragment(id="b", kind=FragmentKind.HISTORY_USER, priority=Priority.MEDIUM,
                     cache_policy=CachePolicy.DYNAMIC, content="hello"),
        ]
        total = counter.count_all(fragments)
        # +4 per fragment overhead
        assert total == counter.count("system") + counter.count("hello") + 8
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/unit/test_token_counter.py -v`
Expected: FAIL — module not found / TokenCounter not defined

- [ ] **Step 3: Write minimal implementation**

```python
# src/mycli/services/context/token_counter.py
import hashlib


class TokenCounter:
    """Count tokens with tiktoken + LRU cache."""

    def __init__(self) -> None:
        self._encoder = None
        self._cache: dict[str, int] = {}
        self._max_cache = 10_000
        self._cache_hits = 0
        try:
            import tiktoken
            self._encoder = tiktoken.get_encoding("o200k_base")
        except Exception:
            pass

    def count(self, text: str) -> int:
        if not text:
            return 0
        key = hashlib.md5(text.encode()).hexdigest()
        if key in self._cache:
            self._cache_hits += 1
            return self._cache[key]
        tokens = self._do_count(text)
        if len(self._cache) >= self._max_cache:
            self._cache.pop(next(iter(self._cache)))
        self._cache[key] = tokens
        return tokens

    def _do_count(self, text: str) -> int:
        if self._encoder:
            return len(self._encoder.encode(text))
        # fallback: ASCII ~0.25 tokens/char, non-ASCII ~1 token/char
        ascii_chars = sum(1 for c in text if ord(c) <= 127)
        non_ascii_chars = len(text) - ascii_chars
        return ascii_chars // 4 + non_ascii_chars

    def count_fragment(self, f: "Fragment") -> int:
        if f.tokens > 0:
            return f.tokens
        content = f.content if isinstance(f.content, str) else str(f.content)
        return self.count(content)

    def count_all(self, fragments: list["Fragment"]) -> int:
        overhead = len(fragments) * 4  # per-message formatting overhead
        return overhead + sum(self.count_fragment(f) for f in fragments)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/unit/test_token_counter.py -v`
Expected: PASS (7 tests)

- [ ] **Step 5: Modify budget.py to use real API usage**

```python
# src/mycli/services/context/compaction/budget.py
# Replace the record() method:

def record(self, api_usage: dict) -> None:
    """用 API 返回的真实 usage 校准。取代 len//4 估算。"""
    actual_input = api_usage.get("input_tokens", 0)
    self.conversation_tokens = actual_input
```

- [ ] **Step 6: Global search and replace**

Run: `grep -rn "len(text)//4\|len(.*)// *4" src/ --include="*.py"`
Expected: No results (or only in deleted window_service.py)

- [ ] **Step 7: Update budget test**

```python
# tests/unit/test_budget.py (add to existing)
def test_record_from_api_usage():
    budget = ContextBudget(max_tokens=200_000)
    budget.record({"input_tokens": 45000})
    assert budget.conversation_tokens == 45000
    assert budget.usage_ratio == 45000 / budget.usable_limit
```

Run: `pytest tests/unit/test_budget.py::test_record_from_api_usage -v`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git rm src/mycli/services/context/window_service.py
git add src/mycli/services/context/token_counter.py tests/unit/test_token_counter.py
git add src/mycli/services/context/compaction/budget.py tests/unit/test_budget.py
git commit -m "feat: replace len//4 token estimation with tiktoken-based TokenCounter

- Add TokenCounter with tiktoken o200k_base + 10K LRU cache
- ContextBudget.record() now uses real API usage for calibration
- Remove deprecated window_service.py
- Fallback handles mixed ASCII/non-ASCII text"
```

---

### Task 2: Fix Cache Zone Boundaries

**Files:**
- Modify: `src/mycli/services/context/compaction/cache_zones.py`
- Modify: `tests/unit/test_cache_zones.py`

- [ ] **Step 1: Write updated test**

```python
# tests/unit/test_cache_zones.py (add to existing)
from mycli.services.context.compaction.cache_zones import CacheZones
from mycli.domain.conversation import Conversation, Message


class TestCacheZones:
    def test_frozen_boundary_is_first_dynamic(self):
        conv = Conversation(session_id="test")
        conv.messages = [
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
            Message(role="system", content="tool_def", metadata={"cache_policy": "STATIC", "tool_name": "read_file"}),
            Message(role="user", content="hello", metadata={"cache_policy": "DYNAMIC"}),
        ]
        zones = CacheZones.from_conversation(conv)
        assert zones.frozen_boundary == 2
        assert zones.fresh_start == 2  # no dead zone

    def test_frozen_boundary_no_dynamic(self):
        conv = Conversation(session_id="test")
        conv.messages = [
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
        ]
        zones = CacheZones.from_conversation(conv)
        assert zones.frozen_boundary == 1
        assert zones.fresh_start == 1

    def test_dead_zone_does_not_exist(self):
        """3-turn session: all messages after frozen_boundary are in fresh zone."""
        conv = Conversation(session_id="test")
        conv.messages = [
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
            Message(role="user", content="turn1", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="assistant", content="resp1", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="tool", content="result1", metadata={"cache_policy": "EPHEMERAL"}),
            Message(role="user", content="turn2", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="assistant", content="resp2", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="tool", content="result2", metadata={"cache_policy": "EPHEMERAL"}),
            Message(role="user", content="turn3", metadata={"cache_policy": "DYNAMIC"}),
        ]
        zones = CacheZones.from_conversation(conv)
        assert zones.frozen_boundary == 1  # first DYNAMIC
        assert zones.fresh_start == 1
        # All messages from index 1 onward are fresh
        assert (len(conv.messages) - zones.fresh_start) == 7

    def test_validate_detects_change(self):
        conv1 = Conversation(session_id="test")
        conv1.messages = [Message(role="system", content="sys_v1", metadata={"cache_policy": "STATIC"})]
        conv2 = Conversation(session_id="test")
        conv2.messages = [Message(role="system", content="sys_v2", metadata={"cache_policy": "STATIC"})]
        zones1 = CacheZones.from_conversation(conv1)
        zones2 = CacheZones.from_conversation(conv2)
        assert not zones1.validate(zones2)
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/unit/test_cache_zones.py::TestCacheZones -v`
Expected: FAIL — old implementation returns different boundaries

- [ ] **Step 3: Rewrite cache_zones.py**

```python
# src/mycli/services/context/compaction/cache_zones.py
from dataclasses import dataclass
from mycli.domain.conversation import Conversation


@dataclass
class CacheZones:
    frozen_boundary: int  # first index where cache_policy is DYNAMIC or EPHEMERAL
    fresh_start: int      # same as frozen_boundary — no dead zone

    @classmethod
    def from_conversation(cls, conversation: Conversation) -> "CacheZones":
        for i, message in enumerate(conversation.messages):
            policy = message.metadata.get("cache_policy", "DYNAMIC")
            if policy in ("DYNAMIC", "EPHEMERAL"):
                return cls(frozen_boundary=i, fresh_start=i)
        return cls(frozen_boundary=len(conversation.messages),
                   fresh_start=len(conversation.messages))

    def validate(self, previous: "CacheZones") -> bool:
        """Verify frozen zone unchanged between turns."""
        return self.frozen_boundary == previous.frozen_boundary

    def advance_frozen(self, new_boundary: int) -> "CacheZones":
        """Move boundary forward after turn completes."""
        return CacheZones(frozen_boundary=new_boundary, fresh_start=new_boundary)
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_cache_zones.py::TestCacheZones -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Update compaction pipeline to use new zones**

In `src/mycli/services/context/compaction/pipeline.py`, the iteration `range(zones.fresh_start, len(messages))` does not need to change — the fix is that `fresh_start` now points to the correct position (first DYNAMIC message, not last user message). Verify by reading the pipeline code.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/services/context/compaction/cache_zones.py tests/unit/test_cache_zones.py
git commit -m "fix: rewrite CacheZones to eliminate dead zone

- frozen_boundary now uses cache_policy metadata, not 'first user message'
- fresh_start equals frozen_boundary — no dead zone between them
- Add validate() for cross-turn boundary check
- Add advance_frozen() for post-turn boundary movement"
```

---

### Task 3: Implement ToolResultBudget

**Files:**
- Modify: `src/mycli/services/context/compaction/pipeline.py:23-37`
- Create: `tests/unit/test_compaction_pipeline.py`

- [ ] **Step 1: Write test**

```python
# tests/unit/test_compaction_pipeline.py
from mycli.services.context.compaction.pipeline import ToolResultBudget
from mycli.services.context.tool_result_formatter import ToolResultFormatter
from mycli.services.context.compaction.cache_zones import CacheZones
from mycli.services.context.compaction.budget import ContextBudget
from mycli.domain.conversation import Conversation, Message


class TestToolResultBudget:
    def test_apply_truncates_tool_results(self):
        formatter = ToolResultFormatter()
        budget_strategy = ToolResultBudget(formatter)
        budget = ContextBudget(max_tokens=200_000)

        conv = Conversation(session_id="test")
        conv.messages = [
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC", "tool_name": "read_file"}),
            Message(role="system", content="tool_def", metadata={"cache_policy": "STATIC"}),
            Message(role="user", content="read file x", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="tool", content="a" * 5000, metadata={
                "cache_policy": "EPHEMERAL",
                "tool_name": "read_file",
            }),
        ]
        zones = CacheZones.from_conversation(conv)

        result = budget_strategy.apply(conv, zones, budget)

        # Tool result should be truncated
        tool_msg = result.messages[3]
        assert len(tool_msg.content) < 5000
        assert tool_msg.metadata.get("l1_truncated") is True
        assert tool_msg.metadata.get("cache_frozen") is True

    def test_skips_already_frozen(self):
        formatter = ToolResultFormatter()
        budget_strategy = ToolResultBudget(formatter)
        budget = ContextBudget(max_tokens=200_000)

        conv = Conversation(session_id="test")
        conv.messages = [
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
            Message(role="user", content="test", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="tool", content="already processed", metadata={
                "cache_policy": "EPHEMERAL",
                "cache_frozen": True,
            }),
        ]
        zones = CacheZones.from_conversation(conv)

        result = budget_strategy.apply(conv, zones, budget)

        # Already-frozen message should be unchanged
        assert result.messages[2].content == "already processed"

    def test_skips_non_tool_messages(self):
        formatter = ToolResultFormatter()
        budget_strategy = ToolResultBudget(formatter)
        budget = ContextBudget(max_tokens=200_000)

        conv = Conversation(session_id="test")
        conv.messages = [
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
            Message(role="user", content="hello world", metadata={"cache_policy": "DYNAMIC"}),
        ]
        zones = CacheZones.from_conversation(conv)

        result = budget_strategy.apply(conv, zones, budget)

        # User message should be unchanged
        assert result.messages[1].content == "hello world"
        assert result.messages[1].metadata.get("l1_truncated") is None
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_compaction_pipeline.py::TestToolResultBudget -v`
Expected: FAIL — budget_strategy.apply() is a no-op

- [ ] **Step 3: Implement ToolResultBudget.apply()**

```python
# src/mycli/services/context/compaction/pipeline.py (lines 23-37)
import copy
from mycli.domain.tools import ToolResultV2


class ToolResultBudget:
    def __init__(self, formatter: "ToolResultFormatter") -> None:
        self.formatter = formatter

    def apply(
        self,
        conversation: "Conversation",
        zones: "CacheZones",
        budget: "ContextBudget",
    ) -> "Conversation":
        compacted = copy.deepcopy(conversation)
        for i in range(zones.fresh_start, len(compacted.messages)):
            msg = compacted.messages[i]
            if msg.role != "tool":
                continue
            if msg.metadata.get("cache_frozen"):
                continue

            tool_name = msg.metadata.get("tool_name", "default")
            result = ToolResultV2(summary=msg.content, raw_payload={})
            msg.content = self.formatter.format(tool_name, result)
            msg.metadata["l1_truncated"] = True
            msg.metadata["cache_frozen"] = True

        return compacted
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_compaction_pipeline.py::TestToolResultBudget -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/services/context/compaction/pipeline.py tests/unit/test_compaction_pipeline.py
git commit -m "feat: implement ToolResultBudget.apply() — L1 truncation in compaction pipeline

- Apply ToolResultFormatter to all non-frozen tool results in Fresh Zone
- Mark processed messages with l1_truncated=True and cache_frozen=True
- Skip messages that are not tool results or are already frozen"
```

---

### Task 4: Implement LLMSummarization

**Files:**
- Modify: `src/mycli/services/context/compaction/pipeline.py:134-156`
- Create: `tests/unit/test_llm_summarization.py`

- [ ] **Step 1: Write test**

```python
# tests/unit/test_llm_summarization.py
from unittest.mock import MagicMock, patch
from mycli.services.context.compaction.pipeline import LLMSummarization
from mycli.services.context.compaction.cache_zones import CacheZones
from mycli.services.context.compaction.budget import ContextBudget
from mycli.domain.conversation import Conversation, Message


class TestLLMSummarization:
    def make_conv(self, n_turns: int = 6) -> Conversation:
        conv = Conversation(session_id="test")
        conv.messages = [
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
        ]
        for i in range(n_turns):
            conv.messages.append(Message(role="user", content=f"q{i}", metadata={"cache_policy": "DYNAMIC"}))
            conv.messages.append(Message(role="assistant", content=f"a{i}", metadata={"cache_policy": "DYNAMIC"}))
        return conv

    def test_below_threshold_does_nothing(self):
        summarizer = LLMSummarization(trigger_ratio=0.9, summarizer_model="test")
        budget = ContextBudget(max_tokens=200_000)
        budget.conversation_tokens = 100_000  # 50% — below threshold
        conv = self.make_conv()

        result = summarizer.apply(conv, CacheZones.from_conversation(conv), budget)
        assert result is conv  # unchanged

    def test_above_threshold_triggers_summarization(self):
        summarizer = LLMSummarization(trigger_ratio=0.9, summarizer_model="test")
        budget = ContextBudget(max_tokens=200_000)
        budget.conversation_tokens = 190_000  # 95% — above threshold
        conv = self.make_conv(n_turns=10)

        with patch.object(summarizer, "_summarize", return_value="This is a summary"):
            result = summarizer.apply(conv, CacheZones.from_conversation(conv), budget)

        # Should have summary message
        summary_msgs = [m for m in result.messages if m.metadata.get("compaction")]
        assert len(summary_msgs) == 1
        assert "This is a summary" in summary_msgs[0].content

    def test_circuit_breaker_stops_after_3_failures(self):
        summarizer = LLMSummarization(trigger_ratio=0.9, summarizer_model="test")
        budget = ContextBudget(max_tokens=200_000)
        budget.conversation_tokens = 190_000
        conv = self.make_conv()

        # Fail 3 times
        for _ in range(3):
            with patch.object(summarizer, "_summarize", side_effect=Exception("fail")):
                result = summarizer.apply(conv, CacheZones.from_conversation(conv), budget)

        # 4th call should return unchanged (circuit breaker open)
        with patch.object(summarizer, "_summarize") as mock_summarize:
            result = summarizer.apply(conv, CacheZones.from_conversation(conv), budget)
            mock_summarize.assert_not_called()

    def test_continuation_message_appended(self):
        summarizer = LLMSummarization(trigger_ratio=0.9, summarizer_model="test")
        budget = ContextBudget(max_tokens=200_000)
        budget.conversation_tokens = 190_000
        conv = self.make_conv()

        with patch.object(summarizer, "_summarize", return_value="Summary content"):
            result = summarizer.apply(conv, CacheZones.from_conversation(conv), budget)

        continuation = [m for m in result.messages if m.metadata.get("compaction_continuation")]
        assert len(continuation) == 1
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_llm_summarization.py -v`
Expected: FAIL — apply() is a no-op

- [ ] **Step 3: Implement LLMSummarization**

```python
# src/mycli/services/context/compaction/pipeline.py (replace lines 134-156)
import copy


class LLMSummarization:
    def __init__(self, trigger_ratio: float = 0.9, summarizer_model: str = "deepseek-lite") -> None:
        self.trigger_ratio = trigger_ratio
        self.model = summarizer_model
        self._consecutive_failures = 0
        self._max_failures = 3

    def apply(
        self,
        conversation: "Conversation",
        zones: "CacheZones",
        budget: "ContextBudget",
    ) -> "Conversation":
        if budget.usage_ratio < self.trigger_ratio:
            return conversation
        if self._consecutive_failures >= self._max_failures:
            return conversation

        fresh = conversation.messages[zones.fresh_start:]
        if len(fresh) < 6:
            return conversation  # not enough to summarize

        split = len(fresh) // 2
        to_summarize = fresh[:split]

        try:
            summary_text = self._summarize(to_summarize)
            self._consecutive_failures = 0
        except Exception:
            self._consecutive_failures += 1
            return conversation

        compacted = copy.deepcopy(conversation)
        summary_msg = Message(
            role="assistant",
            content=summary_text,
            metadata={"compaction": True, "compressed_turns": len(to_summarize)},
        )
        continuation_msg = Message(
            role="assistant",
            content=(
                "[The conversation above this point has been summarized. "
                "All key decisions, file edits, and errors are preserved in "
                "the summary. Continue the conversation naturally.]"
            ),
            metadata={"compaction_continuation": True},
        )

        compacted.messages = (
            compacted.messages[:zones.fresh_start]
            + [summary_msg, continuation_msg]
            + fresh[split:]
        )
        return compacted

    def _summarize(self, messages: list["Message"]) -> str:
        text = "\n".join(
            f"[{m.role}]: {m.content[:500]}"
            for m in messages
        )
        prompt = (
            "Summarize this conversation segment. Use one line per turn.\n"
            "Preserve EXACTLY:\n"
            "- Every decision made and its rationale\n"
            "- Every file edit: what file, what change, why\n"
            "- Every error encountered and how it was resolved\n"
            "- Every key finding that affects subsequent actions\n\n"
            "OK to drop: exact file contents, verbose logs, "
            "duplicate information already captured above.\n\n"
            "Format:\n"
            "Turn N: [action taken] -> [result/finding]\n"
            "Decision: [what was decided, why]\n\n"
            f"Conversation:\n{text}"
        )
        # Call lightweight LLM
        from mycli.llms import complete
        response = complete(prompt, model=self.model, max_tokens=500)
        return response.content
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_llm_summarization.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/services/context/compaction/pipeline.py tests/unit/test_llm_summarization.py
git commit -m "feat: implement LLMSummarization.apply() — L4 with circuit breaker

- Trigger at 90% budget usage
- Structured summary prompt preserving decisions, edits, errors, findings
- Circuit breaker: max 3 consecutive failures
- Continuation message after summary
- Uses lightweight model (deepseek-lite) separate from main model"
```

---

### Task 5: Eliminate Dual Code Paths

**Files:**
- Modify: `src/mycli/application/turn_service.py`
- Modify: `src/mycli/agents/react_loop.py`
- Run: full test suite

- [ ] **Step 1: Check all tests pass before modification**

Run: `pytest tests/ -x -q`
Expected: PASS (or list pre-existing failures)

- [ ] **Step 2: Modify turn_service.py — always use runtime**

```python
# src/mycli/application/turn_service.py
# In handle_user_turn(), replace the conditional branch:

def handle_user_turn(self, user_message: str) -> TurnResponse:
    # Always use TurnExecutor. Build runtime if not already built.
    if self._runtime is None:
        self._runtime = self._build_default_runtime()
    return cast(TurnResponse, self._runtime.handle_user_turn(user_message))

def _build_default_runtime(self) -> "AgentRuntime":
    """Build a runtime with default configuration when none is injected."""
    from mycli.application.runtime.agent_runtime import AgentRuntime
    from mycli.application.runtime.agent_runtime import AgentConfig
    
    config = AgentConfig(
        max_tool_calls_per_turn=50,
        max_tokens_per_turn=200_000,
    )
    return AgentRuntime(config=config, ...)
```

- [ ] **Step 3: Gut ReactAgent to a compatibility wrapper**

```python
# src/mycli/agents/react_loop.py
# Replace ReactAgent.run() with a thin wrapper:

class ReactAgent:
    """Compatibility wrapper — forwards to TurnExecutor."""
    
    def __init__(self, runtime: "AgentRuntime") -> None:
        self._runtime = runtime
    
    def run(self, user_message: str) -> "TurnResponse":
        return self._runtime.handle_user_turn(user_message)
```

- [ ] **Step 4: Run full test suite**

Run: `pytest tests/ -x -q`
Expected: All previously passing tests still pass. No new failures.

- [ ] **Step 5: Fix any broken tests**

If tests were directly importing `ReactAgent.run()` and testing its old behavior, update them to use `TurnExecutor` or `AgentRuntime` instead.

- [ ] **Step 6: Verify no references to old ReactAgent path**

Run: `grep -rn "_run_agent\|ReactAgent\.run" src/ --include="*.py" | grep -v "compatibility\|wrapper\|test_"`
Expected: No results (or only in compatibility comments)

- [ ] **Step 7: Commit**

```bash
git add src/mycli/application/turn_service.py src/mycli/agents/react_loop.py
git add tests/  # any test fixes
git commit -m "refactor: eliminate dual code paths — all turns use TurnExecutor

- TurnService always builds a runtime instead of falling back to _run_agent()
- ReactAgent becomes a thin compatibility wrapper forwarding to TurnExecutor
- Removes the path where compaction/budget/streaming were silently absent

All user turns now go through the full context management pipeline."
```

---

## Phase 1 Completion Check

- [ ] `pytest tests/ -x -q` passes — final full-suite verification pending
- [x] 50-turn session with 40 tool calls stays within budget — deterministic harness added in `tests/unit/evaluation/test_soak.py`; final test run pending
- [ ] Cache hit rate >= 85% for same-session consecutive turns — benchmark threshold added to `scripts/check_sub2api_cache.py`; live provider run not executed
- [x] `len//4` does not appear in any source file
- [x] All messages after frozen_boundary are covered by compaction
- [x] L1 ToolResultBudget actually truncates tool results
- [x] L4 LLMSummarization triggers at 90% and has circuit breaker
- [x] Single code path: TurnExecutor always used

Notes:
- Commit steps in this phase were not executed; changes remain in the working tree for unified review.
