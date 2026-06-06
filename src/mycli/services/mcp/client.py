from __future__ import annotations

import base64
import json
import os
import selectors
import subprocess
import tomllib
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, IO, Literal, Protocol

from mycli.domain.tooling.names import provider_safe_tool_name
from mycli.tools.base import ToolParameter

JsonObject = dict[str, Any]
McpTransportKind = Literal["stdio", "http"]


class JsonRpcError(RuntimeError):
    def __init__(self, *, code: int, message: str, data: object | None = None) -> None:
        super().__init__(f"JSON-RPC error {code}: {message}")
        self.code = code
        self.message = message
        self.data = data


class JsonRpcTransport(Protocol):
    def request(self, payload: JsonObject, *, timeout_seconds: float) -> JsonObject:
        ...


@dataclass(slots=True, frozen=True)
class McpServerConfig:
    name: str
    transport: McpTransportKind = "stdio"
    command: str | None = None
    args: tuple[str, ...] = ()
    url: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    enabled: bool = True
    timeout_seconds: float = 30.0

    def __post_init__(self) -> None:
        name = self.name.strip()
        if not name:
            raise ValueError("MCP server name cannot be blank.")
        object.__setattr__(self, "name", name)
        if self.transport == "stdio":
            if self.command is None or not self.command.strip():
                raise ValueError("stdio MCP server requires command.")
        elif self.transport == "http":
            if self.url is None or not self.url.strip():
                raise ValueError("http MCP server requires url.")
        else:
            raise ValueError(f"Unsupported MCP transport: {self.transport}")
        if self.timeout_seconds <= 0:
            raise ValueError("MCP server timeout_seconds must be positive.")


@dataclass(slots=True, frozen=True)
class McpToolDescriptor:
    server_name: str
    name: str
    description: str = ""
    input_schema: JsonObject = field(default_factory=dict)

    @property
    def route_namespace(self) -> str:
        return provider_safe_tool_name("mcp", self.server_name)

    @property
    def route_name(self) -> str:
        return provider_safe_tool_name("mcp", self.server_name, self.name)

    @property
    def legacy_route_name(self) -> str:
        return f"mcp.{self.server_name}.{self.name}"

    def tool_parameters(self) -> tuple[ToolParameter, ...]:
        properties = self.input_schema.get("properties")
        required = self.input_schema.get("required")
        if not isinstance(properties, Mapping):
            return ()
        required_names = {str(item) for item in required} if isinstance(required, list) else set()
        parameters: list[ToolParameter] = []
        for name, schema in properties.items():
            if not isinstance(name, str) or not isinstance(schema, Mapping):
                continue
            schema_type = schema.get("type", "string")
            description = schema.get("description")
            items_schema = schema.get("items")
            parameters.append(
                ToolParameter(
                    name=name,
                    type=str(schema_type),
                    required=name in required_names,
                    description=str(description) if description is not None else None,
                    items_schema=dict(items_schema) if isinstance(items_schema, Mapping) else None,
                )
            )
        return tuple(parameters)


@dataclass(slots=True, frozen=True)
class McpToolCallResult:
    content: tuple[JsonObject, ...] = ()
    is_error: bool = False

    @property
    def text(self) -> str:
        rendered: list[str] = []
        for item in self.content:
            item_type = str(item.get("type", ""))
            if item_type == "text" and item.get("text") is not None:
                rendered.append(str(item["text"]))
            elif item_type == "json":
                value = item.get("json", item.get("data"))
                rendered.append(json.dumps(value, sort_keys=True))
            elif item.get("text") is not None:
                rendered.append(str(item["text"]))
            else:
                rendered.append(json.dumps(item, sort_keys=True))
        return "\n".join(rendered)


@dataclass(slots=True, frozen=True)
class McpResourceDescriptor:
    server_name: str
    uri: str
    name: str
    description: str = ""
    mime_type: str | None = None


@dataclass(slots=True, frozen=True)
class McpResourceContent:
    server_name: str
    uri: str
    mime_type: str | None = None
    text: str | None = None
    blob: bytes | None = None


class HttpJsonRpcTransport:
    def __init__(self, url: str, *, headers: Mapping[str, str] | None = None) -> None:
        self._url = url
        self._headers = {} if headers is None else dict(headers)

    def request(self, payload: JsonObject, *, timeout_seconds: float) -> JsonObject:
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self._url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                **self._headers,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                return _decode_json(response.read())
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"MCP HTTP request failed with status {error.code}") from error


