# Approval Resume History Normalization Design

## Problem

When a suspended turn resumes after shell approval, `TurnExecutor` restores the
saved conversation and also appends the suspended user message as a new history
item. Each approval therefore persists another copy of the original user
message. The live TUI does not receive that duplicate as a user event, but a
later `transcript.load` projects every persisted item and renders the copies.

The same duplicated history also reaches readable session snapshots and model
context replay.

## Design

### Future writes

Approval continuation remains a new runtime turn for tracing and lifecycle
events, but it does not represent a new user submission. Remove the synthetic
`USER_MESSAGE` append from `resolve_pending_approval`. The continuation keeps
its `APPROVAL_RESOLUTION`, tool lifecycle, model output, and final turn status.
The restored conversation already contains the original user message.

### Legacy history

Keep canonical stored history immutable. Add one normalization function for
history replay that suppresses only legacy synthetic user items matching all of
these conditions:

- the item is an unqueued `USER_MESSAGE`;
- an `APPROVAL_RESOLUTION` appeared earlier in the same turn;
- both items have the same `turn_id`.

The rule does not compare message text. Independent repeated questions remain
visible, and queued steering or follow-up messages remain visible because they
carry `metadata.queued = true`.

Apply normalization before:

- Node TUI `transcript.load` projection;
- readable `session.json` snapshot projection;
- model conversation reconstruction from history.

This repairs existing sessions without rewriting SQLite audit history.

## Pagination

Normalize the complete history sequence before applying `before` and `limit`.
This preserves stable visible pagination and prevents a legacy duplicate from
consuming a transcript page slot.

## Tests

Add regression coverage proving that:

- approval resume persists one original user message across multiple approvals;
- legacy approval-resume duplicates are hidden from TUI transcript loading;
- snapshot projection omits the same legacy duplicates;
- model context replay omits the same legacy duplicates;
- identical messages from independent turns remain present;
- queued user messages in an approval continuation remain present.

Run focused application, projection, gateway, and context tests, followed by the
full Python and TUI verification suites.
