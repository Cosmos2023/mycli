## Why

The session database currently duplicates searchable transcript text in FTS content tables and retains legacy rollout/state snapshots after they stop participating in resume or crash recovery. Long, tool-heavy conversations therefore consume substantially more disk than the canonical transcript requires, even though recent runtime changes have already bounded read-time memory.

## What Changes

- Add a storage schema migration that replaces the conversation search index with an external-content FTS projection and removes the unused history-item FTS projection.
- Add dry-run storage-optimization reporting for legacy rollout event payloads and terminal continuation state that can be removed without changing the canonical transcript.
- Add an explicit maintenance action that compacts eligible legacy rollout rows and deletes only provably inactive legacy state.
- Preserve canonical conversation messages, history items, compact boundaries, summaries, active approval/clarification continuations, provider input assembly, and search behavior.
- Extend storage diagnostics and tests to prove transcript/search equivalence, migration retry safety, and active-recovery preservation.

## Capabilities

### New Capabilities
- `session-storage-compaction`: Space-efficient transcript search indexing and explicit, recovery-safe cleanup of obsolete session runtime payloads.

### Modified Capabilities

None.

## Impact

- Affects the SQLite schema and migration path in `backend/packages/storage`.
- Extends the existing session-maintenance store contract and `/session maintenance` command surface.
- Updates storage doctor expectations for the new FTS layout.
- Requires migration, search-equivalence, recovery-state, maintenance, and database-size regression tests.
- Introduces no new third-party dependency and does not change provider request or transcript APIs.
