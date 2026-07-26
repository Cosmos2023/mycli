from __future__ import annotations

from mycli.application.runtime.subagents.loop import (
    RuntimeChildToolExecutor,
    RuntimeChildTurnRequester,
)
from mycli.domain.runtime import (
    ModelTurnResult,
    RuntimeBlock,
    RuntimeInterruptToken,
    RuntimeItem,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolRouteKey,
    ToolRouteSource,
)
from mycli.llms.adapters.base import ModelMessage, ModelToolDefinition
from mycli.tools.base import ToolResult, ToolSpec
from mycli.tools.bash import BashTool
from mycli.tools.invocation_context import ToolInvocationContext
from mycli.tools.registry import ToolRegistry
from mycli.tools.routing.tool_router import ToolRouter
from tests.support.shell_commands import python_shell_command


class FakeRouter:
    def __init__(self) -> None:
        self.calls: list[
            tuple[ToolCall, ToolExposure, ToolInvocationContext | None]
        ] = []

    def execute(
        self,
        call: ToolCall,
        *,
        exposure: ToolExposure,
        invocation_context: ToolInvocationContext | None = None,
    ) -> ToolResult:
        self.calls.append((call, exposure, invocation_context))
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
    assert router.calls[0][2] == ToolInvocationContext(
        owner_session_id="demo:sub:turn_1:abcd1234"
    )


def test_runtime_child_tool_executor_propagates_interrupt_token() -> None:
    router = FakeRouter()
    token = RuntimeInterruptToken(source="subagent")
    executor = RuntimeChildToolExecutor(
        tool_router=router,
        tool_specs={"Read": ToolSpec(name="Read", description="Read a file.")},
    )

    executor.execute_child_tool(
        call=ToolCall(name="Read", arguments={}, reason="inspect", call_id="call_1"),
        child_session_id="demo:sub:turn_1:abcd1234",
        tool_names=("Read",),
        interrupt_token=token,
    )

    assert router.calls[0][2] == ToolInvocationContext(
        owner_session_id="demo:sub:turn_1:abcd1234",
        interrupt_token=token,
    )


def test_runtime_child_shell_lifecycle_events_keep_dream_owner(tmp_path) -> None:
    bash = BashTool(tmp_path)
    bash.configure_shell_session("main-session")
    events = []
    bash.configure_shell_lifecycle(events.append)
    registry = ToolRegistry.from_tools([bash])
    executor = RuntimeChildToolExecutor(
        tool_router=ToolRouter(tool_registry=registry),
        tool_specs=dict(registry.specs or {}),
    )
    child_session_id = "main-session:dream:turn_1:abcd1234"

    for label in ("find", "ls", "cat"):
        result = executor.execute_child_tool(
            call=ToolCall(
                name="Bash",
                arguments={"command": python_shell_command(f"print({label!r})")},
                reason=f"dream {label}",
                call_id=f"call_{label}",
            ),
            child_session_id=child_session_id,
            tool_names=("Bash",),
        )
        assert result.success is True

    assert events
    assert all(event.owner_session_id == child_session_id for event in events)


class FakeRequester:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []
        self.results: list[ModelTurnResult] = []

    def request_model_turn(
        self,
        *,
        runtime_items: list[RuntimeItem],
        legacy_messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
        stream_sink=None,
        interrupt_token=None,
    ):
        self.calls.append(
            {
                "runtime_items": runtime_items,
                "legacy_messages": legacy_messages,
                "tools": tools,
                "stream_sink": stream_sink,
                "interrupt_token": interrupt_token,
            }
        )
        result = ModelTurnResult(
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
            metadata={
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 10,
                }
            },
        )
        self.results.append(result)
        return result, ()


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


def test_runtime_child_turn_requester_propagates_interrupt_token() -> None:
    requester = FakeRequester()
    token = RuntimeInterruptToken(source="subagent")
    child_requester = RuntimeChildTurnRequester(
        requester=requester,
        tool_exposure_builder=lambda names: ToolExposure(entries=()),
        tool_renderer=lambda exposure: [],
    )

    child_requester.request_child_turn(
        messages=[{"role": "user", "content": "inspect"}],
        tool_names=(),
        child_session_id="demo:sub:turn_1:abcd1234",
        interrupt_token=token,
    )

    assert requester.calls[0]["interrupt_token"] is token


def test_runtime_child_turn_requester_marks_usage_internal() -> None:
    requester = FakeRequester()
    child_requester = RuntimeChildTurnRequester(
        requester=requester,
        tool_exposure_builder=lambda names: ToolExposure(entries=()),
        tool_renderer=lambda exposure: [],
    )
    result = ModelTurnResult(
        items=(
            RuntimeItem(
                role="assistant",
                blocks=(RuntimeBlock(type="text", text="done"),),
            ),
        ),
        done=True,
        metadata={
            "usage": {
                "input_tokens": 100,
                "output_tokens": 10,
            }
        },
    )

    marked = child_requester._mark_internal_usage(
        result,
        child_session_id="demo:memory:turn_1:abcd1234",
    )

    assert marked.metadata["usage_scope"] == "internal"
    assert marked.metadata["child_session_id"] == "demo:memory:turn_1:abcd1234"
    assert marked.metadata["usage"] == {
        "input_tokens": 100,
        "output_tokens": 10,
        "usage_scope": "internal",
        "child_session_id": "demo:memory:turn_1:abcd1234",
    }
    assert result.metadata == {
        "usage": {
            "input_tokens": 100,
            "output_tokens": 10,
        }
    }
