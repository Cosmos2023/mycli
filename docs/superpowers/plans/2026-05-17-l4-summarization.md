# L4 Summarization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `_call_summarizer()` string-concatenation stub with real LLM call + post-compact file hints.

**Architecture:** `LLMSummarization.__init__()` accepts an optional `summarizer_client: SummarizerClient | None`. When `None`, L4 skips (preserving current stub behavior for tests). `AgentRuntime` injects a `SummarizerClient` wrapping the existing `ModelTurnRequester`. `_call_summarizer()` sends a 9-section structured prompt via the client. Post-compact file hints passed as `runtime_reminders` (volatile, not persisted to conversation). LLM failure propagates to existing circuit breaker.

**Tech Stack:** Python 3.12+, pytest. Existing `ModelTurnRequester`. No new LLM client.

**Spec:** `docs/superpowers/specs/2026-05-17-l4-summarization.md`

**Pre-check:**
- `LLMSummarization.__init__()` (pipeline.py:202-218): has `model_name` param but NO `summarizer_client` param
- `LLMSummarization._call_summarizer()` (pipeline.py:351-359): pure string stub, no LLM call
- `AgentRuntime` (agent_runtime.py:129-139): constructs `LLMSummarization(model_name=config.model, ...)` without client injection
- `ModelTurnRequester` exists in `src/mycli/application/runtime/request/` — actual LLM caller

---

### Task 1: Add SummarizerClient protocol + wire into LLMSummarization

**Files:**
- Modify: `src/mycli/services/context/compaction/pipeline.py` — `LLMSummarization.__init__` + `_call_summarizer`
- Create: `tests/unit/test_l4_summarizer.py`

**What changes:** Add `SummarizerClient` protocol. Add `summarizer_client` parameter to `LLMSummarization.__init__`. `_call_summarizer()` uses it when available, falls through to current stub when `None`.

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/test_l4_summarizer.py
import pytest
from unittest.mock import MagicMock
from mycli.services.context.compaction.pipeline import LLMSummarization
from mycli.domain.conversation import Message


class TestL4Summarizer:
    def test_uses_client_when_provided(self):
        mock_client = MagicMock()
        mock_client.complete.return_value = "## Summary\n\n1. Refactor auth\n..."

        summarizer = LLMSummarization(
            trigger_ratio=0.1,
            summarizer_client=mock_client,
            summarizer_model_name="test-lite",
        )

        msgs = [
            Message(role="user", content="Refactor auth module"),
            Message(role="assistant", content="Reading auth.py"),
        ]

        result = summarizer._call_summarizer(msgs)

        assert mock_client.complete.called
        call_args = mock_client.complete.call_args[1]
        prompt = call_args["messages"][0]["content"]
        assert "1. Primary Request" in prompt
        assert result == "## Summary\n\n1. Refactor auth\n..."

    def test_falls_back_to_stub_when_no_client(self):
        summarizer = LLMSummarization(trigger_ratio=0.1, summarizer_client=None)

        msgs = [
            Message(role="user", content="test"),
            Message(role="assistant", content="response"),
        ]

        result = summarizer._call_summarizer(msgs)
        assert "Conversation summary:" in result
        assert "user" in result

    def test_failure_propagates_to_circuit_breaker(self):
        mock_client = MagicMock()
        mock_client.complete.side_effect = Exception("API error")

        summarizer = LLMSummarization(
            trigger_ratio=0.1,
            summarizer_client=mock_client,
        )

        msgs = [Message(role="user", content="test")]

        with pytest.raises(Exception, match="API error"):
            summarizer._call_summarizer(msgs)

        # Circuit breaker in apply() intercepts, _failure_count += 1

    def test_empty_messages_placeholder(self):
        summarizer = LLMSummarization(trigger_ratio=0.9)
        assert summarizer._call_summarizer([]) == "Conversation summary unavailable."
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/unit/test_l4_summarizer.py -v`
Expected: FAIL — `LLMSummarization.__init__` has no `summarizer_client` parameter

- [ ] **Step 3: Add SummarizerClient protocol + update __init__**

```python
# src/mycli/services/context/compaction/pipeline.py

from typing import Protocol


class SummarizerClient(Protocol):
    def complete(
        self,
        *,
        messages: list[dict[str, str]],
        model: str,
        max_tokens: int,
    ) -> object: ...


