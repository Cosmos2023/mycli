from __future__ import annotations

from mycli.domain.tooling.contributed_tools import (
    ToolContributionDescriptor,
    ToolContributionLifecycleState,
    ToolContributionRegistration,
    ToolContributionScope,
    ToolContributionSource,
)
from mycli.domain.tool_exposure import ToolRouteKey
from mycli.domain.tool_exposure import ToolRouteSource
from mycli.tools.routing.tool_exposure_planner import ToolExposurePlanner
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec
from mycli.tools.registry import ToolRegistry


class FakeTool:
    def __init__(self, name: str, description: str) -> None:
        self.spec = ToolSpec(
            name=name,
            description=description,
            parameters=(ToolParameter(name="path", type="string", required=False),),
        )

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        del arguments
        return ToolResult(success=True, summary=f"{self.spec.name} ok")


def test_tool_exposure_planner_exposes_static_tools_as_equal_callable_set() -> None:
    registry = ToolRegistry.from_tools(
        [
            FakeTool("LS", "List files"),
            FakeTool("Read", "Read file"),
            FakeTool("Grep", "Search text"),
            FakeTool("Bash", "Run shell"),
            FakeTool("Edit", "Edit file"),
        ]
    )
    planner = ToolExposurePlanner(tool_registry=registry)

    planned = planner.plan(user_message="please inspect this repository and summarize it")

    assert set(planned.exposure.callable_tool_names()) == {
        "LS",
        "Read",
        "Grep",
        "Bash",
        "Edit",
    }
    assert [entry.source for entry in planned.exposure.entries] == [ToolRouteSource.REGISTRY] * 5


def test_tool_exposure_planner_keeps_write_tools_equal_for_chinese_modify_intent() -> None:
    registry = ToolRegistry.from_tools(
        [
            FakeTool("LS", "List files"),
            FakeTool("Read", "Read file"),
            FakeTool("Edit", "Edit file"),
            FakeTool("Replace", "Replace in file"),
            FakeTool("Append", "Append file"),
        ]
    )
    planner = ToolExposurePlanner(tool_registry=registry)

    planned = planner.plan(user_message="请直接修一下这个 bug，顺手补一条测试")

    assert set(planned.exposure.callable_tool_names()) == {
        "LS",
        "Read",
        "Edit",
        "Replace",
        "Append",
    }
    assert [entry.source for entry in planned.exposure.entries] == [ToolRouteSource.REGISTRY] * 5


def test_tool_exposure_planner_collects_runtime_contributed_tools() -> None:
    registry = ToolRegistry.from_tools([FakeTool("LS", "List files")])
    planner = ToolExposurePlanner(tool_registry=registry)
    runtime_contributed_tool = FakeTool("workspace_summary", "Summarize workspace facts")

    planned = planner.plan(
        user_message="inspect this repo with capability help",
        runtime_contributed_tools=(runtime_contributed_tool,),
    )

    contributed_entries = {
        entry.name: entry
        for entry in planned.exposure.entries
        if entry.source is not ToolRouteSource.REGISTRY
    }

    assert set(contributed_entries) == {"workspace_summary"}
    assert contributed_entries["workspace_summary"].source is ToolRouteSource.RUNTIME


def test_tool_exposure_planner_preserves_descriptor_backed_contribution_metadata() -> None:
    registry = ToolRegistry.from_tools([FakeTool("LS", "List files")])
    planner = ToolExposurePlanner(tool_registry=registry)
    tool = FakeTool("daily_brief", "Prepare a daily brief")
    registration = ToolContributionRegistration(
        descriptor=ToolContributionDescriptor(
            tool_id="provider:daily_brief:thread",
            display_name="daily_brief",
            description="Prepare a daily brief",
            route_key=ToolRouteKey.local("daily_brief"),
            source=ToolContributionSource.PROVIDER,
            scope=ToolContributionScope.THREAD,
            lifecycle_state=ToolContributionLifecycleState.DECLARED,
            spec=tool.spec,
            origin_metadata={"provider_name": "daily-assistant"},
        ),
        tool=tool,
    )

    planned = planner.plan(
        user_message="help me with my daily work",
        runtime_contributed_tools=(registration,),
    )

    contribution_entry = next(
        entry for entry in planned.exposure.entries if entry.name == "daily_brief"
    )

    assert contribution_entry.metadata["tool_id"] == "provider:daily_brief:thread"
    assert contribution_entry.metadata["scope"] == "thread"
