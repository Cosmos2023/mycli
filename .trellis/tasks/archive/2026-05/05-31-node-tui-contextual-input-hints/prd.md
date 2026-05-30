# Node TUI Contextual Input Hints

## Background

The Node TUI now consumes Hermes-like runtime events for running status,
approval, clarification, tool lifecycle, request errors, and message streams.
The bottom input area still renders only prompt, draft, and dense status
metadata. Users can submit messages, interrupt turns, choose approval options,
and answer clarification prompts, but the input area does not expose those
context-sensitive actions.

Terminal UI maturity requires discoverability without adding noisy docs to the
main transcript. A compact hint line in the input area is the right local
surface because it changes with the current interaction mode.

## Goals

- Add a compact contextual hint line to `InputBox`.
- Show different hints for normal input, running turns, pending approval,
  pending clarification, and completion popup mode.
- Keep existing status metadata visible.
- Keep hints short enough to fit narrow terminals via existing truncation.
- Avoid changing runtime/gateway semantics or input routing.

## Non-Goals

- Do not add a full help overlay or command palette in this slice.
- Do not change keybindings.
- Do not change approval or clarification protocols.
- Do not add mouse support.
- Do not copy Hermes code.

## Acceptance Criteria

- Normal input shows a short message/command hint.
- Running turns show an interrupt hint.
- Pending approval shows a number-selection hint.
- Pending clarification shows a reply/command hint.
- Completion popup mode shows navigation/accept/cancel hints.
- Status metadata remains rendered below the input prompt.
- Node typecheck and tests pass.

## Verification

- `npm --prefix tui/node run typecheck`
- `npm --prefix tui/node test`
- `git diff --check`
