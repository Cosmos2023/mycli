# mycli MCP Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a stdio-only MCP host MVP that discovers MCP server tools, exposes them as `mcp.<server>.<tool>` dynamic tools, routes calls through the existing tool loop, and returns MCP results as normal `ToolResultV2` values.

**Architecture:** Keep MCP out of model provider adapters. Parse MCP server config into domain models, wrap the official `mcp` Python SDK behind a small stdio client, use `McpHostService` for discovery/calls, and expose MCP tools via the existing `DynamicToolProvider -> ToolExposurePlanner -> ToolRouter` path.

**Tech Stack:** Python 3.13, official `mcp` Python SDK, existing `DynamicToolRegistration`, `ToolSpec`, `ToolRouter`, `pytest`, `mypy`, `ruff`, `uv`.

---

## Source Context

Read these before implementation:

- Spec: `docs/superpowers/specs/2026-04-26-mycli-mcp-host-design.md`
- Runtime construction: `src/mycli/cli/main.py`
- Config resolution: `src/mycli/services/config_service.py`
- Runtime config model: `src/mycli/domain/runtime/__init__.py`
- Dynamic tool model: `src/mycli/domain/dynamic_tools.py`
- Dynamic tool provider protocol: `src/mycli/services/dynamic_tool_provider.py`
- Tool exposure planner: `src/mycli/services/tool_exposure_planner.py`
- Tool router: `src/mycli/services/tool_router.py`
- Tool contracts: `src/mycli/tools/base.py`

Official SDK/docs used by this plan:

- MCP Python SDK: `https://github.com/modelcontextprotocol/python-sdk`
- MCP client concepts: `https://modelcontextprotocol.io/docs/learn/client-concepts`
- MCP tools spec: `https://modelcontextprotocol.io/specification/draft/server/tools`

## File Structure

- Modify: `pyproject.toml`
  - Add official `mcp` SDK dependency.
- Modify: `uv.lock`
  - Update via `uv add mcp`.
- Create: `src/mycli/domain/mcp.py`
  - Define `McpServerConfig`, `McpToolDescriptor`, result-content models, and config parsing helpers.
- Modify: `src/mycli/domain/runtime/__init__.py`
  - Add `mcp_servers: dict[str, McpServerConfig]` to `AgentConfig`.
- Modify: `src/mycli/services/config_service.py`
  - Parse `[mcp_servers.<name>]` config from user/project TOML and resolve `${ENV_NAME}` substitutions.
- Modify: `src/mycli/domain/dynamic_tools.py`
  - Add `DynamicToolSource.MCP = "mcp"`.
- Create: `src/mycli/infrastructure/mcp_stdio_client.py`
  - Wrap official SDK `ClientSession` and `stdio_client`, with sync methods for current runtime.
- Create: `src/mycli/services/mcp_host_service.py`
  - Discover enabled MCP server tools and call a tool on a named server.
- Create: `src/mycli/services/mcp_tool_provider.py`
  - Convert discovered MCP tools into `DynamicToolRegistration` values.
- Modify: `src/mycli/cli/main.py`
  - Build `McpHostService` and pass `McpToolProvider` into `AgentRuntime`.
- Modify: `README.md`
  - Document MCP server config and MVP limitations.
- Test: `tests/unit/domain/test_mcp.py`
  - Cover config/domain models and environment substitution.
- Test: `tests/unit/services/test_config_service.py`
  - Cover config parsing into `AgentConfig`.
- Test: `tests/unit/infrastructure/test_mcp_stdio_client.py`
  - Cover SDK wrapper with fakes.
- Test: `tests/unit/services/test_mcp_host_service.py`
  - Cover discovery and call delegation with fake client.
- Test: `tests/unit/services/test_mcp_tool_provider.py`
  - Cover namespaced dynamic tool creation and execution.
- Test: `tests/integration/test_cli_repl.py`
  - Cover runtime construction includes MCP provider when config has servers.
- Test: `tests/unit/application/test_agent_runtime.py`
  - Cover a fake MCP dynamic tool round-trip through runtime.

---

### Task 1: Add Official MCP SDK Dependency

**Files:**
- Modify: `pyproject.toml`
- Modify: `uv.lock`

- [ ] **Step 1: Add the SDK dependency**

Run:

```bash
uv add mcp
```

Expected:

```text
pyproject.toml updated with mcp
uv.lock updated
```

- [ ] **Step 2: Verify SDK imports**

Run:

```bash
uv run python - <<'PY'
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
print(ClientSession.__name__)
print(StdioServerParameters.__name__)
print(stdio_client.__name__)
PY
```

Expected:

```text
ClientSession
StdioServerParameters
stdio_client
```

- [ ] **Step 3: Commit dependency addition**

Run:

```bash
git add pyproject.toml uv.lock
git commit -m "Add the MCP Python SDK dependency" \
  -m "MCP stdio transport, session initialization, tool discovery, and tool calls are protocol-specific enough to use the official SDK instead of a hand-rolled JSON-RPC client." \
  -m "Constraint: MCP host v1 is stdio-only and uses official SDK surfaces" \
  -m "Rejected: Hand-roll JSON-RPC stdio | avoid protocol drift and future transport rework" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: uv run python import check for ClientSession, StdioServerParameters, stdio_client" \
  -m "Not-tested: Live MCP server"
```

---

### Task 2: Define MCP Domain Models

**Files:**
- Create: `src/mycli/domain/mcp.py`
- Modify: `src/mycli/domain/runtime/__init__.py`
- Test: `tests/unit/domain/test_mcp.py`

- [ ] **Step 1: Write failing domain tests**

Create `tests/unit/domain/test_mcp.py`:

