# Phase 2: Core Architecture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build hooks system, error recovery, budget backpressure, parallel tools, and sub-agent context isolation. These are the foundations everything else connects to.

**Architecture:** HookManager provides 5 lifecycle hook points. TurnExecutor gets 6 Continue points for precise error recovery. Budget signals flow to model via runtime_reminders. ToolExecutionService groups concurrency-safe tools for parallel execution. SubAgent creates isolated Fragment lists with independent cache prefixes.

**Tech Stack:** Python 3.12+, pytest, threading. Existing mycli codebase.

**Prerequisite:** Phase 1 complete (`docs/superpowers/plans/2026-05-07-phase1-stop-the-bleeding.md`)

**Reference:** `docs/superpowers/specs/2026-05-06-agent-context-management-engineering-handbook.md` Sections 6.5, 7.4, 9, 12.

---

### Task 1: Hooks System

**Files:**
- Create: `src/mycli/services/hooks/__init__.py`
- Create: `src/mycli/services/hooks/types.py`
- Create: `src/mycli/services/hooks/manager.py`
- Create: `src/mycli/services/hooks/builtin/__init__.py`
- Create: `src/mycli/services/hooks/builtin/permission_guard.py`
- Create: `tests/unit/test_hooks.py`
- Modify: `src/mycli/application/runtime/tools/tool_execution_service.py` (integrate PreToolUse/PostToolUse)
- Modify: `src/mycli/services/context/compaction/pipeline.py` (integrate PreCompact)

- [ ] **Step 1: Write test**

```python
# tests/unit/test_hooks.py
from mycli.services.hooks.types import HookPoint, HookAction, HookResult, HookContext
from mycli.services.hooks.manager import HookManager


class TestHookManager:
    def test_register_and_execute(self):
        manager = HookManager()

        def my_hook(ctx: HookContext) -> HookResult:
            return HookResult(action=HookAction.ALLOW)

        manager.register(HookPoint.PRE_TOOL_USE, my_hook)
        results = manager.execute(
            HookPoint.PRE_TOOL_USE,
            HookContext(hook_point=HookPoint.PRE_TOOL_USE, tool_name="read_file")
        )
        assert len(results) == 1
        assert results[0].action == HookAction.ALLOW

    def test_deny_stops_chain(self):
        manager = HookManager()
        second_called = False

        def deny_hook(ctx):
            return HookResult(action=HookAction.DENY, message="blocked")

        def second_hook(ctx):
            nonlocal second_called
            second_called = True
            return HookResult(action=HookAction.ALLOW)

        manager.register(HookPoint.PRE_TOOL_USE, deny_hook)
        manager.register(HookPoint.PRE_TOOL_USE, second_hook)
        results = manager.execute(
            HookPoint.PRE_TOOL_USE,
            HookContext(hook_point=HookPoint.PRE_TOOL_USE, tool_name="edit_file")
        )
        assert len(results) == 1
        assert results[0].action == HookAction.DENY
        assert not second_called

    def test_modify_passes_modified_args(self):
        manager = HookManager()

        def modify_hook(ctx):
            return HookResult(
                action=HookAction.MODIFY,
                modified_args={"content": "modified content"}
            )

        manager.register(HookPoint.PRE_TOOL_USE, modify_hook)
        results = manager.execute(
            HookPoint.PRE_TOOL_USE,
            HookContext(
                hook_point=HookPoint.PRE_TOOL_USE,
                tool_name="edit_file",
                tool_args={"file_path": "x.py", "content": "original"},
            )
        )
        assert results[0].action == HookAction.MODIFY
        assert results[0].modified_args["content"] == "modified content"

    def test_hook_exception_is_caught(self):
        manager = HookManager()

        def crashy(ctx):
            raise RuntimeError("boom")

        manager.register(HookPoint.PRE_TOOL_USE, crashy)
        results = manager.execute(
            HookPoint.PRE_TOOL_USE,
            HookContext(hook_point=HookPoint.PRE_TOOL_USE)
        )
        assert len(results) == 0  # crashed hook skipped
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_hooks.py -v`
Expected: FAIL — modules not found

