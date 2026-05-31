# Current State: Extension Manifest Capability Truth

## Finding

`ExtensionManifestService.manifest()` advertises runtime gateway discovery
surfaces through `rpc_methods`, `event_streams`, and `capabilities`.

The RPC and event stream lists are generated from the shared Python gateway
contract and are already checked against the Node TypeScript event method list.
However, the capability list currently reports:

- `mcp.tools` as `available`
- `skills` as `available`
- `subagents` as `available`

The current foundation goal explicitly excludes MCP, skills, subagent /
multi-agent, and ACP productization. Some foundation-level code exists for
skills and subagents, but external clients should not treat these as stable
Hermes-like product capabilities through the extension manifest.

## Risk

If the manifest overstates these capabilities, future TUI, extension, or ACP
clients can route against surfaces that are intentionally out of scope for the
foundation hardening goal. That weakens the runtime contract because capability
discovery becomes aspirational instead of authoritative.

## Desired State

The manifest should remain truthful for foundation surfaces:

- Keep runtime trace, TUI gateway, approvals, and sessions as `available`.
- Keep dynamic extension lifecycle and ACP server as `not_available`.
- Mark MCP tools, skills, and subagents as not productized / foundation-only,
  using a stable machine-readable status distinct from `available`.
- Unit tests should lock the statuses so future productization must update the
  contract deliberately.