```python
from __future__ import annotations

import pytest

from mycli.domain.mcp import (
    McpResultContent,
    McpServerConfig,
    McpToolDescriptor,
    resolve_mcp_env,
)
from mycli.tools.base import ToolParameter


def test_mcp_server_config_defaults_enabled_args_env_and_timeout() -> None:
    config = McpServerConfig(name="filesystem", command="npx")

    assert config.name == "filesystem"
    assert config.enabled is True
    assert config.command == "npx"
    assert config.args == ()
    assert config.env == {}
    assert config.timeout_seconds == 30.0


def test_mcp_server_config_rejects_blank_enabled_command() -> None:
    with pytest.raises(ValueError, match="command"):
        McpServerConfig(name="filesystem", command=" ")


def test_resolve_mcp_env_substitutes_environment_values() -> None:
    resolved = resolve_mcp_env(
        {"GITHUB_TOKEN": "${GITHUB_TOKEN}", "STATIC": "value"},
        environ={"GITHUB_TOKEN": "test-token"},
    )

    assert resolved == {"GITHUB_TOKEN": "test-token", "STATIC": "value"}


def test_resolve_mcp_env_rejects_missing_environment_value() -> None:
    with pytest.raises(ValueError, match="GITHUB_TOKEN"):
        resolve_mcp_env({"GITHUB_TOKEN": "${GITHUB_TOKEN}"}, environ={})


def test_mcp_tool_descriptor_builds_route_name_and_parameters() -> None:
    descriptor = McpToolDescriptor(
        server_name="filesystem",
        name="search",
        description="Search files",
        input_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "limit": {"type": "integer"},
            },
            "required": ["query"],
        },
    )

    assert descriptor.route_name == "mcp.filesystem.search"
    assert descriptor.route_namespace == "mcp.filesystem"
    assert descriptor.tool_parameters() == (
        ToolParameter(
            name="query",
            type="string",
            required=True,
            description="Search query",
        ),
        ToolParameter(name="limit", type="integer", required=False),
    )


def test_mcp_result_content_text_value_handles_common_shapes() -> None:
    assert McpResultContent(type="text", text="hello").text_value() == "hello"
    assert McpResultContent(type="json", data={"ok": True}).text_value() == '{"ok": true}'
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/domain/test_mcp.py -q
```

Expected:

```text
FAILED ... ModuleNotFoundError: No module named 'mycli.domain.mcp'
```

- [ ] **Step 3: Implement MCP domain models**

Create `src/mycli/domain/mcp.py`:

```python
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Mapping

from mycli.tools.base import ToolParameter

_ENV_REFERENCE = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")


@dataclass(slots=True, frozen=True)
class McpServerConfig:
    name: str
    command: str
    enabled: bool = True
    args: tuple[str, ...] = ()
    env: dict[str, str] = field(default_factory=dict)
    timeout_seconds: float = 30.0

    def __post_init__(self) -> None:
        if not self.name.strip():
            raise ValueError("MCP server name cannot be blank.")
        if self.enabled and not self.command.strip():
            raise ValueError(f"MCP server '{self.name}' requires a non-empty command.")
        if self.timeout_seconds <= 0:
            raise ValueError(f"MCP server '{self.name}' timeout_seconds must be positive.")


@dataclass(slots=True, frozen=True)
class McpToolDescriptor:
    server_name: str
    name: str
    description: str
    input_schema: dict[str, Any] = field(default_factory=dict)

    @property
    def route_namespace(self) -> str:
        return f"mcp.{self.server_name}"

    @property
    def route_name(self) -> str:
        return f"{self.route_namespace}.{self.name}"

    def tool_parameters(self) -> tuple[ToolParameter, ...]:
        properties = self.input_schema.get("properties")
        required_raw = self.input_schema.get("required")
        if not isinstance(properties, dict):
            return ()
        required = {str(item) for item in required_raw} if isinstance(required_raw, list) else set()
        parameters: list[ToolParameter] = []
        for name, raw_schema in properties.items():
            schema = raw_schema if isinstance(raw_schema, dict) else {}
            parameter_type = schema.get("type")
            description = schema.get("description")
            items = schema.get("items")
            parameters.append(
                ToolParameter(
                    name=str(name),
                    type=str(parameter_type) if isinstance(parameter_type, str) else "object",
                    required=str(name) in required,
                    description=description if isinstance(description, str) else None,
                    items_schema=items if isinstance(items, dict) else None,
                )
            )
        return tuple(parameters)


@dataclass(slots=True, frozen=True)
class McpResultContent:
    type: str
    text: str | None = None
    data: Any | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    def text_value(self) -> str:
        if self.text is not None:
            return self.text
        if self.data is not None:
            return json.dumps(self.data, ensure_ascii=False, sort_keys=True)
        return json.dumps(self.raw, ensure_ascii=False, sort_keys=True) if self.raw else ""


def resolve_mcp_env(
    env: Mapping[str, object],
    *,
    environ: Mapping[str, str],
) -> dict[str, str]:
    resolved: dict[str, str] = {}
    for key, value in env.items():
        raw_value = str(value)
        match = _ENV_REFERENCE.match(raw_value)
        if match is None:
            resolved[str(key)] = raw_value
            continue
        env_name = match.group(1)
        if env_name not in environ:
            raise ValueError(f"MCP env value '{env_name}' is not set.")
        resolved[str(key)] = environ[env_name]
    return resolved


__all__ = [
    "McpResultContent",
    "McpServerConfig",
    "McpToolDescriptor",
    "resolve_mcp_env",
]
```

- [ ] **Step 4: Add MCP config field to AgentConfig**

Modify `src/mycli/domain/runtime/__init__.py` imports:

```python
from mycli.domain.mcp import McpServerConfig
```

Add field to `AgentConfig` after `api_key`:

```python
    mcp_servers: dict[str, McpServerConfig] = field(default_factory=dict)
```

- [ ] **Step 5: Run targeted tests**

Run:

```bash
uv run pytest tests/unit/domain/test_mcp.py tests/unit/domain/test_runtime.py -q
uv run mypy src/mycli/domain/mcp.py src/mycli/domain/runtime/__init__.py
```

Expected:

```text
passed
Success: no issues found
```

- [ ] **Step 6: Commit MCP domain models**

Run:

```bash
git add src/mycli/domain/mcp.py src/mycli/domain/runtime/__init__.py tests/unit/domain/test_mcp.py
git commit -m "Define MCP host domain models" \
  -m "MCP server config, discovered tool descriptors, env substitution, and result content now have typed domain models that do not depend on infrastructure SDK objects." \
  -m "Constraint: domain must not import infrastructure or official SDK modules" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: uv run pytest tests/unit/domain/test_mcp.py tests/unit/domain/test_runtime.py -q" \
  -m "Tested: uv run mypy src/mycli/domain/mcp.py src/mycli/domain/runtime/__init__.py"
```

---

### Task 3: Parse MCP Server Configuration

**Files:**
- Modify: `src/mycli/services/config_service.py`
- Modify: `tests/unit/services/test_config_service.py`

- [ ] **Step 1: Add config parsing tests**

Append to `tests/unit/services/test_config_service.py`:

