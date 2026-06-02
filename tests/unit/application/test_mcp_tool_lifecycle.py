from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from mycli.application.runtime.tools.contributed_tool_registry import ToolContributionRegistry
from mycli.application.runtime.tools.tool_orchestrator import ToolOrchestrator
from mycli.domain.conversation import Conversation
from mycli.domain.runtime import PlanState
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.contributed_tools import ToolContributionLifecycleState
from mycli.services.mcp import McpClient, McpServerConfig, McpToolAdapter, McpToolContributionProvider
from mycli.services.tracing import TraceService
from mycli.tools.registry import ToolRegistry
from mycli.tools.routing.tool_exposure_planner import ToolExposurePlanner


class FakeTransport:
    def __init__(self, responses: Mapping[str, Any]) -> None:
        self.responses = dict(responses)

    def request(self, payload: dict[str, Any], *, timeout_seconds: float) -> dict[str, Any]:
        del timeout_seconds
        return dict(self.responses[str(payload["method"])])


def test_mcp_provider_tool_flows_through_orchestrator_registry_and_router(
    tmp_path,
) -> None:
    client = McpClient(
        McpServerConfig(name="local", transport="stdio", command="mcp"),
        transport=FakeTransport(
            {
                "initialize": {"protocolVersion": "2025-03-26"},
                "tools/list": {
                    "tools": [
                        {
                            "name": "echo",
                            "description": "Echo a short message",
                            "inputSchema": {
                                "type": "object",
                                "properties": {"message": {"type": "string"}},
                                "required": ["message"],
                            },
                        }
                    ]
                },
                "tools/call": {
                    "content": [{"type": "text", "text": "echo:hello"}],
                    "isError": False,
                },
            }
        ),
    )
    registry = ToolContributionRegistry()
    tool_registry = ToolRegistry(specs={}, executors={})
    orchestrator = ToolOrchestrator(
        session_id="mcp-session",
        tool_registry=tool_registry,
        tool_exposure_planner=ToolExposurePlanner(tool_registry=tool_registry),
        contributed_tool_registry=registry,
        contributed_tool_providers=(McpToolContributionProvider(McpToolAdapter({"local": client})),),
        trace_service=TraceService(tmp_path / "traces"),
        append_turn_item=lambda **_kwargs: None,
    )

    planned = orchestrator.plan_tool_exposure(
        user_message="echo through mcp",
        conversation=Conversation(session_id="mcp-session"),
        plan_state=PlanState(),
    )
    router = orchestrator.build_tool_router(planned)
    result = router.execute(
        ToolCall(
            name="mcp.local.echo",
            arguments={"message": "hello"},
            reason="Verify MCP provider route",
        ),
        exposure=planned.exposure,
    )
    lifecycle_states = [
        event.state
        for event in (*planned.lifecycle_events, *router.pop_lifecycle_events())
        if event.tool_id == "mcp:local:echo"
    ]

    assert result.success is True
    assert result.summary == "echo:hello"
    assert planned.exposure.callable_tool_names() == ("mcp.local.echo",)
    assert lifecycle_states == [
        ToolContributionLifecycleState.DECLARED,
        ToolContributionLifecycleState.EXPOSED,
        ToolContributionLifecycleState.INVOKED,
        ToolContributionLifecycleState.COMPLETED,
    ]
    assert registry.snapshot()[0]["tool_id"] == "mcp:local:echo"