class LLMSummarization:
    def __init__(
        self,
        *,
        trigger_ratio: float = 0.9,
        model_name: str | None = None,
        trigger_ratios_by_model: dict[str, float] | None = None,
        cost_profile: CompactionCostProfile | None = None,
        cost_profiles_by_model: dict[str, CompactionCostProfile] | None = None,
        max_consecutive_failures: int = 3,
        summarizer_client: SummarizerClient | None = None,
        summarizer_model_name: str | None = None,
    ) -> None:
        self._trigger_ratio = trigger_ratio
        self._model_name = model_name
        self._trigger_ratios_by_model = dict(trigger_ratios_by_model or {})
        self._cost_profile = cost_profile or CompactionCostProfile()
        self._cost_profiles_by_model = dict(cost_profiles_by_model or {})
        self._max_failures = max_consecutive_failures
        self._failure_count = 0
        self._last_cost_metrics: dict[str, int | float | str] | None = None
        self._summarizer_client = summarizer_client
        self._summarizer_model_name = summarizer_model_name
```

- [ ] **Step 4: Replace `_call_summarizer()`**

```python
SUMMARY_PROMPT = (
    "Summarize this conversation. Output exactly these 9 sections. "
    "Each section 1-3 sentences unless noted. Keep total output under 300 words.\n\n"
    "## 1. Primary Request\n"
    "The user's original goal.\n\n"
    "## 2. Key Technical Concepts\n"
    "Frameworks, patterns, architectures. List only.\n\n"
    "## 3. Files Examined or Edited\n"
    "Full paths. Mark edited files with [EDITED].\n\n"
    "## 4. Errors and Fixes\n"
    "Each error → resolution. Write 'None.' if none.\n\n"
    "## 5. Decisions Made\n"
    "What was decided and why. One line each.\n\n"
    "## 6. All User Messages\n"
    "Preserved as close to verbatim as possible.\n\n"
    "## 7. Pending Tasks\n"
    "Work not yet done. Write 'None.' if none.\n\n"
    "## 8. Current Work\n"
    "What was in progress when this summary was created.\n\n"
    "## 9. Optional Next Step\n"
    "Write 'N/A' if unclear.\n\n"
    "---\n\n"
    "Conversation:\n"
    "{conversation_text}\n\n"
    "---\n\n"
    "Summary:"
)


def _call_summarizer(self, messages: list[Message]) -> str:
    if self._summarizer_client is None:
        return self._fallback_summary(messages)

    conversation_text = "\n".join(
        f"[{m.role}]: {m.content[:500]}"
        for m in messages
        if m.content.strip()
    )
    if not conversation_text:
        return "Conversation summary unavailable."

    prompt = SUMMARY_PROMPT.format(conversation_text=conversation_text)
    model = self._summarizer_model_name or "deepseek-lite"

    response = self._summarizer_client.complete(
        messages=[{"role": "user", "content": prompt}],
        model=model,
        max_tokens=600,
    )
    content = getattr(response, "content", str(response))
    return content.strip()


def _fallback_summary(self, messages: list[Message]) -> str:
    """Kept for backward compat when summarizer_client is None."""
    lines = [
        f"- {m.role}: {' '.join(m.content.split())[:120]}"
        for m in messages if m.content.strip()
    ]
    if not lines:
        return "Conversation summary unavailable."
    return "Conversation summary:\n" + "\n".join(lines)
```

- [ ] **Step 5: Run test**

Run: `pytest tests/unit/test_l4_summarizer.py -v`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/mycli/services/context/compaction/pipeline.py tests/unit/test_l4_summarizer.py
git commit -m "feat: add SummarizerClient injection to L4

- LLMSummarization accepts optional summarizer_client (Protocol)
- _call_summarizer() uses client when available, 9-section structured prompt
- Falls back to string stub when client is None (backward compat)
- Failure propagates to existing circuit breaker in apply()
- summarizer_model_name separate from main model_name"
```

---

### Task 2: Inject summarizer client from AgentRuntime

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py` — LLMSummarization construction

**What changes:** When constructing `LLMSummarization`, wrap `ModelTurnRequester` as `SummarizerClient` and pass it in. Use a separate summarizer model (`deepseek-lite` or configurable) rather than the main model.

- [ ] **Step 1: Write failing test**

```python
# tests/unit/application/test_agent_runtime_l4.py
from unittest.mock import MagicMock
from mycli.application.runtime.agent_runtime import AgentRuntime


