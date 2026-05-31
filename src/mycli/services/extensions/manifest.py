from __future__ import annotations

from typing import Any


class ExtensionManifestService:
    """Builds the read-only integration discovery manifest."""

    def manifest(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "agent": {
                "name": "mycli",
                "kind": "local_coding_agent",
            },
            "rpc_methods": [
                {
                    "name": "extension.manifest",
                    "description": "Return the read-only extension capability manifest.",
                },
                {
                    "name": "trace.export",
                    "description": "Return sanitized runtime trace JSONL rows for the active session.",
                },
                {
                    "name": "status.inspect",
                    "description": "Return current runtime status and context window metadata.",
                },
                {
                    "name": "transcript.load",
                    "description": "Load projected transcript history for a session.",
                },
                {
                    "name": "session.list",
                    "description": "List recent sessions.",
                },
                {
                    "name": "session.resume",
                    "description": "Activate an existing session.",
                },
                {
                    "name": "approval.respond",
                    "description": "Resolve a pending approval request.",
                },
                {
                    "name": "completion.slash",
                    "description": "List slash command completions.",
                },
                {
                    "name": "completion.path",
                    "description": "List workspace path completions.",
                },
            ],
            "event_streams": [
                {"name": "status.update", "description": "Runtime status changes."},
                {"name": "approval.request", "description": "Approval gate prompts."},
                {"name": "approval.respond", "description": "Approval resolution notifications."},
                {"name": "turn.event", "description": "Compatibility runtime stream event."},
                {"name": "turn.completed", "description": "Terminal successful turn state."},
                {"name": "turn.failed", "description": "Terminal failed turn state."},
                {"name": "turn.interrupted", "description": "Terminal interrupted turn state."},
            ],
            "capabilities": [
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
                    "status": "available",
                    "description": "Configured MCP tools can contribute runtime tool registrations.",
                },
                {
                    "id": "skills",
                    "status": "available",
                    "description": "Built-in and user skills can be listed and invoked through the Skill tool.",
                },
                {
                    "id": "subagents",
                    "status": "available",
                    "description": "Task tool can run scoped sub-agent work.",
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
