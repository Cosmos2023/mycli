# Current State: Session Lineage Recovery Hardening

## Goal

Harden session lineage recovery so root-to-tip resume fails early and diagnostically when persisted fork metadata cannot produce a valid transcript.

## Existing Behavior

- `SQLiteSessionStore.resolve_resume_session_id(session_id)` follows the latest active child chain to a descendant tip.
- `SQLiteSessionStore.load_conversation_lineage(session_id)` composes root-to-tip messages using `conversation_trees.parent_id` and child `fork_point`.
- `SessionService.resume_conversation(session_id)` resolves the descendant tip and loads the composed lineage.
- `mycli doctor` already checks orphan rows, missing lineage parents, lineage cycles, and fork points that exceed the child conversation's own message count.
- Integration tests already cover pending approval and pending clarification recovery after resuming a root session to a branch tip.

## Gap

For forked conversations, a child's `fork_point` is also a claim about how many messages can be taken from the parent branch. Doctor currently compares `conversation_trees.fork_point` only with the child conversation's message count. That misses a corrupted lineage where `child.fork_point` is greater than the parent's message count. Runtime resume then fails later during lineage composition with a generic invalid fork point error.

## Implementation Direction

- Add store regression coverage for a child `fork_point` greater than the parent message count.
- Improve doctor fork-point diagnostics to validate parent message availability for child branches.
- Keep doctor read-only: no repair, deletion, migration, or vacuum.
- Keep the slice inside Session / State foundation; do not add MCP, skills, subagent, or ACP behavior.

## Risks

- The store currently reports invalid lineage with one generic `ValueError`. This slice can improve test coverage and doctor diagnostics without changing the public exception type.
- More advanced lineage tie-breaking and explicit resume target selection are outside this slice.
