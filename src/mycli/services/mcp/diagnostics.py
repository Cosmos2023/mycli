from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
import re

from mycli.services.mcp.client import JsonRpcError, McpClient, McpServerConfig, load_mcp_server_configs

MCP_DIAGNOSTIC_MESSAGE_LIMIT = 120
_SECRET_PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9_-]{8,}"),
    re.compile(r"(?i)(api[_-]?key|token|secret|authorization|bearer)(\s*[:=]\s*)([^,\s;]+)"),
    re.compile(r"(?i)\b[^\s,;]*(?:api[_-]?key|token|secret)[^\s,;]*\b"),
)

ClientFactory = Callable[[McpServerConfig], McpClient]


@dataclass(frozen=True, slots=True)
class McpServerDiagnostic:
    server_name: str
    transport: str
    enabled: bool
    status: str
    tool_count: int = 0
    failure_category: str | None = None
    failure_kind: str | None = None
    failure_message: str | None = None
    timeout_seconds: float | None = None

    def safe_summary(self) -> str:
        summary = f"{self.server_name}:{self.status}"
        if self.status == "ok":
            summary = f"{summary}:tools={self.tool_count}"
        if self.failure_category:
            summary = f"{summary}:{self.failure_category}"
        if self.failure_kind:
            summary = f"{summary}:{self.failure_kind}"
        return summary


@dataclass(frozen=True, slots=True)
class McpDiscoveryDiagnostics:
    configured_count: int
    enabled_count: int
    disabled_count: int
    tool_count: int
    servers: tuple[McpServerDiagnostic, ...]

    @property
    def failure_count(self) -> int:
        return sum(1 for server in self.servers if server.status == "failed")

    @property
    def ok_count(self) -> int:
        return sum(1 for server in self.servers if server.status == "ok")

    def safe_detail(self, *, limit: int = 5) -> str:
        items = [server.safe_summary() for server in self.servers[:limit]]
        if len(self.servers) > limit:
            items.append("...")
        return ", ".join(items)


def discover_mcp_servers(
    workspace_root: Path,
    *,
    environ: Mapping[str, str] | None = None,
    client_factory: ClientFactory | None = None,
) -> McpDiscoveryDiagnostics:
    configs = load_mcp_server_configs(workspace_root, environ=environ)
    return discover_configured_mcp_servers(configs, client_factory=client_factory)


def discover_configured_mcp_servers(
    configs: Mapping[str, McpServerConfig],
    *,
    client_factory: ClientFactory | None = None,
) -> McpDiscoveryDiagnostics:
    factory = client_factory or McpClient
    diagnostics: list[McpServerDiagnostic] = []
    tool_count = 0
    for name, config in sorted(configs.items()):
        if not config.enabled:
            diagnostics.append(
                McpServerDiagnostic(
                    server_name=name,
                    transport=config.transport,
                    enabled=False,
                    status="disabled",
                    timeout_seconds=config.timeout_seconds,
                )
            )
            continue
        client: McpClient | None = None
        try:
            client = factory(config)
            tools = client.list_tools()
        except Exception as exc:
            diagnostics.append(
                McpServerDiagnostic(
                    server_name=name,
                    transport=config.transport,
                    enabled=True,
                    status="failed",
                    failure_category=classify_mcp_failure(exc),
                    failure_kind=type(exc).__name__,
                    failure_message=_bounded_message(exc),
                    timeout_seconds=config.timeout_seconds,
                )
            )
        else:
            tool_count += len(tools)
            diagnostics.append(
                McpServerDiagnostic(
                    server_name=name,
                    transport=config.transport,
                    enabled=True,
                    status="ok",
                    tool_count=len(tools),
                    timeout_seconds=config.timeout_seconds,
                )
            )
        finally:
            if client is not None:
                client.close()
    enabled_count = sum(1 for config in configs.values() if config.enabled)
    return McpDiscoveryDiagnostics(
        configured_count=len(configs),
        enabled_count=enabled_count,
        disabled_count=len(configs) - enabled_count,
        tool_count=tool_count,
        servers=tuple(diagnostics),
    )


def _bounded_message(exc: Exception) -> str:
    message = redact_mcp_diagnostic_text(exc).replace("\n", " ").strip()
    if len(message) <= MCP_DIAGNOSTIC_MESSAGE_LIMIT:
        return message
    return f"{message[: MCP_DIAGNOSTIC_MESSAGE_LIMIT - 3]}..."


def classify_mcp_failure(exc: Exception) -> str:
    if isinstance(exc, FileNotFoundError):
        return "server_startup"
    if isinstance(exc, TimeoutError):
        return "timeout"
    if isinstance(exc, JsonRpcError):
        return "protocol_error"
    message = str(exc).lower()
    if "timed out" in message or "timeout" in message:
        return "timeout"
    if "no such file" in message or "not found" in message or "permission denied" in message:
        return "server_startup"
    if "http request failed" in message or "connection" in message or "transport" in message:
        return "transport_error"
    if "schema" in message or "inputschema" in message or "input_schema" in message:
        return "schema_error"
    return "execution_error"


def redact_mcp_diagnostic_text(value: object) -> str:
    """Return a display string without obvious secret-like values."""
    text = str(value)
    text = _SECRET_PATTERNS[0].sub("[REDACTED]", text)
    text = _SECRET_PATTERNS[1].sub(
        lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]",
        text,
    )
    return _SECRET_PATTERNS[2].sub("[REDACTED]", text)
