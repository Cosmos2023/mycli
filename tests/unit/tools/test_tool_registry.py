from pathlib import Path

from mycli.domain.tooling.contributed_tools import (
    ToolContributionDescriptor,
    ToolContributionLifecycleState,
    ToolContributionRegistration,
    ToolContributionScope,
    ToolContributionSource,
)
from mycli.domain.tool_exposure import ToolRouteKey
from mycli.domain.tooling.calls import ToolCall
from mycli.services.approval.safety_policy import SafetyPolicy
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec
from mycli.tools.registry import (
    ToolRegistry,
    ToolsetPolicy,
    ToolsetRegistry,
    combined_tool_manifest,
    contributed_tool_manifest_entry,
)


class FakeTool:
    def __init__(self, name: str, description: str = "Fake tool") -> None:
        self.spec = ToolSpec(
            name=name,
            description=description,
            parameters=(ToolParameter(name="path", type="string", required=False),),
        )

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        del arguments
        return ToolResult(success=True, summary=f"{self.spec.name} ok")


def _contribution_registration(
    tool: FakeTool,
    *,
    source: ToolContributionSource = ToolContributionSource.PROVIDER,
) -> ToolContributionRegistration:
    return ToolContributionRegistration(
        descriptor=ToolContributionDescriptor(
            tool_id=f"{source.value}:{tool.spec.name}:thread",
            display_name=tool.spec.name,
            description=tool.spec.description,
            route_key=ToolRouteKey.local(tool.spec.name),
            source=source,
            scope=ToolContributionScope.THREAD,
            lifecycle_state=ToolContributionLifecycleState.EXPOSED,
            spec=tool.spec,
            origin_metadata={"provider_name": "fake-provider"},
        ),
        tool=tool,
    )


def test_tool_registry_validates_required_arguments_before_execution() -> None:
    spec = ToolSpec(
        name="read_file",
        description="Read a file from the workspace",
        parameters=(ToolParameter(name="path", type="string", required=True),),
    )
    registry = ToolRegistry(specs={"read_file": spec}, executors={})

    try:
        registry.validate("read_file", {})
    except ValueError as exc:
        assert "path" in str(exc)
    else:
        raise AssertionError("validate() should reject missing required arguments")


def test_builtin_tool_registry_manifest_has_stable_shape(tmp_path: Path) -> None:
    registry = ToolRegistry(workspace_root=tmp_path)

    manifest = registry.manifest()

    assert manifest["schema_version"] == 1
    tools = manifest["tools"]
    assert len(tools) == len(registry.list_names())
    ids = [tool["id"] for tool in tools]
    names = [tool["name"] for tool in tools]
    assert len(ids) == len(set(ids))
    assert len(names) == len(set(names))
    assert "builtin:Read" in ids
    assert "builtin:Patch" in ids
    read = next(tool for tool in tools if tool["name"] == "Read")
    assert read["toolset"] == "file"
    assert read["risk_level"] == "low"
    assert read["approval_policy"] == "auto_allow"
    assert "read" in read["capability_tags"]
    assert read["effects"] == {"filesystem": "read", "network": False, "process": False}
    assert read["availability"] == {"status": "available"}
    assert read["parameters"][0]["name"] == "file_path"
    read_parameters = {parameter["name"]: parameter for parameter in read["parameters"]}
    assert read_parameters["offset"]["required"] is True
    assert read_parameters["limit"]["required"] is True
    patch = next(tool for tool in tools if tool["name"] == "Patch")
    assert patch["toolset"] == "file"
    assert patch["risk_level"] == "medium"
    assert patch["approval_policy"] == "auto_allow_or_request"
    git_status = next(tool for tool in tools if tool["name"] == "GitStatus")
    assert git_status["id"] == "builtin:GitStatus"
    assert git_status["toolset"] == "dev"
    assert git_status["risk_level"] == "low"
    assert git_status["approval_policy"] == "auto_allow"
    assert "git" in git_status["capability_tags"]
    assert git_status["source"] == "builtin"


def test_builtin_tool_registry_manifest_groups_toolsets(tmp_path: Path) -> None:
    registry = ToolRegistry(workspace_root=tmp_path)

    manifest = registry.manifest()
    toolsets = {toolset["id"]: toolset for toolset in manifest["toolsets"]}

    assert toolsets["file"]["tool_count"] >= 3
    assert toolsets["terminal"]["tool_count"] >= 3
    assert toolsets["dev"]["tool_count"] >= 5
    assert toolsets["workflow"]["tool_count"] >= 3


