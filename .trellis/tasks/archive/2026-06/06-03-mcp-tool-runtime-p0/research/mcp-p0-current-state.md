# MCP Tool Runtime P0 Current State

## Baseline

- Branch: `feature/mycli-mcp-tool-runtime-p0`
- Base: `feature/mycli-hermes-parity-consolidated`
- Existing MCP files:
  - `src/mycli/services/mcp/client.py`
  - `src/mycli/services/mcp/diagnostics.py`
  - `src/mycli/services/mcp/tool_adapter.py`
  - `src/mycli/services/mcp/provider.py`
  - `src/mycli/services/mcp/resource_adapter.py`
  - `evaluation/mcp_smoke.py`

## Existing Capabilities

- `.mycli/mcp_servers.toml` can load `[servers.<name>]` or `[mcp_servers.<name>]`.
- `McpServerConfig` supports stdio/http config fields, `enabled`, env, args, and timeout.
- stdio JSON-RPC framing uses `Content-Length` headers.
- `McpClient` supports `initialize`, `tools/list`, `tools/call`, `resources/list`, and `resources/read`.
- `McpToolAdapter` converts MCP tools into contributed tool registrations.
- `McpToolContributionProvider` feeds MCP registrations into the contributed tool runtime.
- `DoctorService` already has an MCP check backed by `discover_mcp_servers`.
- `evaluation/mcp_smoke.py` proves a local fake stdio server can be discovered, added to manifests, and called.

## Gaps Against P0 Goal

- MCP diagnostics bound messages but do not redact secret-like values.
- `mycli mcp list` / `mycli mcp inspect` provider-free management command is absent.
- MCP tool output is returned raw as summary and raw payload without an explicit long-output truncation strategy.
- MCP tools are registered through `ToolContributionSource.PROVIDER`; manifest special-cases MCP by id, but lifecycle source metadata is not explicit.
- MCP tool specs currently default to low risk; P0 requires external/medium risk or explicit MCP approval metadata.
- Doctor MCP failure detail is too shallow for CLI/doctor parity and does not expose per-server JSON-friendly fields.
- Existing smoke mainly covers success; disabled and failed server diagnostics need explicit coverage.

## Relevant Contracts

- `.trellis/spec/backend/tool-manifest-contract.md`
  - MCP-origin tools must use stable `mcp:<server>:<tool>` ids.
  - Combined manifest renders MCP entries as `source=mcp`, `toolset=external`.
  - Doctor output must remain bounded and must not include command args, env values, headers, raw args, or secrets.
- `.trellis/spec/backend/quality-guidelines.md`
  - Doctor is provider-free and must not require API keys.
  - MCP config load failure is a failed diagnostic and should not start servers.
  - Secret-like values must not be printed.

## Implementation Direction

- Reuse the existing MCP client/adapter/provider foundation.
- Add bounded redaction centrally in MCP diagnostics.
- Add provider-free MCP management service plus CLI handler.
- Add explicit MCP tool medium risk and origin metadata.
- Truncate MCP result summaries and raw text payloads before they enter `ToolResult`.
- Extend tests and smoke around disabled/failure/redaction/CLI behavior.
