# Doctor Recovery Payload Shape Current State

## Current Behavior

- `mycli doctor` opens `sessions.db` read-only and validates required tables,
  schema version, search objects, lineage integrity, orphan child rows, and
  recovery-state JSON for `pending_decision`, `suspended_turn`, `turn_record`,
  and `responses_continuation_state`.
- Doctor already flags:
  - invalid JSON / non-object recovery state payloads
  - suspended-turn `conversation` values that are not lists
  - missing `tool_call` objects in top-level `pending_decision` or nested
    suspended-turn pending approval/clarification objects
  - pending approval / clarification states that lack resumable user-message
    evidence

## Gap

The recovery payload shape validation is still shallow for fields that runtime
resume and TUI recovery need:

- Top-level `pending_decision` can omit `kind`, `preview`, or `options` without
  being reported by doctor.
- Nested suspended-turn `pending_approval` can omit `reason` or `preview`
  without being reported.
- Nested suspended-turn `pending_clarification` can omit `request_id` or
  `question` without being reported, even though TUI recovery requires a stable
  `request_id` to respond after resume.
- Nested `tool_call` can exist but miss `name`, `arguments`, or `reason`.

## Proposed Slice

- Extend doctor recovery-state shape validation to check required scalar/list
  fields for pending decisions, pending approvals, pending clarifications, and
  nested tool calls.
- Keep diagnostics bounded and secret-safe: report only
  `session_id:state_key <field> missing/not object/not list`.
- Add focused doctor tests for malformed pending decision and malformed pending
  clarification payloads that currently slip through.
- Keep doctor read-only; do not repair state.
