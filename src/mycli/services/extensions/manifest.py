from __future__ import annotations

from pathlib import Path
from typing import Any

from mycli.domain.runtime.gateway_contract import (
    SUPPORTED_GATEWAY_EVENT_STREAMS,
    SUPPORTED_GATEWAY_RPC_METHODS,
    gateway_event_payload_schemas,
)
from mycli.tools.registry import ToolRegistry


_RPC_DESCRIPTIONS = {
    "approval.respond": "Resolve a pending approval request.",
    "clarify.respond": "Resolve a pending clarification request.",
    "command.run": "Run a slash command through the local runtime.",
    "completion.path": "List workspace path completions.",
    "completion.slash": "List slash command completions.",
    "decision.resolve": "Compatibility alias for approval.respond.",
    "extension.manifest": "Return the read-only extension capability manifest.",
    "session.bootstrap": "Initialize a Node TUI gateway client session.",
    "session.list": "List recent sessions.",
    "session.resume": "Activate an existing session.",
    "shutdown": "Request gateway shutdown.",
    "status.inspect": "Return current runtime status and context window metadata.",
    "trace.export": "Return sanitized runtime trace JSONL rows for the active session.",
    "transcript.load": "Load projected transcript history for a session.",
    "turn.interrupt": "Request interruption of the active turn.",
    "turn.submit": "Submit a user turn for runtime execution.",
}

_EVENT_DESCRIPTIONS = {
    "approval.request": "Approval gate prompts.",
    "approval.respond": "Approval resolution notifications.",
    "clarify.request": "Clarification gate prompts.",
    "clarify.respond": "Clarification resolution notifications.",
    "gateway.error": "Gateway request or protocol error diagnostics.",
    "message.complete": "Message stream completion metadata or final answer.",
    "message.delta": "Assistant message text deltas.",
    "reasoning.delta": "Reasoning stream deltas.",
    "runtime.event": "Versioned envelope mirror for runtime notifications.",
    "session.changed": "Active session changed after resume or fork.",
    "status.changed": "Runtime status snapshot changes.",
    "status.update": "Runtime status changes.",
    "thinking.delta": "Compatibility thinking stream deltas.",
    "tool.complete": "Tool lifecycle completion.",
    "tool.failed": "Tool lifecycle failure.",
    "tool.progress": "Tool lifecycle progress.",
    "tool.start": "Tool lifecycle start.",
    "turn.completed": "Terminal successful or waiting turn state.",
    "turn.event": "Compatibility runtime stream event.",
    "turn.failed": "Terminal failed turn state.",
    "turn.interrupted": "Terminal interrupted turn state.",
    "turn.started": "Turn execution start.",
    "turn.status": "Normalized turn status and terminal state.",
}


class ExtensionManifestService:
    """Builds the read-only integration discovery manifest."""

    def __init__(self, *, tool_registry: ToolRegistry | None = None) -> None:
        self._tool_registry = tool_registry

    def manifest(self) -> dict[str, Any]:
        payload_schemas = gateway_event_payload_schemas()
        tool_registry = self._tool_registry or ToolRegistry(workspace_root=Path.cwd())
        tool_manifest = tool_registry.manifest()
        toolset_manifest = tool_registry.toolset_manifest()
        return {
            "schema_version": 1,
            "agent": {
                "name": "mycli",
                "kind": "local_coding_agent",
            },
            "rpc_methods": _described_entries(SUPPORTED_GATEWAY_RPC_METHODS, _RPC_DESCRIPTIONS),
            "event_streams": _event_stream_entries(payload_schemas),
            "tool_manifest": tool_manifest,
            "toolset_manifest": toolset_manifest,
            "capabilities": [
                {
                    "id": "tools.manifest",
                    "status": "available",
                    "description": "Read-only built-in local tool manifest with risk and schema metadata.",
                },
                {
                    "id": "toolsets.manifest",
                    "status": "available",
                    "description": (
                        "Read-only toolset grouping, availability, alias, and conflict "
                        "manifest for extension clients."
                    ),
                },
                {
                    "id": "runtime.trace.export",
                    "status": "available",
                    "description": "Sanitized pull-based runtime trace JSONL export.",
                },
                {
                    "id": "runtime.tui_gateway",
                    "status": "available",
                    "description": "JSON-RPC gateway for local TUI and integration clients.",
                },
                {
                    "id": "approvals",
                    "status": "available",
                    "description": "Approval request and response flow for risky actions.",
                },
                {
                    "id": "sessions",
                    "status": "available",
                    "description": "Session listing, resume, transcript load, and fork support.",
                },
                {
                    "id": "mcp.tools",
                    "status": "foundation_only",
                    "description": (
                        "Internal MCP tool registration foundations exist, but the external "
                        "MCP tool capability is not productized."
                    ),
                },
                {
                    "id": "skills",
                    "status": "foundation_only",
                    "description": (
                        "Skill registry and invocation foundations exist, but the extension "
                        "manifest does not expose skills as a stable product capability."
                    ),
                },
                {
                    "id": "subagents",
                    "status": "foundation_only",
                    "description": (
                        "Sub-agent runtime foundations exist, but multi-agent product "
                        "surfaces are not part of the stable extension contract."
                    ),
                },
                {
                    "id": "extensions.lifecycle",
                    "status": "not_available",
                    "description": "Dynamic extension install/start/stop lifecycle is not implemented.",
                },
                {
                    "id": "acp.server",
                    "status": "not_available",
                    "description": "ACP server transport is not implemented.",
                },
            ],
        }


def _described_entries(
    names: frozenset[str],
    descriptions: dict[str, str],
) -> list[dict[str, str]]:
    return [
        {
            "name": name,
            "description": descriptions.get(name, f"{name} integration surface."),
        }
        for name in sorted(names)
    ]


def _event_stream_entries(payload_schemas: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "name": name,
            "description": _EVENT_DESCRIPTIONS.get(name, f"{name} integration surface."),
            "payload_schema": payload_schemas[name],
        }
        for name in sorted(SUPPORTED_GATEWAY_EVENT_STREAMS)
    ]
