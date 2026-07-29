from __future__ import annotations

from mycli.domain.tooling.contributed_tools import (
    ToolContributionDescriptor,
    ToolContributionLifecycleState,
    ToolContributionRegistration,
    ToolContributionScope,
    ToolContributionSource,
)
from mycli.domain.tooling.exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolExposureKind,
    ToolRouteKey,
    ToolRouteSource,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.application.runtime.tools.contributed_tool_registry import ToolContributionRegistry
from mycli.tools.routing.tool_router import ToolRouter
from mycli.tools.base import ToolEffectProfile, ToolParameter, ToolResult, ToolSpec
from mycli.tools.invocation_context import (
    ToolInvocationContext,
    current_tool_owner_session_id,
)
from mycli.tools.registry import ToolRegistry
from mycli.tools.read import ReadTool


class FakeTool:
    def __init__(
        self,
        name: str,
        summary: str,
        *,
        supports_parallel_tool_calls: bool = False,
    ) -> None:
        self.spec = ToolSpec(
            name=name,
            description=f"Tool {name}",
            parameters=(ToolParameter(name="path", type="string", required=False),),
            supports_parallel_tool_calls=supports_parallel_tool_calls,
        )
        self.summary = summary
        self.calls: list[dict[str, object]] = []

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        self.calls.append(arguments)
        return ToolResult(success=True, summary=self.summary, raw_payload={"tool": self.spec.name})


class ExplodingTool(FakeTool):
    def execute(self, arguments: dict[str, object]) -> ToolResult:
        self.calls.append(arguments)
        raise RuntimeError("boom")


class OwnerCapturingTool(FakeTool):
    def __init__(self) -> None:
        super().__init__("OwnerCapture", "captured")
        self.owners: list[str] = []

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        self.owners.append(current_tool_owner_session_id("main"))
        return super().execute(arguments)


def _contribution_registration(tool: FakeTool) -> ToolContributionRegistration:
    return ToolContributionRegistration(
        descriptor=ToolContributionDescriptor(
            tool_id=f"runtime:{tool.spec.name}:turn",
            display_name=tool.spec.name,
            description=tool.spec.description,
            route_key=ToolRouteKey.local(tool.spec.name),
            source=ToolContributionSource.RUNTIME,
            scope=ToolContributionScope.TURN,
            lifecycle_state=ToolContributionLifecycleState.EXPOSED,
            spec=tool.spec,
        ),
        tool=tool,
    )


def test_tool_router_renders_only_callable_tools() -> None:
    registry = ToolRegistry.from_tools([FakeTool("LS", "listed"), FakeTool("Bash", "ran")])
    contributed = FakeTool("workspace_summary", "summarized")
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("LS"),
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["LS"],
            ),
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Bash"),
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["Bash"],
            ),
            ToolExposureEntry(
                route_key=ToolRouteKey.local("workspace_summary"),
                source=ToolRouteSource.RUNTIME,
                spec=contributed.spec,
            ),
        ),
    )
    router = ToolRouter(
        tool_registry=registry,
        contributed_tools={"workspace_summary": _contribution_registration(contributed)},
    )

    rendered = router.render_for_model(exposure)

    assert [tool.name for tool in rendered] == ["Bash", "LS", "workspace_summary"]


def test_tool_router_hides_deferred_schema_but_keeps_tool_callable() -> None:
    deferred = FakeTool("weather_forecast", "forecast")
    registry = ToolRegistry.from_tools([deferred])
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("weather_forecast"),
                source=ToolRouteSource.REGISTRY,
                spec=deferred.spec,
                kind=ToolExposureKind.DEFERRED,
            ),
        ),
    )
    router = ToolRouter(tool_registry=registry)

    assert router.render_for_model(exposure) == []
    result = router.execute(
        ToolCall(
            name="weather_forecast",
            arguments={"path": "Shanghai"},
            reason="use discovered tool",
            call_id="call_weather",
        ),
        exposure=exposure,
    )

    assert result.summary == "forecast"


def test_tool_router_schema_order_does_not_change_when_exposure_order_changes() -> None:
    registry = ToolRegistry.from_tools(
        [
            FakeTool("LS", "listed"),
            FakeTool("Bash", "ran"),
        ]
    )
    first_exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Bash"),
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["Bash"],
            ),
            ToolExposureEntry(
                route_key=ToolRouteKey.local("LS"),
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["LS"],
            ),
        ),
    )
    second_exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("LS"),
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["LS"],
            ),
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Bash"),
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["Bash"],
            ),
        ),
    )
    router = ToolRouter(tool_registry=registry)

    first_names = [tool.name for tool in router.render_for_model(first_exposure)]
    second_names = [tool.name for tool in router.render_for_model(second_exposure)]

    assert first_names == ["Bash", "LS"]
    assert second_names == ["Bash", "LS"]


def test_tool_router_preserves_array_parameter_item_schema() -> None:
    tool = FakeTool("update_plan", "updated")
    tool.spec = ToolSpec(
        name="update_plan",
        description="Replace the active plan with a structured list of pending and in-progress steps.",
        parameters=(
            ToolParameter(
                name="items",
                type="array",
                required=True,
                items_schema={
                    "type": "object",
                    "properties": {
                        "status": {"type": "string"},
                        "description": {"type": "string"},
                    },
                    "required": ["status"],
                    "additionalProperties": False,
                },
            ),
        ),
    )
    registry = ToolRegistry.from_tools([tool])
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("update_plan"),
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["update_plan"],
            ),
        ),
    )
    router = ToolRouter(tool_registry=registry)

    rendered = router.render_for_model(exposure)

    assert rendered[0].parameters[0].items_schema == {
        "type": "object",
        "properties": {
            "status": {"type": "string"},
            "description": {"type": "string"},
        },
        "required": ["status"],
        "additionalProperties": False,
    }