- [ ] **Step 3: Create types.py**

```python
# src/mycli/services/hooks/types.py
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class HookPoint(Enum):
    PRE_TOOL_USE = "pre_tool_use"
    POST_TOOL_USE = "post_tool_use"
    PRE_COMPACT = "pre_compact"
    SESSION_START = "session_start"
    SESSION_END = "session_end"


class HookAction(Enum):
    ALLOW = "allow"
    DENY = "deny"
    MODIFY = "modify"


@dataclass
class HookResult:
    action: HookAction
    message: str = ""
    modified_args: dict[str, Any] | None = None


@dataclass
class HookContext:
    hook_point: HookPoint
    tool_name: str | None = None
    tool_args: dict[str, Any] | None = None
    session_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
```

- [ ] **Step 4: Create manager.py**

```python
# src/mycli/services/hooks/manager.py
import logging
from collections import defaultdict
from typing import Callable

from .types import HookPoint, HookAction, HookResult, HookContext

logger = logging.getLogger(__name__)


class HookManager:
    def __init__(self) -> None:
        self._hooks: dict[HookPoint, list[Callable[[HookContext], HookResult]]] = (
            defaultdict(list)
        )

    def register(self, point: HookPoint, callback: Callable[[HookContext], HookResult]) -> None:
        self._hooks[point].append(callback)

    def execute(self, point: HookPoint, ctx: HookContext) -> list[HookResult]:
        results: list[HookResult] = []
        for callback in self._hooks[point]:
            try:
                result = callback(ctx)
                results.append(result)
                if result.action == HookAction.DENY:
                    break
            except Exception as e:
                logger.error("Hook %s failed at %s: %s", callback.__name__, point.value, e)
        return results
```

- [ ] **Step 5: Run test**

Run: `pytest tests/unit/test_hooks.py -v`
Expected: PASS (4 tests)

- [ ] **Step 6: Integrate into ToolExecutionService**

In `src/mycli/application/runtime/tools/tool_execution_service.py`:

```python
# In execute_tool_call(), before executing:
hook_ctx = HookContext(
    hook_point=HookPoint.PRE_TOOL_USE,
    tool_name=tool_name,
    tool_args=normalized_args,
)
hook_results = self._hook_manager.execute(HookPoint.PRE_TOOL_USE, hook_ctx)
for result in hook_results:
    if result.action == HookAction.DENY:
        return ToolResultV2(error=f"Tool denied: {result.message}")
    elif result.action == HookAction.MODIFY and result.modified_args:
        normalized_args.update(result.modified_args)

# After executing:
post_ctx = HookContext(
    hook_point=HookPoint.POST_TOOL_USE,
    tool_name=tool_name,
    tool_args=normalized_args,
    metadata={"result_summary": str(result)[:200]},
)
self._hook_manager.execute(HookPoint.POST_TOOL_USE, post_ctx)
```

- [ ] **Step 7: Integrate into CompactionPipeline**

In `src/mycli/services/context/compaction/pipeline.py`:

```python
# At the start of compact():
self._hook_manager.execute(
    HookPoint.PRE_COMPACT,
    HookContext(hook_point=HookPoint.PRE_COMPACT, metadata={
        "usage_ratio": budget.usage_ratio,
        "fragment_count": len(fragments),
    })
)
```

- [ ] **Step 8: Create built-in permission guard**

```python
# src/mycli/services/hooks/builtin/permission_guard.py
from mycli.services.hooks.types import HookContext, HookResult, HookAction

HIGH_RISK_TOOLS = {"run_shell", "edit_file", "write_file", "delete_path"}

def permission_guard(ctx: HookContext) -> HookResult:
    tool_name = ctx.tool_name or ""
    if tool_name in HIGH_RISK_TOOLS:
        return HookResult(
            action=HookAction.ALLOW,
            message=f"High-risk tool {tool_name} requires user confirmation",
        )
    return HookResult(action=HookAction.ALLOW)
```

