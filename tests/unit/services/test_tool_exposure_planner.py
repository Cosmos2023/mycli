from __future__ import annotations

from pathlib import Path

from mycli.domain.capabilities import (
    CapabilityActivation,
    CapabilityActivationDependencyStatus,
    CapabilityActivationSource,
)
from mycli.domain.dynamic_tools import (
    DynamicToolDescriptor,
    DynamicToolLifecycleState,
    DynamicToolRegistration,
    DynamicToolScope,
    DynamicToolSource,
)
from mycli.domain.tool_exposure import ToolRouteKey
from mycli.domain.tool_exposure import ToolRouteSource
from mycli.services.tool_exposure_planner import ToolExposurePlanner
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


def test_tool_exposure_planner_separates_direct_and_deferred_tools_for_repo_analysis() -> None:
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

    assert "list_directory" in planned.exposure.callable_tool_names()
    assert "read_file" in planned.exposure.callable_tool_names()
    assert "run_shell" in planned.exposure.callable_tool_names()
    assert "edit_file" in planned.exposure.callable_tool_names()
    assert {entry.name for entry in planned.exposure.deferred} >= {"run_shell", "edit_file"}


def test_tool_exposure_planner_promotes_write_tools_for_chinese_modify_intent() -> None:
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

    direct_names = {entry.name for entry in planned.exposure.direct}

    assert {"edit_file", "replace_in_file", "append_file"} <= direct_names


def test_tool_exposure_planner_collects_runtime_and_capability_dynamic_tools() -> None:
    registry = ToolRegistryV2.from_tools([FakeTool("list_directory", "List files")])
    planner = ToolExposurePlanner(tool_registry=registry)
    runtime_dynamic_tool = FakeTool("workspace_summary", "Summarize workspace facts")
    capability_dynamic_tool = FakeTool("capability_outline", "Outline capability state")
    activation = CapabilityActivation(
        name="repository-analysis",
        description="Inspect repositories",
        instructions="Use repository evidence.",
        source=CapabilityActivationSource.EXPLICIT_MENTION,
        dependency_status=CapabilityActivationDependencyStatus.READY,
        source_path=str(Path("/tmp/repository-analysis.md")),
        metadata={"dynamic_tools": (capability_dynamic_tool,)},
    )

    planned = planner.plan(
        user_message="inspect this repo with capability help",
        capability_activations=(activation,),
        runtime_dynamic_tools=(runtime_dynamic_tool,),
    )

    dynamic_entries = {entry.name: entry for entry in planned.exposure.dynamic}

    assert set(dynamic_entries) == {"workspace_summary", "capability_outline"}
    assert dynamic_entries["workspace_summary"].source is ToolRouteSource.RUNTIME
    assert dynamic_entries["capability_outline"].source is ToolRouteSource.CAPABILITY
    assert dynamic_entries["capability_outline"].metadata["capability_name"] == "repository-analysis"


def test_tool_exposure_planner_preserves_descriptor_backed_dynamic_metadata() -> None:
    registry = ToolRegistryV2.from_tools([FakeTool("list_directory", "List files")])
    planner = ToolExposurePlanner(tool_registry=registry)
    tool = FakeTool("daily_brief", "Prepare a daily brief")
    registration = DynamicToolRegistration(
        descriptor=DynamicToolDescriptor(
            tool_id="capability:daily_brief:thread",
            display_name="daily_brief",
            description="Prepare a daily brief",
            route_key=ToolRouteKey.local("daily_brief"),
            source=DynamicToolSource.CAPABILITY,
            scope=DynamicToolScope.THREAD,
            lifecycle_state=DynamicToolLifecycleState.DECLARED,
            spec=tool.spec,
            origin_metadata={"capability_name": "daily-assistant"},
        ),
        tool=tool,
    )

    planned = planner.plan(
        user_message="help me with my daily work",
        runtime_dynamic_tools=(registration,),
    )

    dynamic_entry = planned.exposure.dynamic[0]

    assert dynamic_entry.dynamic_descriptor is not None
    assert dynamic_entry.dynamic_descriptor.scope is DynamicToolScope.THREAD
    assert dynamic_entry.metadata["tool_id"] == "capability:daily_brief:thread"
    assert dynamic_entry.metadata["scope"] == "thread"
