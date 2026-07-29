from __future__ import annotations

from mycli.cli.node_tui.gateway import supported_event_streams, supported_rpc_methods
from mycli.domain.tooling.contributed_tools import (
    ToolContributionDescriptor,
    ToolContributionLifecycleState,
    ToolContributionRegistration,
    ToolContributionScope,
    ToolContributionSource,
)
from mycli.domain.runtime.gateway_contract import GATEWAY_ERROR_CODES
from mycli.domain.tooling.exposure import ToolRouteKey
from mycli.domain.tooling.names import provider_safe_tool_name
from mycli.services.extensions import ExtensionManifestService
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec


class FakeTool:
    def __init__(self, name: str) -> None:
        self.spec = ToolSpec(
            name=name,
            description="Fake contributed tool",
            parameters=(ToolParameter(name="topic", type="string", required=False),),
        )

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        del arguments
        return ToolResult(success=True, summary=f"{self.spec.name} ok")


def _contribution_registration(name: str) -> ToolContributionRegistration:
    tool = FakeTool(name)
    return ToolContributionRegistration(
        descriptor=ToolContributionDescriptor(
            tool_id=f"provider:{name}:thread",
            display_name=name,
            description=tool.spec.description,
            route_key=ToolRouteKey.local(name),
            source=ToolContributionSource.PROVIDER,
            scope=ToolContributionScope.THREAD,
            lifecycle_state=ToolContributionLifecycleState.EXPOSED,
            spec=tool.spec,
        ),
        tool=tool,
    )


def _mcp_contribution_registration(server: str, tool_name: str) -> ToolContributionRegistration:
    legacy_route_name = f"mcp.{server}.{tool_name}"
    route_name = provider_safe_tool_name("mcp", server, tool_name)
    tool = FakeTool(route_name)
    return ToolContributionRegistration(
        descriptor=ToolContributionDescriptor(
            tool_id=f"mcp:{server}:{tool_name}",
            display_name=route_name,
            description=tool.spec.description,
            route_key=ToolRouteKey.local(route_name),
            source=ToolContributionSource.PROVIDER,
            scope=ToolContributionScope.THREAD,
            lifecycle_state=ToolContributionLifecycleState.DECLARED,
            spec=tool.spec,
            origin_metadata={
                "server": server,
                "tool": tool_name,
                "legacy_route_name": legacy_route_name,
            },
        ),
        tool=tool,
    )


def _skill_contribution_registration(skill_name: str) -> ToolContributionRegistration:
    legacy_route_name = f"skill.{skill_name}"
    route_name = provider_safe_tool_name("skill", skill_name)
    tool = FakeTool(route_name)
    return ToolContributionRegistration(
        descriptor=ToolContributionDescriptor(
            tool_id=f"skill:{skill_name}",
            display_name=route_name,
            description=tool.spec.description,
            route_key=ToolRouteKey.local(route_name),
            source=ToolContributionSource.PROVIDER,
            scope=ToolContributionScope.THREAD,
            lifecycle_state=ToolContributionLifecycleState.DECLARED,
            spec=tool.spec,
            origin_metadata={
                "skill": skill_name,
                "source_kind": "repo",
                "legacy_route_name": legacy_route_name,
            },
        ),
        tool=tool,
    )


def _subagent_contribution_registration(profile_name: str) -> ToolContributionRegistration:
    legacy_route_name = f"subagent.{profile_name}"
    route_name = provider_safe_tool_name("subagent", profile_name)
    tool = FakeTool(route_name)
    return ToolContributionRegistration(
        descriptor=ToolContributionDescriptor(
            tool_id=f"subagent:{profile_name}",
            display_name=route_name,
            description=tool.spec.description,
            route_key=ToolRouteKey.local(route_name),
            source=ToolContributionSource.PROVIDER,
            scope=ToolContributionScope.THREAD,
            lifecycle_state=ToolContributionLifecycleState.DECLARED,
            spec=tool.spec,
            origin_metadata={
                "profile": profile_name,
                "default_tools": ["Read", "Grep"],
                "denied_tools": ["Task"],
                "availability": "available",
                "legacy_route_name": legacy_route_name,
            },
        ),
        tool=tool,
    )


