# Runtime V2 Phase 5d Cache-First Finalization Plan

## Goal

Close the remaining high-impact cache drift paths by making tool visibility, reasoning replay, dynamic tool metadata, and session memory align with the cache-first request shape contract.

## Scope

- Keep model-visible tool names authoritative in native tool schema, not duplicated in developer text.
- Exclude reasoning-only content from natural language summaries and textual replay fragments.
- Preserve structured reasoning blocks for provider runtime item replay.
- Stop auto-injecting recent session summaries as runtime memory.
- Sort dynamic tool text and metadata deterministically.

## Non-Goals

- Do not remove persisted session summaries.
- Do not remove provider-specific reasoning metadata.
- Do not change execution safety or approval behavior.
- Do not replace provider SDK clients.

## Acceptance Criteria

- Developer provider payload remains stable when only duplicated tool-list text changes.
- Reasoning-only blocks do not appear in conversation summary or textual replay.
- Runtime memory collection does not automatically include recent assistant summaries.
- Dynamic tool context order is deterministic.
