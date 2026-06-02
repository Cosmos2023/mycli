# MCP Tool Lifecycle Foundation

## Problem

`mycli` already has early MCP client, adapter, and provider code, but MCP tools
are not yet a verifiable product foundation. A local MCP server can be described
in config and converted into contributed tools, but discovery diagnostics,
doctor reporting, extension manifest source attribution, deterministic smoke
coverage, and runtime-call evidence are incomplete.

## Goal

Build the minimum Hermes-like MCP tool lifecycle foundation without copying
Hermes code and without productizing the wider MCP ecosystem.

This slice must prove that `mycli` can safely discover, register, diagnose, and
call one local stdio MCP tool through the existing contributed-tool path.

## Scope

- Load local stdio MCP server config from `.mycli/mcp_servers.toml`.
- Discover enabled MCP tools with bounded timeout/failure diagnostics.
- Convert MCP tool schema into `ToolContributionRegistration`.
- Surface MCP-origin tools in the combined tool manifest and toolset manifest.
- Report MCP config/discovery health from doctor without leaking command args,
  env values, headers, raw tool arguments, or secrets.
- Add deterministic MCP smoke coverage for discovery, call, manifest, and
  doctor.
- Update MCP/tool manifest docs with completed scope and remaining gaps.

## Non-goals

- OAuth, SSE, hosted MCP, plugin marketplace, ACP, skills productization, and
  subagent/multi-agent productization.
- Copying Hermes-agent code.
- Merging to `main`.

## Acceptance Criteria

- Unit tests cover MCP diagnostics success, disabled config, discovery failure,
  doctor output, and manifest source attribution.
- `uv run python evaluation/mcp_smoke.py` passes and writes a bounded JSON
  report under `evaluation/runs/`.
- `uv run mycli doctor` reports MCP diagnostics.
- `uv run pytest tests/unit tests/integration -q` passes.
- `uv run python evaluation/tool_smoke.py` still passes.
- Docs describe the MCP foundation scope and remaining Hermes gaps.
