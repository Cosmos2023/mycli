from __future__ import annotations

import time
from pathlib import Path

import pytest

from mycli.application.runtime.tools.tool_execution_service import (
    CONCURRENCY_SAFE_TOOLS,
    ToolExecutionService,
)
from mycli.application.runtime.tools.tool_call_runtime import ToolCallRuntime
from mycli.application.runtime.tools.contributed_tool_registry import ToolContributionRegistry
from mycli.domain.conversation import Conversation
from mycli.domain.runtime import ActivityEvent, PlanState, TurnItem, TurnItemType
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.exposure import ToolExposure, ToolExposureEntry, ToolRouteKey, ToolRouteSource
from mycli.services.context.context_manager import ContextManager
from mycli.services.hooks import HookManager
from mycli.services.tracing import TraceService
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec
from mycli.tools.registry import ToolRegistry
from mycli.tools.routing.tool_router import ToolRouter


class DelayedTool:
    def __init__(
        self,
        *,
        name: str,
        delay_seconds: float,
        supports_parallel_tool_calls: bool = False,
    ) -> None:
        self.spec = ToolSpec(
            name=name,
            description=f"{name} tool",
            parameters=(ToolParameter("path", "string"),),
            supports_parallel_tool_calls=supports_parallel_tool_calls,
        )
        self._delay_seconds = delay_seconds
        self.seen_arguments: list[dict[str, object]] = []

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        self.seen_arguments.append(dict(arguments))
        time.sleep(self._delay_seconds)
        path = str(arguments["path"])
        return ToolResult(
            success=True,
            summary=f"{self.spec.name} {path}",
            raw_payload={"path": path, "content": f"{self.spec.name}:{path}"},
        )


class InterruptingTool:
    def __init__(self, *, name: str) -> None:
        self.spec = ToolSpec(
            name=name,
            description=f"{name} tool",
            parameters=(ToolParameter("path", "string"),),
        )
        self.seen_arguments: list[dict[str, object]] = []

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        self.seen_arguments.append(dict(arguments))
        raise KeyboardInterrupt


def _tool_exposure(*tool_names: str) -> ToolExposure:
    return ToolExposure(
        entries=tuple(
            ToolExposureEntry(
                route_key=ToolRouteKey.local(tool_name),
                source=ToolRouteSource.REGISTRY,
                spec=ToolSpec(
                    name=tool_name,
                    description=f"{tool_name} tool",
                    parameters=(ToolParameter("path", "string"),),
                ),
            )
            for tool_name in tool_names
        )
    )


def _append_turn_item(*, turn_items: list[TurnItem], item: TurnItem, **_: object) -> None:
    turn_items.append(item)


def _service(
    tmp_path: Path,
    *,
    tools: list[DelayedTool],
) -> tuple[ToolExecutionService, ToolRouter]:
    registry = ToolRegistry.from_tools(tools)
    service = ToolExecutionService(
        session_id="demo",
        context_manager=ContextManager(),
        trace_service=TraceService(home_dir=tmp_path / "home"),
        append_turn_item=_append_turn_item,
        append_lifecycle_events=lambda **_: None,
        apply_tool_effects=lambda **kwargs: kwargs["plan_state"],
        normalize_tool_call=lambda call: call,
        hook_manager=HookManager(),
    )
    router = ToolRouter(
        tool_registry=registry,
        contributed_tool_registry=ToolContributionRegistry(),
    )
    return service, router


def test_concurrency_safe_tools_exports_expected_names() -> None:
    assert {
        "Read",
        "Grep",
        "Glob",
        "LS",
        "WebSearch",
        "WebFetch",
        "Lint",
    }.issubset(CONCURRENCY_SAFE_TOOLS)
    assert "Edit" not in CONCURRENCY_SAFE_TOOLS
    assert "Plan" not in CONCURRENCY_SAFE_TOOLS


def test_execute_tool_calls_runs_adjacent_safe_tools_in_parallel(tmp_path: Path) -> None:
    read_file = DelayedTool(name="Read", delay_seconds=0.20, supports_parallel_tool_calls=True)
    search_text = DelayedTool(name="Grep", delay_seconds=0.20, supports_parallel_tool_calls=True)
    service, router = _service(tmp_path, tools=[read_file, search_text])
    conversation = Conversation(session_id="demo")
    activity_events: list[ActivityEvent] = []
    turn_items: list[TurnItem] = []
    calls = (
        ToolCall(name="Read", arguments={"path": "alpha"}, reason="inspect", call_id="call_1"),
        ToolCall(name="Grep", arguments={"path": "beta"}, reason="inspect", call_id="call_2"),
    )

    started_at = time.perf_counter()
    plan_state = service.execute_tool_calls(
        conversation=conversation,
        calls=calls,
        tool_router=router,
        tool_exposure=_tool_exposure("Read", "Grep"),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=activity_events,
        turn_items=turn_items,
    )
    elapsed = time.perf_counter() - started_at

    assert plan_state == PlanState()
    assert elapsed < 0.35
    assert [message.role for message in conversation.messages] == [
        "assistant",
        "tool",
        "assistant",
        "tool",
    ]
    assert [message.tool_call_id for message in conversation.messages if message.role == "tool"] == [
        "call_1",
        "call_2",
    ]
    assert [item.type for item in turn_items] == [
        TurnItemType.TOOL_CALL,
        TurnItemType.TOOL_RESULT,
        TurnItemType.TOOL_CALL,
        TurnItemType.TOOL_RESULT,
    ]
    assert [item.call_id for item in turn_items if item.type is TurnItemType.TOOL_RESULT] == [
        "call_1",
        "call_2",
    ]