```python
def test_resolve_config_reads_project_mcp_servers_and_env_substitutions(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (workspace / ".mycli").mkdir()

    (workspace / ".mycli" / "config.toml").write_text(
        (
            "api_key = \"project-token\"\n"
            "\n"
            "[mcp_servers.filesystem]\n"
            "enabled = true\n"
            "command = \"npx\"\n"
            "args = [\"-y\", \"@modelcontextprotocol/server-filesystem\", \".\"]\n"
            "env = { ROOT = \"${MCP_ROOT}\" }\n"
            "timeout_seconds = 12\n"
        ),
        encoding="utf-8",
    )

    config = resolve_config(
        cli_args={"session": "mcp-demo"},
        env={"MCP_ROOT": str(workspace)},
        cwd=workspace,
        home=home_dir,
    )

    assert set(config.mcp_servers) == {"filesystem"}
    server = config.mcp_servers["filesystem"]
    assert server.enabled is True
    assert server.command == "npx"
    assert server.args == ("-y", "@modelcontextprotocol/server-filesystem", ".")
    assert server.env == {"ROOT": str(workspace)}
    assert server.timeout_seconds == 12.0


def test_resolve_config_rejects_enabled_mcp_server_without_command(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (workspace / ".mycli").mkdir()

    (workspace / ".mycli" / "config.toml").write_text(
        (
            "api_key = \"project-token\"\n"
            "\n"
            "[mcp_servers.bad]\n"
            "enabled = true\n"
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="requires a non-empty command"):
        resolve_config(
            cli_args={"session": "mcp-demo"},
            env={},
            cwd=workspace,
            home=home_dir,
        )


def test_resolve_config_rejects_missing_mcp_env_substitution(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (workspace / ".mycli").mkdir()

    (workspace / ".mycli" / "config.toml").write_text(
        (
            "api_key = \"project-token\"\n"
            "\n"
            "[mcp_servers.github]\n"
            "command = \"uvx\"\n"
            "args = [\"mcp-server-github\"]\n"
            "env = { GITHUB_TOKEN = \"${GITHUB_TOKEN}\" }\n"
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="GITHUB_TOKEN"):
        resolve_config(
            cli_args={"session": "mcp-demo"},
            env={},
            cwd=workspace,
            home=home_dir,
        )
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/services/test_config_service.py -q
```

Expected:

```text
FAILED ... AttributeError: 'AgentConfig' object has no attribute 'mcp_servers'
```

If Task 2 already added the field, expected failure is no configured MCP servers parsed.

- [ ] **Step 3: Implement MCP config parsing**

Modify `src/mycli/services/config_service.py` imports:

```python
from mycli.domain.mcp import McpServerConfig, resolve_mcp_env
```

Add helper functions above `resolve_config`:

```python
def _merge_mcp_server_tables(
    user_config: dict[str, object],
    project_config: dict[str, object],
) -> dict[str, object]:
    merged: dict[str, object] = {}
    user_servers = user_config.get("mcp_servers")
    project_servers = project_config.get("mcp_servers")
    if isinstance(user_servers, dict):
        merged.update(user_servers)
    if isinstance(project_servers, dict):
        merged.update(project_servers)
    return merged


def _parse_mcp_servers(
    *,
    user_config: dict[str, object],
    project_config: dict[str, object],
    env: Mapping[str, str],
) -> dict[str, McpServerConfig]:
    servers: dict[str, McpServerConfig] = {}
    for name, raw_server in _merge_mcp_server_tables(user_config, project_config).items():
        if not isinstance(raw_server, dict):
            raise ValueError(f"MCP server '{name}' config must be a table.")
        enabled = bool(raw_server.get("enabled", True))
        raw_args = raw_server.get("args", [])
        if not isinstance(raw_args, list):
            raise ValueError(f"MCP server '{name}' args must be a list.")
        raw_env = raw_server.get("env", {})
        if not isinstance(raw_env, dict):
            raise ValueError(f"MCP server '{name}' env must be a table.")
        timeout = raw_server.get("timeout_seconds", 30)
        command = str(raw_server.get("command", ""))
        servers[str(name)] = McpServerConfig(
            name=str(name),
            enabled=enabled,
            command=command,
            args=tuple(str(item) for item in raw_args),
            env=resolve_mcp_env(raw_env, environ=env),
            timeout_seconds=float(str(timeout)),
        )
    return servers
```

In `resolve_config`, before `return AgentConfig(...)`, add:

```python
    mcp_servers = _parse_mcp_servers(
        user_config=user_config,
        project_config=project_config,
        env=env,
    )
```

Pass into `AgentConfig`:

```python
        mcp_servers=mcp_servers,
```

- [ ] **Step 4: Run targeted tests**

Run:

```bash
uv run pytest tests/unit/services/test_config_service.py -q
uv run mypy src/mycli/services/config_service.py
```

Expected:

```text
passed
Success: no issues found
```

- [ ] **Step 5: Commit config parsing**

Run:

```bash
git add src/mycli/services/config_service.py tests/unit/services/test_config_service.py
git commit -m "Parse stdio MCP server configuration" \
  -m "Config resolution now accepts optional mcp_servers tables, resolves environment references, and stores typed server definitions on AgentConfig without affecting projects that do not configure MCP." \
  -m "Constraint: Missing environment substitutions should fail before server startup" \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: uv run pytest tests/unit/services/test_config_service.py -q" \
  -m "Tested: uv run mypy src/mycli/services/config_service.py"
```

---

### Task 4: Wrap The MCP Stdio SDK

**Files:**
- Create: `src/mycli/infrastructure/mcp_stdio_client.py`
- Test: `tests/unit/infrastructure/test_mcp_stdio_client.py`

- [ ] **Step 1: Write fake SDK wrapper tests**

Create `tests/unit/infrastructure/test_mcp_stdio_client.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from mycli.domain.mcp import McpServerConfig
from mycli.infrastructure.mcp_stdio_client import (
    McpStdioClient,
    mcp_result_to_tool_result,
    sdk_tool_to_descriptor,
)


@dataclass(slots=True)
class FakeTool:
    name: str
    description: str
    inputSchema: dict[str, Any]


@dataclass(slots=True)
class FakeTextContent:
    type: str = "text"
    text: str = "hello"


@dataclass(slots=True)
class FakeCallResult:
    content: list[object]
    isError: bool = False
    structuredContent: dict[str, object] | None = None


def test_sdk_tool_to_descriptor_maps_common_sdk_attributes() -> None:
    descriptor = sdk_tool_to_descriptor(
        server_name="filesystem",
        tool=FakeTool(
            name="search",
            description="Search files",
            inputSchema={
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        ),
    )

    assert descriptor.server_name == "filesystem"
    assert descriptor.name == "search"
    assert descriptor.description == "Search files"
    assert descriptor.route_name == "mcp.filesystem.search"
    assert descriptor.input_schema["required"] == ["query"]


def test_mcp_result_to_tool_result_maps_text_and_structured_content() -> None:
    result = mcp_result_to_tool_result(
        server_name="filesystem",
        tool_name="search",
        result=FakeCallResult(
            content=[FakeTextContent(text="match 1"), FakeTextContent(text="match 2")],
            structuredContent={"matches": 2},
        ),
    )

    assert result.success is True
    assert result.summary == "match 1\nmatch 2"
    assert result.artifacts["structured_content"] == {"matches": 2}
    assert result.raw_payload["server_name"] == "filesystem"
    assert result.raw_payload["tool_name"] == "search"


def test_mcp_result_to_tool_result_maps_error_results() -> None:
    result = mcp_result_to_tool_result(
        server_name="github",
        tool_name="create_issue",
        result=FakeCallResult(content=[FakeTextContent(text="forbidden")], isError=True),
    )

    assert result.success is False
    assert result.error == "forbidden"
    assert result.summary == "forbidden"


def test_mcp_stdio_client_delegates_to_injected_runner() -> None:
    calls: list[tuple[McpServerConfig, str, dict[str, object]]] = []

    def list_runner(server: McpServerConfig):
        assert server.name == "filesystem"
        return [
            FakeTool(
                name="search",
                description="Search files",
                inputSchema={"type": "object", "properties": {}},
            )
        ]

    def call_runner(server: McpServerConfig, tool_name: str, arguments: dict[str, object]):
        calls.append((server, tool_name, arguments))
        return FakeCallResult(content=[FakeTextContent(text="ok")])

    client = McpStdioClient(list_runner=list_runner, call_runner=call_runner)
    server = McpServerConfig(name="filesystem", command="npx")

    assert client.list_tools(server)[0].route_name == "mcp.filesystem.search"
    result = client.call_tool(server, "search", {"query": "abc"})

    assert result.success is True
    assert result.summary == "ok"
    assert calls == [(server, "search", {"query": "abc"})]
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_mcp_stdio_client.py -q
```

