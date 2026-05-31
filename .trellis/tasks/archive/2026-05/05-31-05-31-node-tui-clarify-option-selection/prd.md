# Node TUI Clarify Option Selection

## Background

The runtime and gateway now support a Hermes-like `clarify.request` /
`clarify.respond` loop. The Node TUI renders clarification rows and sends
plain input as `clarify.respond` while a clarification is pending.

This slice improves the TUI consumption layer for option-based clarification
requests. It should make numbered choices ergonomic without changing the
runtime protocol or conflating clarification with approval.

## Goals

- Render option-based clarifications as explicit numbered choices.
- Let users answer a pending clarification by typing the option number.
- Let users answer with an exact option label and normalize it to the label.
- Preserve free-form text fallback for open-ended clarification requests.
- Keep slash commands routed as commands while clarification is pending.
- Keep approval and clarification state/actions separate.

## Non-Goals

- Do not add `clarify.respond` protocol changes.
- Do not add a full multi-select editor in this slice.
- Do not change Python runtime behavior.
- Do not copy Hermes source code.

## Acceptance Criteria

- Given a pending clarification with options `Runtime` and `TUI`, typing `1`
  sends `clarify.respond` with response `Runtime`.
- Typing `tui` or `TUI` sends response `TUI`.
- Typing arbitrary non-option text sends that text unchanged.
- `/help` and other slash commands still route through command handling.
- Clarification row output includes a concise input hint for numbered choices.
- Node TUI tests and typecheck pass.

## Verification

- `npm --prefix tui/node run typecheck`
- `npm --prefix tui/node test`
- `git diff --check`
