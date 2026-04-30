# Runtime V2 Phase 5c Compact Volatile State Plan

## Goal

Reduce cache-hostile churn in late volatile context by rendering runtime policy and plan state as compact deterministic status instead of long replay-like natural language blocks.

## Scope

- Render runtime policy state in sorted key order on one compact line.
- Preserve runtime reminders, but keep them after the compact state block.
- Render plan state as counts plus current and next actionable items.
- Omit completed plan item text from volatile context.

## Non-Goals

- Do not change plan persistence.
- Do not remove runtime reminders.
- Do not change provider clients or tool execution behavior.

## Acceptance Criteria

- `volatile:plan` no longer includes completed plan item text.
- Plan context still exposes completed/pending/in-progress counts and active work.
- `volatile:runtime_policy` is deterministic regardless of runtime policy dict insertion order.
- Existing prompt dynamic guidance still reads runtime policy metadata.