class TestAgentRuntimeL4Injection:
    def test_l4_has_summarizer_client(self, mock_config, mock_services):
        runtime = AgentRuntime(config=mock_config(L4=True))
        pipeline = runtime._compaction_pipeline
        summarizer = pipeline.llm_summarization

        assert summarizer._summarizer_client is not None
        assert summarizer._summarizer_model_name is not None

    def test_l4_skips_when_client_disabled(self, mock_config, mock_services):
        runtime = AgentRuntime(config=mock_config(L4=False))
        summarizer = runtime._compaction_pipeline.llm_summarization

        assert summarizer._summarizer_client is None
        # Falls back to string stub
        msgs = [MagicMock(role="user", content="test", metadata={})]
        result = summarizer._call_summarizer(msgs)
        assert "Conversation summary:" in result
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/application/test_agent_runtime_l4.py -v`
Expected: FAIL — `summarizer_client` not passed

- [ ] **Step 3: Modify AgentRuntime L4 construction**

In `src/mycli/application/runtime/agent_runtime.py`, lines 129-139:

```python
# Build summarizer client from existing ModelTurnRequester
summarizer_client = _SummarizerClientAdapter(self._model_turn_requester)

llm_summarization=LLMSummarization(
    trigger_ratio=config.compaction_l4_trigger_ratio,
    model_name=config.model,
    trigger_ratios_by_model=config.compaction_l4_trigger_ratios_by_model,
    cost_profile=CompactionCostProfile(...),
    summarizer_client=summarizer_client,
    summarizer_model_name=getattr(config, 'compaction_l4_summarizer_model', None)
        or "deepseek-lite",
)
```

Add adapter class in same file or pipeline.py:

```python
class _SummarizerClientAdapter:
    """Adapt ModelTurnRequester → SummarizerClient protocol."""
    def __init__(self, requester):
        self._requester = requester

    def complete(self, *, messages, model, max_tokens):
        from mycli.llms.adapters.compat_chat_adapter import ChatCompletionClient
        # Delegate to the underlying client
        client = getattr(self._requester, '_client', None)
        if client is not None and hasattr(client, 'complete'):
            return client.complete(messages=messages, model=model, max_tokens=max_tokens)
        raise RuntimeError("Summarizer client not available")
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/application/test_agent_runtime_l4.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/application/runtime/agent_runtime.py tests/unit/application/test_agent_runtime_l4.py
git commit -m "feat: inject SummarizerClient into L4 from AgentRuntime

- AgentRuntime wraps ModelTurnRequester as SummarizerClient
- Passes separate summarizer_model_name (deepseek-lite default)
- L4 falls back to string stub when client is None
- _SummarizerClientAdapter bridges protocol gap"
```

---

### Task 3: Post-compact file hints via runtime_reminders

**Files:**
- Modify: `src/mycli/services/context/compaction/pipeline.py` — `_collect_recent_files()`
- Modify: `src/mycli/application/runtime/turn_executor.py` — wire hints to runtime_reminders
- Create: `tests/unit/test_l4_rehydration.py`

**What changes:** `_collect_recent_files()` extracts recently touched file paths from the summarized messages. `LLMSummarization.apply()` returns these as metadata on the compacted conversation. TurnExecutor picks them up and adds to `runtime_reminders` for the next request. **Does not inject Read tool calls into the transcript.**

- [ ] **Step 1: Write test**

```python
# tests/unit/test_l4_rehydration.py
from mycli.services.context.compaction.pipeline import _collect_recent_files
from mycli.domain.conversation import Message
from mycli.domain.runtime import RuntimeBlock


def _make_tool_msg(tool_name, path, role="tool", tool_call_id="c1"):
    return Message(
        role=role, content="ok", tool_call_id=tool_call_id,
        metadata={"tool_name": tool_name, "path": path},
        blocks=(RuntimeBlock(
            type="tool_result", text="ok", call_id=tool_call_id,
            metadata={"tool_name": tool_name, "path": path},
        ),),
    )