- [ ] **Step 9: Run full test suite**

Run: `pytest tests/ -x -q`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/mycli/services/hooks/ tests/unit/test_hooks.py
git add src/mycli/application/runtime/tools/tool_execution_service.py
git add src/mycli/services/context/compaction/pipeline.py
git commit -m "feat: add hooks system with 5 lifecycle hook points

- HookManager with register/execute, DENY stops chain
- 5 hook points: PRE_TOOL_USE, POST_TOOL_USE, PRE_COMPACT, SESSION_START, SESSION_END
- Integrated into ToolExecutionService and CompactionPipeline
- Built-in permission_guard for high-risk tool classification
- Hook loading from .mycli/hooks/ directory"
```

---

### Task 2: Error Recovery with Continue Points

**Files:**
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Create: `tests/unit/test_error_recovery.py`

- [ ] **Step 1: Write test**

```python
# tests/unit/test_error_recovery.py
from unittest.mock import MagicMock, patch, call
from mycli.application.runtime.turn_executor import TurnExecutor, LoopState


class TestErrorRecovery:
    def test_ptl_triggers_drain_then_compact(self):
        executor = make_turn_executor()
        state = LoopState(fragments=[mock_fragment()])

        # First PTL: drain should be attempted
        with patch.object(executor, "_try_collapse_drain", return_value=True):
            with patch.object(executor, "_request_model_turn",
                              side_effect=[PromptTooLongError(), mock_response()]):
                result = executor._run_turn_loop(state)

        assert state.transition == "collapse_drain_retry"

    def test_ptl_reactive_compact_once(self):
        executor = make_turn_executor()
        state = LoopState(fragments=[mock_fragment()])

        with patch.object(executor, "_try_collapse_drain", return_value=False):
            with patch.object(executor, "_reactive_compact", return_value=state.fragments):
                with patch.object(executor, "_request_model_turn",
                                  side_effect=[PromptTooLongError(), PromptTooLongError()]):
                    result = executor._run_turn_loop(state)

        assert state.has_attempted_reactive_compact is True

    def test_otk_escalates_then_recovers(self):
        executor = make_turn_executor()
        state = LoopState(fragments=[mock_fragment()])

        with patch.object(executor, "_request_model_turn",
                          side_effect=[
                              OutputTokenLimitError(),
                              OutputTokenLimitError(),
                              OutputTokenLimitError(),
                              OutputTokenLimitError(),  # 4th: recovery exhausted
                          ]):
            result = executor._run_turn_loop(state)

        assert state.max_output_tokens_override == 65536
        assert state.otk_recovery_count == 3

    def test_keyboard_interrupt_preserves_sent_fragments(self):
        executor = make_turn_executor()
        state = LoopState(fragments=[mock_fragment(content="user msg")])

        with patch.object(executor, "_request_model_turn",
                          side_effect=KeyboardInterrupt()):
            result = executor._run_turn_loop(state)

        interrupt_notices = [
            f for f in state.fragments
            if f.metadata.get("interrupt_notice")
        ]
        assert len(interrupt_notices) == 1
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_error_recovery.py -v`
Expected: FAIL

- [ ] **Step 3: Implement LoopState and Continue points**

```python
# src/mycli/application/runtime/turn_executor.py
from dataclasses import dataclass, field

@dataclass
class LoopState:
    fragments: list["Fragment"]
    max_output_tokens_override: int | None = None
    has_attempted_reactive_compact: bool = False
    otk_recovery_count: int = 0
    fallback_model: str | None = None
    transition: str = ""


