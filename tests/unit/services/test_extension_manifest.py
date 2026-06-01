from __future__ import annotations

from mycli.cli.node_tui.gateway import supported_event_streams, supported_rpc_methods
from mycli.domain.runtime.gateway_contract import GATEWAY_ERROR_CODES
from mycli.services.extensions import ExtensionManifestService


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
    assert capabilities["extensions.lifecycle"]["status"] == "not_available"
    assert capabilities["acp.server"]["status"] == "not_available"


def test_extension_manifest_does_not_productize_foundation_only_capabilities() -> None:
    manifest = ExtensionManifestService().manifest()

    capabilities = {capability["id"]: capability for capability in manifest["capabilities"]}

    for capability_id in ("mcp.tools", "skills", "subagents"):
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
    ]
    assert schemas["gateway.error"]["properties"]["code"]["enum"] == list(GATEWAY_ERROR_CODES)
    assert schemas["approval.respond"]["properties"]["choice"]["enum"] == [
        "approve_once",
        "reject",
        "allow_session",
    ]
    assert schemas["approval.request"]["properties"]["options"]["items"]["properties"]["choice"]["enum"] == [
        "approve_once",
        "reject",
        "allow_session",
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
