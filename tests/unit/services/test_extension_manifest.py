from __future__ import annotations

from mycli.services.extensions import ExtensionManifestService


def test_extension_manifest_exposes_core_discovery_surfaces() -> None:
    manifest = ExtensionManifestService().manifest()

    assert manifest["schema_version"] == 1
    assert manifest["agent"]["name"] == "mycli"
    rpc_methods = {method["name"] for method in manifest["rpc_methods"]}
    assert "extension.manifest" in rpc_methods
    assert "trace.export" in rpc_methods
    assert "approval.respond" in rpc_methods

    capabilities = {capability["id"]: capability for capability in manifest["capabilities"]}
    assert capabilities["runtime.trace.export"]["status"] == "available"
    assert capabilities["extensions.lifecycle"]["status"] == "not_available"
    assert capabilities["mcp.tools"]["status"] == "available"
    assert capabilities["subagents"]["status"] == "available"


def test_extension_manifest_has_stable_event_stream_entries() -> None:
    manifest = ExtensionManifestService().manifest()

    event_names = {event["name"] for event in manifest["event_streams"]}

    assert "status.update" in event_names
    assert "approval.request" in event_names
    assert "turn.event" in event_names
    assert "turn.completed" in event_names
