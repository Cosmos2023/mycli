# mycli MCP Host Design

Date: 2026-04-26
Status: approved for implementation planning

## Goal

Add a first-class MCP host MVP to `mycli` so external MCP stdio servers can
contribute tools to the existing agent loop.

The implementation should make MCP tools feel like normal runtime tools:
discovered tools enter the existing tool exposure planner, model calls route
through the existing tool router, MCP results become normal `ToolResultV2`
values, and subsequent model turns receive them as ordinary tool results.

## Non-Goals

- Do not implement Streamable HTTP transport in this change.
- Do not implement MCP resources, prompts, sampling, roots, elicitation, or OAuth.
- Do not build a long-lived daemon or background MCP process manager yet.
- Do not bypass existing approval, trace, session, or tool exposure logic.
- Do not commit project-local MCP secrets or raw MCP logs.

## External Protocol Decision

Use the official `mcp` Python SDK.

Rationale:

- MCP client initialization, stdio transport, tool listing, and tool invocation
  are protocol-sensitive enough that a hand-rolled JSON-RPC client would create
  avoidable maintenance risk.
- The Python SDK exposes the target MVP shape directly: `ClientSession`,
  `StdioServerParameters`, `stdio_client`, `list_tools`, and `call_tool`.
- Using the SDK keeps future Streamable HTTP, resources, prompts, and OAuth work
  on the supported protocol path.

Initial transport scope is stdio only.

Reference sources:

- MCP Python SDK: `https://github.com/modelcontextprotocol/python-sdk`
- MCP client concepts: `https://modelcontextprotocol.io/docs/learn/client-concepts`
- MCP tools specification: `https://modelcontextprotocol.io/specification/draft/server/tools`

## Configuration

`mycli` should read MCP server definitions from project/user config using a
TOML table keyed by server name:

```toml
[mcp_servers.filesystem]
enabled = true
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "."]
env = {}
timeout_seconds = 30
```

Multiple servers use multiple subtables:

```toml
[mcp_servers.github]
enabled = true
command = "uvx"
args = ["mcp-server-github"]
env = { GITHUB_TOKEN = "${GITHUB_TOKEN}" }
timeout_seconds = 30
```

Configuration rules:

- `enabled` defaults to `true`.
- `command` is required for enabled servers.
- `args` defaults to an empty list.
- `env` defaults to an empty table.
- `${NAME}` values resolve from process environment at runtime.
- Missing environment substitutions fail during server startup with a clear
  configuration error.
- `timeout_seconds` defaults to `30`.

The MVP should preserve existing provider config behavior and add MCP config as
an optional feature. A project without `mcp_servers` must behave exactly as it
does today.

## Tool Naming And Routing

MCP tools must be namespaced before exposure:

```text
mcp.<server_name>.<tool_name>
```

Examples:

```text
mcp.filesystem.search
mcp.github.create_issue
```

This prevents collisions with local tools such as `read_file` and gives safety,
trace, and lifecycle code a stable source identity.

The internal route key should use:

```text
namespace = "mcp.<server_name>"
name = "<tool_name>"
value = "mcp.<server_name>.<tool_name>"
```

The dynamic tool descriptor should identify:

- `source = DynamicToolSource.PROVIDER` or a new `MCP` source if the existing enum
  is extended.
- `scope = THREAD` for discovered server tools.
- `origin_metadata.server_name`
- `origin_metadata.mcp_tool_name`
- `origin_metadata.transport = "stdio"`

## Runtime Integration

The MCP host should use the existing dynamic tool path:

```text
config_service
  -> AgentRuntime
  -> McpHostService
  -> McpToolProvider
  -> ToolExposurePlanner
  -> DynamicToolRegistration
  -> ToolRouter
  -> ToolResultV2
  -> ContextManager tool-result reinjection
```

No MCP-specific branch should be added to the model provider adapters. MCP tool
calls are still model tool calls; only the tool executor behind the route differs.

## Proposed Modules

Create `src/mycli/domain/mcp.py`.

Responsibility:

- Define `McpServerConfig`.
- Define `McpToolDescriptor`.
- Define MCP-specific error types or error-kind constants.
- Keep these models infrastructure-free.

Create `src/mycli/infrastructure/mcp_stdio_client.py`.

Responsibility:

- Wrap the official SDK.
- Convert `McpServerConfig` into `StdioServerParameters`.
- Provide synchronous methods for the current sync runtime:
  - `list_tools(server: McpServerConfig) -> tuple[McpToolDescriptor, ...]`
  - `call_tool(server: McpServerConfig, tool_name: str, arguments: dict[str, object]) -> ToolResultV2`
- Internally run SDK async calls using `asyncio.run` for the MVP.
- Map SDK errors, protocol errors, startup failures, and timeouts to clear
  domain/infrastructure exceptions.

Create `src/mycli/services/mcp_host_service.py`.

