from __future__ import annotations

from mycli.domain.tooling.contributed_tools import (
    ToolContributionDescriptor,
    ToolContributionLifecycleState,
    ToolContributionRegistration,
    ToolContributionScope,
    ToolContributionSource,
)
from mycli.domain.tool_exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolRouteKey,
    ToolRouteSource,
)
from mycli.domain.tools import ToolCall
from mycli.application.runtime.tools.contributed_tool_registry import ToolContributionRegistry
from mycli.tools.routing.tool_router import ToolRouter
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec
from mycli.tools.registry import ToolRegistry


class FakeTool:
    def __init__(self, name: str, summary: str) -> None:
        self.spec = ToolSpec(
            name=name,
            description=f"Tool {name}",
            parameters=(ToolParameter(name="path", type="string", required=False),),
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
