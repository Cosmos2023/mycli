# MCP Tool Runtime P0

## Problem

`mycli` has a local tool, hook, plugin command, and partial MCP foundation, but MCP local stdio tools are not yet a complete Hermes-like external tool runtime slice. The P0 goal is to make local stdio MCP servers configurable, discoverable, diagnosable, manifest-visible, and executable through the existing tool runtime without requiring an LLM provider.

## Scope

In scope:

- Local stdio MCP server configuration through `.mycli/mcp_servers.toml`.
- Provider-free MCP config/discovery/doctor/CLI diagnostics.
- Minimal stdio JSON-RPC initialize, `tools/list`, and `tools/call`.
- MCP tool registration into the contributed tool and manifest path.
- MCP tool execution converted into `ToolResult`.
- Bounded, redacted diagnostics and long-output truncation.
- Unit tests and provider-free smoke for success, disabled, and failure cases.

Out of scope:

- Hosted MCP.
- OAuth.
- SSE.
- ACP.
- Marketplace.
- Subagent/multi-agent productization.
- Copying Hermes-agent implementation code.

## Requirements

### Config / Discovery

- Load `.mycli/mcp_servers.toml` from the workspace.
- Support server fields: name/id from table name, `transport`, `command`, `args`, `env`, `enabled`, `timeout_seconds`.
- Disabled servers must not start.
- Config parse and validation failures must be represented as diagnostics and must not require model/provider startup.
- Secret-like values from env, headers, tokens, API keys, or nested payloads must be redacted.

### Client

- Enabled stdio MCP servers can initialize and list tools.
- `tools/call` passes arguments by MCP schema name.
- Startup failure, timeout, server crash, and JSON-RPC errors return bounded failure diagnostics.
- Server failure must not break session, turn, or runtime construction.

### Manifest / Execution

- MCP tools use stable ids: `mcp:<server_id>:<tool_name>`.
- MCP route names use `mcp.<server_id>.<tool_name>`.
- Manifest can distinguish `source=mcp` and `toolset=external`.
- MCP tool specs expose medium risk and MCP approval/risk metadata.
- MCP tool execution returns `ToolResult(success, summary, raw_payload, error)`.
- Long MCP output must be summarized/truncated before it enters summary or raw payload.

### CLI / Doctor

- Provide provider-free commands:
  - `mycli mcp list [--json]`
  - `mycli mcp inspect <server_id> [--json]`
- CLI output must be bounded and redacted.
- Doctor MCP check reports configured, enabled, disabled, failed, discovered tool count, and per-server safe detail.

### Tests / Smoke

- Unit tests cover config parse, disabled server, bad command/startup failure, list success/failure, manifest source/id/toolset, tool execution success/failure/truncation, doctor diagnostics, and CLI human/JSON output.
- Provider-free smoke creates temporary fake stdio MCP servers and verifies:
  - disabled server is not started
  - enabled server initializes and lists tools
  - MCP tool enters manifest
  - `call_tool` returns a `ToolResult`
  - failed server is diagnosable and redacted

## Acceptance

- `uv run pytest tests/unit/services/test_mcp_client.py tests/unit/services/test_mcp_diagnostics.py tests/unit/application/test_mcp_tool_lifecycle.py tests/unit/cli/test_main.py tests/unit/services/test_extension_manifest.py tests/unit/services/test_mcp_provider.py -q`
- `uv run python evaluation/mcp_smoke.py`
- `uv run ruff check src tests evaluation/mcp_smoke.py`
- `uv run mypy src/mycli`
- `uv run pytest tests/unit tests/integration -q`

If broad verification is blocked by unrelated existing failures, record the exact command and failure, keep focused MCP verification green, and do not mark the overall goal complete until the required evidence exists or the blocker satisfies the blocked audit policy.