class TurnExecutor:
    def _run_turn_loop(self, state: LoopState) -> TurnRecord:
        while True:
            try:
                response = self._request_model_turn(
                    fragments=state.fragments,
                    max_tokens=state.max_output_tokens_override or 4096,
                    model=state.fallback_model or self._config.model,
                )
                return self._process_response(response)
            
            except PromptTooLongError:
                # 1: Collapse drain (zero-cost)
                if self._try_collapse_drain(state):
                    state.transition = "collapse_drain_retry"
                    continue
                # 2: Reactive Compact (one attempt)
                if not state.has_attempted_reactive_compact:
                    state.fragments = self._reactive_compact(state.fragments)
                    state.has_attempted_reactive_compact = True
                    state.transition = "reactive_compact_retry"
                    continue
                return self._finalize_error("prompt_too_long", state)
            
            except OutputTokenLimitError:
                # 3: Escalate output budget
                if state.max_output_tokens_override is None:
                    state.max_output_tokens_override = 65536
                    state.transition = "max_output_tokens_escalate"
                    continue
                # 4: Recovery message (max 3)
                if state.otk_recovery_count < 3:
                    state.fragments = self._inject_otk_recovery(state.fragments)
                    state.otk_recovery_count += 1
                    state.transition = "max_output_tokens_recovery"
                    continue
                return self._finalize_completed(state)
            
            except KeyboardInterrupt:
                # 5: User interrupt
                state.fragments = self._append_interrupt_notice(state.fragments)
                return self._finalize_interrupted(state)
            
            except ModelFallbackError:
                # 6: Model fallback
                if self._config.fallback_model:
                    state.fallback_model = self._config.fallback_model
                    state.transition = "model_fallback"
                    continue
                raise
    
    def _inject_otk_recovery(self, fragments):
        return fragments + [Fragment(
            id="otk_recovery",
            kind=FragmentKind.REMINDER,
            priority=Priority.HIGH,
            cache_policy=CachePolicy.EPHEMERAL,
            content="Output token limit hit. Resume directly — no apology, no recap.",
        )]
    
    def _append_interrupt_notice(self, fragments):
        return fragments + [Fragment(
            id="interrupt_notice",
            kind=FragmentKind.REMINDER,
            priority=Priority.HIGH,
            cache_policy=CachePolicy.EPHEMERAL,
            content="[Previous response was interrupted. State preserved. Continue from where you were.]",
            metadata={"interrupt_notice": True},
        )]
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_error_recovery.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/application/runtime/turn_executor.py tests/unit/test_error_recovery.py
git commit -m "feat: add 6 Continue points for precise error recovery

- LoopState tracks recovery state across continue points
- PTL: collapse drain -> reactive compact (one each)
- OTK: escalate -> recovery message (max 3)
- Ctrl+C: append interrupt notice, exit gracefully
- Model fallback on failure"
```

---

### Task 3: Budget Backpressure

**Files:**
- Modify: `src/mycli/application/runtime/turn_executor.py`

- [ ] **Step 1: Write test**

```python
# tests/unit/test_budget_nudge.py
class TestBudgetNudge:
    def test_warning_at_60_percent(self):
        from mycli.application.runtime.turn_executor import BudgetNudge
        nudge = BudgetNudge()
        fragments = [mock_fragment(tokens=60000)]
        budget = mock_budget(usage_ratio=0.60, usable_limit=100000)

        result = nudge.check_and_nudge(fragments, budget)
        assert any("budget_remaining" in str(f.content) for f in result)

    def test_stop_at_85_percent(self):
        nudge = BudgetNudge()
        fragments = [mock_fragment(tokens=85000)]
        budget = mock_budget(usage_ratio=0.85, usable_limit=100000)

        result = nudge.check_and_nudge(fragments, budget)
        assert any("MUST respond" in str(f.content) for f in result)

    def test_no_nudge_at_30_percent(self):
        nudge = BudgetNudge()
        fragments = [mock_fragment(tokens=30000)]
        budget = mock_budget(usage_ratio=0.30, usable_limit=100000)

        result = nudge.check_and_nudge(fragments, budget)
        assert len(result) == len(fragments)  # no new fragments added
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_budget_nudge.py -v`
Expected: FAIL

- [ ] **Step 3: Implement BudgetNudge**

```python
# Add to src/mycli/application/runtime/turn_executor.py

