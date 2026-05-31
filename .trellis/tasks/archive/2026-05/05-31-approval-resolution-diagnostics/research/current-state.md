# Approval Resolution Diagnostics Research

## Current State

- Approval flow already supports approve once, reject, and allow session.
- `allow_session` records `approval_allowance` trace/log events.
- Session allowance reuse records `approval_auto_allowed` trace/log events.
- Invalid choice keeps the pending decision but only returns a user-facing message.
- Duplicate/stale approval resolution after a decision is cleared returns "There is no pending decision to resolve." without trace/log evidence.
- Missing suspended turn after a pending decision returns a user-facing error without trace/log evidence.

## Gap

Hermes-like agent foundations need approval state machine diagnostics that can explain why approval resolution did not execute a tool. Current success and allow-session paths are observable, but negative resolution paths are not.

## Design Direction

Add local-only `approval_resolution` trace/log diagnostics for:

- no pending decision
- invalid choice
- allow-session requested but unavailable
- rejected
- missing suspended turn

The diagnostic payload must be bounded and must not enter provider-visible transcript or request-shape inputs.

## Relevant Specs

- `.trellis/spec/backend/runtime-tui-gateway-contract.md`
- `.trellis/spec/backend/logging-guidelines.md`
- `.trellis/spec/backend/quality-guidelines.md`