def test_toolset_registry_manifest_exposes_enablement_aliases_and_sources(tmp_path: Path) -> None:
    registry = ToolRegistry(workspace_root=tmp_path)

    manifest = registry.toolset_manifest(
        policies={"web": ToolsetPolicy(enabled=False, aliases=("network",))}
    )

    assert manifest["schema_version"] == 1
    assert manifest["source"] == "extension_foundation"
    toolsets = {toolset["id"]: toolset for toolset in manifest["toolsets"]}
    assert toolsets["file"]["enabled"] is True
    assert "files" in toolsets["file"]["aliases"]
    assert toolsets["file"]["sources"] == ["builtin"]
    assert "Read" in toolsets["file"]["tools"]
    assert toolsets["web"]["enabled"] is False
    assert toolsets["web"]["aliases"] == ["network"]
    assert manifest["summary"]["disabled_toolsets"] == 1
    assert manifest["summary"]["conflict_count"] == 0


def test_toolset_registry_reports_alias_and_route_conflicts() -> None:
    entries = (
        {
            "id": "builtin:Read",
            "name": "Read",
            "source": "builtin",
            "toolset": "file",
        },
        {
            "id": "contributed:Read",
            "name": "Read",
            "source": "contributed",
            "toolset": "external",
        },
    )
    registry = ToolsetRegistry(
        entries,
        policies={
            "file": ToolsetPolicy(aliases=("shared",)),
            "external": ToolsetPolicy(aliases=("shared",)),
        },
    )

    manifest = registry.manifest()
    conflicts = manifest["conflicts"]

    assert {
        "type": "alias_conflict",
        "alias": "shared",
        "toolsets": ["external", "file"],
    } in conflicts
    assert {"type": "route_conflict", "route_name": "Read", "count": 2} in conflicts
    assert "conflicts" in registry.manifest_issues()


def test_contributed_tool_manifest_entry_uses_same_tool_shape() -> None:
    registration = _contribution_registration(FakeTool("daily_brief", "Prepare a brief"))

    entry = contributed_tool_manifest_entry(registration)

    assert entry["id"] == "provider:daily_brief:thread"
    assert entry["name"] == "daily_brief"
    assert entry["source"] == "provider"
    assert entry["toolset"] == "external"
    assert entry["parameters"][0]["name"] == "path"
    assert entry["availability"] == {"status": "available", "state": "exposed"}
    assert entry["contribution"]["scope"] == "thread"


def test_combined_tool_manifest_includes_contributed_tools_and_toolsets(tmp_path: Path) -> None:
    registry = ToolRegistry(workspace_root=tmp_path)
    registration = _contribution_registration(FakeTool("daily_brief", "Prepare a brief"))

    manifest = combined_tool_manifest(
        builtin_manifest=registry.manifest(),
        contributed_tools=(registration,),
    )

    tools = {tool["name"]: tool for tool in manifest["tools"]}
    toolsets = {toolset["id"]: toolset for toolset in manifest["toolsets"]}
    assert manifest["source"] == "combined"
    assert tools["Read"]["source"] == "builtin"
    assert tools["daily_brief"]["source"] == "provider"
    assert toolsets["external"]["tool_count"] == 1


def test_builtin_tool_manifest_aligns_with_safety_policy(tmp_path: Path) -> None:
    registry = ToolRegistry(workspace_root=tmp_path)
    policy = SafetyPolicy(workspace_root=tmp_path)
    manifest_tools = {tool["name"]: tool for tool in registry.manifest()["tools"]}

    for name in ("Read", "Grep", "Glob", "LS", "GitStatus", "GitDiff", "GitLog", "GitShow"):
        decision = policy.evaluate(ToolCall(name=name, arguments={"path": "."}, reason="test"))
        assert decision.kind.value == manifest_tools[name]["approval_policy"]
        assert decision.metadata["risk_level"] == manifest_tools[name]["risk_level"]

    write_decision = policy.evaluate(
        ToolCall(name="Write", arguments={"file_path": "demo.txt", "content": "x"}, reason="test")
    )
    assert write_decision.metadata["risk_level"] == manifest_tools["Write"]["risk_level"]
    assert manifest_tools["Write"]["approval_policy"] == "auto_allow_or_request"

    shell_decision = policy.evaluate(
        ToolCall(name="Bash", arguments={"command": "pwd"}, reason="test")
    )
    assert shell_decision.metadata["risk_level"] == manifest_tools["Bash"]["risk_level"]
    assert manifest_tools["Bash"]["approval_policy"] == "shell_safety_analysis"


def test_patch_tool_reports_file_mutation_target(tmp_path: Path) -> None:
    registry = ToolRegistry(workspace_root=tmp_path)

    targets = registry.mutation_targets(
        ToolCall(
            name="Patch",
            arguments={
                "file_path": "app.py",
                "old_string": "x",
                "new_string": "y",
            },
            reason="patch",
        )
    )

    assert targets == ("app.py",)
