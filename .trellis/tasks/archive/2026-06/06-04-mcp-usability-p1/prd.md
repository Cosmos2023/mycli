# MCP Usability P1

## Objective

Implement roadmap slice 4 from `docs/hermes-parity-roadmap.md`: make local MCP
tools reliable and diagnosable enough for normal agent use while staying within
the local agent foundation scope.

## Requirements

1. Discovery Diagnostics
   - Classify MCP server discovery failures with stable categories:
     config, server startup, timeout, protocol, schema, execution, transport.
   - Preserve bounded exception type/message for humans.
   - Redact secrets and avoid printing command args, env values, headers, raw
     tool args, raw tool output, or provider payloads.
   - Expose category in doctor and `mycli mcp list|inspect`.

2. Manifest Stability
   - Keep stable MCP tool ids: `mcp:<server>:<tool>`.
   - Keep external manifest source as `mcp` and toolset as `external`.
   - Add bounded MCP origin metadata for server, tool, transport,
     timeout_seconds, failure semantics, and result-summary policy.
   - Do not change provider-visible schema ordering except intentional MCP tool
     schema hydration.

3. Tool Lifecycle Semantics
   - MCP tool failures return `ToolResult(success=False)` with stable
     `error_kind`, `exception_type`, bounded redacted error, server, and tool.
   - MCP tool-level `isError` results align with local tool failure semantics:
     `success=False`, bounded summary, `error_kind=mcp_tool_error`.
   - Timeout/startup/protocol errors must be distinguishable.

4. Model-Friendly Result Summary
   - Successful MCP result summaries should be concise and bounded.
   - Raw content remains bounded in raw payload/artifacts, not injected
     unbounded into model context.
   - Raw payload must include content summary metadata: counts, types, chars,
     and truncation flags.

5. Smoke and Tests
   - Unit tests cover failure classification, result summary metadata,
     manifest origin metadata, CLI/doctor category rendering, and redaction.
   - `evaluation/mcp_smoke.py` verifies success, disabled server non-start,
     broken startup category, result summary payload, manifest metadata, and
     doctor warning.

## Acceptance Criteria

- Discovery can tell whether a failed server is startup, timeout, protocol,
  schema, execution, or transport failure.
- Doctor and `mycli mcp` output show bounded failure category and redacted
  message.
- MCP contributed manifest entries expose stable MCP metadata.
- MCP tool success payload includes content summary metadata.
- MCP tool failures use stable local-tool-like error kinds.
- Provider-free MCP smoke passes.
- Roadmap completion log is updated and this Trellis task is archived.

## Out of Scope

- ACP, remote agents, hosted MCP auth/OAuth, remote marketplace, SSE management,
  browser/computer-use, cron, packaging, enterprise policy.
- Copying Hermes-agent code.
