# Node TUI Local Help Overlay

## Background

The Node TUI now has contextual input hints, approval and clarification flows,
tool lifecycle rendering, error diagnostics, and an overlay component. However,
`/help` is still not a Node-local command, so users cannot reliably discover
TUI-specific keys and local commands without involving the Python gateway.

Hermes-like TUI maturity favors an always-available local help surface for
keyboard actions and local UI commands.

## Goals

- Make `/help` a Node-local command.
- Render help through the existing overlay surface.
- List the primary TUI actions: send, slash commands, interrupt, approval
  numbers, clarification replies, completion popup navigation, view/theme/clear
  commands.
- Keep the help content static, bounded, and local to the TUI.
- Preserve existing Python gateway slash command routing for non-local
  commands.

## Non-Goals

- Do not add a searchable command palette.
- Do not add new keybindings.
- Do not change runtime/gateway protocols.
- Do not add mouse support.
- Do not copy Hermes code.

## Acceptance Criteria

- `/help` is recognized by `isLocalCommand`.
- `handleLocalCommand("/help", state)` returns a command result that opens an
  overlay titled `/help`.
- Help output includes the key actions and local commands.
- Non-local slash commands such as `/usage` still route to the gateway.
- Node typecheck and tests pass.

## Verification

- `npm --prefix tui/node run typecheck`
- `npm --prefix tui/node test`
- `git diff --check`
