# TurnGuard Checkpoint 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 mycli agent 的三条循环路径建立统一的停止决策层（Checkpoint），防止无限工具调用消耗 80w token。

**Architecture:** 新增 `TurnCheckpoint` 类作为纯函数式的停止条件评估器，穷举 5 个 ExitReason + 4 个 ContinueReason。`turn_executor.py`、`react_loop.py`、`turn_service.py` 三条路径统一接入。所有硬退出判断（token/步数/循环/无进展）不产生 prompt 变化，仅 ContinueReason 通过现有 `runtime_reminders` 通道注入提醒。

**Tech Stack:** Python 3.13, pytest, dataclasses

---

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新增 | `src/mycli/services/turn_guard/__init__.py` | 导出 TurnCheckpoint, CheckpointResult, ExitReason, ContinueReason, NoProgressTracker |
| 新增 | `src/mycli/services/turn_guard/checkpoint.py` | TurnCheckpoint 核心 + 所有退出/继续条件判断 |
| 新增 | `tests/unit/services/turn_guard/test_checkpoint.py` | 覆盖每个 ExitReason 和 ContinueReason 的单元测试 |
| 修改 | `src/mycli/domain/runtime/__init__.py` | AgentConfig 新增 6 个字段 |
| 修改 | `src/mycli/application/runtime/turn_executor.py` | _run_turn_loop 接入 Checkpoint |
| 修改 | `src/mycli/application/runtime/agent_runtime.py` | 初始化 TurnCheckpoint 实例 |
| 修改 | `src/mycli/agents/react_loop.py` | run() 接入 Checkpoint + step_index |
| 修改 | `src/mycli/application/turn_service.py` | _run_agent() 接入 Checkpoint + step_index |

---

### Task 1: 创建 TurnCheckpoint 核心模块

**Files:**
- Create: `src/mycli/services/turn_guard/__init__.py`
- Create: `src/mycli/services/turn_guard/checkpoint.py`

- [ ] **Step 1: 创建 `__init__.py`**

```python
from __future__ import annotations

from mycli.services.turn_guard.checkpoint import (
    CheckpointResult,
    ContinueReason,
    ExitReason,
    NoProgressTracker,
    TurnCheckpoint,
)

__all__ = [
    "CheckpointResult",
    "ContinueReason",
    "ExitReason",
    "NoProgressTracker",
    "TurnCheckpoint",
]
```

- [ ] **Step 2: 创建 `checkpoint.py`**