def test_execute_tool_calls_uses_tool_parallel_support_metadata(tmp_path: Path) -> None:
    first = DelayedTool(
        name="CustomParallel",
        delay_seconds=0.20,
        supports_parallel_tool_calls=True,
    )
    second = DelayedTool(
        name="AnotherParallel",
        delay_seconds=0.20,
        supports_parallel_tool_calls=True,
    )
    service, router = _service(tmp_path, tools=[first, second])
    conversation = Conversation(session_id="demo")
    activity_events: list[ActivityEvent] = []
    turn_items: list[TurnItem] = []
    calls = (
        ToolCall(
            name="CustomParallel",
            arguments={"path": "alpha"},
            reason="inspect",
            call_id="call_1",
        ),
        ToolCall(
            name="AnotherParallel",
            arguments={"path": "beta"},
            reason="inspect",
            call_id="call_2",
        ),
    )

    started_at = time.perf_counter()
    service.execute_tool_calls(
        conversation=conversation,
        calls=calls,
        tool_router=router,
        tool_exposure=_tool_exposure("CustomParallel", "AnotherParallel"),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=activity_events,
        turn_items=turn_items,
    )
    elapsed = time.perf_counter() - started_at

    assert "CustomParallel" not in CONCURRENCY_SAFE_TOOLS
    assert "AnotherParallel" not in CONCURRENCY_SAFE_TOOLS
    assert elapsed < 0.35
    assert [message.tool_call_id for message in conversation.messages if message.role == "tool"] == [
        "call_1",
        "call_2",
    ]


def test_execute_tool_calls_preserves_order_across_safe_and_unsafe_calls(tmp_path: Path) -> None:
    read_file = DelayedTool(name="Read", delay_seconds=0.15, supports_parallel_tool_calls=True)
    edit_file = DelayedTool(name="Edit", delay_seconds=0.15)
    search_text = DelayedTool(name="Grep", delay_seconds=0.15, supports_parallel_tool_calls=True)
    service, router = _service(tmp_path, tools=[read_file, edit_file, search_text])
    conversation = Conversation(session_id="demo")
    activity_events: list[ActivityEvent] = []
    turn_items: list[TurnItem] = []
    calls = (
        ToolCall(name="Read", arguments={"path": "alpha"}, reason="inspect", call_id="call_1"),
        ToolCall(name="Edit", arguments={"path": "beta"}, reason="mutate", call_id="call_2"),
        ToolCall(name="Grep", arguments={"path": "gamma"}, reason="inspect", call_id="call_3"),
    )

    started_at = time.perf_counter()
    service.execute_tool_calls(
        conversation=conversation,
        calls=calls,
        tool_router=router,
        tool_exposure=_tool_exposure("Read", "Edit", "Grep"),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=activity_events,
        turn_items=turn_items,
    )
    elapsed = time.perf_counter() - started_at

    assert elapsed >= 0.40
    assert elapsed < 0.55
    assert "Edit" not in CONCURRENCY_SAFE_TOOLS
    assert [message.tool_call_id for message in conversation.messages if message.role == "tool"] == [
        "call_1",
        "call_2",
        "call_3",
    ]
    result_blocks = [
        block
        for message in conversation.messages
        if message.role == "tool"
        for block in message.blocks
        if block.type == "tool_result"
    ]
    assert [block.metadata["tool_name"] for block in result_blocks] == [
        "Read",
        "Edit",
        "Grep",
    ]
    assert [item.call_id for item in turn_items if item.type is TurnItemType.TOOL_CALL] == [
        "call_1",
        "call_2",
        "call_3",
    ]


