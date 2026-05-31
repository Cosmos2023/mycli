# Node TUI Resume Status Snapshot Parity

## Problem

After `session.resume`, the gateway emits `session.changed` but does not emit a
fresh status snapshot for the newly active session. Node TUI state can therefore
keep stale `pendingApproval` or `pendingClarification` from the previously
active session.

This weakens session/state parity because waiting approval, waiting
clarification, and suspended turn indicators are not guaranteed to be bound to
the current resolved session tip after resume.

## Scope

In scope:

- Gateway `session.resume` notification ordering.
- Node reducer `status.changed` pending-state cleanup.
- Python gateway and Node reducer tests.
- Contract spec update for the resume/status snapshot behavior.

Out of scope:

- Changing session lineage resolution.
- Changing runtime approval or clarification semantics.
- Productizing MCP/skills/subagent/ACP.
- Adding new UI surfaces.

## Requirements

- `session.resume` must emit `session.changed` for the resolved active session.
- `session.resume` must then emit `status.changed` for that same active session.
- The emitted `status.changed` payload must include `pending_decision` and
  `suspended_turn` booleans for the active session.
- Node reducer must clear stale `pendingApproval` when
  `status.changed.pending_decision === false`.
- Node reducer must clear stale `pendingClarification` when
  `status.changed.suspended_turn === false`.
- Existing pending state must remain when the status snapshot does not
  explicitly say the relevant pending state is false.

## Acceptance Criteria

- Gateway unit test proves `session.resume` emits `session.changed` followed by
  `status.changed` with the active session id and false pending flags.
- Reducer unit test proves `status.changed` clears stale approval and
  clarification state.
- Focused Python and Node tests pass.
- Node TUI `npm run typecheck` passes.