class StdioJsonRpcTransport:
    def __init__(
        self,
        *,
        command: str,
        args: tuple[str, ...] = (),
        env: Mapping[str, str] | None = None,
        cwd: Path | None = None,
    ) -> None:
        self._command = command
        self._args = args
        self._env = {} if env is None else dict(env)
        self._cwd = cwd
        self._process: subprocess.Popen[bytes] | None = None

    def request(self, payload: JsonObject, *, timeout_seconds: float) -> JsonObject:
        process = self._ensure_process()
        if process.stdin is None or process.stdout is None:
            raise RuntimeError("MCP stdio process pipes are unavailable.")
        process.stdin.write(_encode_framed_json(payload))
        process.stdin.flush()
        return _read_framed_json(process.stdout, timeout_seconds=timeout_seconds)

    def close(self) -> None:
        process = self._process
        self._process = None
        if process is None:
            return
        process.terminate()
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=1)

    def _ensure_process(self) -> subprocess.Popen[bytes]:
        if self._process is not None and self._process.poll() is None:
            return self._process
        process_env = os.environ.copy()
        process_env.update(self._env)
        self._process = subprocess.Popen(
            [self._command, *self._args],
            cwd=self._cwd,
            env=process_env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        return self._process


class McpClient:
    def __init__(self, config: McpServerConfig, *, transport: JsonRpcTransport | None = None) -> None:
        self.config = config
        self._transport = transport if transport is not None else self._build_transport(config)
        self._next_id = 1
        self._initialized = False

    def initialize(self) -> JsonObject:
        if self._initialized:
            return {}
        result = self.request(
            "initialize",
            {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "mycli", "version": "0.1.0"},
            },
            initialize=False,
        )
        self._initialized = True
        return result

    def request(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
        *,
        initialize: bool = True,
    ) -> JsonObject:
        if initialize and method != "initialize":
            self.initialize()
        payload: JsonObject = {"jsonrpc": "2.0", "id": self._next_id, "method": method}
        self._next_id += 1
        if params is not None:
            payload["params"] = dict(params)
        response = self._transport.request(payload, timeout_seconds=self.config.timeout_seconds)
        if "error" in response:
            error = response["error"]
            if isinstance(error, Mapping):
                raise JsonRpcError(
                    code=int(error.get("code", -32000)),
                    message=str(error.get("message", "MCP request failed")),
                    data=error.get("data"),
                )
            raise JsonRpcError(code=-32000, message=str(error))
        result = response.get("result", response)
        if not isinstance(result, dict):
            return {"value": result}
        return dict(result)

    def list_tools(self) -> tuple[McpToolDescriptor, ...]:
        result = self.request("tools/list")
        tools = result.get("tools", ())
        if not isinstance(tools, list):
            return ()
        return tuple(self._parse_tool(item) for item in tools if isinstance(item, Mapping))

    def call_tool(self, name: str, arguments: Mapping[str, Any]) -> McpToolCallResult:
        result = self.request("tools/call", {"name": name, "arguments": dict(arguments)})
        content = result.get("content", ())
        items = tuple(dict(item) for item in content if isinstance(item, Mapping)) if isinstance(content, list) else ()
        return McpToolCallResult(content=items, is_error=bool(result.get("isError", False)))

    def list_resources(self) -> tuple[McpResourceDescriptor, ...]:
        result = self.request("resources/list")
        resources = result.get("resources", ())
        if not isinstance(resources, list):
            return ()
        return tuple(self._parse_resource(item) for item in resources if isinstance(item, Mapping))

    def read_resource(self, uri: str) -> tuple[McpResourceContent, ...]:
        result = self.request("resources/read", {"uri": uri})
        contents = result.get("contents", ())
        if not isinstance(contents, list):
            return ()
        return tuple(self._parse_resource_content(item) for item in contents if isinstance(item, Mapping))

    def _parse_tool(self, item: Mapping[str, Any]) -> McpToolDescriptor:
        schema = item.get("inputSchema", item.get("input_schema", {}))
        return McpToolDescriptor(
            server_name=self.config.name,
            name=str(item.get("name", "")),
            description=str(item.get("description", "")),
            input_schema=dict(schema) if isinstance(schema, Mapping) else {},
        )

    def _parse_resource(self, item: Mapping[str, Any]) -> McpResourceDescriptor:
        return McpResourceDescriptor(
            server_name=self.config.name,
            uri=str(item.get("uri", "")),
            name=str(item.get("name", item.get("uri", ""))),
            description=str(item.get("description", "")),
            mime_type=str(item["mimeType"]) if item.get("mimeType") is not None else None,
        )

    def _parse_resource_content(self, item: Mapping[str, Any]) -> McpResourceContent:
        blob_value = item.get("blob")
        blob = base64.b64decode(str(blob_value)) if blob_value is not None else None
        return McpResourceContent(
            server_name=self.config.name,
            uri=str(item.get("uri", "")),
            mime_type=str(item["mimeType"]) if item.get("mimeType") is not None else None,
            text=str(item["text"]) if item.get("text") is not None else None,
            blob=blob,
        )

    def _build_transport(self, config: McpServerConfig) -> JsonRpcTransport:
        if config.transport == "http":
            if config.url is None:
                raise ValueError("http MCP server requires url.")
            return HttpJsonRpcTransport(config.url)
        if config.command is None:
            raise ValueError("stdio MCP server requires command.")
        return StdioJsonRpcTransport(command=config.command, args=config.args, env=config.env)

    def close(self) -> None:
        close = getattr(self._transport, "close", None)
        if callable(close):
            close()