def test_execute_tool_calls_executes_all_calls_and_keeps_tool_results_ordered(tmp_path: Path) -> None:
    list_directory = DelayedTool(name="LS", delay_seconds=0.10, supports_parallel_tool_calls=True)
    git_diff = DelayedTool(name="Grep", delay_seconds=0.10, supports_parallel_tool_calls=True)
    edit_file = DelayedTool(name="Edit", delay_seconds=0.10)
    git_log = DelayedTool(name="Read", delay_seconds=0.10, supports_parallel_tool_calls=True)
    service, router = _service(tmp_path, tools=[list_directory, git_diff, edit_file, git_log])
    conversation = Conversation(session_id="demo")
    activity_events: list[ActivityEvent] = []
    turn_items: list[TurnItem] = []
    calls = (
        ToolCall(
            name="LS",
            arguments={"path": "one"},
            reason="inspect",
            call_id="call_1",
        ),
        ToolCall(
            name="Grep",
            arguments={"path": "two"},
            reason="inspect",
            call_id="call_2",
        ),
        ToolCall(
            name="Edit",
            arguments={"path": "three"},
            reason="mutate",
            call_id="call_3",
        ),
        ToolCall(
            name="Read",
            arguments={"path": "four"},
            reason="inspect",
            call_id="call_4",
        ),
    )

    service.execute_tool_calls(
        conversation=conversation,
        calls=calls,
        tool_router=router,
        tool_exposure=_tool_exposure("LS", "Grep", "Edit", "Read"),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=activity_events,
        turn_items=turn_items,
    )

    assert list_directory.seen_arguments == [{"path": "one"}]
    assert git_diff.seen_arguments == [{"path": "two"}]
    assert edit_file.seen_arguments == [{"path": "three"}]
    assert git_log.seen_arguments == [{"path": "four"}]
    tool_messages = [message for message in conversation.messages if message.role == "tool"]
    assert [message.tool_call_id for message in tool_messages] == [
        "call_1",
        "call_2",
        "call_3",
        "call_4",
    ]
    assert [item.type for item in turn_items] == [
        TurnItemType.TOOL_CALL,
        TurnItemType.TOOL_RESULT,
        TurnItemType.TOOL_CALL,
        TurnItemType.TOOL_RESULT,
        TurnItemType.TOOL_CALL,
        TurnItemType.TOOL_RESULT,
        TurnItemType.TOOL_CALL,
        TurnItemType.TOOL_RESULT,
    ]


def test_execute_tool_calls_records_aborted_outputs_for_pending_calls_after_interrupt(
    tmp_path: Path,
) -> None:
    search_text = InterruptingTool(name="Grep")
    edit_file = DelayedTool(name="Edit", delay_seconds=0.01)
    read_file = DelayedTool(name="Read", delay_seconds=0.01, supports_parallel_tool_calls=True)
    service, router = _service(tmp_path, tools=[search_text, edit_file, read_file])
    conversation = Conversation(session_id="demo")
    activity_events: list[ActivityEvent] = []
    turn_items: list[TurnItem] = []
    calls = (
        ToolCall(name="Grep", arguments={"path": "one"}, reason="interrupt", call_id="call_1"),
        ToolCall(name="Edit", arguments={"path": "two"}, reason="mutate", call_id="call_2"),
        ToolCall(name="Read", arguments={"path": "three"}, reason="inspect", call_id="call_3"),
    )

    with pytest.raises(KeyboardInterrupt):
        service.execute_tool_calls(
            conversation=conversation,
            calls=calls,
            tool_router=router,
            tool_exposure=_tool_exposure("Grep", "Edit", "Read"),
            plan_state=PlanState(),
            turn_id="turn_1",
            activity_events=activity_events,
            turn_items=turn_items,
        )

    assert search_text.seen_arguments == [{"path": "one"}]
    assert edit_file.seen_arguments == []
    assert read_file.seen_arguments == []
    tool_messages = [message for message in conversation.messages if message.role == "tool"]
    assert [message.tool_call_id for message in tool_messages] == [
        "call_1",
        "call_2",
        "call_3",
    ]
    result_blocks = [
        block
        for message in tool_messages
        for block in message.blocks
        if block.type == "tool_result"
    ]
    assert [block.metadata["error_kind"] for block in result_blocks] == [
        "tool_interrupted",
        "tool_interrupted",
        "tool_interrupted",
    ]
    assert [item.call_id for item in turn_items if item.type is TurnItemType.TOOL_RESULT] == [
        "call_1",
        "call_2",
        "call_3",
    ]


