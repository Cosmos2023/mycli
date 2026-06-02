# Current MCP Foundation Research

## Existing Code

- `src/mycli/services/mcp/client.py` provides MCP server config loading,
  JSON-RPC client calls, stdio/http transports, tool listing, tool calls, and
  resource access.
- `src/mycli/services/mcp/tool_adapter.py` converts MCP tool descriptors into
  `ToolContributionRegistration` route names such as `mcp.<server>.<tool>`.
- `src/mycli/services/mcp/provider.py` supplies MCP tools through the runtime
  contributed-tool provider path.
- `src/mycli/cli/bootstrap.py` builds MCP clients from workspace config and
  passes them into runtime contributed-tool providers.
- `src/mycli/services/diagnostics/doctor.py` currently checks only MCP config
  count and enabled count.

## Gap For This Slice

- Add a bounded discovery diagnostic service around existing clients.
- Keep doctor output safe: server names, transport kind, enabled/disabled
  counts, tool counts, and bounded error kind/message only.
- Mark MCP-origin registrations as `source=mcp` in the combined manifest while
  preserving generic provider-contributed tools as `source=provider`.
- Add deterministic stdio MCP smoke rather than depending on a real external
  MCP server.

## Safety Notes

- Discovery must not print command args or env values.
- Stdio clients should expose a close path so discovery/smoke can terminate
  local test servers.
- Doctor should warn on discovery failures but fail on invalid config parsing.
