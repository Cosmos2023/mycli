## Why

The Node runtime persists exact provider requests, but it rebuilds active context into a new position on every user turn. That reordering breaks the append-only wire prefix used by automatic provider prompt caches and causes avoidable continuation resets even when the underlying instructions and conversation are unchanged.

## What Changes

- Add a durable provider-input timeline that records ordered context updates, context tombstones, conversation items, and explicit window boundaries.
- Project each provider request by extending the current timeline instead of reinserting effective context into reconstructed conversation history.
- Separate stable provider configuration, bootstrap-prefix, complete-timeline, and adjacent-request common-prefix diagnostics.
- Keep dynamic developer context chronological while preserving provider-specific role compatibility, including DeepSeek system-role fallback.
- Treat compaction, rollback, fork, and incompatible legacy replay as explicit new-window boundaries without rewriting prior records.
- Add structural cache-stability tests across Responses, Chat Completions, Anthropic Messages, tool loops, resume, and compaction.

## Capabilities

### New Capabilities

- `provider-input-timeline-stability`: Defines append-only provider-input ordering, context diff placement, stable request compatibility, window boundaries, reconstruction, and cache-prefix diagnostics.

### Modified Capabilities

None.

## Impact

- Affects `@mycli/core` model-input contracts and request projection.
- Adds an additive SQLite schema migration and storage reconstruction APIs in `@mycli/storage`.
- Replaces turn-by-turn context reinsertion in `@mycli/runtime` with timeline projection.
- Adjusts provider request serialization for chronological dynamic developer context without changing public CLI commands.
- Existing sessions remain readable and receive an append-only compatibility window on their first migrated request.
