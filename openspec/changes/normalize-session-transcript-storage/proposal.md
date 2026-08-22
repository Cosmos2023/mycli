## Why

Schema v9 removed redundant FTS content and obsolete terminal payloads, but every model-visible user, assistant, and tool item is still written into both `conversation_messages` and `history_items`, while turn lifecycle data is stored separately in `turn_rollouts`. On the current post-vacuum database those three payload sets occupy about 93 MiB, including at least 15.85 MiB of exact cross-table long-string duplication and additional duplication inside provider tool-result rows.

## What Changes

- Introduce one typed, append-only canonical transcript event log for provider-visible items, readable activity, turn lifecycle events, and compaction boundaries.
- Build provider input, `/resume`, complete readable transcript pages, local search, artifact snapshots, and approval/clarification projections from that single ordered log instead of independently persisted conversation/history/rollout payloads.
- Store full tool output, tool arguments, assistant text, images, provider continuation metadata, and display annotations once per semantic event; projections may expose different bounded views without copying the source payload.
- Replace message-count compaction boundaries with stable event/window boundaries and reconstruct provider context from only the newest valid replacement plus its surviving suffix, including sessions compacted hundreds of times.
- Add a transactional, retry-safe schema migration for supported v2-v9 databases that reconciles the legacy tables, preserves opaque malformed legacy rows without silently repairing or deleting them, proves projection equivalence, and removes the redundant tables and triggers only after the canonical log is complete. Databases containing abandoned sessions with ambiguous legacy identities remain on v9 unless the owner explicitly removes those sessions.
- Update the Python compatibility reader, storage doctor, maintenance metrics, search FTS projection, gateway transcript paths, and synthetic/fresh-v10 benchmarks for the normalized schema. Copied-real runs remain diagnostic evidence rather than a release gate when that legacy database is retired instead of migrated.
- Keep provider input ledgers, runtime recovery tables, shell output storage, blob compression, provider-ledger retention, and age/count-based session retention out of this phase.

## Capabilities

### New Capabilities

- `canonical-transcript-event-log`: A single durable session event log with deterministic provider, display, search, recovery, compaction, lineage, and legacy-migration projections.

### Modified Capabilities

None.

## Impact

- Replaces the current `conversation_messages` / `history_items` / `turn_rollouts` ownership split in `backend/packages/storage` with a new schema version and typed event contract.
- Changes storage write composition in the Node turn runtime, approval/clarification continuation paths, compaction coordinator, readable transcript projector, search, session fork/import, artifacts, doctor, and maintenance reporting.
- Requires Python read compatibility for the new schema and explicit rejection by older binaries.
- Requires migration fixtures for supported legacy schemas, malformed/opaque rows, multi-call tool batches, images, approval resume, repeated compaction, fork lineage, and interrupted migration retry.
- Requires copied-real-database dry-run evidence proving that unsupported legacy data fails closed without modifying the source. Fresh-v10 and supported-fixture benchmarks gate logical/physical size, startup/resume behavior, projection parity, and post-migration write amplification.
- Adds no third-party dependency and does not change provider wire APIs or user-facing transcript RPC shapes.
