from __future__ import annotations

from collections.abc import Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import time
from typing import Any

import pytest

from mycli.services.mcp.client import (
    HttpJsonRpcTransport,
    JsonRpcError,
    McpClient,
    McpServerConfig,
    load_mcp_server_configs,
)
from mycli.domain.runtime import RuntimeInterruptToken
from mycli.services.mcp.resource_adapter import McpResourceAdapter
from mycli.services.mcp.tool_adapter import McpToolAdapter
from mycli.domain.tooling.output import ToolImageContent, ToolJsonContent, ToolTextContent


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


class InterruptAwareTransport:
    def __init__(self, token: RuntimeInterruptToken) -> None:
        self.token = token
        self.requests: list[dict[str, Any]] = []
        self.aborted_request_ids: list[object] = []

    def request(
        self,
        payload: dict[str, Any],
        *,
        timeout_seconds: float,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> dict[str, Any]:
        del timeout_seconds
        self.requests.append(payload)
        if payload["method"] == "initialize":
            return {"protocolVersion": "2025-03-26"}
        assert interrupt_token is self.token
        self.token.request("test_interrupt")
        interrupt_token.raise_if_interrupted()
        raise AssertionError("unreachable")

    def notify(
        self,
        payload: dict[str, Any],
        *,
        timeout_seconds: float,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> None:
        del timeout_seconds, interrupt_token
        self.requests.append(payload)

    def abort_request(self, request_id: object) -> None:
        self.aborted_request_ids.append(request_id)


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

    configs = load_mcp_server_configs(tmp_path, home_dir=tmp_path / "home")

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


def test_load_mcp_server_configs_merges_global_and_workspace_with_workspace_precedence(
    tmp_path: Path,
) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    (home / ".mycli").mkdir(parents=True)
    (workspace / ".mycli").mkdir(parents=True)
    (home / ".mycli" / "mcp_servers.toml").write_text(
        "\n".join(
            [
                "[mcpServers.rail]",
                'type = "streamable_http"',
                'url = "https://global.example.test/mcp"',
                "",
                "[mcpServers.global_only]",
                'type = "streamable_http"',
                'url = "https://global-only.example.test/mcp"',
            ]
        ),
        encoding="utf-8",
    )
    (workspace / ".mycli" / "mcp_servers.toml").write_text(
        "\n".join(
            [
                "[servers.rail]",
                'transport = "streamable_http"',
                'url = "https://workspace.example.test/mcp"',
            ]
        ),
        encoding="utf-8",
    )

    configs = load_mcp_server_configs(workspace, home_dir=home)

    assert set(configs) == {"rail", "global_only"}
    assert configs["rail"].transport == "streamable_http"
    assert configs["rail"].url == "https://workspace.example.test/mcp"
    assert configs["global_only"].transport == "streamable_http"


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


def test_mcp_client_sends_cancel_notification_for_interrupted_request() -> None:
    token = RuntimeInterruptToken(source="test")
    transport = InterruptAwareTransport(token)
    client = McpClient(
        McpServerConfig(name="fs", transport="stdio", command="mcp"),
        transport=transport,
    )

    with pytest.raises(KeyboardInterrupt):
        client.call_tool("search", {"query": "needle"}, interrupt_token=token)

    tool_request = next(item for item in transport.requests if item.get("method") == "tools/call")
    cancellation = transport.requests[-1]
    assert cancellation == {
        "jsonrpc": "2.0",
        "method": "notifications/cancelled",
        "params": {
            "requestId": tool_request["id"],
            "reason": "test_interrupt",
        },
    }
    assert transport.aborted_request_ids == [tool_request["id"]]


def test_streamable_http_client_keeps_session_and_decodes_sse_tools() -> None:
    requests: list[dict[str, Any]] = []
    session_headers: list[str | None] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length))
            requests.append(payload)
            session_headers.append(self.headers.get("Mcp-Session-Id"))
            method = payload["method"]
            if method == "initialize":
                body = json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": payload["id"],
                        "result": {"protocolVersion": "2025-03-26"},
                    }
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Mcp-Session-Id", "session-123")
            elif method == "notifications/initialized":
                body = b""
                self.send_response(202)
                self.send_header("Content-Type", "application/json")
            else:
                body = (
                    "event: message\n"
                    f"data: {json.dumps({'jsonrpc': '2.0', 'id': payload['id'], 'result': {'tools': [{'name': 'lookup', 'inputSchema': {'type': 'object'}}]}})}\n\n"
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if body:
                self.wfile.write(body)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        client = McpClient(
            McpServerConfig(
                name="rail",
                transport="streamable_http",
                url=f"http://{host}:{port}/mcp",
            )
        )

        tools = client.list_tools()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert [request["method"] for request in requests] == [
        "initialize",
        "notifications/initialized",
        "tools/list",
    ]
    assert "id" not in requests[1]
    assert session_headers == [None, "session-123", "session-123"]
    assert tools[0].name == "lookup"


def test_legacy_http_transport_does_not_send_initialized_notification() -> None:
    transport = HttpJsonRpcTransport("http://127.0.0.1:1", streamable=False)

    transport.notify(
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        timeout_seconds=0.01,
    )


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
    hydrated = adapter.load_tool_schema("mcp_fs_search")
    result = registration.tool.execute({"query": "needle"})

    assert registration.descriptor.route_name == "mcp_fs_search"
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


def test_mcp_tool_adapter_preserves_mixed_model_output_content() -> None:
    transport = FakeTransport(
        {
            "initialize": {"protocolVersion": "2025-03-26"},
            "tools/list": {
                "tools": [
                    {
                        "name": "inspect",
                        "description": "Inspect mixed content",
                        "inputSchema": {"type": "object", "properties": {}},
                    }
                ]
            },
            "tools/call": {
                "content": [
                    {"type": "text", "text": "first line\nsecond line"},
                    {
                        "type": "image",
                        "data": "aW1hZ2U=",
                        "mimeType": "image/png",
                    },
                    {
                        "type": "resource",
                        "resource": {"uri": "file:///README.md", "text": "docs"},
                    },
                ],
                "structuredContent": {"count": 2},
                "isError": False,
            },
        }
    )
    client = McpClient(
        McpServerConfig(name="fs", transport="stdio", command="mcp"),
        transport=transport,
    )
    result = McpToolAdapter({"fs": client}).list_tool_stubs()[0].tool.execute({})

    assert result.model_output is not None
    assert result.model_output.content == (
        ToolTextContent("first line\nsecond line"),
        ToolImageContent("data:image/png;base64,aW1hZ2U="),
        ToolJsonContent(
            {"resource": {"text": "docs", "uri": "file:///README.md"}, "type": "resource"}
        ),
        ToolJsonContent({"count": 2}),
    )
    assert result.model_output.contains_external_context is True


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
    if "id" not in request:
        continue
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


def test_stdio_mcp_interrupt_restarts_transport_without_stale_response(tmp_path: Path) -> None:
    server = tmp_path / "interruptible_server.py"
    pid_log = tmp_path / "pids.txt"
    server.write_text(
        """
from __future__ import annotations

import json
import os
import sys
import time

with open(sys.argv[1], "a", encoding="utf-8") as log:
    log.write(f"{os.getpid()}\\n")

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
    request = json.loads(sys.stdin.buffer.read(int(headers["content-length"])))
    if "id" not in request:
        continue
    method = request["method"]
    if method == "tools/call" and request["params"]["name"] == "hang":
        time.sleep(30)
    if method == "initialize":
        result = {"protocolVersion": "2025-03-26"}
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": "ok"}]}
    else:
        result = {"ok": method}
    payload = json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}).encode()
    sys.stdout.buffer.write(f"Content-Length: {len(payload)}\\r\\n\\r\\n".encode() + payload)
    sys.stdout.buffer.flush()
""".lstrip(),
        encoding="utf-8",
    )
    token = RuntimeInterruptToken(source="test")
    client = McpClient(
        McpServerConfig(
            name="stdio",
            transport="stdio",
            command="python",
            args=(str(server), str(pid_log)),
        )
    )
    interrupted = threading.Event()

    def call_hanging_tool() -> None:
        try:
            client.call_tool("hang", {}, interrupt_token=token)
        except KeyboardInterrupt:
            interrupted.set()

    worker = threading.Thread(target=call_hanging_tool)
    worker.start()
    for _ in range(100):
        if pid_log.exists() and pid_log.read_text(encoding="utf-8").strip():
            break
        threading.Event().wait(0.01)
    token.request("test_interrupt")
    assert interrupted.wait(timeout=1.5)
    worker.join(timeout=1)

    result = client.call_tool("fast", {})
    client.close()

    assert result.text == "ok"
    assert len(pid_log.read_text(encoding="utf-8").splitlines()) == 2


def test_http_mcp_transport_closes_inflight_connection_on_interrupt() -> None:
    started = threading.Event()
    release = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            self.rfile.read(length)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.flush()
            started.set()
            release.wait(timeout=5)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    host, port = server.server_address
    transport = HttpJsonRpcTransport(f"http://{host}:{port}/mcp", streamable=True)
    token = RuntimeInterruptToken(source="test")
    interrupted = threading.Event()

    def request() -> None:
        try:
            transport.request(
                {"jsonrpc": "2.0", "id": 1, "method": "tools/call"},
                timeout_seconds=30,
                interrupt_token=token,
            )
        except KeyboardInterrupt:
            interrupted.set()

    worker = threading.Thread(target=request)
    worker.start()
    assert started.wait(timeout=1)
    interrupt_started = time.monotonic()
    token.request("test_interrupt")
    interrupt_elapsed = time.monotonic() - interrupt_started
    try:
        assert interrupt_elapsed < 0.1
        assert interrupted.wait(timeout=1)
    finally:
        release.set()
        worker.join(timeout=2)
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)