def load_mcp_server_configs(workspace_root: Path, *, environ: Mapping[str, str] | None = None) -> dict[str, McpServerConfig]:
    path = workspace_root / ".mycli" / "mcp_servers.toml"
    if not path.exists():
        return {}
    with path.open("rb") as handle:
        data = tomllib.load(handle)
    servers = data.get("servers", data.get("mcp_servers", {}))
    if not isinstance(servers, Mapping):
        raise ValueError(".mycli/mcp_servers.toml must define a [servers] table.")
    return {
        name: _parse_server_config(name, value, environ=environ)
        for name, value in servers.items()
        if isinstance(name, str) and isinstance(value, Mapping)
    }


def _parse_server_config(
    name: str,
    raw: Mapping[str, Any],
    *,
    environ: Mapping[str, str] | None,
) -> McpServerConfig:
    env = raw.get("env", {})
    args = raw.get("args", ())
    transport = str(raw.get("transport", "stdio"))
    if transport not in {"stdio", "http"}:
        raise ValueError(f"Unsupported MCP transport for server {name}: {transport}")
    return McpServerConfig(
        name=name,
        transport=transport,  # type: ignore[arg-type]
        command=str(raw["command"]) if raw.get("command") is not None else None,
        args=tuple(str(item) for item in args) if isinstance(args, list) else (),
        url=str(raw["url"]) if raw.get("url") is not None else None,
        env=_resolve_env(env, environ=environ),
        enabled=bool(raw.get("enabled", True)),
        timeout_seconds=float(raw.get("timeout_seconds", 30.0)),
    )


def _resolve_env(raw: object, *, environ: Mapping[str, str] | None) -> dict[str, str]:
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        raise ValueError("MCP server env must be a table.")
    source = os.environ if environ is None else environ
    resolved: dict[str, str] = {}
    for key, value in raw.items():
        text = str(value)
        if text.startswith("${") and text.endswith("}"):
            env_name = text[2:-1]
            if env_name not in source:
                raise ValueError(f"Missing environment variable for MCP server env: {env_name}")
            text = source[env_name]
        resolved[str(key)] = text
    return resolved


def _encode_framed_json(payload: JsonObject) -> bytes:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body


def _decode_framed_json(data: bytes) -> JsonObject:
    header_bytes, separator, body = data.partition(b"\r\n\r\n")
    if not separator:
        header_bytes, separator, body = data.partition(b"\n\n")
    if not separator:
        return _decode_json(data)
    headers: dict[str, str] = {}
    for line in header_bytes.decode("ascii", errors="replace").splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        headers[key.strip().lower()] = value.strip()
    length = int(headers.get("content-length", len(body)))
    return _decode_json(body[:length])


def _read_framed_json(stream: IO[bytes], *, timeout_seconds: float) -> JsonObject:
    selector = selectors.DefaultSelector()
    selector.register(stream, selectors.EVENT_READ)
    try:
        buffer = bytearray()
        while b"\r\n\r\n" not in buffer and b"\n\n" not in buffer:
            if not selector.select(timeout=timeout_seconds):
                raise TimeoutError("Timed out waiting for MCP stdio response header.")
            chunk = os.read(stream.fileno(), 4096)
            if not chunk:
                raise RuntimeError("MCP stdio server closed stdout before sending a response.")
            buffer.extend(chunk)
        header_bytes, separator, body = bytes(buffer).partition(b"\r\n\r\n")
        if not separator:
            header_bytes, separator, body = bytes(buffer).partition(b"\n\n")
        headers: dict[str, str] = {}
        for line in header_bytes.decode("ascii", errors="replace").splitlines():
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            headers[key.strip().lower()] = value.strip()
        length = int(headers.get("content-length", "0"))
        if length <= 0:
            raise RuntimeError("MCP stdio response missing Content-Length.")
        while len(body) < length:
            if not selector.select(timeout=timeout_seconds):
                raise TimeoutError("Timed out waiting for MCP stdio response body.")
            chunk = os.read(stream.fileno(), length - len(body))
            if not chunk:
                break
            body += chunk
        if len(body) != length:
            raise RuntimeError("MCP stdio response body ended before Content-Length bytes.")
        return _decode_json(body)
    finally:
        selector.close()


def _decode_json(data: bytes) -> JsonObject:
    value = json.loads(data.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("MCP JSON-RPC response must be an object.")
    return value