Expected:

```text
FAILED ... ModuleNotFoundError: No module named 'mycli.infrastructure.mcp_stdio_client'
```

- [ ] **Step 3: Implement SDK wrapper and result mapper**

Create `src/mycli/infrastructure/mcp_stdio_client.py`:

```python
from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Sequence
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from mycli.domain.mcp import McpResultContent, McpServerConfig, McpToolDescriptor
from mycli.tools.base import ToolResultV2

ListToolsRunner = Callable[[McpServerConfig], Sequence[object]]
CallToolRunner = Callable[[McpServerConfig, str, dict[str, object]], object]


class McpStdioClient:
    def __init__(
        self,
        *,
        list_runner: ListToolsRunner | None = None,
        call_runner: CallToolRunner | None = None,
    ) -> None:
        self._list_runner = list_runner
        self._call_runner = call_runner

    def list_tools(self, server: McpServerConfig) -> tuple[McpToolDescriptor, ...]:
        if self._list_runner is not None:
            tools = self._list_runner(server)
        else:
            tools = asyncio.run(self._list_tools_async(server))
        return tuple(sdk_tool_to_descriptor(server_name=server.name, tool=tool) for tool in tools)

    def call_tool(
        self,
        server: McpServerConfig,
        tool_name: str,
        arguments: dict[str, object],
    ) -> ToolResultV2:
        if self._call_runner is not None:
            result = self._call_runner(server, tool_name, arguments)
        else:
            result = asyncio.run(self._call_tool_async(server, tool_name, arguments))
        return mcp_result_to_tool_result(
            server_name=server.name,
            tool_name=tool_name,
            result=result,
        )

    async def _list_tools_async(self, server: McpServerConfig) -> Sequence[object]:
        params = _server_parameters(server)
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await asyncio.wait_for(
                    session.list_tools(),
                    timeout=server.timeout_seconds,
                )
        tools = getattr(result, "tools", result)
        return list(tools) if isinstance(tools, Sequence) else []

    async def _call_tool_async(
        self,
        server: McpServerConfig,
        tool_name: str,
        arguments: dict[str, object],
    ) -> object:
        params = _server_parameters(server)
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                return await asyncio.wait_for(
                    session.call_tool(tool_name, arguments=arguments),
                    timeout=server.timeout_seconds,
                )


def _server_parameters(server: McpServerConfig) -> StdioServerParameters:
    return StdioServerParameters(
        command=server.command,
        args=list(server.args),
        env=server.env or None,
    )


def sdk_tool_to_descriptor(*, server_name: str, tool: object) -> McpToolDescriptor:
    name = _read_string(tool, "name", default="unknown")
    description = _read_string(tool, "description", default=f"MCP tool {name}")
    raw_schema = _read_attr(tool, "inputSchema", "input_schema", default={})
    input_schema = raw_schema if isinstance(raw_schema, dict) else {}
    return McpToolDescriptor(
        server_name=server_name,
        name=name,
        description=description,
        input_schema=dict(input_schema),
    )


def mcp_result_to_tool_result(
    *,
    server_name: str,
    tool_name: str,
    result: object,
) -> ToolResultV2:
    contents = _extract_result_contents(result)
    text_parts = tuple(part.text_value() for part in contents if part.text_value())
    summary = "\n".join(text_parts).strip()
    structured = _read_attr(result, "structuredContent", "structured_content", default=None)
    is_error = bool(_read_attr(result, "isError", "is_error", default=False))
    if not summary and structured is not None:
        summary = json.dumps(structured, ensure_ascii=False, sort_keys=True)
    if not summary:
        summary = f"MCP tool {server_name}.{tool_name} returned no content."
    raw_payload = {
        "server_name": server_name,
        "tool_name": tool_name,
        "content": [content.raw for content in contents],
        "structured_content": structured,
        "is_error": is_error,
    }
    return ToolResultV2(
        success=not is_error,
        summary=summary,
        artifacts={"structured_content": structured} if structured is not None else {},
        raw_payload=raw_payload,
        error=summary if is_error else None,
    )


def _extract_result_contents(result: object) -> tuple[McpResultContent, ...]:
    raw_content = _read_attr(result, "content", default=())
    if not isinstance(raw_content, Sequence) or isinstance(raw_content, (str, bytes)):
        return ()
    contents: list[McpResultContent] = []
    for item in raw_content:
        raw = _object_to_dict(item)
        content_type = str(raw.get("type", _read_attr(item, "type", default="unknown")))
        text = raw.get("text", _read_attr(item, "text", default=None))
        data = raw.get("data", _read_attr(item, "data", default=None))
        contents.append(
            McpResultContent(
                type=content_type,
                text=text if isinstance(text, str) else None,
                data=data,
                raw=raw,
            )
        )
    return tuple(contents)


def _read_attr(obj: object, *names: str, default: object) -> object:
    if isinstance(obj, dict):
        for name in names:
            if name in obj:
                return obj[name]
    for name in names:
        value = getattr(obj, name, None)
        if value is not None:
            return value
    return default


def _read_string(obj: object, name: str, *, default: str) -> str:
    value = _read_attr(obj, name, default=default)
    return value if isinstance(value, str) and value else default


def _object_to_dict(obj: object) -> dict[str, Any]:
    if isinstance(obj, dict):
        return dict(obj)
    for attr in ("model_dump", "to_dict", "dict"):
        serializer = getattr(obj, attr, None)
        if callable(serializer):
            value = serializer()
            if isinstance(value, dict):
                return dict(value)
    payload: dict[str, Any] = {}
    for name in ("type", "text", "data"):
        value = getattr(obj, name, None)
        if value is not None:
            payload[name] = value
    return payload


__all__ = [
    "McpStdioClient",
    "mcp_result_to_tool_result",
    "sdk_tool_to_descriptor",
]
```

