# Runtime Contract Schema Convergence

## Problem

The integration branch has a Hermes-like runtime event contract, but discovery
and typed client surfaces can drift. Python gateway constants, extension
manifest output, TypeScript event types, reducer handling, and Trellis spec must
agree on the same RPC methods and event streams.

## Scope

This slice covers runtime contract discovery and schema alignment only. It does
not productize ACP, MCP, skills, or subagents.

## Requirements

- Python gateway supported event streams include every gateway event emitted as
  a stable integration stream, including `runtime.event` and `session.changed`.
- Extension manifest RPC methods and event streams are generated from gateway
  supported constants, not hand-maintained partial lists.
- Manifest tests assert equality with gateway constants for RPC/event names.
- TypeScript gateway event types include `session.changed`.
- Runtime contract spec documents `session.changed` and the manifest equality
  rule.
- Existing human slash command output count tests are updated to the new manifest
  surface.

## Acceptance Criteria

- `ExtensionManifestService().manifest()["rpc_methods"]` names exactly match
  `supported_rpc_methods()`.
- `ExtensionManifestService().manifest()["event_streams"]` names exactly match
  `supported_event_streams()`.
- TypeScript `KnownGatewayEventMethod` includes `session.changed`.
- Tests pass:
  - `uv run pytest tests/unit/services/test_extension_manifest.py tests/unit/cli/node_tui/test_gateway.py tests/unit/cli/test_main.py -q`
  - `npm --prefix tui/node test`
  - `npm --prefix tui/node run typecheck`

## Non-goals

- No new runtime transport.
- No ACP server implementation.
- No MCP/skills/subagent productization.
- No main merge.
