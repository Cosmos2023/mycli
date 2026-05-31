# Extension Manifest Foundation Capability Truth

## Problem

The extension manifest is a machine-readable contract for external clients. It
currently marks MCP tools, skills, and subagents as `available`, while the
active Hermes-like foundation goal explicitly excludes MCP, skills,
subagent/multi-agent, and ACP productization.

This makes the manifest too optimistic and risks clients depending on surfaces
that are not yet stable product capabilities.

## Scope

In scope:

- Update `ExtensionManifestService.manifest()` capability statuses so it only
  claims stable foundation surfaces as `available`.
- Keep gateway RPC and event stream discovery unchanged.
- Update unit tests for manifest capability statuses.
- Keep slash command / extension inspection output coherent if it lists these
  capabilities.

Out of scope:

- Productizing MCP, skills, subagents, multi-agent, or ACP.
- Removing existing internal code for skills/subagents.
- Changing Node TUI protocol payloads.
- Adding new dependencies.

## Requirements

- `runtime.trace.export`, `runtime.tui_gateway`, `approvals`, and `sessions`
  remain `available`.
- `extensions.lifecycle` and `acp.server` remain `not_available`.
- `mcp.tools`, `skills`, and `subagents` must not be reported as `available`
  until productized.
- The non-productized status must be machine-readable and documented by tests.
- Descriptions must make clear that the surfaces are foundation/internal or not
  stable external capabilities yet.

## Acceptance Criteria

- `tests/unit/services/test_extension_manifest.py` proves stable foundation
  capabilities are available and out-of-scope capabilities are not available.
- Existing manifest event stream and RPC method tests still pass.
- `uv run pytest tests/unit/services/test_extension_manifest.py -q` passes.
- `uv run ruff check src/mycli/services/extensions/manifest.py tests/unit/services/test_extension_manifest.py` passes.
- Trellis task is archived and committed.
