# Current State

## Existing Behavior

- `approval.respond` resolution paths append local `approval_resolution` trace
  rows and workspace log entries for success and failure states.
- `clarify.respond` resolution paths clear/resume suspended turns on success,
  and return assistant messages for failure states such as blank response, no
  pending clarification, or mismatched `request_id`.
- Gateway and Node TUI already expose `clarify.request` / `clarify.respond`
  events, and doctor can inspect suspended clarification recovery rows.
- There is no local trace/log diagnostic equivalent to `approval_resolution`
  for clarification responses.
- Doctor does not summarize clarification response diagnostics.

## Gap

Hermes-like local agent foundations should make waiting-input state machines
diagnosable. Clarification failures can currently be visible to the user, but
they are not captured as local trace/log diagnostics, so post-mortem doctor
output cannot explain repeated no-pending or mismatched clarification
responses.

## Chosen Slice

Add `clarification_resolution` local diagnostics with bounded payload fields,
then summarize those rows in doctor. This mirrors the approval diagnostics
pattern without changing gateway events, provider transcript shape, or
clarification state behavior.
