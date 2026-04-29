from __future__ import annotations

from mycli.domain.dynamic_tools import (
    DynamicToolDescriptor,
    DynamicToolLifecycleState,
    DynamicToolRegistration,
    DynamicToolScope,
    DynamicToolSource,
)
from mycli.domain.tool_exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolExposureKind,
    ToolRouteKey,
    ToolRouteSource,
)
from mycli.domain.tools import ToolCall
from mycli.services.dynamic_tool_registry import DynamicToolRegistry
from mycli.services.tool_router import ToolRouter
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.registry import ToolRegistryV2


class FakeTool:
    def __init__(self, name: str, summary: str) -> None:
        self.spec = ToolSpec(
            name=name,
            description=f"Tool {name}",
            parameters=(ToolParameter(name="path", type="string", required=False),),
        )
        self.summary = summary
        self.calls: list[dict[str, object]] = []

    def execute(self, arguments: dict[str, object]) -> ToolResultV2:
        self.calls.append(arguments)
        return ToolResultV2(success=True, summary=self.summary, raw_payload={"tool": self.spec.name})


class ExplodingTool(FakeTool):
    def execute(self, arguments: dict[str, object]) -> ToolResultV2:
        self.calls.append(arguments)
        raise RuntimeError("boom")


def _dynamic_registration(tool: FakeTool) -> DynamicToolRegistration:
    return DynamicToolRegistration(
        descriptor=DynamicToolDescriptor(
            tool_id=f"runtime:{tool.spec.name}:turn",
            display_name=tool.spec.name,
            description=tool.spec.description,
            route_key=ToolRouteKey.local(tool.spec.name),
            source=DynamicToolSource.RUNTIME,
            scope=DynamicToolScope.TURN,
            lifecycle_state=DynamicToolLifecycleState.EXPOSED,
            spec=tool.spec,
        ),
        tool=tool,
    )


def test_tool_router_renders_only_callable_tools() -> None:
    registry = ToolRegistryV2.from_tools([FakeTool("list_directory", "listed"), FakeTool("run_shell", "ran")])
    dynamic = FakeTool("workspace_summary", "summarized")
    exposure = ToolExposure(
        direct=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("list_directory"),
                kind=ToolExposureKind.DIRECT,
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["list_directory"],
            ),
        ),
        deferred=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("run_shell"),
                kind=ToolExposureKind.DEFERRED,
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["run_shell"],
            ),
        ),
        dynamic=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("workspace_summary"),
                kind=ToolExposureKind.DYNAMIC,
                source=ToolRouteSource.RUNTIME,
                spec=dynamic.spec,
            ),
        ),
    )
    router = ToolRouter(
        tool_registry=registry,
        dynamic_tools={"workspace_summary": _dynamic_registration(dynamic)},
    )

    rendered = router.render_for_model(exposure)

    assert [tool.name for tool in rendered] == ["list_directory", "run_shell", "workspace_summary"]


def test_tool_router_schema_order_does_not_change_when_compatibility_groups_change() -> None:
    registry = ToolRegistryV2.from_tools(
        [
            FakeTool("list_directory", "listed"),
            FakeTool("run_shell", "ran"),
        ]
    )
    first_exposure = ToolExposure(
        direct=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("run_shell"),
                kind=ToolExposureKind.DIRECT,
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["run_shell"],
            ),
        ),
        deferred=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("list_directory"),
                kind=ToolExposureKind.DEFERRED,
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["list_directory"],
            ),
        ),
    )
    second_exposure = ToolExposure(
        direct=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("list_directory"),
                kind=ToolExposureKind.DIRECT,
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["list_directory"],
            ),
        ),
        deferred=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("run_shell"),
                kind=ToolExposureKind.DEFERRED,
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["run_shell"],
            ),
        ),
    )
    router = ToolRouter(tool_registry=registry)

    first_names = [tool.name for tool in router.render_for_model(first_exposure)]
    second_names = [tool.name for tool in router.render_for_model(second_exposure)]

    assert first_names == ["list_directory", "run_shell"]
    assert second_names == ["list_directory", "run_shell"]


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
    registry = ToolRegistryV2.from_tools([tool])
    exposure = ToolExposure(
        direct=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("update_plan"),
                kind=ToolExposureKind.DIRECT,
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


def test_tool_router_executes_dynamic_tool_when_exposed() -> None:
    registry = ToolRegistryV2.from_tools([FakeTool("list_directory", "listed")])
    dynamic = FakeTool("workspace_summary", "summarized")
    exposure = ToolExposure(
        dynamic=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("workspace_summary"),
                kind=ToolExposureKind.DYNAMIC,
                source=ToolRouteSource.RUNTIME,
                spec=dynamic.spec,
            ),
        ),
    )
    dynamic_registry = DynamicToolRegistry()
    registration = _dynamic_registration(dynamic)
    dynamic_registry.register(registration)
    router = ToolRouter(
        tool_registry=registry,
        dynamic_tools={"workspace_summary": registration},
        dynamic_tool_registry=dynamic_registry,
    )

    result = router.execute(
        ToolCall(
            name="workspace_summary",
            arguments={"path": "."},
            reason="summarize workspace",
            call_id="call_dynamic_1",
        ),
        exposure=exposure,
    )

    assert result.summary == "summarized"
    assert dynamic.calls == [{"path": "."}]
    lifecycle = router.pop_lifecycle_events()
    assert [event.state.value for event in lifecycle] == ["invoked", "completed"]


def test_tool_router_marks_dynamic_tool_failed_when_execution_raises() -> None:
    registry = ToolRegistryV2.from_tools([FakeTool("list_directory", "listed")])
    dynamic = ExplodingTool("workspace_summary", "summarized")
    exposure = ToolExposure(
        dynamic=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("workspace_summary"),
                kind=ToolExposureKind.DYNAMIC,
                source=ToolRouteSource.RUNTIME,
                spec=dynamic.spec,
            ),
        ),
    )
    dynamic_registry = DynamicToolRegistry()
    registration = _dynamic_registration(dynamic)
    dynamic_registry.register(registration)
    router = ToolRouter(
        tool_registry=registry,
        dynamic_tools={"workspace_summary": registration},
        dynamic_tool_registry=dynamic_registry,
    )

    try:
        router.execute(
            ToolCall(
                name="workspace_summary",
                arguments={"path": "."},
                reason="summarize workspace",
                call_id="call_dynamic_2",
            ),
            exposure=exposure,
        )
    except RuntimeError as exc:
        assert str(exc) == "boom"
    else:
        raise AssertionError("router should re-raise dynamic tool execution errors")

    lifecycle = router.pop_lifecycle_events()
    assert [event.state.value for event in lifecycle] == ["invoked", "failed"]


def test_tool_router_executes_deferred_tool_calls() -> None:
    registry = ToolRegistryV2.from_tools([FakeTool("run_shell", "ran")])
    exposure = ToolExposure(
        deferred=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("run_shell"),
                kind=ToolExposureKind.DEFERRED,
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["run_shell"],
            ),
        ),
    )
    router = ToolRouter(tool_registry=registry)

    result = router.execute(
        ToolCall(
            name="run_shell",
            arguments={"path": "."},
            reason="run shell",
            call_id="call_deferred_1",
        ),
        exposure=exposure,
    )

    assert result.summary == "ran"
