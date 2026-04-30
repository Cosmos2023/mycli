# Runtime V2 Phase 5b Memory and Evidence Dedupe Plan

## Goal

Reduce cache-hostile volatile context duplication by keeping replay transcript as the authority for recent conversation and tool evidence, while excluding memory records already present in replay.

## Scope

- Remove memory record values that already appear in current conversation/history replay.
- Omit memory section when all memory records are duplicates.
- Sanitize volatile conversation context so replayed message lines are not repeated after `Current user request`.
- Preserve conversation summaries that are not direct replay duplicates.

## Non-Goals

- Do not redesign memory retrieval scoring.
- Do not remove tool evidence from replay transcript.
- Do not change provider SDK clients.

## Acceptance Criteria

- `retrieved_memory` does not include session summaries that exactly match replayed assistant/user/tool text.
- `volatile:conversation_context` does not repeat replayed `user:`, `assistant:`, or `tool:` lines.
- Tool evidence remains available through replay transcript.
