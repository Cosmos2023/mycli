from __future__ import annotations

from mycli.application.runtime.subagents.loop import (
    RuntimeChildToolExecutor,
    RuntimeChildTurnRequester,
)
from mycli.domain.runtime import ModelTurnResult, RuntimeBlock, RuntimeItem
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolRouteKey,
    ToolRouteSource,
)
from mycli.llms.adapters.base import ModelMessage, ModelToolDefinition
from mycli.tools.base import ToolResult, ToolSpec


class FakeRouter:
    def __init__(self) -> None:
        self.calls: list[tuple[ToolCall, ToolExposure]] = []

    def execute(self, call: ToolCall, *, exposure: ToolExposure) -> ToolResult:
        self.calls.append((call, exposure))
        return ToolResult(success=True, summary="ok", raw_payload={"content": "ok"})


def test_runtime_child_tool_executor_uses_child_exposure_only() -> None:
    router = FakeRouter()
    executor = RuntimeChildToolExecutor(
        tool_router=router,
        tool_specs={
            "Read": ToolSpec(name="Read", description="Read a file."),
            "Task": ToolSpec(name="Task", description="Run a child agent."),
        },
    )
    call = ToolCall(
        name="Read",
        arguments={"path": "README.md"},
        reason="inspect file",
        call_id="call_1",
    )

    result = executor.execute_child_tool(
        call=call,
        child_session_id="demo:sub:turn_1:abcd1234",
        tool_names=("Read",),
    )

    assert result.success is True
    assert router.calls[0][0] == call
    assert router.calls[0][1].callable_tool_names() == ("Read",)


class FakeRequester:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def request_model_turn(
        self,
        *,
        runtime_items: list[RuntimeItem],
        legacy_messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
        stream_sink=None,
    ):
        self.calls.append(
            {
                "runtime_items": runtime_items,
                "legacy_messages": legacy_messages,
                "tools": tools,
                "stream_sink": stream_sink,
            }
        )
        return (
            ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(type="text", text="checking"),
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="Read",
                                tool_arguments={"path": "README.md"},
                                call_id="call_1",
                            ),
                        ),
                    ),
                ),
                done=False,
            ),
            (),
        )


def test_runtime_child_turn_requester_projects_model_result() -> None:
    requester = FakeRequester()
    spec = ToolSpec(name="Read", description="Read a file.")
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Read"),
                source=ToolRouteSource.REGISTRY,
                spec=spec,
            ),
        )
    )
    child_requester = RuntimeChildTurnRequester(
        requester=requester,
        tool_exposure_builder=lambda names: exposure,
        tool_renderer=lambda exposure: [
            ModelToolDefinition(name="Read", description="Read a file.", parameters=())
        ],
    )

    turn = child_requester.request_child_turn(
        messages=[
            {"role": "system", "content": "Read only."},
            {"role": "user", "content": "Find docs"},
        ],
        tool_names=("Read",),
        child_session_id="demo:sub:turn_1:abcd1234",
    )

    assert turn.text == "checking"
    assert turn.tool_calls == (
        ToolCall(
            name="Read",
            arguments={"path": "README.md"},
            reason="child sub-agent tool call",
            call_id="call_1",
        ),
    )
    assert requester.calls[0]["stream_sink"] is None
