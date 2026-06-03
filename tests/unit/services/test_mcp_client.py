from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from mycli.services.mcp.client import JsonRpcError, McpClient, McpServerConfig, load_mcp_server_configs
from mycli.services.mcp.resource_adapter import McpResourceAdapter
from mycli.services.mcp.tool_adapter import McpToolAdapter


class FakeTransport:
    def __init__(self, responses: Mapping[str, Any]) -> None:
        self.responses = dict(responses)
        self.requests: list[dict[str, Any]] = []

    def request(self, payload: dict[str, Any], *, timeout_seconds: float) -> dict[str, Any]:
        del timeout_seconds
        self.requests.append(payload)
        method = str(payload["method"])
        response = self.responses[method]
        if isinstance(response, Exception):
            raise response
        return dict(response)


def test_load_mcp_server_configs_reads_project_file_and_resolves_env(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_dir = tmp_path / ".mycli"
    config_dir.mkdir()
    (config_dir / "mcp_servers.toml").write_text(
        "\n".join(
            [
                "[servers.filesystem]",
                'transport = "stdio"',
                'command = "npx"',
                'args = ["-y", "@modelcontextprotocol/server-filesystem", "."]',
                "timeout_seconds = 3",
                "",
                "[servers.github]",
                'transport = "http"',
                'url = "https://mcp.example.test"',
                "enabled = false",
                'env = { GITHUB_TOKEN = "${GITHUB_TOKEN}", STATIC = "value" }',
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("GITHUB_TOKEN", "secret")

    configs = load_mcp_server_configs(tmp_path)

    assert configs["filesystem"] == McpServerConfig(
        name="filesystem",
        transport="stdio",
        command="npx",
        args=("-y", "@modelcontextprotocol/server-filesystem", "."),
        timeout_seconds=3.0,
    )
    assert configs["github"].url == "https://mcp.example.test"
    assert configs["github"].enabled is False
    assert configs["github"].env == {"GITHUB_TOKEN": "secret", "STATIC": "value"}


def test_mcp_client_initializes_lists_tools_and_calls_tool() -> None:
    transport = FakeTransport(
        {
            "initialize": {"protocolVersion": "2025-03-26", "serverInfo": {"name": "fake"}},
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
            "tools/call": {"content": [{"type": "text", "text": "match"}], "isError": False},
        }
    )
    client = McpClient(McpServerConfig(name="fs", transport="stdio", command="mcp"), transport=transport)

    tools = client.list_tools()
    result = client.call_tool("search", {"query": "needle"})

    assert tools[0].name == "search"
    assert tools[0].input_schema["required"] == ["query"]
    assert result.text == "match"
    assert [request["method"] for request in transport.requests] == [
        "initialize",
        "tools/list",
        "tools/call",
    ]
    assert transport.requests[-1]["params"] == {"name": "search", "arguments": {"query": "needle"}}


def test_mcp_client_raises_protocol_error() -> None:
    transport = FakeTransport(
        {
            "initialize": {"protocolVersion": "2025-03-26"},
            "tools/list": JsonRpcError(code=-32603, message="server failed"),
        }
    )
    client = McpClient(McpServerConfig(name="fs", transport="stdio", command="mcp"), transport=transport)

    with pytest.raises(JsonRpcError, match="server failed"):
        client.list_tools()


def test_mcp_tool_adapter_exposes_stubs_then_hydrates_full_schema_on_demand() -> None:
    transport = FakeTransport(
        {
            "initialize": {"protocolVersion": "2025-03-26"},
            "tools/list": {
                "tools": [
                    {
                        "name": "search",
                        "description": "Search files",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "query": {"type": "string", "description": "Search query"},
                                "limit": {"type": "integer"},
                            },
                            "required": ["query"],
                        },
                    }
                ]
            },
            "tools/call": {"content": [{"type": "json", "json": {"ok": True}}]},
        }
    )
    client = McpClient(McpServerConfig(name="fs", transport="stdio", command="mcp"), transport=transport)
    adapter = McpToolAdapter({"fs": client})

    stubs = adapter.list_tool_stubs()
    registration = stubs[0]
    hydrated = adapter.load_tool_schema("mcp.fs.search")
    result = registration.tool.execute({"query": "needle"})

    assert registration.descriptor.route_name == "mcp.fs.search"
    assert registration.descriptor.spec.parameters == ()
    assert [parameter.name for parameter in hydrated.parameters] == ["query", "limit"]
    assert hydrated.parameters[0].required is True
    assert result.success is True
    assert result.summary == 'MCP fs.search ok: {"ok": true}'
    assert result.raw_payload["server"] == "fs"
    assert result.raw_payload["status"] == "ok"
    assert result.raw_payload["content_summary"]["item_count"] == 1
    assert result.raw_payload["content_summary"]["types"] == ["json"]
    assert registration.descriptor.spec.risk_level == "medium"
    assert registration.descriptor.origin_metadata["approval_policy"] == "auto_allow_or_request"
    assert registration.descriptor.origin_metadata["transport"] == "stdio"
    assert registration.descriptor.origin_metadata["failure_semantics"] == "mcp_local_tool"
    assert registration.descriptor.origin_metadata["result_summary_policy"] == "bounded_model_summary"


def test_mcp_tool_adapter_truncates_long_tool_output() -> None:
    long_text = "x" * 13000
    transport = FakeTransport(
        {
            "initialize": {"protocolVersion": "2025-03-26"},
            "tools/list": {
                "tools": [
                    {
                        "name": "long",
                        "description": "Long output",
                        "inputSchema": {"type": "object", "properties": {}},
                    }
                ]
            },
            "tools/call": {"content": [{"type": "text", "text": long_text}]},
        }
    )
    client = McpClient(McpServerConfig(name="fs", transport="stdio", command="mcp"), transport=transport)
    adapter = McpToolAdapter({"fs": client})

    registration = adapter.list_tool_stubs()[0]
    result = registration.tool.execute({})

    assert result.success is True
    assert len(result.summary) <= 4000
    assert "[truncated" in result.summary
    assert result.raw_payload["truncated"] is True
    assert len(result.raw_payload["content"][0]["text"]) <= 12000


def test_mcp_tool_adapter_returns_failed_tool_result_for_call_failure() -> None:
    transport = FakeTransport(
        {
            "initialize": {"protocolVersion": "2025-03-26"},
            "tools/list": {
                "tools": [
                    {
                        "name": "explode",
                        "description": "Explodes",
                        "inputSchema": {"type": "object", "properties": {}},
                    }
                ]
            },
            "tools/call": JsonRpcError(code=-32000, message="api_key=sk-secret-token-value"),
        }
    )
    client = McpClient(McpServerConfig(name="fs", transport="stdio", command="mcp"), transport=transport)
    adapter = McpToolAdapter({"fs": client})

    registration = adapter.list_tool_stubs()[0]
    result = registration.tool.execute({})

    assert result.success is False
    assert result.summary == "MCP fs.explode failed: protocol_error"
    assert result.raw_payload["error_kind"] == "protocol_error"
    assert result.raw_payload["exception_type"] == "JsonRpcError"
    assert "sk-secret-token-value" not in result.error
    assert "[REDACTED]" in (result.error or "")


def test_mcp_tool_adapter_maps_mcp_is_error_to_local_tool_failure() -> None:
    transport = FakeTransport(
        {
            "initialize": {"protocolVersion": "2025-03-26"},
            "tools/list": {
                "tools": [
                    {
                        "name": "validate",
                        "description": "Validate input",
                        "inputSchema": {"type": "object", "properties": {}},
                    }
                ]
            },
            "tools/call": {
                "content": [{"type": "text", "text": "validation failed"}],
                "isError": True,
            },
        }
    )
    client = McpClient(McpServerConfig(name="fs", transport="stdio", command="mcp"), transport=transport)
    adapter = McpToolAdapter({"fs": client})

    registration = adapter.list_tool_stubs()[0]
    result = registration.tool.execute({})

    assert result.success is False
    assert result.summary == "MCP fs.validate error: validation failed"
    assert result.error == result.summary
    assert result.raw_payload["status"] == "error"
    assert result.raw_payload["error_kind"] == "mcp_tool_error"
    assert result.raw_payload["content_summary"]["types"] == ["text"]


def test_mcp_resource_adapter_lists_and_reads_resources() -> None:
    transport = FakeTransport(
        {
            "initialize": {"protocolVersion": "2025-03-26"},
            "resources/list": {
                "resources": [
                    {
                        "uri": "file:///README.md",
                        "name": "README",
                        "description": "Project README",
                        "mimeType": "text/markdown",
                    }
                ]
            },
            "resources/read": {
                "contents": [{"uri": "file:///README.md", "mimeType": "text/markdown", "text": "# Readme"}]
            },
        }
    )
    client = McpClient(McpServerConfig(name="fs", transport="stdio", command="mcp"), transport=transport)
    adapter = McpResourceAdapter({"fs": client})

    resources = adapter.list_resources()
    content = adapter.read_resource(server_name="fs", uri="file:///README.md")

    assert resources[0].name == "README"
    assert content.text == "# Readme"


def test_stdio_transport_uses_content_length_json_rpc_framing(tmp_path: Path) -> None:
    server = tmp_path / "server.py"
    server.write_text(
        """
from __future__ import annotations

import json
import sys

while True:
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if line in {b"\\r\\n", b"\\n", b""}:
            break
        key, value = line.decode("ascii").strip().split(":", 1)
        headers[key.lower()] = value.strip()
    if not headers:
        break
    body = sys.stdin.buffer.read(int(headers["content-length"]))
    request = json.loads(body)
    response = {"jsonrpc": "2.0", "id": request["id"], "result": {"ok": request["method"]}}
    payload = json.dumps(response).encode("utf-8")
    sys.stdout.buffer.write(f"Content-Length: {len(payload)}\\r\\n\\r\\n".encode("ascii") + payload)
    sys.stdout.buffer.flush()
""".lstrip(),
        encoding="utf-8",
    )
    config = McpServerConfig(name="stdio", transport="stdio", command="python", args=(str(server),))
    client = McpClient(config)

    result = client.request("ping")

    assert result == {"ok": "ping"}
