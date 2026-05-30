# Runtime Clarify Request Contract

## Goal

Add the first Hermes-like `clarify.request` runtime-to-TUI contract so mycli can
surface structured user clarification requests as typed events instead of
hiding them inside generic tool-result output.

## Context

- Hermes-like gateway parity needs distinct channels for approval, status,
  tool lifecycle, messages, reasoning, terminal turn state, and clarification.
- mycli already has an `AskUserQuestion` tool that produces a structured
  question payload, but the runtime currently records it as an ordinary tool
  result.
- The Node gateway already converts `RuntimeStreamEvent` values into direct
  method-name notifications and `runtime.event` envelope mirrors.

## Research References

- [`research/runtime-clarify-request-contract.md`](research/runtime-clarify-request-contract.md)
  records the current gap, recommended slice, payload shape, and risks.

## Requirements

- When `AskUserQuestion` succeeds with
  `raw_payload.status == "awaiting_user_response"`, emit a
  `RuntimeStreamEvent(kind="clarify_request")` through the existing lifecycle
  sink.
- The event metadata must be normalized and bounded:
  - `request_id`
  - `tool_id`
  - `call_id`
  - `tool_name`
  - `question`
  - `options`
  - optional `header`
  - `multi_select`
- `NodeTuiGateway` must translate `RuntimeStreamEvent(kind="clarify_request")`
  into a `clarify.request` notification with `client_turn_id` injected.
- `clarify.request` must also be mirrored through the existing `runtime.event`
  envelope path.
- Add Node TypeScript protocol payload typing for `clarify.request`.
- Preserve normal tool lifecycle behavior and ordinary tool-result recording.
- Do not implement `clarify.respond`, TUI rendering, runtime suspension, or
  session persistence in this slice.
- Do not merge into `main`.

## Non-Goals

- No Python/Node interactive clarify response loop.
- No reducer display or input handling for clarify prompts.
- No transport migration to Hermes' exact envelope shape.
- No copying Hermes source code.

## Acceptance Criteria

- Tool execution unit tests prove `AskUserQuestion` emits
  `tool.start`, `tool.progress`, `tool.complete`, and then
  `clarify_request` without changing normal `TOOL_RESULT` recording.
- Gateway unit tests prove `clarify_request` becomes direct
  `clarify.request` plus a `runtime.event` mirror.
- Node type tests prove `GatewayClient.waitForEvent("clarify.request", ...)`
  narrows the payload.
- Python focused tests pass.
- Node typecheck and focused protocol/client tests pass.
- Trellis task is archived and work is committed only on
  `feature/mycli-runtime-clarify-request-contract`.