- [ ] **Step 4: Run targeted tests**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_mcp_stdio_client.py -q
uv run mypy src/mycli/infrastructure/mcp_stdio_client.py
```

Expected:

```text
passed
Success: no issues found
```

- [ ] **Step 5: Commit SDK wrapper**

Run:

```bash
git add src/mycli/infrastructure/mcp_stdio_client.py tests/unit/infrastructure/test_mcp_stdio_client.py
git commit -m "Wrap MCP stdio tool calls" \
  -m "The MCP stdio client wraps official SDK discovery and tool invocation while returning typed mycli descriptors and ToolResultV2 payloads to the rest of the runtime." \
  -m "Constraint: current runtime is synchronous, so SDK async calls are wrapped at the infrastructure boundary" \
  -m "Confidence: medium" \
  -m "Scope-risk: moderate" \
  -m "Tested: uv run pytest tests/unit/infrastructure/test_mcp_stdio_client.py -q" \
  -m "Tested: uv run mypy src/mycli/infrastructure/mcp_stdio_client.py" \
  -m "Not-tested: Live stdio MCP server"
```

---

### Task 5: Add MCP Host Service

**Files:**
- Create: `src/mycli/services/mcp_host_service.py`
- Test: `tests/unit/services/test_mcp_host_service.py`

- [ ] **Step 1: Write host service tests**

Create `tests/unit/services/test_mcp_host_service.py`:

```python
from __future__ import annotations

from mycli.domain.mcp import McpServerConfig, McpToolDescriptor
from mycli.services.mcp_host_service import McpHostService
from mycli.tools.base import ToolResultV2


class FakeMcpClient:
    def __init__(self) -> None:
        self.listed: list[str] = []
        self.called: list[tuple[str, str, dict[str, object]]] = []

    def list_tools(self, server: McpServerConfig) -> tuple[McpToolDescriptor, ...]:
        self.listed.append(server.name)
        return (
            McpToolDescriptor(
                server_name=server.name,
                name="search",
                description="Search files",
                input_schema={"type": "object", "properties": {}},
            ),
        )

    def call_tool(
        self,
        server: McpServerConfig,
        tool_name: str,
        arguments: dict[str, object],
    ) -> ToolResultV2:
        self.called.append((server.name, tool_name, arguments))
        return ToolResultV2(success=True, summary=f"{server.name}.{tool_name} ok")


def test_mcp_host_service_discovers_tools_from_enabled_servers() -> None:
    client = FakeMcpClient()
    service = McpHostService(
        servers={
            "filesystem": McpServerConfig(name="filesystem", command="npx"),
            "disabled": McpServerConfig(name="disabled", command="npx", enabled=False),
        },
        client=client,
    )

    tools = service.discover_tools()

    assert [tool.route_name for tool in tools] == ["mcp.filesystem.search"]
    assert client.listed == ["filesystem"]


def test_mcp_host_service_caches_discovered_tools() -> None:
    client = FakeMcpClient()
    service = McpHostService(
        servers={"filesystem": McpServerConfig(name="filesystem", command="npx")},
        client=client,
    )

    service.discover_tools()
    service.discover_tools()

    assert client.listed == ["filesystem"]


def test_mcp_host_service_calls_tool_on_named_server() -> None:
    client = FakeMcpClient()
    service = McpHostService(
        servers={"filesystem": McpServerConfig(name="filesystem", command="npx")},
        client=client,
    )

    result = service.call_tool(
        server_name="filesystem",
        tool_name="search",
        arguments={"query": "abc"},
    )

    assert result.summary == "filesystem.search ok"
    assert client.called == [("filesystem", "search", {"query": "abc"})]


def test_mcp_host_service_rejects_unknown_server() -> None:
    service = McpHostService(servers={}, client=FakeMcpClient())

    result = service.call_tool(
        server_name="missing",
        tool_name="search",
        arguments={},
    )

    assert result.success is False
    assert "Unknown MCP server" in result.summary
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/services/test_mcp_host_service.py -q
```

Expected:

```text
FAILED ... ModuleNotFoundError: No module named 'mycli.services.mcp_host_service'
```

- [ ] **Step 3: Implement MCP host service**

Create `src/mycli/services/mcp_host_service.py`:

```python
from __future__ import annotations

from typing import Protocol

from mycli.domain.mcp import McpServerConfig, McpToolDescriptor
from mycli.infrastructure.mcp_stdio_client import McpStdioClient
from mycli.tools.base import ToolResultV2


class McpClient(Protocol):
    def list_tools(self, server: McpServerConfig) -> tuple[McpToolDescriptor, ...]:
        ...

    def call_tool(
        self,
        server: McpServerConfig,
        tool_name: str,
        arguments: dict[str, object],
    ) -> ToolResultV2:
        ...


class McpHostService:
    def __init__(
        self,
        *,
        servers: dict[str, McpServerConfig],
        client: McpClient | None = None,
    ) -> None:
        self._servers = dict(servers)
        self._client = client or McpStdioClient()
        self._tool_cache: tuple[McpToolDescriptor, ...] | None = None

    def has_enabled_servers(self) -> bool:
        return any(server.enabled for server in self._servers.values())

    def discover_tools(self) -> tuple[McpToolDescriptor, ...]:
        if self._tool_cache is not None:
            return self._tool_cache
        tools: list[McpToolDescriptor] = []
        for server in self._servers.values():
            if not server.enabled:
                continue
            tools.extend(self._client.list_tools(server))
        self._tool_cache = tuple(sorted(tools, key=lambda item: item.route_name))
        return self._tool_cache

    def call_tool(
        self,
        *,
        server_name: str,
        tool_name: str,
        arguments: dict[str, object],
    ) -> ToolResultV2:
        server = self._servers.get(server_name)
        if server is None:
            return ToolResultV2(
                success=False,
                summary=f"Unknown MCP server: {server_name}",
                error=f"Unknown MCP server: {server_name}",
                raw_payload={"server_name": server_name, "tool_name": tool_name},
            )
        if not server.enabled:
            return ToolResultV2(
                success=False,
                summary=f"MCP server is disabled: {server_name}",
                error=f"MCP server is disabled: {server_name}",
                raw_payload={"server_name": server_name, "tool_name": tool_name},
            )
        return self._client.call_tool(server, tool_name, arguments)


