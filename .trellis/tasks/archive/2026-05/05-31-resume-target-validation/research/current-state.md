# Current State: Resume Target Validation

## Goal

Make session resume behavior explicit when the requested session id does not exist, while preserving recovery for legacy sessions that have messages but no `conversation_trees` metadata.

## Existing Behavior

- `SQLiteSessionStore.resolve_resume_session_id(session_id)` follows child links to the latest descendant tip.
- If the requested session id has no children, the method currently returns the requested id without checking whether a `sessions` row, `conversation_trees` row, or `conversation_messages` rows exist.
- `SessionService.resume_conversation(session_id)` then builds a `Conversation` for the resolved id and appends lineage rows. For a missing id, this can produce an empty conversation that looks like a valid resume.
- Legacy DBs can legitimately contain `sessions` and `conversation_messages` rows without `conversation_trees` metadata. Those must keep working.

## Gap

Missing resume targets should fail as corrupted/missing state instead of silently creating a new empty conversation. Silent empty resumes make it hard to distinguish "session exists but has no messages" from "user requested the wrong id".

## Implementation Direction

- Add store tests for missing resume target and legacy message-only session resume.
- Add session service tests for the same behavior at the public service boundary.
- Implement target existence validation in `SQLiteSessionStore._resolve_resume_session_id()`.
- Treat any of these as existence evidence:
  - row in `sessions`
  - row in `conversation_trees`
  - one or more rows in `conversation_messages`
- Do not change destructive cleanup or repair behavior.

## Risks

- Empty sessions saved through current store code have a `sessions` row and should still be resumable.
- Completely missing ids should fail consistently before lineage composition.