Responsibility:

- Own the configured server list.
- Discover tools from enabled servers.
- Cache discovered tool descriptors for a turn or session.
- Execute a named MCP tool on the correct server.
- Normalize tool results into `ToolResultV2`.

Create `src/mycli/services/mcp_tool_provider.py`.

Responsibility:

- Implement the existing `DynamicToolProvider` protocol.
- Convert `McpToolDescriptor` values into `DynamicToolRegistration`.
- Build `SchemaTool` wrappers whose `execute()` method calls `McpHostService`.
- Use namespaced route names.

## MCP Tool Schema Mapping

MCP tool metadata should map to `ToolSpec`:

- MCP tool name -> route name suffix.
- MCP description -> `ToolSpec.description`.
- MCP `inputSchema.properties` -> `ToolParameter` entries.
- MCP `inputSchema.required` -> `ToolParameter.required`.
- Unsupported schema shapes should degrade conservatively to a single object-like
  parameter only if needed; prefer exact primitive/object/array mapping where
  possible.

The first implementation should support the common JSON Schema property types:

- `string`
- `number`
- `integer`
- `boolean`
- `array`
- `object`

Nested object schemas can remain in `items_schema` or metadata until mycli's
tool schema model is expanded.

## MCP Result Mapping

MCP `call_tool` results should become `ToolResultV2`:

- Text content blocks join into a readable summary/body.
- Structured content, when present, goes into `raw_payload` and artifacts.
- Error results become `success=False` with the MCP error message.
- Unknown content blocks are preserved in `raw_payload`.

The runtime should not expose raw SDK objects to context manager or session
storage.

## Safety And Approval

MCP tools should not bypass existing safeguards.

MVP behavior:

- MCP tools are dynamically exposed and routed through the same `ToolRouter`.
- MCP calls should be treated as non-local dynamic tools for activity and trace.
- MCP tools should start as deferred or dynamic entries, not privileged local
  direct tools.
- Existing risk/approval evaluation should still run before execution where
  applicable.

Future trust levels can be added later:

```toml
[mcp_servers.github]
trust = "low" # low | workspace | trusted
```

This design intentionally does not add trust levels in the MVP to keep behavior
simple and reviewable.

## Logging And Trace

MCP host events should be visible but should not leak secrets:

- Server startup/discovery event includes server name, command basename, and tool
  count, not full env values.
- Tool invocation activity includes route name and summarized arguments.
- Tool result activity includes success/failure and summary.
- Raw MCP payload logging can be added later; MVP should avoid writing raw
  secrets from MCP arguments or env.

## Lifecycle

MVP can use short-lived client sessions:

- Open stdio client for discovery.
- Open stdio client for each tool call.
- Close after operation.

This is simpler and safer than managing persistent subprocesses. It may be slower
for high-frequency MCP tools, but the boundary can later evolve into a pooled
`McpConnectionManager` without changing `ToolRouter` or model adapters.

## Testing Strategy

Unit tests:

- Config parsing accepts `mcp_servers`.
- Config parsing resolves `${ENV_NAME}` substitutions.
- Config parsing rejects enabled servers with missing command.
- MCP tool provider converts fake tool descriptors into namespaced dynamic tools.
- Tool router can execute an MCP dynamic tool through a fake host service.
- MCP result mapper handles text content, structured content, and error content.

Integration-style tests without real MCP servers:

- Build `AgentRuntime` with a fake `McpToolProvider`.
- Verify MCP dynamic tools appear in tool exposure.
- Verify a model-requested `mcp.server.tool` call routes to the fake MCP host and
  reinjects a `tool_result`.

Optional live smoke test:

- Use a local filesystem MCP server only when the dependency is installed and the
  command is available.
- Mark it opt-in so normal CI does not require Node, uvx, or external services.

Verification commands:

```bash
uv run mypy src
uv run ruff check src tests
uv run pytest -q
```

## Acceptance Criteria

- A user can configure at least one stdio MCP server in `.mycli/config.toml`.
- Enabled server tools appear to the model as `mcp.<server>.<tool>`.
- A model can call a discovered MCP tool.
- MCP tool results are returned as normal tool results and participate in the
  next model turn.
- Existing local tools, provider paths, session persistence, and approval flow
  continue to pass tests.
- No local secrets, MCP env values, or raw logs are committed.

## Risks

- The current runtime is synchronous; using `asyncio.run` is acceptable for MVP
  but will need revisiting for persistent connections or streaming MCP behavior.
- MCP tool schemas can be richer than `ToolSpec` currently supports; v1 should
  preserve unsupported details in metadata rather than pretending full fidelity.
- Short-lived stdio sessions may be slow for some servers; this is an explicit
  tradeoff to keep lifecycle simple.
- MCP servers can perform high-impact external actions, so future trust-level and
  per-tool safety policies should be designed after the MVP proves the routing
  path.

