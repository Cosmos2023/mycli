# Node TUI Clarify Request Consumption

## Goal

Consume the Hermes-like `clarify.request` runtime event in the Node TUI so
structured user-clarification requests become visible, typed UI state instead
of invisible protocol traffic.

## Context

- The runtime contract slice emits `clarify.request` from `AskUserQuestion`
  results and mirrors it through `runtime.event`.
- Node TUI already consumes approval, status, tool lifecycle, message,
  reasoning, and turn status events.
- Clarification is not approval. It should have its own state and visual row
  until a later slice adds a real `clarify.respond` flow.

## Research References

- [`research/node-tui-clarify-request-consumption.md`](research/node-tui-clarify-request-consumption.md)
  records the existing reducer/transcript gap and recommended slice.

## Requirements

- Add `pendingClarification` to `ShellState`.
- Add a `clarification` transcript item type and display-model bucket.
- On `clarify.request`, store the payload in `pendingClarification` and append
  a visible transcript row with the question and options.
- `runtime.event` carrying `type: "clarify.request"` must reuse the same
  reducer path.
- The row must render distinctly from approval and must not include approval
  response instructions.
- `statusMetadata(...)` must include `clarification pending` while a
  clarification is pending.
- Terminal turn states must clear `pendingClarification`, matching approval
  cleanup behavior.
- A future-compatible `clarify.respond` event may clear `pendingClarification`
  if received, but this slice must not send that request.
- Do not merge into `main`.

## Non-Goals

- No `clarify.respond` request API or gateway method.
- No keyboard handling or form submission for clarification answers.
- No runtime suspension/resume or session persistence changes.
- No Hermes source code copying.

## Acceptance Criteria

- Reducer tests prove direct `clarify.request` stores pending state and appends
  a `clarification` transcript row.
- Reducer tests prove `runtime.event` can carry `clarify.request`.
- Display/render tests prove the row is grouped into the active turn and
  visibly shows question/options.
- Status metadata tests prove `clarification pending` appears.
- Node typecheck and focused Node tests pass.
- Trellis task is archived and work is committed only on
  `feature/mycli-node-tui-clarify-request-consumption`.
