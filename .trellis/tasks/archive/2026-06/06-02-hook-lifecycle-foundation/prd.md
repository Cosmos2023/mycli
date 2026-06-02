# Hook Lifecycle Foundation

## Research

Hermes-agent exposes hooks across tool, LLM/API, approval, gateway, and session
lifecycle through plugins and shell hooks. mycli currently has an internal
in-memory `HookManager` with pre/post tool hooks and compaction/session points,
but no user-visible inspection, doctor check, or trace evidence of hook
decisions.

This slice intentionally avoids external shell/plugin hooks. It makes the
existing internal hook lifecycle discoverable, diagnosable, and visible in safe
runtime diagnostics so later plugin/productization work can reuse the same
execution path.

## Requirements

- `HookManager` exposes bounded registration metadata and recent execution
  status.
- Tool execution records safe hook summaries in `tool_execution` trace payloads.
- `/hooks` renders registered hooks with hook point, callback name, enabled
  state, call count, last status, and last action.
- `doctor` includes a hooks check.
- Deny and modify behavior remains backward compatible.
- Diagnostics never print raw tool arguments, command strings, file contents,
  headers, or secret-like values.

## Acceptance

- Unit tests cover hook allow, deny, modify, exception diagnostics, snapshot
  output, and slash-command rendering.
- Tool execution tests prove hook summaries are present in trace payloads for
  allow/deny/error paths.
- Doctor tests prove hooks status is surfaced.
- A deterministic provider-free smoke verifies slash and doctor hook output.
- `ruff`, `mypy`, focused tests, and hook smoke pass.
