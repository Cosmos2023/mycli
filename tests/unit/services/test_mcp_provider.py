from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from mycli.domain.conversation import Conversation
from mycli.domain.runtime import PlanState
from mycli.services.mcp import McpClient, McpServerConfig, McpToolAdapter, McpToolContributionProvider


class FakeTransport:
    def __init__(self, responses: Mapping[str, Any]) -> None:
        self.responses = dict(responses)

    def request(self, payload: dict[str, Any], *, timeout_seconds: float) -> dict[str, Any]:
        del timeout_seconds
        return dict(self.responses[str(payload["method"])])


def test_mcp_tool_contribution_provider_returns_hydrated_thread_tools() -> None:
    client = McpClient(
        McpServerConfig(name="fs", transport="stdio", command="mcp"),
        transport=FakeTransport(
            {
                "initialize": {"protocolVersion": "2025-03-26"},
                "tools/list": {
                    "tools": [
                        {
                            "name": "search",
                            "description": "Search files",
                            "inputSchema": {
                                "type": "object",
                                "properties": {"query": {"type": "string"}},
                                "required": ["query"],
                            },
                        }
                    ]
                },
            }
        ),
    )
    provider = McpToolContributionProvider(McpToolAdapter({"fs": client}))

    registrations = provider.provide(
        user_message="search docs",
        conversation=Conversation(session_id="demo"),
        plan_state=PlanState(),
    )

    assert registrations[0].descriptor.route_name == "mcp_fs_search"
    assert registrations[0].descriptor.spec.parameters[0].name == "query"
