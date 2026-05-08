from __future__ import annotations

from pathlib import Path

from mycli.domain.capabilities import (
    CapabilityActivation,
    CapabilityActivationDependencyStatus,
    CapabilityActivationSource,
)
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
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.registry import ToolRegistryV2


class FakeTool:
    def __init__(self, name: str, description: str) -> None:
        self.spec = ToolSpec(
            name=name,
            description=description,
            parameters=(ToolParameter(name="path", type="string", required=False),),
        )

    def execute(self, arguments: dict[str, object]) -> ToolResultV2:
        del arguments
        return ToolResultV2(success=True, summary=f"{self.spec.name} ok")


def test_tool_exposure_planner_exposes_static_tools_as_equal_callable_set() -> None:
    registry = ToolRegistryV2.from_tools(
        [
            FakeTool("list_directory", "List files"),
            FakeTool("read_file", "Read file"),
            FakeTool("search_text", "Search text"),
            FakeTool("run_shell", "Run shell"),
            FakeTool("edit_file", "Edit file"),
        ]
    )
    planner = ToolExposurePlanner(tool_registry=registry)

    planned = planner.plan(user_message="please inspect this repository and summarize it")

    assert set(planned.exposure.callable_tool_names()) == {
        "list_directory",
        "read_file",
        "search_text",
        "run_shell",
        "edit_file",
    }
    assert [entry.source for entry in planned.exposure.entries] == [ToolRouteSource.REGISTRY] * 5


def test_tool_exposure_planner_keeps_write_tools_equal_for_chinese_modify_intent() -> None:
    registry = ToolRegistryV2.from_tools(
        [
            FakeTool("list_directory", "List files"),
            FakeTool("read_file", "Read file"),
            FakeTool("edit_file", "Edit file"),
            FakeTool("replace_in_file", "Replace in file"),
            FakeTool("append_file", "Append file"),
        ]
    )
    planner = ToolExposurePlanner(tool_registry=registry)

    planned = planner.plan(user_message="请直接修一下这个 bug，顺手补一条测试")

    assert set(planned.exposure.callable_tool_names()) == {
        "list_directory",
        "read_file",
        "edit_file",
        "replace_in_file",
        "append_file",
    }
    assert [entry.source for entry in planned.exposure.entries] == [ToolRouteSource.REGISTRY] * 5


def test_tool_exposure_planner_collects_runtime_and_capability_contributed_tools() -> None:
    registry = ToolRegistryV2.from_tools([FakeTool("list_directory", "List files")])
    planner = ToolExposurePlanner(tool_registry=registry)
    runtime_contributed_tool = FakeTool("workspace_summary", "Summarize workspace facts")
    capability_contributed_tool = FakeTool("capability_outline", "Outline capability state")
    activation = CapabilityActivation(
        name="repository-analysis",
        description="Inspect repositories",
        instructions="Use repository evidence.",
        source=CapabilityActivationSource.EXPLICIT_MENTION,
        dependency_status=CapabilityActivationDependencyStatus.READY,
        source_path=str(Path("/tmp/repository-analysis.md")),
        metadata={"contributed_tools": (capability_contributed_tool,)},
    )

    planned = planner.plan(
        user_message="inspect this repo with capability help",
        capability_activations=(activation,),
        runtime_contributed_tools=(runtime_contributed_tool,),
    )

    contributed_entries = {
        entry.name: entry
        for entry in planned.exposure.entries
        if entry.source is not ToolRouteSource.REGISTRY
    }

    assert set(contributed_entries) == {"workspace_summary", "capability_outline"}
    assert contributed_entries["workspace_summary"].source is ToolRouteSource.RUNTIME
    assert contributed_entries["capability_outline"].source is ToolRouteSource.CAPABILITY
    assert contributed_entries["capability_outline"].metadata["capability_name"] == "repository-analysis"


def test_tool_exposure_planner_preserves_descriptor_backed_contribution_metadata() -> None:
    registry = ToolRegistryV2.from_tools([FakeTool("list_directory", "List files")])
    planner = ToolExposurePlanner(tool_registry=registry)
    tool = FakeTool("daily_brief", "Prepare a daily brief")
    registration = ToolContributionRegistration(
        descriptor=ToolContributionDescriptor(
            tool_id="capability:daily_brief:thread",
            display_name="daily_brief",
            description="Prepare a daily brief",
            route_key=ToolRouteKey.local("daily_brief"),
            source=ToolContributionSource.CAPABILITY,
            scope=ToolContributionScope.THREAD,
            lifecycle_state=ToolContributionLifecycleState.DECLARED,
            spec=tool.spec,
            origin_metadata={"capability_name": "daily-assistant"},
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

    assert contribution_entry.metadata["tool_id"] == "capability:daily_brief:thread"
    assert contribution_entry.metadata["scope"] == "thread"