def test_extension_manifest_exposes_core_discovery_surfaces() -> None:
    manifest = ExtensionManifestService().manifest()

    assert manifest["schema_version"] == 1
    assert manifest["agent"]["name"] == "mycli"
    rpc_methods = {method["name"] for method in manifest["rpc_methods"]}
    assert rpc_methods == supported_rpc_methods()

    capabilities = {capability["id"]: capability for capability in manifest["capabilities"]}
    assert capabilities["runtime.trace.export"]["status"] == "available"
    assert capabilities["runtime.tui_gateway"]["status"] == "available"
    assert capabilities["approvals"]["status"] == "available"
    assert capabilities["sessions"]["status"] == "available"
    assert capabilities["tools.manifest"]["status"] == "available"
    assert capabilities["toolsets.manifest"]["status"] == "available"
    assert capabilities["skills"]["status"] == "available"
    assert capabilities["subagents"]["status"] == "available"
    assert capabilities["extensions.lifecycle"]["status"] == "not_available"
    assert capabilities["acp.server"]["status"] == "not_available"


def test_extension_manifest_does_not_productize_foundation_only_capabilities() -> None:
    manifest = ExtensionManifestService().manifest()

    capabilities = {capability["id"]: capability for capability in manifest["capabilities"]}

    for capability_id in ("mcp.tools", "workspace.trust"):
        capability = capabilities[capability_id]
        assert capability["status"] == "foundation_only"
        assert "product" in capability["description"].lower()


def test_extension_manifest_has_stable_event_stream_entries() -> None:
    manifest = ExtensionManifestService().manifest()

    event_names = {event["name"] for event in manifest["event_streams"]}

    assert event_names == supported_event_streams()
    assert "runtime.event" in event_names
    assert "session.changed" in event_names


def test_extension_manifest_exposes_event_payload_schemas() -> None:
    manifest = ExtensionManifestService().manifest()

    schemas = {
        event["name"]: event["payload_schema"]
        for event in manifest["event_streams"]
        if isinstance(event.get("payload_schema"), dict)
    }

    assert set(schemas) == supported_event_streams()
    assert schemas["turn.status"]["required"] == ["state", "kind", "text", "terminal"]
    assert schemas["turn.status"]["properties"]["state"]["enum"] == [
        "waiting_approval",
        "waiting_clarification",
        "completed",
        "failed",
        "interrupted",
        "rejected",
    ]
    assert schemas["gateway.error"]["properties"]["code"]["enum"] == [
        "internal_error",
        "invalid_params",
        "method_not_found",
        "turn_in_progress",
        "decision_not_pending",
        "clarification_not_pending",
        "incompatible_protocol",
        "stale_turn",
        "queue_conflict",
        "queue_capacity",
        "queue_worker_start_failed",
        "no_active_turn",
        "turn_id_mismatch",
        "active_turn_not_steerable",
        "input_too_large",
        "message_id_conflict",
    ]
    assert schemas["gateway.error"]["properties"]["code"]["enum"] == list(GATEWAY_ERROR_CODES)
    assert schemas["approval.respond"]["properties"]["choice"]["enum"] == [
        "approve_once",
        "reject",
        "allow_session",
        "always_allow",
    ]
    assert schemas["approval.request"]["properties"]["options"]["items"]["properties"]["choice"]["enum"] == [
        "approve_once",
        "reject",
        "allow_session",
        "always_allow",
    ]
    assert schemas["runtime.event"]["required"] == [
        "version",
        "sequence",
        "type",
        "payload",
        "timestamp",
    ]
    assert schemas["tool.complete"]["required"] == [
        "client_turn_id",
        "tool_id",
        "call_id",
        "name",
        "duration_s",
        "summary",
        "summary_chars",
        "summary_truncated",
        "success",
    ]


def test_extension_manifest_exposes_builtin_tool_manifest() -> None:
    manifest = ExtensionManifestService().manifest()

    tool_manifest = manifest["tool_manifest"]
    assert tool_manifest["schema_version"] == 1
    tools = {tool["name"]: tool for tool in tool_manifest["tools"]}

    assert tools["Read"]["id"] == "builtin:Read"
    assert tools["Read"]["toolset"] == "file"
    assert tools["Bash"]["approval_policy"] == "shell_safety_analysis"
    assert "toolsets" in tool_manifest


