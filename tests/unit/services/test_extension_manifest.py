from __future__ import annotations

from mycli.cli.node_tui.gateway import supported_event_streams, supported_rpc_methods
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
        "tool_id",
        "call_id",
        "name",
        "duration_s",
        "summary",
        "summary_chars",
        "summary_truncated",
        "success",
    ]
