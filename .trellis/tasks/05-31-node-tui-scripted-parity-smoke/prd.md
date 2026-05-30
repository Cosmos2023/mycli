# Node TUI Scripted Parity Smoke

## Problem

Recent runtime/TUI slices added Hermes-like typed stream events, completion
metadata handling, request-error display, contextual hints, theme commands, and
the local `/help` overlay. The current real Node scripted-client integration
only submits one user message, so it does not prove those local TUI command
paths can coexist with a real gateway turn in one end-to-end smoke run.

## Goal

Add a focused smoke test that runs the real Node scripted client through the
Python gateway and verifies a realistic sequence:

1. Open local `/help` without sending `command.run` to the gateway.
2. Change the local theme with `/theme mono`.
3. Submit a normal user turn through the gateway.
4. Consume typed reasoning/text/completion stream events without duplicate
   assistant text or reasoning leakage.
5. Write and assert the final scripted-client reducer state dump.

## Non-Goals

- Do not add a new runtime event type.
- Do not change production persistence or session storage.
- Do not make `message.complete` authoritative for final assistant text.
- Do not copy Hermes code; use Hermes only as the semantic target for
  contract parity.

## Acceptance Criteria

- `tests/integration/test_node_tui_gateway.py` exercises one real Node scripted
  client run with local `/help`, local `/theme mono`, and a gateway-backed
  `hello` turn.
- The fake gateway service receives only the normal user message, proving local
  commands are consumed locally.
- The dumped reducer state proves:
  - `/help` opened the overlay with key guidance lines.
  - `themeName` is `mono` and the transcript contains the theme-change notice.
  - The final visible assistant answer is exactly `hello final`.
  - Reasoning text is not appended to the assistant answer.
  - Typed and legacy deltas do not duplicate answer text.
- Targeted Python and Node checks pass, or any missing dependency limitation is
  documented with a remediation path.

## Risks

- Node dependency installation can be unreliable in fresh worktrees. If the
  worktree lacks `tui/node/node_modules`, verification may need to reuse an
  existing already-installed worktree dependency directory temporarily, then
  remove it before commit.
- The scripted smoke should stay focused; reducer-specific edge cases remain in
  Node unit tests.