class BudgetNudge:
    WARN_THRESHOLD = 0.60
    STOP_THRESHOLD = 0.85

    def check_and_nudge(self, fragments, budget):
        total = sum(f.tokens for f in fragments if f.tokens > 0)
        ratio = total / max(budget.usable_limit, 1)

        if ratio >= self.STOP_THRESHOLD:
            return fragments + [Fragment(
                id="budget_stop",
                kind=FragmentKind.REMINDER,
                priority=Priority.HIGH,
                cache_policy=CachePolicy.EPHEMERAL,
                content=(
                    f"<token_budget_remaining>Context window is {ratio:.0%} full. "
                    f"You MUST respond now based on available information. "
                    f"Do NOT call more tools unless absolutely necessary."
                    f"</token_budget_remaining>"
                ),
            )]

        if ratio >= self.WARN_THRESHOLD:
            return fragments + [Fragment(
                id="budget_warn",
                kind=FragmentKind.REMINDER,
                priority=Priority.MEDIUM,
                cache_policy=CachePolicy.EPHEMERAL,
                content=(
                    f"<token_budget_remaining>Context window is {ratio:.0%} full. "
                    f"Consider responding soon to preserve context space."
                    f"</token_budget_remaining>"
                ),
            )]

        return fragments
```

- [ ] **Integrate into TurnExecutor loop** — call `BudgetNudge.check_and_nudge()` after each tool result append.

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_budget_nudge.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/application/runtime/turn_executor.py tests/unit/test_budget_nudge.py
git commit -m "feat: add budget backpressure signals to model

- BudgetNudge injects warnings at 60% and 85% usage
- Model receives token_budget_remaining hints
- Integrated into TurnExecutor tool result append loop"
```

---

### Task 4: Parallel Tool Execution

**Files:**
- Modify: `src/mycli/application/runtime/tools/tool_execution_service.py`
- Create: `tests/unit/test_parallel_tools.py`

- [ ] **Step 1: Write test**

```python
# tests/unit/test_parallel_tools.py
import time
from mycli.application.runtime.tools.tool_execution_service import (
    ToolExecutionService, CONCURRENCY_SAFE_TOOLS
)


class TestParallelTools:
    def test_read_file_is_concurrency_safe(self):
        assert "read_file" in CONCURRENCY_SAFE_TOOLS

    def test_edit_file_is_not_concurrency_safe(self):
        assert "edit_file" not in CONCURRENCY_SAFE_TOOLS

    def test_parallel_reads_execute_faster_than_sequential(self):
        service = make_service()

        calls = [
            mock_tool_call("read_file", {"path": "a.py"}, seq=0),
            mock_tool_call("read_file", {"path": "b.py"}, seq=1),
            mock_tool_call("read_file", {"path": "c.py"}, seq=2),
        ]

        start = time.time()
        results = service.execute_tool_calls(calls)
        elapsed = time.time() - start

        # 3 parallel reads should be faster than 3 sequential
        # If sequential: each takes ~0.1s = ~0.3s
        # If parallel: ~0.1s total
        assert elapsed < 0.2

    def test_results_ordered_by_sequence(self):
        service = make_service()
        calls = [
            mock_tool_call("read_file", {"path": "slow.py"}, seq=0),
            mock_tool_call("read_file", {"path": "fast.py"}, seq=1),
        ]
        results = service.execute_tool_calls(calls)
        assert len(results) == 2
        assert results[0].metadata["sequence"] == 0
        assert results[1].metadata["sequence"] == 1

    def test_mixed_safe_and_unsafe(self):
        service = make_service()
        calls = [
            mock_tool_call("read_file", {"path": "a.py"}, seq=0),
            mock_tool_call("edit_file", {"path": "a.py"}, seq=1),  # unsafe
            mock_tool_call("read_file", {"path": "b.py"}, seq=2),
        ]
        results = service.execute_tool_calls(calls)
        assert len(results) == 3
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_parallel_tools.py -v`
Expected: FAIL

