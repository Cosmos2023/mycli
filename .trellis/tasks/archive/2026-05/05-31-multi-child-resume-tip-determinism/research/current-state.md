# Current State: Multi-child Resume Tip Determinism

## Goal

Make root-to-tip resume deterministic when a session has multiple child branches.

## Existing Behavior

- `SQLiteSessionStore._latest_child_session_id()` orders children by:
  1. `sessions.last_active_at DESC`
  2. `sessions.updated_at DESC`
  3. `conversation_trees.session_id DESC`
- `resolve_resume_session_id(root)` follows that selected child repeatedly until a tip is reached.
- Existing tests prove a linear root -> child -> grandchild chain resolves to the grandchild, but do not lock behavior when siblings exist.

## Gap

Without regression coverage and spec text, the multi-child ordering contract can drift. That would make `/resume root` pick a different branch after future storage or query changes.

## Implementation Direction

- Add store-level tests for:
  - choosing the child with newest `last_active_at`
  - using `updated_at` as tie-breaker
  - using `session_id DESC` as final stable tie-breaker
- Add service-level test proving `resume_conversation(root)` returns the selected tip lineage.
- Document the ordering in database guidelines.

## Risks

- This slice does not introduce a UI for choosing among multiple branches; it only makes the existing automatic tip selection stable and tested.
