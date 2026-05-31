# Current State

## Existing Behavior

- The runtime contract now declares stable `gateway.error.code` values:
  `internal_error`, `invalid_params`, `method_not_found`, `turn_in_progress`,
  `decision_not_pending`, and `clarification_not_pending`.
- Unexpected request-handler exceptions emit `gateway.error` and return a
  JSON-RPC error.
- Several expected request failures return a JSON-RPC error only:
  unknown methods, invalid params, approval mismatch, no pending approval, and
  turn-in-progress during approval/clarification resolution.
- The gateway process loop emits `gateway.error` for malformed inbound messages,
  but one path still uses `invalid_request`, which is not part of the declared
  gateway error taxonomy.

## Gap

Hermes-like runtime clients need a consistent error event stream. If expected
request failures only appear in JSON-RPC responses, passive event consumers,
scripted smokes, and future extension clients cannot observe the same failure
surface. If emitted error codes drift outside the manifest enum, the contract is
internally inconsistent.

## Chosen Slice

Add a small gateway-local helper that returns JSON-RPC errors and emits matching
`gateway.error` events for request-scoped failures. Use only declared error
codes. Cover unknown method, invalid params, approval no-pending/wrong-id, and
turn-in-progress paths with tests.

This slice does not change the JSON-RPC response shape or create a new UI.