def test_tool_router_reports_parallel_support_from_registry_specs() -> None:
    registry = ToolRegistry.from_tools(
        [
            FakeTool("ReadOnly", "read", supports_parallel_tool_calls=True),
            FakeTool("Mutating", "mutate"),
        ]
    )
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("ReadOnly"),
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["ReadOnly"],
            ),
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Mutating"),
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["Mutating"],
            ),
        ),
    )
    router = ToolRouter(tool_registry=registry)

    assert router.supports_parallel_tool_calls(
        ToolCall(
            name="ReadOnly",
            arguments={},
            reason="inspect",
            call_id="call_read",
        ),
        exposure=exposure,
    )
    assert not router.supports_parallel_tool_calls(
        ToolCall(
            name="Mutating",
            arguments={},
            reason="mutate",
            call_id="call_mutate",
        ),
        exposure=exposure,
    )


def test_tool_router_reports_parallel_support_from_contributed_specs() -> None:
    registry = ToolRegistry.from_tools([FakeTool("LS", "listed")])
    contributed = FakeTool(
        "workspace_summary",
        "summarized",
        supports_parallel_tool_calls=True,
    )
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("workspace_summary"),
                source=ToolRouteSource.RUNTIME,
                spec=contributed.spec,
            ),
        ),
    )
    registration = _contribution_registration(contributed)
    router = ToolRouter(
        tool_registry=registry,
        contributed_tools={"workspace_summary": registration},
    )

    assert router.supports_parallel_tool_calls(
        ToolCall(
            name="workspace_summary",
            arguments={"path": "."},
            reason="summarize",
            call_id="call_contributed",
        ),
        exposure=exposure,
    )


def test_tool_router_executes_contributed_tool_when_exposed() -> None:
    registry = ToolRegistry.from_tools([FakeTool("LS", "listed")])
    contributed = FakeTool("workspace_summary", "summarized")
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("workspace_summary"),
                source=ToolRouteSource.RUNTIME,
                spec=contributed.spec,
            ),
        ),
    )
    contribution_registry = ToolContributionRegistry()
    registration = _contribution_registration(contributed)
    contribution_registry.register(registration)
    router = ToolRouter(
        tool_registry=registry,
        contributed_tools={"workspace_summary": registration},
        contributed_tool_registry=contribution_registry,
    )

    result = router.execute(
        ToolCall(
            name="workspace_summary",
            arguments={"path": "."},
            reason="summarize workspace",
            call_id="call_contributed_1",
        ),
        exposure=exposure,
    )

    assert result.summary == "summarized"
    assert contributed.calls == [{"path": "."}]
    lifecycle = router.pop_lifecycle_events()
    assert [event.state.value for event in lifecycle] == ["invoked", "completed"]


def test_tool_router_marks_contributed_tool_failed_when_execution_raises() -> None:
    registry = ToolRegistry.from_tools([FakeTool("LS", "listed")])
    contributed = ExplodingTool("workspace_summary", "summarized")
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("workspace_summary"),
                source=ToolRouteSource.RUNTIME,
                spec=contributed.spec,
            ),
        ),
    )
    contribution_registry = ToolContributionRegistry()
    registration = _contribution_registration(contributed)
    contribution_registry.register(registration)
    router = ToolRouter(
        tool_registry=registry,
        contributed_tools={"workspace_summary": registration},
        contributed_tool_registry=contribution_registry,
    )

    try:
        router.execute(
            ToolCall(
                name="workspace_summary",
                arguments={"path": "."},
                reason="summarize workspace",
                call_id="call_contributed_2",
            ),
            exposure=exposure,
        )
    except RuntimeError as exc:
        assert str(exc) == "boom"
    else:
        raise AssertionError("router should re-raise contributed tool execution errors")

    lifecycle = router.pop_lifecycle_events()
    assert [event.state.value for event in lifecycle] == ["invoked", "failed"]


def test_tool_router_executes_exposed_tool_calls() -> None:
    registry = ToolRegistry.from_tools([FakeTool("Bash", "ran")])
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Bash"),
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["Bash"],
            ),
        ),
    )
    router = ToolRouter(tool_registry=registry)

    result = router.execute(
        ToolCall(
            name="Bash",
            arguments={"command": "pwd"},
            reason="run shell",
            call_id="call_tool_1",
        ),
        exposure=exposure,
    )

    assert result.summary == "ran"


def test_tool_router_scopes_owner_to_one_execution() -> None:
    tool = OwnerCapturingTool()
    registry = ToolRegistry.from_tools([tool])
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local(tool.spec.name),
                source=ToolRouteSource.REGISTRY,
                spec=tool.spec,
            ),
        )
    )
    router = ToolRouter(tool_registry=registry)
    call = ToolCall(
        name=tool.spec.name,
        arguments={},
        reason="capture owner",
        call_id="call_owner",
    )

    router.execute(
        call,
        exposure=exposure,
        invocation_context=ToolInvocationContext(owner_session_id="child-session"),
    )
    router.execute(call, exposure=exposure)

    assert tool.owners == ["child-session", "main"]


def test_tool_router_returns_effect_profile_without_executing_tool(tmp_path) -> None:
    read_tool = ReadTool(tmp_path)
    registry = ToolRegistry.from_tools([read_tool])
    router = ToolRouter(tool_registry=registry)
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Read"),
                source=ToolRouteSource.REGISTRY,
                spec=read_tool.spec,
            ),
        )
    )

    profile = router.effect_profile(
        ToolCall(
            name="Read",
            arguments={"file_path": "missing.txt"},
            reason="inspect",
            call_id="call_read_1",
        ),
        exposure=exposure,
    )

    assert profile == ToolEffectProfile(filesystem="read")
