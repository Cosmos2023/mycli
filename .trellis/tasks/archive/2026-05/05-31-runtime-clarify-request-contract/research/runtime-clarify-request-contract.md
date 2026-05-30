# Runtime Clarify Request Contract Research

## Existing Behavior

- `AskUserQuestionTool` already returns a structured tool `raw_payload`:
  `question`, `options`, `header`, `multi_select`, and
  `status: "awaiting_user_response"`.
- That payload is currently recorded as an ordinary tool result by
  `ToolExecutionService`; Node TUI receives only generic tool lifecycle events.
- `NodeTuiGateway._forward_stream_event(...)` already routes
  `RuntimeStreamEvent` kinds to Hermes-like JSON-RPC notifications and mirrors
  them through `runtime.event`.
- The runtime/TUI contract spec lists approval, status, tool lifecycle, message,
  reasoning, terminal turn status, and runtime envelope channels, but does not
  yet define `clarify.request`.
- Node protocol types have a typed gateway event union, so adding a new runtime
  channel should also add a TypeScript payload type.

## Recommended Slice

- Treat `AskUserQuestion` success payloads with
  `status == "awaiting_user_response"` as the initial source of
  `clarify.request`.
- Emit a `RuntimeStreamEvent(kind="clarify_request")` from
  `ToolExecutionService` after the normal tool outcome is recorded.
- Route that stream event in `NodeTuiGateway` to a direct `clarify.request`
  notification. The existing `_emit_event` mirror then automatically emits a
  `runtime.event` envelope.
- Add the `clarify.request` payload to Node gateway protocol types.
- Keep this slice contract-only: do not implement the TUI response path,
  turn suspension, resume, or a new terminal state yet.

## Payload Shape

- `client_turn_id`: injected by `NodeTuiGateway`, as with other stream events.
- `request_id`: stable per tool call, using the tool call id when present.
- `question`: user-facing question text.
- `options`: bounded array of option objects with `label` and optional
  `description`.
- `header`: optional short label.
- `multi_select`: boolean.
- `tool_id`, `call_id`, and `tool_name`: diagnostic routing fields matching the
  tool lifecycle convention.

## Risks

- A full clarify UX requires runtime suspension and a response path, but adding
  those in the same slice would couple protocol, TUI input flow, persistence,
  and model resume behavior.
  - Mitigation: this slice publishes the event contract first; later TUI/runtime
    slices can consume it.
- Forwarding arbitrary raw tool payloads could leak oversized or unexpected
  fields.
  - Mitigation: build a normalized, bounded payload instead of forwarding
    `raw_payload` wholesale.
- Treating `clarify.request` as approval would conflate user-question UX with
  safety gating.
  - Mitigation: keep it as a separate notification channel.

## Out Of Scope

- No `clarify.respond` request method.
- No reducer or rendering changes beyond protocol types.
- No session persistence for pending clarify state.
- No Hermes implementation code copying.