class TestRehydration:
    def test_collects_edited_first(self):
        msgs = [
            _make_tool_msg("Read", "a.py"),
            _make_tool_msg("Read", "b.py"),
            _make_tool_msg("Edit", "c.py"),
        ]
        result = _collect_recent_files(msgs, n=3)
        assert result[0] == "c.py"  # edited first

    def test_no_files_returns_empty(self):
        msgs = [Message(role="user", content="hello")]
        assert _collect_recent_files(msgs) == []

    def test_deduplicates_paths(self):
        msgs = [
            _make_tool_msg("Read", "auth.py"),
            _make_tool_msg("Read", "auth.py"),
        ]
        result = _collect_recent_files(msgs, n=3)
        assert len(result) == 1

    def test_frozen_zone_unchanged_after_l4_apply(self, monkeypatch):
        from mycli.services.context.compaction.pipeline import LLMSummarization
        from mycli.services.context.compaction.cache_zones import CacheZones
        from mycli.services.context.compaction.budget import ContextBudget
        from mycli.domain.conversation import Conversation

        summarizer = LLMSummarization(trigger_ratio=0.1, summarizer_client=None)
        budget = ContextBudget(max_tokens=200_000)
        budget.total_tokens = 190_000

        conv = Conversation(session_id="test")
        conv.messages = [
            Message(role="system", content="FROZEN_sys", metadata={"cache_policy": "STATIC"}),
            Message(role="system", content="FROZEN_tool", metadata={"cache_policy": "STATIC"}),
            Message(role="user", content="test", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="assistant", content="resp", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="tool", content="r", tool_call_id="c1",
                    metadata={"tool_name": "Read", "path": "a.py"}),
            Message(role="assistant", content="done", metadata={"cache_policy": "DYNAMIC"}),
        ]

        zones = CacheZones.from_conversation(conv)
        frozen_before = [
            (m.content, dict(m.metadata))
            for m in conv.messages[:zones.fresh_start]
        ]

        result = summarizer.apply(conv, zones, budget)
        frozen_after = [
            (m.content, dict(m.metadata))
            for m in result.messages[:zones.fresh_start]
        ]

        assert frozen_before == frozen_after, "FROZEN ZONE changed after L4"
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_l4_rehydration.py -v`
Expected: FAIL — `_collect_recent_files` not defined

- [ ] **Step 3: Implement `_collect_recent_files()`**

```python
# src/mycli/services/context/compaction/pipeline.py


def _collect_recent_files(messages: list[Message], n: int = 3) -> list[str]:
    edited: list[str] = []
    read: list[str] = []
    seen: set[str] = set()

    for message in reversed(messages):
        if message.role != "tool":
            continue
        path = _extract_tool_path(message)
        if not path or path in seen:
            continue
        seen.add(path)
        tool_name = _extract_tool_name(message)
        if tool_name in ("Edit", "Write", "edit_file", "write_file"):
            edited.append(path)
        elif tool_name in ("Read", "read_file"):
            read.append(path)

    return (edited + read)[:n]


def _extract_tool_path(message: Message) -> str | None:
    for block in message.blocks:
        if block.type == "tool_result":
            path = block.metadata.get("path")
            if isinstance(path, str) and path:
                return path
    return message.metadata.get("path")


def _extract_tool_name(message: Message) -> str:
    for block in message.blocks:
        if block.type == "tool_result":
            name = block.metadata.get("tool_name")
            if isinstance(name, str) and name:
                return name
    return message.metadata.get("tool_name", "")
```

- [ ] **Step 4: Store hints in compaction metadata**

In `LLMSummarization.apply()`, after the compaction message is built, attach `recent_files` to the cost_metrics so TurnExecutor can read it:

```python
cost_metrics["recent_files"] = _collect_recent_files(to_summarize, n=3)
```

- [ ] **Step 5: Wire in TurnExecutor** (minimal)

In `turn_executor.py`, after `compaction_pipeline.apply()` returns, check if the compacted conversation has `recent_files` in the summary metadata. If so, add to `runtime_reminders`:

```python
cost_metrics = runtime._compaction_pipeline.llm_summarization.last_cost_metrics
if cost_metrics and "recent_files" in cost_metrics:
    files = cost_metrics["recent_files"]
    if files:
        reminders.append(
            f"[Compaction applied. Recent files: {', '.join(files)}. "
            f"Re-read these files if you need current content.]"
        )
```

- [ ] **Step 6: Run all tests**

Run: `pytest tests/unit/test_l4_rehydration.py tests/unit/test_l4_summarizer.py -v`
Expected: PASS (8 tests)

- [ ] **Step 7: Commit**

```bash
git add src/mycli/services/context/compaction/pipeline.py \
        src/mycli/application/runtime/turn_executor.py \
        tests/unit/test_l4_rehydration.py
git commit -m "feat: add post-compact file hints via runtime_reminders

- _collect_recent_files() finds recently touched files (edited > read)
- Hints passed as runtime_reminders, not injected into transcript
- FROZEN ZONE verified byte-level unchanged after L4 apply
- No Read tool calls injected into conversation history"
```

---

## Completion Check

- [ ] `pytest tests/unit/test_l4_summarizer.py tests/unit/test_l4_rehydration.py tests/unit/application/test_agent_runtime_l4.py -v` passes (10 tests)
- [ ] `SummarizerClient` protocol injected from `AgentRuntime`
- [ ] `_call_summarizer()` calls real LLM when client provided
- [ ] Falls back to string stub when client is `None` (backward compat)
- [ ] LLM failure propagates to existing circuit breaker
- [ ] Post-compact file hints via `runtime_reminders` (volatile, not in transcript)
- [ ] FROZEN ZONE byte-level unchanged after L4
- [ ] Existing tests (`pytest tests/unit/services/context/compaction/ -q`) still pass
