from __future__ import annotations

import time
from pathlib import Path

from mycli.application.runtime.tools.tool_execution_service import (
    CONCURRENCY_SAFE_TOOLS,
    ToolExecutionService,
)
from mycli.application.runtime.tools.contributed_tool_registry import ToolContributionRegistry
from mycli.domain.conversation import Conversation
from mycli.domain.runtime import ActivityEvent, PlanState, TurnItem, TurnItemType
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.exposure import ToolExposure, ToolExposureEntry, ToolRouteKey, ToolRouteSource
from mycli.services.context.context_manager import ContextManager
from mycli.services.hooks import HookManager
from mycli.services.tracing import TraceService
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.registry import ToolRegistryV2
from mycli.tools.routing.tool_router import ToolRouter


class DelayedTool:
    def __init__(self, *, name: str, delay_seconds: float) -> None:
        self.spec = ToolSpec(
            name=name,
            description=f"{name} tool",
            parameters=(ToolParameter("path", "string"),),
        )
        self._delay_seconds = delay_seconds
        self.seen_arguments: list[dict[str, object]] = []

    def execute(self, arguments: dict[str, object]) -> ToolResultV2:
        self.seen_arguments.append(dict(arguments))
        time.sleep(self._delay_seconds)
        path = str(arguments["path"])
        return ToolResultV2(
            success=True,
            summary=f"{self.spec.name} {path}",
            raw_payload={"path": path, "content": f"{self.spec.name}:{path}"},
        )


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
    registry = ToolRegistryV2.from_tools(tools)
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
        "read_file",
        "read_file_range",
        "search_text",
        "list_directory",
        "git_status",
        "git_diff",
        "git_log",
    }.issubset(CONCURRENCY_SAFE_TOOLS)
    assert "edit_file" not in CONCURRENCY_SAFE_TOOLS
    assert "update_plan" not in CONCURRENCY_SAFE_TOOLS


def test_execute_tool_calls_runs_adjacent_safe_tools_in_parallel(tmp_path: Path) -> None:
    read_file = DelayedTool(name="read_file", delay_seconds=0.20)
    search_text = DelayedTool(name="search_text", delay_seconds=0.20)
    service, router = _service(tmp_path, tools=[read_file, search_text])
    conversation = Conversation(session_id="demo")
    activity_events: list[ActivityEvent] = []
    turn_items: list[TurnItem] = []
    calls = (
        ToolCall(name="read_file", arguments={"path": "alpha"}, reason="inspect", call_id="call_1"),
        ToolCall(name="search_text", arguments={"path": "beta"}, reason="inspect", call_id="call_2"),
    )

    started_at = time.perf_counter()
    plan_state = service.execute_tool_calls(
        conversation=conversation,
        calls=calls,
        tool_router=router,
        tool_exposure=_tool_exposure("read_file", "search_text"),
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


def test_execute_tool_calls_preserves_order_across_safe_and_unsafe_calls(tmp_path: Path) -> None:
    read_file = DelayedTool(name="read_file", delay_seconds=0.15)
    edit_file = DelayedTool(name="edit_file", delay_seconds=0.15)
    search_text = DelayedTool(name="search_text", delay_seconds=0.15)
    service, router = _service(tmp_path, tools=[read_file, edit_file, search_text])
    conversation = Conversation(session_id="demo")
    activity_events: list[ActivityEvent] = []
    turn_items: list[TurnItem] = []
    calls = (
        ToolCall(name="read_file", arguments={"path": "alpha"}, reason="inspect", call_id="call_1"),
        ToolCall(name="edit_file", arguments={"path": "beta"}, reason="mutate", call_id="call_2"),
        ToolCall(name="search_text", arguments={"path": "gamma"}, reason="inspect", call_id="call_3"),
    )

    started_at = time.perf_counter()
    service.execute_tool_calls(
        conversation=conversation,
        calls=calls,
        tool_router=router,
        tool_exposure=_tool_exposure("read_file", "edit_file", "search_text"),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=activity_events,
        turn_items=turn_items,
    )
    elapsed = time.perf_counter() - started_at

    assert elapsed >= 0.40
    assert elapsed < 0.55
    assert "edit_file" not in CONCURRENCY_SAFE_TOOLS
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
        "read_file",
        "edit_file",
        "search_text",
    ]
    assert [item.call_id for item in turn_items if item.type is TurnItemType.TOOL_CALL] == [
        "call_1",
        "call_2",
        "call_3",
    ]


def test_execute_tool_calls_executes_all_calls_and_keeps_tool_results_ordered(tmp_path: Path) -> None:
    list_directory = DelayedTool(name="list_directory", delay_seconds=0.10)
    git_diff = DelayedTool(name="git_diff", delay_seconds=0.10)
    edit_file = DelayedTool(name="edit_file", delay_seconds=0.10)
    git_log = DelayedTool(name="git_log", delay_seconds=0.10)
    service, router = _service(tmp_path, tools=[list_directory, git_diff, edit_file, git_log])
    conversation = Conversation(session_id="demo")
    activity_events: list[ActivityEvent] = []
    turn_items: list[TurnItem] = []
    calls = (
        ToolCall(
            name="list_directory",
            arguments={"path": "one"},
            reason="inspect",
            call_id="call_1",
        ),
        ToolCall(
            name="git_diff",
            arguments={"path": "two"},
            reason="inspect",
            call_id="call_2",
        ),
        ToolCall(
            name="edit_file",
            arguments={"path": "three"},
            reason="mutate",
            call_id="call_3",
        ),
        ToolCall(
            name="git_log",
            arguments={"path": "four"},
            reason="inspect",
            call_id="call_4",
        ),
    )

    service.execute_tool_calls(
        conversation=conversation,
        calls=calls,
        tool_router=router,
        tool_exposure=_tool_exposure("list_directory", "git_diff", "edit_file", "git_log"),
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