def test_extension_manifest_exposes_toolset_manifest() -> None:
    manifest = ExtensionManifestService().manifest()

    toolset_manifest = manifest["toolset_manifest"]
    assert toolset_manifest["schema_version"] == 1
    assert toolset_manifest["summary"]["conflict_count"] == 0
    toolsets = {toolset["id"]: toolset for toolset in toolset_manifest["toolsets"]}

    assert toolsets["file"]["enabled"] is True
    assert "Read" in toolsets["file"]["tools"]
    assert "files" in toolsets["file"]["aliases"]
    assert toolsets["terminal"]["sources"] == ["builtin"]


def test_extension_manifest_unifies_builtin_and_contributed_tool_views() -> None:
    manifest = ExtensionManifestService(
        contributed_tools=(_contribution_registration("daily_brief"),)
    ).manifest()

    tools = {tool["name"]: tool for tool in manifest["tool_manifest"]["tools"]}
    toolsets = {toolset["id"]: toolset for toolset in manifest["toolset_manifest"]["toolsets"]}

    assert tools["Read"]["source"] == "builtin"
    assert tools["daily_brief"]["source"] == "provider"
    assert tools["daily_brief"]["toolset"] == "external"
    assert "daily_brief" in toolsets["external"]["tools"]
    assert toolsets["external"]["sources"] == ["provider"]


def test_extension_manifest_marks_mcp_origin_contributed_tools_as_mcp() -> None:
    manifest = ExtensionManifestService(
        contributed_tools=(_mcp_contribution_registration("local", "echo"),)
    ).manifest()

    tools = {tool["name"]: tool for tool in manifest["tool_manifest"]["tools"]}
    toolsets = {toolset["id"]: toolset for toolset in manifest["toolset_manifest"]["toolsets"]}
    entry = tools["mcp_local_echo"]

    assert entry["source"] == "mcp"
    assert entry["toolset"] == "external"
    assert entry["risk_level"] == "low"
    assert entry["approval_policy"] == "auto_allow"
    assert entry["contribution"]["origin"]["server"] == "local"
    assert entry["contribution"]["origin"]["tool"] == "echo"
    assert entry["contribution"]["origin"]["legacy_route_name"] == "mcp.local.echo"
    assert "mcp_local_echo" in toolsets["external"]["tools"]
    assert toolsets["external"]["sources"] == ["mcp"]


def test_extension_manifest_marks_skill_origin_contributed_tools_as_skill() -> None:
    manifest = ExtensionManifestService(
        contributed_tools=(_skill_contribution_registration("code-review"),)
    ).manifest()

    tools = {tool["name"]: tool for tool in manifest["tool_manifest"]["tools"]}
    toolsets = {toolset["id"]: toolset for toolset in manifest["toolset_manifest"]["toolsets"]}
    entry = tools["skill_code_review"]

    assert entry["source"] == "skill"
    assert entry["toolset"] == "external"
    assert entry["contribution"]["origin"]["skill"] == "code-review"
    assert entry["contribution"]["origin"]["source_kind"] == "repo"
    assert entry["contribution"]["origin"]["legacy_route_name"] == "skill.code-review"
    assert "skill_code_review" in toolsets["external"]["tools"]
    assert toolsets["external"]["sources"] == ["skill"]


def test_extension_manifest_marks_subagent_origin_contributed_tools_as_subagent() -> None:
    manifest = ExtensionManifestService(
        contributed_tools=(_subagent_contribution_registration("explore"),)
    ).manifest()

    tools = {tool["name"]: tool for tool in manifest["tool_manifest"]["tools"]}
    toolsets = {toolset["id"]: toolset for toolset in manifest["toolset_manifest"]["toolsets"]}
    entry = tools["subagent_explore"]

    assert entry["source"] == "subagent"
    assert entry["toolset"] == "external"
    assert entry["contribution"]["origin"]["profile"] == "explore"
    assert entry["contribution"]["origin"]["availability"] == "available"
    assert "subagent_explore" in toolsets["external"]["tools"]
    assert toolsets["external"]["sources"] == ["subagent"]