```python
from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import StrEnum

from mycli.domain.conversation import Conversation
from mycli.domain.runtime import PlanState, StopReason


class ExitReason(StrEnum):
    TOKEN_BUDGET_EXCEEDED = "token_budget_exceeded"
    TOOL_COUNT_EXCEEDED = "tool_count_exceeded"
    LOOP_DETECTED = "loop_detected"
    REPEATED_REPLANNING = "repeated_replanning"
    NO_PROGRESS = "no_progress"


class ContinueReason(StrEnum):
    FORCE_ANSWER = "force_answer"
    REROUTE = "reroute"
    TRUNCATION_AWARE = "truncation_aware"
    NEXT_STEP = "next_step"


@dataclass(slots=True, frozen=True)
class CheckpointResult:
    exit_reason: ExitReason | None = None
    continue_reason: ContinueReason = ContinueReason.NEXT_STEP
    stop_reason: StopReason | None = None
    assistant_message: str | None = None
    reminders: tuple[str, ...] = field(default_factory=tuple)


class NoProgressTracker:
    def __init__(self) -> None:
        self._seen_signatures: set[str] = set()
        self._no_progress_count = 0

    def update(self, conversation: Conversation) -> None:
        current_signatures = self._tool_call_signatures(conversation)
        new_signatures = current_signatures - self._seen_signatures
        if new_signatures:
            self._no_progress_count = 0
            self._seen_signatures |= new_signatures
        else:
            self._no_progress_count += 1

    def no_progress_count(self) -> int:
        return self._no_progress_count

    @staticmethod
    def _tool_call_signatures(conversation: Conversation) -> set[str]:
        sigs: set[str] = set()
        for message in conversation.messages:
            if message.role != "assistant":
                continue
            for call in message.tool_calls:
                sig = json.dumps(
                    {"name": call.name, "arguments": call.arguments},
                    ensure_ascii=False,
                    sort_keys=True,
                )
                sigs.add(sig)
        return sigs


class TurnCheckpoint:
    def __init__(
        self,
        *,
        max_tool_calls_per_turn: int = 25,
        max_tokens_per_turn: int = 200_000,
        max_same_tool_calls: int = 4,
        no_progress_threshold: int = 6,
        force_answer_threshold: int = 12,
        reroute_threshold: int = 3,
        repeated_replanning_threshold: int = 2,
    ) -> None:
        self._max_tool_calls = max_tool_calls_per_turn
        self._max_tokens = max_tokens_per_turn
        self._max_same_tool_calls = max_same_tool_calls
        self._no_progress_threshold = no_progress_threshold
        self._force_answer_threshold = force_answer_threshold
        self._reroute_threshold = reroute_threshold
        self._repeated_replanning_threshold = repeated_replanning_threshold

    def evaluate(
        self,
        *,
        step_index: int,
        conversation: Conversation,
        cumulative_tokens: int = 0,
        plan_state: PlanState | None = None,
        no_progress_tracker: NoProgressTracker | None = None,
    ) -> CheckpointResult:
        # Priority 1: Token budget hard stop (already had last chance)
        if cumulative_tokens > self._max_tokens:
            return CheckpointResult(
                exit_reason=ExitReason.TOKEN_BUDGET_EXCEEDED,
                stop_reason=StopReason.CONTEXT_WINDOW_EXCEEDED,
                assistant_message=(
                    f"Token budget exceeded ({cumulative_tokens}/{self._max_tokens}). "
                    "Please narrow the request."
                ),
            )

        # Priority 2: Tool call count hard stop (already had last chance)
        if step_index > self._max_tool_calls:
            return CheckpointResult(
                exit_reason=ExitReason.TOOL_COUNT_EXCEEDED,
                stop_reason=StopReason.LOOP_DETECTED,
                assistant_message=(
                    f"Tool call limit reached ({step_index}/{self._max_tool_calls}). "
                    "Please narrow the request or use /continue to resume."
                ),
            )

        # Priority 3: Repeated identical tool calls
        max_repeated = self._max_repeated_tool_signatures(conversation)
        if max_repeated >= self._max_same_tool_calls:
            return CheckpointResult(
                exit_reason=ExitReason.LOOP_DETECTED,
                stop_reason=StopReason.LOOP_DETECTED,
                assistant_message=(
                    "I stopped due to repeated exploration of the same path without new evidence. "
                    "Please narrow the request or inspect a confirmed path."
                ),
            )

        # Priority 4: Repeated replanning
        plan_state_obj = plan_state or PlanState()
        replan_count = self._count_tool_calls_in_current_turn(
            conversation, "update_plan"
        )
        if replan_count >= self._repeated_replanning_threshold and plan_state_obj.items:
            return CheckpointResult(
                exit_reason=ExitReason.REPEATED_REPLANNING,
                stop_reason=StopReason.LOOP_DETECTED,
                assistant_message=(
                    "I stopped due to repeated replanning without executing the current plan. "
                    "Continue the existing plan or narrow the request."
                ),
            )

        # Priority 5: No progress
        if (
            no_progress_tracker is not None
            and no_progress_tracker.no_progress_count() >= self._no_progress_threshold
        ):
            return CheckpointResult(
                exit_reason=ExitReason.NO_PROGRESS,
                stop_reason=StopReason.LOOP_DETECTED,
                assistant_message=(
                    "No new evidence after multiple tool calls. "
                    "Summarizing what is known so far."
                ),
            )

        # Determine continue reason
        reminders: list[str] = []
        continue_reason = ContinueReason.NEXT_STEP

        # Token budget last chance: at threshold, FORCE_ANSWER; exceeded → hard stop (above)
        if cumulative_tokens >= self._max_tokens:
            continue_reason = ContinueReason.FORCE_ANSWER
            reminders.append(
                "Token budget nearly exhausted. You MUST answer now. Do NOT call any more tools."
            )

        # Tool count last chance: at threshold, FORCE_ANSWER; exceeded → hard stop (above)
        if step_index == self._max_tool_calls:
            continue_reason = ContinueReason.FORCE_ANSWER
            reminders.append(
                "You have reached the maximum tool call limit. You MUST answer now "
                "using only the evidence you already have. Do NOT call any more tools."
            )

        if step_index >= self._force_answer_threshold and step_index < self._max_tool_calls:
            continue_reason = ContinueReason.FORCE_ANSWER
            reminders.append(
                "You have taken many steps. Stop exploring and answer now based on available evidence."
            )

        if max_repeated >= self._reroute_threshold:
            if continue_reason == ContinueReason.NEXT_STEP:
                continue_reason = ContinueReason.REROUTE
            reminders.append(
                "You are repeating the same tool exploration. Summarize what is already known or choose a different confirmed path."
            )

        if self._has_truncation_signal(conversation):
            if continue_reason == ContinueReason.NEXT_STEP:
                continue_reason = ContinueReason.TRUNCATION_AWARE
            reminders.append(
                "A recent file excerpt was truncated. Prefer read_file_range on the confirmed path instead of repeating read_file."
            )

        return CheckpointResult(
            continue_reason=continue_reason,
            reminders=tuple(reminders),
        )

    def _max_repeated_tool_signatures(self, conversation: Conversation) -> int:
        signatures: dict[str, int] = {}
        max_count = 0
        for message in conversation.messages:
            if message.role != "assistant":
                continue
            for call in message.tool_calls:
                signature = json.dumps(
                    {"name": call.name, "arguments": call.arguments},
                    ensure_ascii=False,
                    sort_keys=True,
                )
                signatures[signature] = signatures.get(signature, 0) + 1
                max_count = max(max_count, signatures[signature])
        return max_count

    def _count_tool_calls_in_current_turn(
        self, conversation: Conversation, tool_name: str
    ) -> int:
        count = 0
        for message in reversed(conversation.messages):
            if message.role == "user":
                break
            if message.role != "assistant":
                continue
            for call in message.tool_calls:
                if call.name == tool_name:
                    count += 1
        return count

    def _has_truncation_signal(self, conversation: Conversation) -> bool:
        for message in conversation.messages:
            if message.role != "tool":
                continue
            for block in message.blocks:
                if block.type != "tool_result":
                    continue
                lowered = (block.text or "").lower()
                if "excerpt truncated" in lowered or "use read_file_range" in lowered:
                    return True
        return False
```

