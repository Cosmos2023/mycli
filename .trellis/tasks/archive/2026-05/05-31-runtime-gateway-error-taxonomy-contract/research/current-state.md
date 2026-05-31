# Current State

## Existing Behavior

- Python advertises `gateway.error` in `SUPPORTED_GATEWAY_EVENT_STREAMS` and
  `GATEWAY_EVENT_PAYLOAD_SCHEMAS`.
- The payload schema requires `code` and `message`, but `code` is only typed as
  a generic string.
- TypeScript `GatewayErrorPayload` and `GATEWAY_EVENT_PAYLOAD_CONTRACTS` mirror
  the generic string shape.
- The Node reducer appends gateway/request errors to transcript state, but does
  not validate or document a stable code taxonomy.

## Gap

Hermes-like clients need stable machine-readable error codes to distinguish
request validation failures, no-pending approval/clarification, turn
concurrency, unknown methods, and internal gateway errors. Today those codes
exist as ad hoc strings in Python branches but are not declared in the contract
or checked against TypeScript.

## Chosen Slice

Add a gateway error-code taxonomy to the runtime contract and mirror it in
TypeScript protocol contracts:

- `internal_error`
- `invalid_params`
- `method_not_found`
- `turn_in_progress`
- `decision_not_pending`
- `clarification_not_pending`

This is a contract-hardening slice: it does not change transport shape or add a
new error UI.