__all__ = ["McpClient", "McpHostService"]
```

- [ ] **Step 4: Run targeted tests**

Run:

```bash
uv run pytest tests/unit/services/test_mcp_host_service.py -q
uv run mypy src/mycli/services/mcp_host_service.py
```

Expected:

```text
passed
Success: no issues found
```

- [ ] **Step 5: Commit host service**

Run:

```bash
git add src/mycli/services/mcp_host_service.py tests/unit/services/test_mcp_host_service.py
git commit -m "Add an MCP host service" \
  -m "The host service owns enabled server discovery, tool descriptor caching, and named tool invocation while hiding the stdio SDK client from runtime orchestration." \
  -m "Constraint: service layer should expose ToolResultV2, not SDK result objects" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: uv run pytest tests/unit/services/test_mcp_host_service.py -q" \
  -m "Tested: uv run mypy src/mycli/services/mcp_host_service.py"
```

---

### Task 6: Expose MCP Tools As Dynamic Tools

**Files:**
- Modify: `src/mycli/domain/dynamic_tools.py`
- Create: `src/mycli/services/mcp_tool_provider.py`
- Test: `tests/unit/services/test_mcp_tool_provider.py`
- Modify: `tests/unit/domain/test_dynamic_tools.py`

- [ ] **Step 1: Add source enum and provider tests**

Append to `tests/unit/domain/test_dynamic_tools.py`:

```python
def test_dynamic_tool_source_includes_mcp() -> None:
    assert DynamicToolSource.MCP.value == "mcp"
```

Create `tests/unit/services/test_mcp_tool_provider.py`:

```python
from __future__ import annotations

from mycli.domain.mcp import McpToolDescriptor
from mycli.domain.dynamic_tools import DynamicToolScope, DynamicToolSource
from mycli.services.mcp_tool_provider import McpToolProvider
from mycli.tools.base import ToolResultV2


class FakeMcpHostService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, object]]] = []

    def discover_tools(self) -> tuple[McpToolDescriptor, ...]:
        return (
            McpToolDescriptor(
                server_name="filesystem",
                name="search",
                description="Search files",
                input_schema={
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
            ),
        )

    def call_tool(
        self,
        *,
        server_name: str,
        tool_name: str,
        arguments: dict[str, object],
    ) -> ToolResultV2:
        self.calls.append((server_name, tool_name, arguments))
        return ToolResultV2(success=True, summary="mcp ok")


def test_mcp_tool_provider_converts_discovered_tools_to_dynamic_registrations() -> None:
    host = FakeMcpHostService()
    provider = McpToolProvider(host_service=host)

    registrations = provider.provide(
        user_message="search docs",
        conversation=None,  # type: ignore[arg-type]
        plan_state=None,  # type: ignore[arg-type]
        capability_activations=(),
    )

    registration = registrations[0]
    assert registration.descriptor.tool_id == "mcp:filesystem:search:thread"
    assert registration.descriptor.route_name == "mcp.filesystem.search"
    assert registration.descriptor.source is DynamicToolSource.MCP
    assert registration.descriptor.scope is DynamicToolScope.THREAD
    assert registration.descriptor.origin_metadata == {
        "server_name": "filesystem",
        "mcp_tool_name": "search",
        "transport": "stdio",
    }
    assert registration.tool.spec.name == "mcp.filesystem.search"
    assert registration.tool.spec.parameters[0].name == "query"


def test_mcp_dynamic_tool_executes_through_host_service() -> None:
    host = FakeMcpHostService()
    provider = McpToolProvider(host_service=host)
    registration = provider.provide(
        user_message="search docs",
        conversation=None,  # type: ignore[arg-type]
        plan_state=None,  # type: ignore[arg-type]
        capability_activations=(),
    )[0]

    result = registration.tool.execute({"query": "abc"})

    assert result.summary == "mcp ok"
    assert host.calls == [("filesystem", "search", {"query": "abc"})]
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/domain/test_dynamic_tools.py tests/unit/services/test_mcp_tool_provider.py -q
```

Expected:

```text
FAILED ... AttributeError: MCP
FAILED ... ModuleNotFoundError: No module named 'mycli.services.mcp_tool_provider'
```

- [ ] **Step 3: Add MCP dynamic source**

Modify `src/mycli/domain/dynamic_tools.py`:

```python
class DynamicToolSource(StrEnum):
    RUNTIME = "runtime"
    CAPABILITY = "capability"
    PROVIDER = "provider"
    MCP = "mcp"
```

- [ ] **Step 4: Implement MCP tool provider**

Create `src/mycli/services/mcp_tool_provider.py`:

```python
from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.capabilities import CapabilityActivation
from mycli.domain.conversation import Conversation
from mycli.domain.dynamic_tools import (
    DynamicToolDescriptor,
    DynamicToolLifecycleState,
    DynamicToolRegistration,
    DynamicToolScope,
    DynamicToolSource,
)
from mycli.domain.mcp import McpToolDescriptor
from mycli.domain.runtime import PlanState
from mycli.domain.tool_exposure import ToolRouteKey
from mycli.services.mcp_host_service import McpHostService
from mycli.tools.base import ToolResultV2, ToolSpec


@dataclass(slots=True)
class McpDynamicTool:
    descriptor: McpToolDescriptor
    host_service: McpHostService

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name=self.descriptor.route_name,
            description=self.descriptor.description,
            parameters=self.descriptor.tool_parameters(),
            risk_level="medium",
        )

    def execute(self, arguments: dict[str, object]) -> ToolResultV2:
        return self.host_service.call_tool(
            server_name=self.descriptor.server_name,
            tool_name=self.descriptor.name,
            arguments=arguments,
        )

    def run(self, call) -> object:
        return self.execute(call.arguments).to_legacy()


class McpToolProvider:
    def __init__(self, *, host_service: McpHostService) -> None:
        self._host_service = host_service

    def provide(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        capability_activations: tuple[CapabilityActivation, ...],
    ) -> tuple[DynamicToolRegistration, ...]:
        del user_message, conversation, plan_state, capability_activations
        registrations: list[DynamicToolRegistration] = []
        for descriptor in self._host_service.discover_tools():
            tool = McpDynamicTool(descriptor=descriptor, host_service=self._host_service)
            registrations.append(
                DynamicToolRegistration(
                    descriptor=DynamicToolDescriptor(
                        tool_id=f"mcp:{descriptor.server_name}:{descriptor.name}:thread",
                        display_name=descriptor.route_name,
                        description=descriptor.description,
                        route_key=ToolRouteKey(
                            namespace=descriptor.route_namespace,
                            name=descriptor.name,
                        ),
                        source=DynamicToolSource.MCP,
                        scope=DynamicToolScope.THREAD,
                        lifecycle_state=DynamicToolLifecycleState.DECLARED,
                        spec=tool.spec,
                        origin_metadata={
                            "server_name": descriptor.server_name,
                            "mcp_tool_name": descriptor.name,
                            "transport": "stdio",
                        },
                    ),
                    tool=tool,
                )
            )
        return tuple(registrations)


