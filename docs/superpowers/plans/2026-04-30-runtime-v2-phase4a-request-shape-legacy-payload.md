# Runtime V2 Phase 4a RequestShape Legacy Payload Plan

## Goal

Use `RequestShape` as the source for legacy `ModelMessage` payload construction so chat-completions style providers begin receiving the cache-first ordering designed in Runtime v2.

## Scope

- Add a formatter from `RequestShape.provider_messages` to legacy `ModelMessage`.
- Update the runtime legacy path to build `legacy_messages` from the same `RequestShape` that is traced.
- Keep `RuntimeItem`/block path on the existing structured contract path for now because provider replay blocks must preserve tool calls and tool results.
- Keep model adapter APIs unchanged.

## Non-Goals

- Do not replace Responses/Anthropic block replay in this phase.
- Do not change provider SDK clients directly.
- Do not redesign memory retrieval in this phase.

## Acceptance Criteria

- Legacy payload order is stable system, developer tool guidance, replay transcript, current user request, volatile context.
- Runtime trace and legacy payload come from the same `RequestShape` build.
- Existing structured block path tests keep passing.
