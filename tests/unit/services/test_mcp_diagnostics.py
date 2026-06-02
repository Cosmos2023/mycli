from __future__ import annotations

from mycli.services.mcp.client import McpServerConfig, McpToolDescriptor
from mycli.services.mcp.diagnostics import discover_configured_mcp_servers


class FakeClient:
    closed_configs: list[str] = []

    def __init__(self, config: McpServerConfig) -> None:
        self.config = config

    def list_tools(self) -> tuple[McpToolDescriptor, ...]:
        if self.config.name == "broken":
            raise RuntimeError("boom secret-token-value command args should not matter")
        return (
            McpToolDescriptor(
                server_name=self.config.name,
                name="echo",
                description="Echo",
            ),
        )

    def close(self) -> None:
        self.closed_configs.append(self.config.name)


def test_mcp_discovery_diagnostics_reports_success_disabled_and_failure() -> None:
    FakeClient.closed_configs = []
    diagnostics = discover_configured_mcp_servers(
        {
            "ok": McpServerConfig(name="ok", transport="stdio", command="mcp"),
            "disabled": McpServerConfig(
                name="disabled",
                transport="stdio",
                command="mcp",
                enabled=False,
            ),
            "broken": McpServerConfig(name="broken", transport="stdio", command="mcp"),
        },
        client_factory=FakeClient,
    )

    assert diagnostics.configured_count == 3
    assert diagnostics.enabled_count == 2
    assert diagnostics.disabled_count == 1
    assert diagnostics.tool_count == 1
    assert diagnostics.failure_count == 1
    assert diagnostics.safe_detail() == (
        "broken:failed:RuntimeError, disabled:disabled, ok:ok:tools=1"
    )
    assert FakeClient.closed_configs == ["broken", "ok"]


def test_mcp_discovery_failure_messages_are_bounded() -> None:
    diagnostics = discover_configured_mcp_servers(
        {
            "broken": McpServerConfig(name="broken", transport="stdio", command="mcp"),
        },
        client_factory=FakeClient,
    )

    server = diagnostics.servers[0]

    assert server.status == "failed"
    assert server.failure_kind == "RuntimeError"
    assert server.failure_message is not None
    assert len(server.failure_message) <= 120