__all__ = ["McpDynamicTool", "McpToolProvider"]
```

If mypy complains about the `run(self, call)` method, import `ToolCall` and `ToolResult` and use:

```python
from mycli.domain.tools import ToolCall, ToolResult

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()
```

- [ ] **Step 5: Run targeted tests**

Run:

```bash
uv run pytest tests/unit/domain/test_dynamic_tools.py tests/unit/services/test_mcp_tool_provider.py -q
uv run mypy src/mycli/domain/dynamic_tools.py src/mycli/services/mcp_tool_provider.py
```

Expected:

```text
passed
Success: no issues found
```

- [ ] **Step 6: Commit MCP tool provider**

Run:

```bash
git add src/mycli/domain/dynamic_tools.py src/mycli/services/mcp_tool_provider.py tests/unit/domain/test_dynamic_tools.py tests/unit/services/test_mcp_tool_provider.py
git commit -m "Expose MCP tools as dynamic tools" \
  -m "Discovered MCP tools now become namespaced thread-scoped dynamic tools that execute through McpHostService and return normal ToolResultV2 values." \
  -m "Constraint: MCP tools must route through existing dynamic tool lifecycle and ToolRouter" \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: uv run pytest tests/unit/domain/test_dynamic_tools.py tests/unit/services/test_mcp_tool_provider.py -q" \
  -m "Tested: uv run mypy src/mycli/domain/dynamic_tools.py src/mycli/services/mcp_tool_provider.py"
```

---

### Task 7: Wire MCP Host Into CLI Runtime

**Files:**
- Modify: `src/mycli/cli/main.py`
- Modify: `tests/integration/test_cli_repl.py`

- [ ] **Step 1: Add runtime construction test**

Append to `tests/integration/test_cli_repl.py`:

```python
def test_build_turn_service_attaches_mcp_tool_provider_when_servers_configured(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (workspace / ".mycli").mkdir()
    (workspace / ".mycli" / "config.toml").write_text(
        (
            "api_key = \"test-key\"\n"
            "\n"
            "[mcp_servers.filesystem]\n"
            "command = \"npx\"\n"
            "args = [\"-y\", \"@modelcontextprotocol/server-filesystem\", \".\"]\n"
        ),
        encoding="utf-8",
    )

    service = build_turn_service(
        cli_args={"session": "mcp-demo"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )

    providers = service._runtime._dynamic_tool_providers
    assert len(providers) == 1
    assert providers[0].__class__.__name__ == "McpToolProvider"
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
uv run pytest tests/integration/test_cli_repl.py::test_build_turn_service_attaches_mcp_tool_provider_when_servers_configured -q
```

Expected:

```text
FAILED ... assert 0 == 1
```

- [ ] **Step 3: Wire MCP services in CLI builder**

Modify `src/mycli/cli/main.py` imports:

```python
from mycli.services.mcp_host_service import McpHostService
from mycli.services.mcp_tool_provider import McpToolProvider
```

Before constructing `AgentRuntime`, add:

```python
    dynamic_tool_providers = ()
    if config.mcp_servers:
        mcp_host_service = McpHostService(servers=config.mcp_servers)
        if mcp_host_service.has_enabled_servers():
            dynamic_tool_providers = (
                McpToolProvider(host_service=mcp_host_service),
            )
```

Pass into `AgentRuntime`:

```python
        dynamic_tool_providers=dynamic_tool_providers,
```

- [ ] **Step 4: Run CLI integration tests**

Run:

```bash
uv run pytest tests/integration/test_cli_repl.py -q
uv run mypy src/mycli/cli/main.py
```

Expected:

```text
passed
Success: no issues found
```

- [ ] **Step 5: Commit runtime wiring**

Run:

```bash
git add src/mycli/cli/main.py tests/integration/test_cli_repl.py
git commit -m "Attach configured MCP servers to the runtime" \
  -m "Runtime construction now creates an MCP host and dynamic tool provider when config defines enabled MCP servers, preserving existing behavior when no servers are configured." \
  -m "Constraint: MCP must enter through dynamic_tool_providers instead of a separate runtime branch" \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: uv run pytest tests/integration/test_cli_repl.py -q" \
  -m "Tested: uv run mypy src/mycli/cli/main.py"
```

---

### Task 8: Verify MCP Tool Round Trip Through Runtime

**Files:**
- Modify: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Add runtime round-trip test with fake MCP provider**

Append to `tests/unit/application/test_agent_runtime.py` near existing dynamic tool tests:

```python
class FakeMcpAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_tools: list[list[str]] = []

    def next_turn(self, *, items, tools):
        del items
        self.calls += 1
        self.seen_tools.append([tool.name for tool in tools])
        if self.calls == 1:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="mcp.filesystem.search",
                                tool_arguments={"query": "README"},
                                call_id="call_mcp_search",
                                source="mcp",
                            ),
                        ),
                    ),
                ),
                done=False,
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="MCP search complete."),),
                ),
            ),
            done=True,
        )


class FakeMcpTool:
    spec = ToolSpec(
        name="mcp.filesystem.search",
        description="Search via MCP",
        parameters=(ToolParameter(name="query", type="string", required=True),),
    )

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def execute(self, arguments: dict[str, object]) -> ToolResultV2:
        self.calls.append(dict(arguments))
        return ToolResultV2(success=True, summary="Found README.md")

    def run(self, call):
        return self.execute(call.arguments).to_legacy()


class FakeMcpDynamicProvider(DynamicToolProvider):
    def __init__(self, tool: FakeMcpTool) -> None:
        self.tool = tool

    def provide(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        capability_activations,
    ) -> tuple[object, ...]:
        del user_message, conversation, plan_state, capability_activations
        return (
            DynamicToolRegistration(
                descriptor=DynamicToolDescriptor(
                    tool_id="mcp:filesystem:search:thread",
                    display_name="mcp.filesystem.search",
                    description="Search via MCP",
                    route_key=ToolRouteKey(namespace="mcp.filesystem", name="search"),
                    source=DynamicToolSource.MCP,
                    scope=DynamicToolScope.THREAD,
                    lifecycle_state=DynamicToolLifecycleState.DECLARED,
                    spec=self.tool.spec,
                    origin_metadata={
                        "server_name": "filesystem",
                        "mcp_tool_name": "search",
                        "transport": "stdio",
                    },
                ),
                tool=self.tool,
            ),
        )