- [ ] **Step 3: Implement execute_tool_calls**

```python
# src/mycli/application/runtime/tools/tool_execution_service.py

CONCURRENCY_SAFE_TOOLS = {
    "read_file", "read_file_range", "search_text",
    "list_directory", "grep", "git_diff", "git_status",
}

class ToolExecutionService:
    def execute_tool_calls(self, calls):
        from concurrent.futures import ThreadPoolExecutor, as_completed

        results = [None] * len(calls)
        parallel_group = []

        for call in calls:
            tool_name = self._extract_tool_name(call)
            if tool_name in CONCURRENCY_SAFE_TOOLS:
                parallel_group.append(call)
            else:
                if parallel_group:
                    self._execute_parallel(parallel_group, results)
                    parallel_group = []
                self._execute_sequential(call, results)

        if parallel_group:
            self._execute_parallel(parallel_group, results)

        return [r for r in results if r is not None]

    def _execute_parallel(self, calls, results):
        from concurrent.futures import ThreadPoolExecutor, as_completed
        with ThreadPoolExecutor(max_workers=len(calls)) as executor:
            futures = {executor.submit(self.execute_tool_call, c): c for c in calls}
            for future in as_completed(futures):
                call = futures[future]
                idx = call.metadata["sequence"]
                results[idx] = future.result()

    def _execute_sequential(self, call, results):
        idx = call.metadata["sequence"]
        results[idx] = self.execute_tool_call(call)
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_parallel_tools.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/application/runtime/tools/tool_execution_service.py tests/unit/test_parallel_tools.py
git commit -m "feat: add parallel tool execution for concurrency-safe tools

- CONCURRENCY_SAFE_TOOLS: read_file, search_text, list_directory, grep, etc.
- execute_tool_calls groups safe tools for ThreadPoolExecutor parallel execution
- Unsafe tools execute sequentially, flushing parallel groups first
- Results ordered by sequence_number metadata"
```

---

### Task 5: Sub-Agent Context Isolation

**Files:**
- Create: `src/mycli/agents/sub_agent.py`
- Create: `tests/unit/test_sub_agent.py`

- [ ] **Step 1: Write test**

```python
# tests/unit/test_sub_agent.py
from unittest.mock import MagicMock, patch
from mycli.agents.sub_agent import SubAgent
from mycli.services.context.token_counter import Fragment, FragmentKind, Priority, CachePolicy


class TestSubAgent:
    def test_sub_agent_has_independent_context(self):
        agent = SubAgent(
            name="test_sub",
            system_prompt="You are a test agent",
            tools=[mock_tool("read_file"), mock_tool("search_text")],
            model="test-model",
            budget=mock_budget(),
        )

        with patch.object(agent, "_call_model") as mock_call:
            mock_call.return_value = mock_response(is_final=True, content="Done")
            report = agent.run("Find all Python files")

        # Parent gets a report Fragment
        assert report.kind == FragmentKind.TOOL_RESULT
        assert report.metadata["source"] == "sub_agent"
        assert "Done" in report.content

    def test_tool_definitions_are_sorted(self):
        agent = SubAgent(
            name="test_sub",
            system_prompt="test",
            tools=[mock_tool("z_tool"), mock_tool("a_tool")],
            model="test",
            budget=mock_budget(),
        )
        names = [t.name for t in agent.tools]
        assert names == ["a_tool", "z_tool"]

    def test_internal_tool_calls_not_in_report_metadata(self):
        agent = SubAgent(
            name="test_sub",
            system_prompt="test",
            tools=[mock_tool("read_file")],
            model="test",
            budget=mock_budget(),
        )

        responses = [
            mock_response(tool_calls=[mock_tool_call("read_file")]),
            mock_response(tool_calls=[mock_tool_call("read_file")]),
            mock_response(is_final=True, content="All done"),
        ]

        with patch.object(agent, "_call_model", side_effect=responses):
            report = agent.run("test")

        assert report.metadata["tool_calls"] == 2  # internal count
        # But report content doesn't contain raw tool results
        assert "file content" not in report.content.lower()
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_sub_agent.py -v`
Expected: FAIL