- [ ] **Step 3: 运行现有测试确保未引入 import 错误**

Run: `python -c "from mycli.services.turn_guard import TurnCheckpoint, ExitReason, ContinueReason, CheckpointResult, NoProgressTracker; print('OK')"`

Expected: `OK`

- [ ] **Step 4: 提交**

```bash
git add src/mycli/services/turn_guard/
git commit -m "$(cat <<'EOF'
feat: add TurnCheckpoint with 5 exit and 4 continue reasons

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 编写 Checkpoint 单元测试

**Files:**
- Create: `tests/unit/services/turn_guard/__init__.py`
- Create: `tests/unit/services/turn_guard/test_checkpoint.py`

- [ ] **Step 1: 创建 `tests/unit/services/turn_guard/__init__.py`**

```python
```

(empty file)

- [ ] **Step 2: 创建 `tests/unit/services/turn_guard/test_checkpoint.py`**

```python
from __future__ import annotations

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import (
    PlanItem,
    PlanState,
    PlanStatus,
    RuntimeBlock,
    StopReason,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.services.turn_guard import (
    CheckpointResult,
    ContinueReason,
    ExitReason,
    NoProgressTracker,
    TurnCheckpoint,
)


def _tool_message(
    *, tool_name: str, path: str | None, success: bool = True, text: str | None = None
) -> Message:
    return Message(
        role="tool",
        content=text or f"Tool {tool_name}",
        blocks=(
            RuntimeBlock(
                type="tool_result",
                text=text or f"Tool {tool_name}",
                metadata={
                    "tool_name": tool_name,
                    "success": success,
                    "path": path,
                },
            ),
        ),
    )


def _assistant_tool_call(
    *, name: str, arguments: dict[str, object]
) -> Message:
    return Message(
        role="assistant",
        content="",
        tool_calls=(
            ToolCall(
                name=name,
                arguments=arguments,
                reason="explore",
                call_id=f"call_{name}_{hash(frozenset(arguments.items()))}",
            ),
        ),
    )


class TestTurnCheckpointExitReasons:
    def test_token_budget_exceeded_hard_stops_when_over_limit(self) -> None:
        checkpoint = TurnCheckpoint(max_tokens_per_turn=1000)
        conversation = Conversation(session_id="test", messages=[])

        result = checkpoint.evaluate(
            step_index=0,
            conversation=conversation,
            cumulative_tokens=1001,
        )

        assert result.exit_reason == ExitReason.TOKEN_BUDGET_EXCEEDED
        assert result.stop_reason == StopReason.CONTEXT_WINDOW_EXCEEDED
        assert result.assistant_message is not None

    def test_token_budget_at_limit_gives_force_answer_not_hard_stop(self) -> None:
        checkpoint = TurnCheckpoint(max_tokens_per_turn=1000)
        conversation = Conversation(session_id="test", messages=[])

        result = checkpoint.evaluate(
            step_index=0,
            conversation=conversation,
            cumulative_tokens=1000,
        )

        assert result.exit_reason is None
        assert result.continue_reason == ContinueReason.FORCE_ANSWER
        assert any("MUST answer" in r for r in result.reminders)

    def test_token_budget_not_exceeded_when_under_limit(self) -> None:
        checkpoint = TurnCheckpoint(max_tokens_per_turn=1000)
        conversation = Conversation(session_id="test", messages=[])

        result = checkpoint.evaluate(
            step_index=0,
            conversation=conversation,
            cumulative_tokens=999,
        )

        assert result.exit_reason is None

    def test_tool_count_exceeded_hard_stops_when_over_limit(self) -> None:
        checkpoint = TurnCheckpoint(max_tool_calls_per_turn=5)
        conversation = Conversation(session_id="test", messages=[])

        result = checkpoint.evaluate(
            step_index=6,
            conversation=conversation,
        )

        assert result.exit_reason == ExitReason.TOOL_COUNT_EXCEEDED
        assert result.stop_reason == StopReason.LOOP_DETECTED

    def test_tool_count_at_limit_gives_force_answer_not_hard_stop(self) -> None:
        checkpoint = TurnCheckpoint(max_tool_calls_per_turn=5)
        conversation = Conversation(session_id="test", messages=[])

        result = checkpoint.evaluate(
            step_index=5,
            conversation=conversation,
        )

        assert result.exit_reason is None
        assert result.continue_reason == ContinueReason.FORCE_ANSWER
        assert any("MUST answer" in r for r in result.reminders)

    def test_tool_count_not_exceeded_under_limit(self) -> None:
        checkpoint = TurnCheckpoint(max_tool_calls_per_turn=5)
        conversation = Conversation(session_id="test", messages=[])

        result = checkpoint.evaluate(
            step_index=4,
            conversation=conversation,
        )

        assert result.exit_reason is None

    def test_loop_detected_when_same_tool_call_repeated_4_times(self) -> None:
        checkpoint = TurnCheckpoint(max_same_tool_calls=4)
        conversation = Conversation(
            session_id="test",
            messages=[
                _assistant_tool_call(name="list_directory", arguments={"path": "."}),
                _assistant_tool_call(name="list_directory", arguments={"path": "."}),
                _assistant_tool_call(name="list_directory", arguments={"path": "."}),
                _assistant_tool_call(name="list_directory", arguments={"path": "."}),
            ],
        )

        result = checkpoint.evaluate(
            step_index=3,
            conversation=conversation,
        )

        assert result.exit_reason == ExitReason.LOOP_DETECTED
        assert result.stop_reason == StopReason.LOOP_DETECTED

    def test_loop_not_detected_with_different_tool_calls(self) -> None:
        checkpoint = TurnCheckpoint(max_same_tool_calls=4)
        conversation = Conversation(
            session_id="test",
            messages=[
                _assistant_tool_call(name="list_directory", arguments={"path": "."}),
                _assistant_tool_call(name="read_file", arguments={"path": "a.py"}),
                _assistant_tool_call(name="search_text", arguments={"pattern": "x"}),
            ],
        )

        result = checkpoint.evaluate(
            step_index=2,
            conversation=conversation,
        )

        assert result.exit_reason is None

    def test_repeated_replanning_stops_when_plan_exists(self) -> None:
        checkpoint = TurnCheckpoint(repeated_replanning_threshold=2)
        conversation = Conversation(
            session_id="test",
            messages=[
                _assistant_tool_call(
                    name="update_plan",
                    arguments={"items": [{"content": "step 1", "status": "in_progress"}]},
                ),
                _assistant_tool_call(
                    name="update_plan",
                    arguments={"items": [{"content": "step 1 revised", "status": "in_progress"}]},
                ),
            ],
        )
        plan_state = PlanState(
            items=(PlanItem(id="1", content="step 1", status=PlanStatus.IN_PROGRESS),)
        )

        result = checkpoint.evaluate(
            step_index=2,
            conversation=conversation,
            plan_state=plan_state,
        )

        assert result.exit_reason == ExitReason.REPEATED_REPLANNING
        assert result.stop_reason == StopReason.LOOP_DETECTED

    def test_repeated_replanning_does_not_stop_without_existing_plan(self) -> None:
        checkpoint = TurnCheckpoint(repeated_replanning_threshold=2)
        conversation = Conversation(
            session_id="test",
            messages=[
                _assistant_tool_call(
                    name="update_plan",
                    arguments={"items": []},
                ),
                _assistant_tool_call(
                    name="update_plan",
                    arguments={"items": []},
                ),
            ],
        )

        result = checkpoint.evaluate(
            step_index=2,
            conversation=conversation,
        )

        assert result.exit_reason is None

    def test_no_progress_stops_after_threshold(self) -> None:
        checkpoint = TurnCheckpoint(no_progress_threshold=3)
        conversation = Conversation(
            session_id="test",
            messages=[
                _assistant_tool_call(name="list_directory", arguments={"path": "."}),
            ],
        )
        tracker = NoProgressTracker()
        tracker.update(conversation)  # step 0: new sig found
        tracker.update(conversation)  # step 1: no new sig
        tracker.update(conversation)  # step 2: no new sig
        tracker.update(conversation)  # step 3: no new sig → count == 3

        result = checkpoint.evaluate(
            step_index=3,
            conversation=conversation,
            no_progress_tracker=tracker,
        )

        assert result.exit_reason == ExitReason.NO_PROGRESS
        assert result.stop_reason == StopReason.LOOP_DETECTED

    def test_no_progress_resets_when_new_tool_called(self) -> None:
        checkpoint = TurnCheckpoint(no_progress_threshold=3)
        tracker = NoProgressTracker()
        conv1 = Conversation(
            session_id="test",
            messages=[
                _assistant_tool_call(name="list_directory", arguments={"path": "."}),
            ],
        )
        tracker.update(conv1)
        assert tracker.no_progress_count() == 0

        tracker.update(conv1)
        assert tracker.no_progress_count() == 1

        conv2 = Conversation(
            session_id="test",
            messages=[
                _assistant_tool_call(name="list_directory", arguments={"path": "."}),
                _assistant_tool_call(name="read_file", arguments={"path": "a.py"}),
            ],
        )
        tracker.update(conv2)
        assert tracker.no_progress_count() == 0


class TestTurnCheckpointContinueReasons:
    def test_force_answer_when_step_exceeds_threshold(self) -> None:
        checkpoint = TurnCheckpoint(force_answer_threshold=12)
        conversation = Conversation(session_id="test", messages=[])

        result = checkpoint.evaluate(
            step_index=12,
            conversation=conversation,
        )

        assert result.exit_reason is None
        assert result.continue_reason == ContinueReason.FORCE_ANSWER
        assert any("Stop exploring" in r for r in result.reminders)

    def test_reroute_when_repeated_calls_but_below_stop_threshold(self) -> None:
        checkpoint = TurnCheckpoint(max_same_tool_calls=4, reroute_threshold=3)
        conversation = Conversation(
            session_id="test",
            messages=[
                _assistant_tool_call(name="list_directory", arguments={"path": "."}),
                _assistant_tool_call(name="list_directory", arguments={"path": "."}),
                _assistant_tool_call(name="list_directory", arguments={"path": "."}),
            ],
        )

        result = checkpoint.evaluate(
            step_index=2,
            conversation=conversation,
        )

        assert result.exit_reason is None
        assert result.continue_reason == ContinueReason.REROUTE
        assert any("different" in r.lower() for r in result.reminders)

    def test_truncation_aware_when_truncation_signal_present(self) -> None:
        checkpoint = TurnCheckpoint()
        conversation = Conversation(
            session_id="test",
            messages=[
                _tool_message(
                    tool_name="read_file",
                    path="src/x.py",
                    text="... excerpt truncated; use read_file_range for exact sections if needed.",
                ),
            ],
        )

        result = checkpoint.evaluate(
            step_index=0,
            conversation=conversation,
        )

        assert result.exit_reason is None
        assert result.continue_reason == ContinueReason.TRUNCATION_AWARE
        assert any("read_file_range" in r for r in result.reminders)

    def test_next_step_when_all_conditions_normal(self) -> None:
        checkpoint = TurnCheckpoint()
        conversation = Conversation(session_id="test", messages=[])

        result = checkpoint.evaluate(
            step_index=0,
            conversation=conversation,
        )

        assert result.exit_reason is None
        assert result.continue_reason == ContinueReason.NEXT_STEP
        assert result.reminders == ()

    def test_force_answer_beats_reroute_in_priority(self) -> None:
        """force_answer is higher priority than reroute."""
        checkpoint = TurnCheckpoint(
            force_answer_threshold=10,
            reroute_threshold=3,
            max_same_tool_calls=10,
        )
        conversation = Conversation(
            session_id="test",
            messages=[
                _assistant_tool_call(name="list_directory", arguments={"path": "."}),
                _assistant_tool_call(name="list_directory", arguments={"path": "."}),
                _assistant_tool_call(name="list_directory", arguments={"path": "."}),
            ],
        )

        result = checkpoint.evaluate(
            step_index=11,
            conversation=conversation,
        )

        assert result.exit_reason is None
        assert result.continue_reason == ContinueReason.FORCE_ANSWER


class TestNoProgressTracker:
    def test_starts_at_zero(self) -> None:
        tracker = NoProgressTracker()
        assert tracker.no_progress_count() == 0

    def test_increments_when_no_new_signatures(self) -> None:
        tracker = NoProgressTracker()
        conv = Conversation(
            session_id="test",
            messages=[
                _assistant_tool_call(name="list_directory", arguments={"path": "."}),
            ],
        )
        tracker.update(conv)
        assert tracker.no_progress_count() == 0

        tracker.update(conv)
        assert tracker.no_progress_count() == 1

        tracker.update(conv)
        assert tracker.no_progress_count() == 2

    def test_resets_when_new_signature_appears(self) -> None:
        tracker = NoProgressTracker()
        conv1 = Conversation(
            session_id="test",
            messages=[
                _assistant_tool_call(name="list_directory", arguments={"path": "."}),
            ],
        )
        tracker.update(conv1)
        tracker.update(conv1)
        assert tracker.no_progress_count() == 1

        conv2 = Conversation(
            session_id="test",
            messages=[
                _assistant_tool_call(name="list_directory", arguments={"path": "."}),
                _assistant_tool_call(name="read_file", arguments={"path": "src/x.py"}),
            ],
        )
        tracker.update(conv2)
        assert tracker.no_progress_count() == 0

    def test_different_arguments_count_as_different_signature(self) -> None:
        tracker = NoProgressTracker()
        conv1 = Conversation(
            session_id="test",
            messages=[
                _assistant_tool_call(name="read_file", arguments={"path": "a.py"}),
            ],
        )
        tracker.update(conv1)
        assert tracker.no_progress_count() == 0

        conv2 = Conversation(
            session_id="test",
            messages=[
                _assistant_tool_call(name="read_file", arguments={"path": "a.py"}),
                _assistant_tool_call(name="read_file", arguments={"path": "b.py"}),
            ],
        )
        tracker.update(conv2)
        assert tracker.no_progress_count() == 0

    def test_same_tool_different_args_detected_as_new(self) -> None:
        tracker = NoProgressTracker()
        conv1 = Conversation(
            session_id="test",
            messages=[
                _assistant_tool_call(name="search_text", arguments={"pattern": "foo"}),
            ],
        )
        tracker.update(conv1)
        tracker.update(conv1)
        assert tracker.no_progress_count() == 1

        conv2 = Conversation(
            session_id="test",
            messages=[
                _assistant_tool_call(name="search_text", arguments={"pattern": "foo"}),
                _assistant_tool_call(name="search_text", arguments={"pattern": "bar"}),
            ],
        )
        tracker.update(conv2)
        assert tracker.no_progress_count() == 0
```

- [ ] **Step 3: 运行测试验证全部通过**

Run: `pytest tests/unit/services/turn_guard/test_checkpoint.py -v`

Expected: 18 passed

- [ ] **Step 4: 提交**

```bash
git add tests/unit/services/turn_guard/
git commit -m "$(cat <<'EOF'
test: add TurnCheckpoint unit tests covering all exit/continue reasons

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: AgentConfig 新增字段

**Files:**
- Modify: `src/mycli/domain/runtime/__init__.py:108-124`

- [ ] **Step 1: 在 AgentConfig 中添加 6 个字段**

在 `autop_approve_medium` 后追加：

```python
    auto_approve_medium: bool = True
    max_tool_calls_per_turn: int = 25
    max_tokens_per_turn: int = 200_000
    max_same_tool_calls: int = 4
    no_progress_threshold: int = 6
    force_answer_threshold: int = 12
    reroute_threshold: int = 3
```

- [ ] **Step 2: 运行现有测试确保未 break**

Run: `pytest tests/unit/services/test_runtime_policy.py -v`

Expected: 所有已有测试通过（AgentConfig 新增字段有默认值，不影响现有代码）

- [ ] **Step 3: 提交**

```bash
git add src/mycli/domain/runtime/__init__.py
git commit -m "$(cat <<'EOF'
feat: add turn guard fields to AgentConfig

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: turn_executor._run_turn_loop 接入 Checkpoint

**Files:**
- Modify: `src/mycli/application/runtime/turn_executor.py:228-476`

- [ ] **Step 1: 在 `_run_turn_loop` 中接入 Checkpoint**

在 `while True:` 之后、`_policy_decision` 调用之前，插入 Checkpoint 评估。在循环末尾新增 `cumulative_tokens` 累加和 `no_progress_tracker` 更新。

具体改动：

在第 249 行 `while True:` 后，第 250 行 `reasoning_effort...` 前插入 checkpoint 调用：

```python
    while True:
        # --- TurnGuard checkpoint ---
        checkpoint_result = runtime._checkpoint.evaluate(
            step_index=step_index,
            conversation=conversation,
            cumulative_tokens=cumulative_tokens,
            plan_state=current_plan_state,
            no_progress_tracker=no_progress_tracker,
        )
        if checkpoint_result.exit_reason is not None:
            runtime._append_turn_item(
                turn_id=turn_id,
                turn_items=turn_items,
                item=TurnItem(
                    type=TurnItemType.WARNING,
                    text=checkpoint_result.assistant_message or "",
                ),
            )
            runtime._save_runtime_state(
                conversation=conversation,
                plan_state=current_plan_state,
            )
            return runtime._finalize_response(
                response=TurnResponse(
                    assistant_message=checkpoint_result.assistant_message
                    or "Turn guard limit reached.",
                    progress_updates=tuple(progress_updates),
                    activity_events=tuple(activity_events),
                ),
                turn_id=turn_id,
                user_message=user_message,
                started_at=started_at,
                status=TurnStatus.COMPLETED,
                stop_reason=checkpoint_result.stop_reason or StopReason.LOOP_DETECTED,
                turn_items=turn_items,
                context_baseline=latest_context_baseline,
            )
        checkpoint_reminders = checkpoint_result.reminders
        # --- End TurnGuard checkpoint ---

        (
            reasoning_effort,
            runtime_reminders,
            runtime_policy_state,
            _force_answer,
            stage_message,
            policy_response,
        ) = runtime._policy_decision(
            user_message=user_message,
            conversation=conversation,
            plan_state=current_plan_state,
            step_index=step_index,
        )
        # Merge checkpoint reminders AFTER _policy_decision assigns runtime_reminders
        if checkpoint_reminders:
            runtime_reminders = runtime_reminders + checkpoint_reminders
```

在第 366 行 `usage_payload` 之后，添加 token 累加：

```python
            usage_payload = turn_result.metadata.get("usage")
            runtime._trace_cache_shape_diagnostic(
                turn_id=turn_id,
                request_shape=request_shape,
                usage=usage_payload if isinstance(usage_payload, dict) else None,
            )
            # Track cumulative tokens
            if isinstance(usage_payload, dict):
                cumulative_tokens += usage_payload.get("total_tokens", 0)
```

在第 441 行 `step_index += 1; continue` 之前，添加 no_progress_tracker 更新：

```python
            if turn_has_tool_call:
                no_progress_tracker.update(conversation)
                step_index += 1
                continue
```

同时需要在函数签名中初始化 `cumulative_tokens` 和 `no_progress_tracker`。在 `step_index = 0` 之后添加：

```python
    step_index = 0
    cumulative_tokens = 0
    no_progress_tracker = NoProgressTracker()
```

需要在文件顶部添加导入：

```python
from mycli.services.turn_guard import NoProgressTracker
```

- [ ] **Step 2: 验证语法正确**

Run: `python -c "from mycli.application.runtime.turn_executor import TurnExecutor; print('OK')"`

Expected: `OK`

- [ ] **Step 3: 运行现有测试确保未 break**

Run: `pytest tests/unit/ -x -q`

Expected: 全部通过

- [ ] **Step 4: 提交**

```bash
git add src/mycli/application/runtime/turn_executor.py
git commit -m "$(cat <<'EOF'
feat: wire TurnCheckpoint into turn_executor._run_turn_loop

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: agent_runtime 初始化 TurnCheckpoint

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py`

- [ ] **Step 1: 添加导入和初始化**

在文件顶部 import 区域添加：

```python
from mycli.services.turn_guard import TurnCheckpoint
```

在第 124 行 `self._runtime_policy = RuntimePolicy()` 之后添加：

```python
        self._runtime_policy = RuntimePolicy()
        self._checkpoint = TurnCheckpoint(
            max_tool_calls_per_turn=config.max_tool_calls_per_turn,
            max_tokens_per_turn=config.max_tokens_per_turn,
            max_same_tool_calls=config.max_same_tool_calls,
            no_progress_threshold=config.no_progress_threshold,
            force_answer_threshold=config.force_answer_threshold,
            reroute_threshold=config.reroute_threshold,
        )
```

- [ ] **Step 2: 验证**

Run: `python -c "from mycli.application.runtime.agent_runtime import AgentRuntime; print('OK')"`

Expected: `OK`

- [ ] **Step 3: 提交**

```bash
git add src/mycli/application/runtime/agent_runtime.py
git commit -m "$(cat <<'EOF'
feat: initialize TurnCheckpoint in AgentRuntime

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: react_loop.py 接入 Checkpoint

**Files:**
- Modify: `src/mycli/agents/react_loop.py`

- [ ] **Step 1: 添加 step_index 和 Checkpoint 接入**

`react_loop.py` 的 `run()` 方法是旧路径，没有 runtime，需要显式创建 `TurnCheckpoint` 并接入。

在文件顶部添加导入：

```python
from mycli.services.turn_guard import TurnCheckpoint, NoProgressTracker
```

在 `run()` 方法中，第 41 行 `last_tool_result = None` 后添加：

```python
        last_tool_result: ToolResult | None = None
        step_index = 0
        cumulative_tokens = 0
        no_progress_tracker = NoProgressTracker()
        checkpoint = TurnCheckpoint(
            max_tool_calls_per_turn=context.config.max_tool_calls_per_turn,
            max_tokens_per_turn=context.config.max_tokens_per_turn,
            max_same_tool_calls=context.config.max_same_tool_calls,
            no_progress_threshold=context.config.no_progress_threshold,
            force_answer_threshold=context.config.force_answer_threshold,
            reroute_threshold=context.config.reroute_threshold,
        )
```

在第 44 行 `while True:` 之后插入 checkpoint 检查（在 turn_context 组装之前）：

```python
        while True:
            checkpoint_result = checkpoint.evaluate(
                step_index=step_index,
                conversation=context._conversation if hasattr(context, '_conversation') else 
                    type('Conversation', (), {'session_id': '', 'messages': []})(),
                cumulative_tokens=cumulative_tokens,
                no_progress_tracker=no_progress_tracker,
            )
            if checkpoint_result.exit_reason is not None:
                return TurnResponse(
                    assistant_message=checkpoint_result.assistant_message
                    or "Turn guard limit reached.",
                    progress_updates=tuple(progress_updates),
                )
```

由于 `react_loop.py` 没有 `Conversation` 对象，需要构造或传递。查看 `ExecutionContext` 的结构，它只有 `conversation_messages`（tuple of Message）和 `conversation_summary`。这里的最简做法是：从 context 构造一个临时 Conversation 用于 checkpoint 检查。

```python
            # Build conversation for checkpoint evaluation
            conv_for_checkpoint = Conversation(
                session_id=context.config.session_id,
                messages=list(context.conversation_messages),
            )
            checkpoint_result = checkpoint.evaluate(
                step_index=step_index,
                conversation=conv_for_checkpoint,
                cumulative_tokens=cumulative_tokens,
                no_progress_tracker=no_progress_tracker,
            )
```

在第 135 行 `last_tool_result = ...` 和第 136 行 `continue` 处，添加步数递增和 progress 追踪：

将：
```python
                last_tool_result = self._tool_registry.run(call)
                continue
```

改为：
```python
                last_tool_result = self._tool_registry.run(call)
                no_progress_tracker.update(conv_for_checkpoint)
                step_index += 1
                continue
```

- [ ] **Step 2: 验证**

Run: `python -c "from mycli.agents.react_loop import ReactAgent; print('OK')"`

Expected: `OK`

- [ ] **Step 3: 提交**

```bash
git add src/mycli/agents/react_loop.py
git commit -m "$(cat <<'EOF'
feat: wire TurnCheckpoint into react_loop agent path

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: turn_service.py _run_agent 接入 Checkpoint

**Files:**
- Modify: `src/mycli/application/turn_service.py`

- [ ] **Step 1: 添加导入和 Checkpoint 接入**

在文件顶部添加导入：

```python
from mycli.services.turn_guard import TurnCheckpoint, NoProgressTracker
```

在 `_run_agent()` 方法中，第 176 行 `last_tool_result = None` 后添加：

```python
        last_tool_result: ToolResult | None = None
        step_index = 0
        cumulative_tokens = 0
        no_progress_tracker = NoProgressTracker()
        _checkpoint = TurnCheckpoint(
            max_tool_calls_per_turn=self._config.max_tool_calls_per_turn,
            max_tokens_per_turn=self._config.max_tokens_per_turn,
            max_same_tool_calls=self._config.max_same_tool_calls,
            no_progress_threshold=self._config.no_progress_threshold,
            force_answer_threshold=self._config.force_answer_threshold,
            reroute_threshold=self._config.reroute_threshold,
        )
```

在第 179 行 `while True:` 之后插入 checkpoint 检查：

```python
        while True:
            conv_for_checkpoint = Conversation(
                session_id=self._config.session_id,
                messages=list(context.conversation_messages),
            )
            checkpoint_result = _checkpoint.evaluate(
                step_index=step_index,
                conversation=conv_for_checkpoint,
                cumulative_tokens=cumulative_tokens,
                no_progress_tracker=no_progress_tracker,
            )
            if checkpoint_result.exit_reason is not None:
                return TurnResponse(
                    assistant_message=checkpoint_result.assistant_message
                    or "Turn guard limit reached.",
                    progress_updates=tuple(progress_updates),
                )
```

在第 266 行 `last_tool_result = ...` 和第 272 行 `continue` 处：

将：
```python
                try:
                    last_tool_result = self._tool_registry.run(call)
                except Exception as exc:  # pragma: no cover
                    ...
                continue
```

改为：
```python
                try:
                    last_tool_result = self._tool_registry.run(call)
                    no_progress_tracker.update(conv_for_checkpoint)
                    step_index += 1
                except Exception as exc:  # pragma: no cover
                    ...
                continue
```

- [ ] **Step 2: 验证**

Run: `python -c "from mycli.application.turn_service import TurnService; print('OK')"`

Expected: `OK`

- [ ] **Step 3: 运行测试**

Run: `pytest tests/unit/ -x -q`

Expected: 全部通过

- [ ] **Step 4: 提交**

```bash
git add src/mycli/application/turn_service.py
git commit -m "$(cat <<'EOF'
feat: wire TurnCheckpoint into turn_service _run_agent path

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: RuntimePolicy 复用 Checkpoint 逻辑

**Files:**
- Modify: `src/mycli/services/runtime_policy/policy.py`

- [ ] **Step 1: 在 RuntimePolicy 中移除重复的循环检测逻辑**

`RuntimePolicy.evaluate()` 中有三处独立的 stop 逻辑（repeated replanning、repeated tool calls >= 4、repeated with failures >= 3），现在由 Checkpoint 接管。移除这些 stop 判断，改为委托给 Checkpoint。

具体改动：在 `policy.py` 中删除 `REPEATED_TOOL_CALL_REROUTE_THRESHOLD` 和 `REPEATED_TOOL_CALL_STOP_THRESHOLD` 常量（第 16-17 行），以及相关的 stop 分支（第 115-152 行——即 `repeated_update_plan_calls >= 2` 返回 stop 的块、`repeated_count >= STOP_THRESHOLD` 返回 stop 的块、`repeated_count >= REROUTE_THRESHOLD and repeated_recoverable_failures` 返回 stop 的块）。

保留 reminder 逻辑（`repeated_count >= REROUTE_THRESHOLD` 时注入 reroute 提醒，以及 `has_truncation_signal` 时注入 truncation 提醒），因为这些在 profile 特定的分支中被引用。

简化后的 `evaluate()` 只负责：
1. Profile 推断
2. Reasoning effort 选择
3. Policy state 组装
4. Profile 特定的 reminders 生成（source_first_overview、source_first_verification 等）

所有硬退出判断从 `RuntimePolicy` 移除，交给 `TurnCheckpoint`。

- [ ] **Step 2: 运行测试验证**

Run: `pytest tests/unit/services/test_runtime_policy.py -v`

由于移除了 stop 逻辑，需要更新 `test_runtime_policy_stops_repeated_replanning_when_plan_already_exists` 测试——它不再应期望 stop_reason。

将该测试改为期望 warnings only：

```python
def test_runtime_policy_stops_repeated_replanning_when_plan_already_exists() -> None:
    # This stop is now handled by TurnCheckpoint, not RuntimePolicy
    policy = RuntimePolicy()
    conversation = Conversation(...)
    plan_state = PlanState(...)

    decision = policy.evaluate(
        user_message="请继续推进",
        conversation=conversation,
        plan_state=plan_state,
        step_index=2,
        configured_reasoning_effort=ReasoningEffort.MEDIUM,
    )

    # stop logic moved to TurnCheckpoint; RuntimePolicy only sets reminders
    assert any("replanning" in reminder.lower() or "当前计划" in reminder for reminder in decision.reminders)
```

- [ ] **Step 3: 提交**

```bash
git add src/mycli/services/runtime_policy/policy.py tests/unit/services/test_runtime_policy.py
git commit -m "$(cat <<'EOF'
refactor: delegate exit decisions from RuntimePolicy to TurnCheckpoint

Stop decisions (LOOP_DETECTED, REPEATED_REPLANNING) now live in
TurnCheckpoint. RuntimePolicy retains profile inference, reasoning
effort selection, and profile-specific reminders only.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: 最终验证

- [ ] **Step 1: 运行全部测试**

Run: `pytest tests/unit/ -v`

Expected: 全部通过

- [ ] **Step 2: 确认导入链路完整**

```bash
python -c "
from mycli.services.turn_guard import TurnCheckpoint, ExitReason, ContinueReason, CheckpointResult, NoProgressTracker
from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.application.runtime.turn_executor import TurnExecutor
from mycli.application.turn_service import TurnService
from mycli.agents.react_loop import ReactAgent
from mycli.services.runtime_policy import RuntimePolicy
from mycli.domain.runtime import AgentConfig
print('All imports OK')
"
```

Expected: `All imports OK`

- [ ] **Step 3: 最终提交（如有改动）**

```bash
git status
```
