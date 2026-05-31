# Stable Approval Decision IDs

## Current behavior

- `NodeTuiGateway._approval_request_payload()` emits
  `decision_id="decision_current"` for every approval request.
- `_handle_approval_response()` only accepts `decision_current`.
- This is compatible with older clients, but it is not a stable approval
  identity. If a client stores an approval prompt, reconnects, or external
  consumers observe multiple requests over time, the payload does not identify
  which tool call the response belongs to.

## Gap

Hermes-like approval contracts need a stable request identity. The runtime
already has the useful identity: `PendingDecision.tool_call.call_id`. The
gateway should expose that identity when present and keep `decision_current` as
an alias for existing clients.

## Target

- `approval.request.decision_id` is the pending tool call id when available.
- `approval.respond.decision_id` accepts either the active stable id or the
  compatibility alias `decision_current`.
- Wrong/stale ids still return `decision_not_pending`.
- No session DB schema change is needed for this slice because pending decision
  already persists the tool call.