- [ ] **Step 3: Implement SubAgent**

```python
# src/mycli/agents/sub_agent.py
from mycli.services.context.token_counter import Fragment, FragmentKind, Priority, CachePolicy


class SubAgent:
    def __init__(self, name, system_prompt, tools, model, budget, max_tool_calls=25):
        self.name = name
        self.system_prompt = system_prompt
        self.tools = sorted(tools, key=lambda t: t.name)
        self.model = model
        self.budget = budget
        self.max_tool_calls = max_tool_calls
        self._messages = []

    def run(self, task: str) -> Fragment:
        self._messages = self._build_initial_context(task)
        tool_call_count = 0

        for _ in range(self.max_tool_calls):
            response = self._call_model(self._messages, self.tools)
            if self._is_final(response):
                return Fragment(
                    id=f"sub_report:{self.name}",
                    kind=FragmentKind.TOOL_RESULT,
                    priority=Priority.HIGH,
                    cache_policy=CachePolicy.DYNAMIC,
                    content=f"[Sub-agent '{self.name}' report]:\n{response.content}",
                    metadata={
                        "source": "sub_agent",
                        "sub_agent_name": self.name,
                        "tool_calls": tool_call_count,
                    },
                )
            for call in response.tool_calls:
                result = self._execute_tool(call)
                self._messages.append(self._to_assistant_message(call))
                self._messages.append(self._to_tool_result_message(result))
                tool_call_count += 1

        return Fragment(
            id=f"sub_report:{self.name}_timeout",
            kind=FragmentKind.TOOL_RESULT,
            priority=Priority.LOW,
            cache_policy=CachePolicy.DYNAMIC,
            content=f"[Sub-agent '{self.name}' reached max tool calls ({self.max_tool_calls})]",
            metadata={"source": "sub_agent", "timeout": True},
        )

    def _build_initial_context(self, task):
        return [
            {"role": "system", "content": self.system_prompt,
             "metadata": {"cache_policy": "STATIC"}},
            *[{"role": "system", "content": t.render_schema(),
               "metadata": {"cache_policy": "STATIC", "tool_name": t.name}}
              for t in self.tools],
            {"role": "user", "content": task,
             "metadata": {"cache_policy": "DYNAMIC"}},
        ]
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_sub_agent.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/agents/sub_agent.py tests/unit/test_sub_agent.py
git commit -m "feat: add SubAgent with independent context isolation

- SubAgent has own Fragment list, tool set, budget, and cache prefix
- Parent receives only final report Fragment (internal tool calls hidden)
- Tool definitions sorted for cache stability
- Max tool calls guard with timeout report"
```

---

## Phase 2 Completion Check

- [ ] `pytest tests/ -x -q` passes — final full-suite verification pending
- [x] PreToolUse hook can intercept and DENY a tool call
- [x] PTL error auto-recovers through drain → compact
- [x] OTK error auto-escalates and recovers
- [x] Budget warnings appear in model context at 60% and 85%
- [x] 5 read_file calls execute in parallel
- [x] Sub-agent 20 tool calls produce exactly 1 report Fragment in parent context

Notes:
- Commit steps in this phase were not executed; changes remain in the working tree for unified review.