def test_agent_runtime_routes_mcp_dynamic_tool_and_reinjects_result(
    tmp_path: Path,
) -> None:
    adapter = FakeMcpAdapter()
    tool = FakeMcpTool()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistryV2.from_tools([ListDirectoryTool(tmp_path)]),
        config=AgentConfig(workspace_root=tmp_path, session_id="mcp-demo", max_steps=4),
        home_dir=tmp_path,
        dynamic_tool_providers=(FakeMcpDynamicProvider(tool),),
    )

    response = runtime.handle_user_message("use MCP search")

    assert response.assistant_message == "MCP search complete."
    assert tool.calls == [{"query": "README"}]
    assert "mcp.filesystem.search" in adapter.seen_tools[0]
    conversation = runtime._session_service.load_conversation("mcp-demo")
    assert any(
        message.role == "tool" and "Found README.md" in message.content
        for message in conversation.messages
    )
```

If imports are missing, add them at the top of the test file:

```python
from mycli.domain.tool_exposure import ToolRouteKey
from mycli.services.dynamic_tool_provider import DynamicToolProvider
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.list_directory import ListDirectoryTool
from mycli.tools.registry import ToolRegistryV2
```

- [ ] **Step 2: Run test to verify behavior**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime.py::test_agent_runtime_routes_mcp_dynamic_tool_and_reinjects_result -q
```

Expected:

```text
passed
```

If it fails because `DynamicToolSource.MCP` is not imported in the test file, add it to the existing import from `mycli.domain.dynamic_tools`.

- [ ] **Step 3: Run dynamic-tool related tests**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime.py -k "dynamic_tool or mcp" -q
```

Expected:

```text
passed
```

- [ ] **Step 4: Commit runtime round-trip coverage**

Run:

```bash
git add tests/unit/application/test_agent_runtime.py
git commit -m "Cover MCP dynamic tool runtime routing" \
  -m "A runtime test now proves an MCP-namespaced dynamic tool can be exposed, called by the model, executed through ToolRouter, and reinjected as a normal tool result." \
  -m "Constraint: MCP calls must behave like normal dynamic tool calls in the runtime loop" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: uv run pytest tests/unit/application/test_agent_runtime.py -k 'dynamic_tool or mcp' -q"
```

---

### Task 9: Document MCP Configuration

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add MCP docs section**

Add this section after the model provider sections in `README.md`:

```markdown
## MCP Host

`mycli` can host stdio MCP servers and expose their tools to the agent as
namespaced dynamic tools.

Example project config:

```toml
[mcp_servers.filesystem]
enabled = true
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "."]
env = {}
timeout_seconds = 30
```

Tools from that server are exposed as:

```text
mcp.filesystem.<tool_name>
```

Environment values can reference process environment variables:

```toml
[mcp_servers.github]
enabled = true
command = "uvx"
args = ["mcp-server-github"]
env = { GITHUB_TOKEN = "${GITHUB_TOKEN}" }
```

Do not commit real API keys or tokens in `.mycli/config.toml`. Prefer environment
references for secrets.

MCP host v1 supports stdio tools only:

- supported: `tools/list`, `tools/call`
- not yet supported: resources, prompts, Streamable HTTP, OAuth, sampling,
  elicitation, persistent connection pooling
```

- [ ] **Step 2: Run docs secret scan**

Run:

```bash
rg -n "sk-[A-Za-z0-9_-]{16,}|xox[baprs]-|AKIA[0-9A-Z]{16}|GITHUB_TOKEN = \"[A-Za-z0-9]" README.md docs/superpowers -g '*.md' || true
```

Expected:

```text
no real secrets; example ${GITHUB_TOKEN} references are acceptable
```

- [ ] **Step 3: Commit docs**

Run:

```bash
git add README.md
git commit -m "Document stdio MCP host configuration" \
  -m "The README now shows how to configure stdio MCP servers, namespaced tool routes, environment substitutions, and current MCP MVP limitations without including real secrets." \
  -m "Constraint: MCP server secrets should use environment references" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: rg secret-pattern scan over README.md docs/superpowers"
```

---

### Task 10: Full Verification

**Files:**
- Modify only files reported by verification failures.

- [ ] **Step 1: Run full type checking**

Run:

```bash
uv run mypy src
```

Expected:

```text
Success: no issues found
```

- [ ] **Step 2: Run lint**

Run:

```bash
uv run ruff check src tests
```

Expected:

```text
All checks passed!
```

If ruff reports import order issues, run:

```bash
uv run ruff check src tests --fix
uv run ruff check src tests
```

- [ ] **Step 3: Run full tests**

Run:

```bash
uv run pytest -q
```

Expected:

```text
passed
```

- [ ] **Step 4: Confirm local config and logs are not staged**

Run:

```bash
git status --short --ignored | rg "(\\.mycli/|^log/|model-raw|evaluation/runs|\\.DS_Store)" || true
```

Expected output may show ignored files with `!!`; it must not show staged or unstaged tracked changes for local config or raw logs.

- [ ] **Step 5: Commit verification fixes if needed**

If verification required code changes, run:

```bash
git add src tests README.md
git commit -m "Stabilize MCP host verification" \
  -m "Strict typing, linting, and tests now pass after integrating the stdio MCP host path." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: uv run mypy src" \
  -m "Tested: uv run ruff check src tests" \
  -m "Tested: uv run pytest -q"
```

If verification passes without changes, do not create an empty commit.

---

## Self-Review

Spec coverage:

- Official SDK dependency: Task 1.
- Stdio-only transport: Task 4.
- Config parsing for `[mcp_servers.<name>]`: Task 3.
- Environment substitution: Task 2 and Task 3.
- MCP tool naming `mcp.<server>.<tool>`: Task 2 and Task 6.
- Existing dynamic tool path: Task 6, Task 7, Task 8.
- Tool result normalization: Task 4 and Task 5.
- Safety boundary through existing router/exposure: Task 6, Task 7, Task 8.
- Docs and secret hygiene: Task 9 and Task 10.

Placeholder scan:

- No incomplete implementation steps are intentional.
- All new modules have concrete tests before implementation steps.

Type consistency:

- `McpServerConfig`, `McpToolDescriptor`, and `McpResultContent` are defined in Task 2 and reused consistently.
- `McpStdioClient` exposes `list_tools()` and `call_tool()` and is consumed by `McpHostService`.
- `McpToolProvider` implements the existing `DynamicToolProvider` protocol.
- Route names consistently use `mcp.<server_name>.<tool_name>`.
