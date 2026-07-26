from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from mycli.services.mcp.client import load_mcp_server_configs
from mycli.services.mcp.diagnostics import (
    McpDiscoveryDiagnostics,
    McpServerDiagnostic,
    discover_configured_mcp_servers,
    redact_mcp_diagnostic_text,
)


@dataclass(slots=True, frozen=True)
class McpManagementRow:
    server_id: str
    transport: str
    enabled: bool
    status: str
    tool_count: int
    timeout_seconds: float | None
    failure_category: str | None = None
    failure_kind: str | None = None
    failure_message: str | None = None

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "server_id": self.server_id,
            "transport": self.transport,
            "enabled": self.enabled,
            "status": self.status,
            "tool_count": self.tool_count,
            "timeout_seconds": self.timeout_seconds,
        }
        payload["failure_category"] = self.failure_category
        if self.failure_kind:
            payload["failure_kind"] = self.failure_kind
        if self.failure_message:
            payload["failure_message"] = redact_mcp_diagnostic_text(self.failure_message)
        return payload


@dataclass(slots=True, frozen=True)
class McpManagementResponse:
    ok: bool
    action: str
    message: str
    servers: tuple[McpManagementRow, ...] = ()
    server: McpManagementRow | None = None
    issues: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "ok": self.ok,
            "action": self.action,
            "message": self.message,
            "servers": [row.to_dict() for row in self.servers],
            "issues": list(self.issues),
        }
        if self.server is not None:
            payload["server"] = self.server.to_dict()
        return payload


class McpManagementService:
    def __init__(
        self,
        *,
        workspace_root: Path,
        home_dir: Path,
        env: Mapping[str, str],
    ) -> None:
        self._workspace_root = workspace_root
        self._home_dir = home_dir
        self._env = dict(env)

    def list_servers(self) -> McpManagementResponse:
        diagnostics, issues = self._discover()
        if diagnostics is None:
            return McpManagementResponse(
                ok=False,
                action="list",
                message="mcp config invalid",
                issues=issues,
            )
        rows = _rows_from_diagnostics(diagnostics)
        return McpManagementResponse(
            ok=diagnostics.failure_count == 0,
            action="list",
            message=(
                f"mcp: {diagnostics.configured_count} configured, "
                f"{diagnostics.enabled_count} enabled, "
                f"{diagnostics.tool_count} tools discovered"
            ),
            servers=rows,
        )

    def inspect_server(self, server_id: str) -> McpManagementResponse:
        diagnostics, issues = self._discover()
        if diagnostics is None:
            return McpManagementResponse(
                ok=False,
                action="inspect",
                message="mcp config invalid",
                issues=issues,
            )
        rows = _rows_from_diagnostics(diagnostics)
        row = next((item for item in rows if item.server_id == server_id), None)
        if row is None:
            return McpManagementResponse(
                ok=False,
                action="inspect",
                message=f"mcp server not found: {server_id}",
                servers=rows,
            )
        return McpManagementResponse(
            ok=row.status != "failed",
            action="inspect",
            message=f"mcp server: {server_id}",
            server=row,
            servers=(row,),
        )

    def _discover(self) -> tuple[McpDiscoveryDiagnostics | None, tuple[str, ...]]:
        try:
            configs = load_mcp_server_configs(
                self._workspace_root,
                home_dir=self._home_dir,
                environ=self._env,
            )
            diagnostics = discover_configured_mcp_servers(configs)
        except Exception as exc:
            return None, (redact_mcp_diagnostic_text(exc),)
        return diagnostics, ()


def _rows_from_diagnostics(diagnostics: McpDiscoveryDiagnostics) -> tuple[McpManagementRow, ...]:
    return tuple(_row_for(server) for server in diagnostics.servers)


def _row_for(server: McpServerDiagnostic) -> McpManagementRow:
    return McpManagementRow(
        server_id=server.server_name,
        transport=server.transport,
        enabled=server.enabled,
        status=server.status,
        tool_count=server.tool_count,
        timeout_seconds=server.timeout_seconds,
        failure_category=server.failure_category,
        failure_kind=server.failure_kind,
        failure_message=server.failure_message,
    )