def test_tool_call_runtime_batches_adjacent_safe_calls_and_preserves_order() -> None:
    calls = (
        ToolCall(name="Read", arguments={"path": "one"}, reason="inspect", call_id="call_1"),
        ToolCall(name="Grep", arguments={"path": "two"}, reason="inspect", call_id="call_2"),
        ToolCall(name="Edit", arguments={"path": "three"}, reason="mutate", call_id="call_3"),
        ToolCall(name="LS", arguments={"path": "four"}, reason="inspect", call_id="call_4"),
    )
    executed_batches: list[tuple[str, ...]] = []

    def execute_batch(batch: tuple[ToolCall, ...], plan_state: PlanState) -> tuple[PlanState, ...]:
        executed_batches.append(tuple(call.call_id or "" for call in batch))
        return tuple(plan_state for _ in batch)

    runtime = ToolCallRuntime(
        concurrency_safe_tools=CONCURRENCY_SAFE_TOOLS,
        execute_batch=execute_batch,
    )

    result = runtime.execute_calls(calls=calls, plan_state=PlanState())

    assert result == PlanState()
    assert executed_batches == [
        ("call_1", "call_2"),
        ("call_3",),
        ("call_4",),
    ]


def test_tool_call_runtime_runs_safe_batch_in_parallel() -> None:
    calls = (
        ToolCall(name="Read", arguments={"path": "one"}, reason="inspect", call_id="call_1"),
        ToolCall(name="Grep", arguments={"path": "two"}, reason="inspect", call_id="call_2"),
    )

    def execute_call(call: ToolCall, plan_state: PlanState) -> PlanState:
        del call
        time.sleep(0.20)
        return plan_state

    runtime = ToolCallRuntime(
        concurrency_safe_tools=CONCURRENCY_SAFE_TOOLS,
        execute_call=execute_call,
    )

    started_at = time.perf_counter()
    result = runtime.execute_calls(calls=calls, plan_state=PlanState())
    elapsed = time.perf_counter() - started_at

    assert result == PlanState()
    assert elapsed < 0.35


def test_tool_call_runtime_records_abort_outcomes_for_interrupted_safe_batch() -> None:
    calls = (
        ToolCall(name="Read", arguments={"path": "one"}, reason="inspect", call_id="call_1"),
        ToolCall(name="Grep", arguments={"path": "two"}, reason="inspect", call_id="call_2"),
    )
    aborted_call_ids: list[str] = []
    applied_call_ids: list[str] = []

    def execute_batch(batch: tuple[ToolCall, ...], plan_state: PlanState) -> tuple[PlanState, ...]:
        del batch, plan_state
        raise KeyboardInterrupt

    def abort_outcome(call: ToolCall, plan_state: PlanState) -> tuple[str, PlanState]:
        aborted_call_ids.append(call.call_id or "")
        return call.call_id or "", plan_state

    def apply_outcome(outcome: tuple[str, PlanState]) -> PlanState:
        call_id, plan_state = outcome
        applied_call_ids.append(call_id)
        return plan_state

    runtime = ToolCallRuntime(
        concurrency_safe_tools=CONCURRENCY_SAFE_TOOLS,
        execute_batch=execute_batch,
        abort_outcome=abort_outcome,
    )

    with pytest.raises(KeyboardInterrupt):
        runtime.execute_calls(
            calls=calls,
            plan_state=PlanState(),
            apply_outcome=apply_outcome,
        )

    assert aborted_call_ids == ["call_1", "call_2"]
    assert applied_call_ids == ["call_1", "call_2"]


def test_tool_call_runtime_records_abort_outcomes_for_pending_calls_after_interrupt() -> None:
    calls = (
        ToolCall(name="Read", arguments={"path": "one"}, reason="inspect", call_id="call_1"),
        ToolCall(name="Edit", arguments={"path": "two"}, reason="mutate", call_id="call_2"),
        ToolCall(name="Grep", arguments={"path": "three"}, reason="inspect", call_id="call_3"),
    )
    executed_call_ids: list[str] = []
    aborted_call_ids: list[str] = []
    applied_call_ids: list[str] = []

    def execute_call(call: ToolCall, plan_state: PlanState) -> PlanState:
        del plan_state
        executed_call_ids.append(call.call_id or "")
        raise KeyboardInterrupt

    def abort_outcome(call: ToolCall, plan_state: PlanState) -> tuple[str, PlanState]:
        aborted_call_ids.append(call.call_id or "")
        return call.call_id or "", plan_state

    def apply_outcome(outcome: tuple[str, PlanState]) -> PlanState:
        call_id, plan_state = outcome
        applied_call_ids.append(call_id)
        return plan_state

    runtime = ToolCallRuntime(
        concurrency_safe_tools=CONCURRENCY_SAFE_TOOLS,
        execute_call=execute_call,
        abort_outcome=abort_outcome,
    )

    with pytest.raises(KeyboardInterrupt):
        runtime.execute_calls(
            calls=calls,
            plan_state=PlanState(),
            apply_outcome=apply_outcome,
        )

    assert executed_call_ids == ["call_1"]
    assert aborted_call_ids == ["call_1", "call_2", "call_3"]
    assert applied_call_ids == ["call_1", "call_2", "call_3"]
