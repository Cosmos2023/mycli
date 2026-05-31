# Current State

## Existing Behavior

- Runtime approval choices are represented by `DecisionAction` values:
  `approve_once`, `reject`, and `allow_session`.
- The Node TUI gateway accepts `approval.respond` with a `choice` string and
  maps it through `DECISION_CHOICE_MAP`.
- Python `gateway.error` and status enums are already exposed as
  machine-readable payload schema enums, but `approval.respond.choice` remains a
  generic string in the Python runtime contract.
- TypeScript exposes `ApprovalRespondPayload.choice` as `string`, and
  `ApprovalOptionPayload.choice` allows the three known values plus arbitrary
  strings.
- The extension manifest publishes event payload schemas, so external clients
  can discover event fields, but they cannot discover the allowed approval
  choices today.

## Gap

Hermes-like clients should be able to handle approval decisions as a stable
state-machine contract. Keeping approval choices as unconstrained strings makes
TUI, extension, and future ACP clients rely on prose or ad hoc lists.

## Chosen Slice

Add a shared approval decision-choice taxonomy to the runtime contract:

- `approve_once`
- `reject`
- `allow_session`

Mirror the taxonomy in TypeScript payload types and protocol contracts, then
cover the behavior with Python and Node tests.

This slice does not change approval policy, transport shape, or UI layout.
