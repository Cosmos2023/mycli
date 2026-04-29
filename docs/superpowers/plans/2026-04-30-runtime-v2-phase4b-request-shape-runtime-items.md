# Runtime V2 Phase 4b RequestShape RuntimeItem Payload Plan

## Goal

Make structured `RuntimeItem` payloads come from `RequestShape` so Responses/Anthropic-style adapters also receive cache-first request ordering while preserving tool-call and tool-result blocks.

## Scope

- Extend `RequestShape` with block-aware provider runtime item shapes.
- Teach `RequestShapeBuilder` to build runtime items in the same cache-first order as provider messages.
- Add a formatter from request-shape runtime items to `RuntimeItem`.
- Update runtime block path to use request-shape runtime items instead of constructing from `InstructionContract` directly.

## Non-Goals

- Do not change provider SDK clients directly.
- Do not alter tool execution semantics.
- Do not redesign memory retrieval in this phase.

## Acceptance Criteria

- Block path order is stable system, developer guidance, replay transcript, current user request, volatile context.
- Assistant tool-call blocks and tool-result blocks survive request-shape formatting.
- Current user request is not duplicated in replay.
