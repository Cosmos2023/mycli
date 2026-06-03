# MCP Usability P1 Research

## Roadmap Source

`docs/hermes-parity-roadmap.md` slice 4 requires local MCP tools to move from
P0 smokeable to reliable and diagnosable enough for normal agent use.

## Current Implementation

- `McpClient` supports local stdio and HTTP JSON-RPC transports, config loading
  from `.mycli/mcp_servers.toml`, `tools/list`, `tools/call`,
  `resources/list`, and `resources/read`.
- `McpToolAdapter` converts MCP tools into contributed runtime tools.
- MCP tools already show as `source=mcp` and `toolset=external` in combined
  manifests through `ToolRegistry` source inference.
- `discover_configured_mcp_servers()` reports per-server status, tool counts,
  failure kind/message, disabled servers, and redacts obvious secrets.
- `DoctorService._check_mcp()` reports aggregate configured/enabled/tools and
  a compact detail string.
- `mycli mcp list|inspect` exposes provider-free management output.
- `evaluation/mcp_smoke.py` covers config loading, disabled server non-start,
  discovery failure redaction, manifest exposure, doctor warning, and a real
  stdio fake server call.

## Gaps

- Failure kind is currently the Python exception class, not an actionable MCP
  taxonomy. Users cannot reliably distinguish config, server startup, timeout,
  JSON-RPC error, schema, and execution failures.
- MCP tool result payloads contain raw bounded content but do not expose a
  model-friendly summary structure with content counts/types/truncation.
- Manifest origin metadata is present but minimal; it does not expose transport,
  failure semantics, timeout seconds, or summary policy.
- Discovery safe summaries are compact but not enough for P1 doctor/CLI
  diagnosis.
- Tool failure payloads do not align with local tool lifecycle conventions such
  as stable `error_kind`, bounded `error`, and diagnostic-only raw payload.

## Proposed Design

Introduce a small MCP diagnostics taxonomy in `services/mcp/diagnostics.py`:

- `config_error`
- `server_startup`
- `timeout`
- `protocol_error`
- `schema_error`
- `execution_error`
- `transport_error`

Use it for discovery diagnostics and tool execution payloads while preserving
the exception class as `exception_type` for debugging.

Improve MCP tool results:

- Summary begins with a concise MCP envelope:
  `MCP <server>.<tool> ok/error: <bounded text>`
- Raw payload includes:
  - `server`, `tool`
  - `status`
  - `error_kind` and `exception_type` on failure
  - `content_summary`: item count, content types, text/json counts,
    summary chars, raw truncation flag
  - bounded `content`
- Raw server output remains in bounded payload only; model-visible summary stays
  compact.

Improve contributed manifest metadata:

- Keep `tool_id=mcp:<server>:<tool>` stable.
- Add bounded origin metadata: `server`, `tool`, `transport`,
  `timeout_seconds`, `failure_semantics`, `result_summary_policy`,
  `risk_level`, `approval_policy`.

Improve diagnostics visibility:

- `McpServerDiagnostic` exposes `failure_category` in addition to
  `failure_kind`.
- `safe_summary()` and management rows include the category.
- Doctor details remain bounded and redacted.
- Provider-free smoke asserts categories, summary payload, manifest metadata,
  disabled server behavior, and doctor output.

## Non-Goals

- No ACP or remote-agent productization.
- No hosted MCP auth, OAuth, SSE management UI, or marketplace.
- No raw MCP output injection into stable context.
- No new dependencies.
