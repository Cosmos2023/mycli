## Context

Schema v9 has three durable representations of session activity. `conversation_messages` is the provider-input authority, `history_items` is the complete readable/activity authority, and `turn_rollouts` retains turn status plus recovery-era events. Core write paths append user, assistant, context, tool-call, and tool-result content to both conversation and history tables. Tool results additionally repeat the full output inside the provider row's `content` and block payload. Compaction boundaries live in history while also copying replacement data into checkpoint state and summaries.

After phase-one cleanup and vacuum, the inspected database is 163,684,352 bytes. Payloads account for approximately 35.28 MiB in `conversation_messages`, 29.45 MiB in `history_items`, and 32.84 MiB in `turn_rollouts`. Content fingerprints find 16,620,009 bytes of exact cross-table strings of at least 128 bytes and 4,678,320 bytes of duplicated tool output inside conversation rows. The database also contains legacy formats and three sessions whose existing provider projection fails; migration must not silently delete or repair those rows.

The current runtime already demonstrates the desired projection boundary in limited form: when legacy conversation rows are absent, `loadConversationItems` can reconstruct simple provider items from history. Codex uses the broader version of this pattern: one append-only typed rollout stream contains provider items, runtime events, turn context, and compaction checkpoints; resume scans newest-to-oldest for the latest surviving replacement and then replays only its suffix. mycli will adopt that ownership model while keeping SQLite transactions, current RPC shapes, model-input ledgers, and Python compatibility. The inspected real database also contains abandoned sessions with stale recovery state and ambiguous reused legacy identities. On 2026-08-14 the project owner explicitly retired those sessions from the supported migration scope rather than extending heuristic compatibility for data that will not be resumed.

## Goals / Non-Goals

**Goals:**

- Make one append-only typed event log authoritative for provider, display, search, lifecycle, compaction, and lineage projections.
- Store large arguments, output, assistant text, images, and provider state once per semantic event.
- Remove routine dual writes and eliminate `conversation_messages`, `history_items`, `turn_rollouts`, and duplicated summary/checkpoint payloads after verified cutover.
- Keep provider reconstruction bounded after hundreds of compactions by locating the newest surviving checkpoint first.
- Migrate supported v9 data incrementally while it remains authoritative, then perform one short atomic ownership cutover.
- Preserve valid projections exactly and preserve invalid/opaque legacy bytes with the same bounded failure classification.
- Quantify migration time, temporary space, resume behavior, and per-turn write amplification for supported fixtures and fresh v10 storage. A copied legacy database that fails parity remains v9 and is not a release blocker when the owner retires it.

**Non-Goals:**

- Compressing or content-addressing large blobs; that remains phase three.
- Retaining or pruning provider ledger records; immutable model-input persistence remains separate.
- Age-, count-, or size-based session retention.
- Changing provider wire formats, transcript RPC payloads, or approval/clarification UX.
- Making readable artifacts or FTS indexes authoritative.
- Automatically vacuuming after logical normalization.
- Heuristically repairing, merging, or deleting explicitly abandoned legacy sessions solely to make a copied-real cutover pass.
- Guaranteeing a v10 cutover for a retired v9 database whose provider/readable identities cannot be reconciled exactly.

## Decisions

### Use one typed `transcript_events` table as the durable transcript authority

Schema v10 will use an append-only table shaped around:

- global `sequence_no` for stable append and page ordering;
- `session_id`, stable `event_id`, optional `turn_id`, and `event_type`;
- optional `provider_index` for provider ordering and legacy search/fork compatibility;
- one canonical `payload_json` envelope containing the full semantic payload once; and
- a stable created timestamp and uniqueness constraints on session/event identity.

Core event kinds cover user input with durable images, assistant output, assistant tool-call batches, tool results, model-visible context, display-only activity, approval/clarification events, turn lifecycle markers, rollback, compaction, and opaque legacy payloads. A multi-call assistant response remains one canonical batch so Responses and chat-completions grouping is not inferred from adjacent rows. A tool result stores full output once; readable summary and safe mutation metadata are fields of that event rather than a second history row.

Keeping `history_items` and treating it as canonical was rejected because it lacks durable image content for old user rows, splits provider tool batches, and cannot reproduce every current provider item without reconciliation. Keeping `conversation_messages` was rejected because it does not contain reasoning, plans, approvals, shell activity, or complete display ordering. A new typed superset makes ownership explicit and allows legacy reconciliation before either source is removed.

### Derive all transcript views through typed projectors

The storage package will expose one event reader and separate pure projectors:

- provider projector: emits exact `CanonicalConversationItem` grouping and model-visible metadata;
- readable projector: emits complete filtered `TranscriptItem` history and page groups;
- search projector: maps searchable canonical event payloads to existing bounded result shapes;
- artifact projector: produces recent bounded snapshots; and
- recovery projector: resolves canonical event references used by continuation state.

Projection code owns compatibility repair. It must not rewrite append-only canonical events. The current provider and readable hash suites become shared contract tests for both v9 legacy adapters and v10 event adapters.

Persisting pre-rendered provider and display JSON beside each event was rejected because it recreates the duplication this change removes. Projectors may cache only bounded, regenerable metadata outside provider-visible request hashes.

### Keep external-content FTS over canonical event payloads

`transcript_events_fts` will use `content='transcript_events'` and `content_rowid='sequence_no'`, maintained by insert/delete/update protocol triggers during staging and migration. Search will include only event kinds that previously participated in canonical conversation search and will map legacy `provider_index` values to the current `message_index` response field.

A separate stored `search_text` column was rejected because it would copy the largest text fields again. Exact old FTS rank is not a durable contract, but the same matching sessions/events, workspace filtering, bounded snippets, and stable legacy indices are required.

### Represent compaction as an indexed event checkpoint

A compaction event contains its window identity, replacement provider history, source event/provider boundary, summary, and audit metadata once. Mutable `compact_checkpoint` state references the event/window identity rather than copying replacement messages. Summary listing derives from compaction events, allowing `session_summaries` to be removed at cutover.

Provider resume queries the newest valid surviving compaction event by `(session_id, event_type, sequence_no DESC)`, installs its replacement, and replays only later model-visible events. Readable transcript scans canonical visible events independently and hides compaction payloads. Rollback and fork operate on complete turn/event boundaries, not raw message counts.

Retaining every old replacement in the provider input was rejected because hundreds of compactions would grow resume memory and corrupt prompt semantics. Deleting old compaction events was also rejected in this phase because they remain useful audit records; blob deduplication can reduce their storage later.

### Stage v9 normalization before an atomic v10 cutover

Opening an existing v9 database with the new binary does not immediately rewrite payloads or change the marker. The legacy adapter remains authoritative until the user explicitly runs `/session maintenance --apply-transcript-normalization`.

The explicit action creates staging and source-map tables, migrates bounded row/session batches, and commits progress after each batch. Deterministic event ids and source hashes make retry idempotent. Staging reconciliation may merge matching conversation/history/rollout sources before the event log becomes append-only. Ordinary v9 writes continue through the legacy path; each later migration pass consumes new source rows.

Final cutover acquires the normal `BEGIN IMMEDIATE` write boundary, migrates the durable tail, validates source coverage and stored projection manifests, creates/rebuilds canonical FTS, switches the version marker to 10, and removes legacy transcript tables in the same transaction. If any step fails, v9 remains authoritative. New empty databases create the final v10 shape directly.

An exact-parity failure is a supported terminal outcome for an abandoned legacy database: the migration reports bounded structural diagnostics, rolls back, and leaves schema v9 untouched. The operator may retain that database as an archive or explicitly remove unwanted sessions before retrying. The migration never guesses which of two repeated legacy messages or reused tool-call identities should survive.

An automatic startup rewrite was rejected because it can hold the only writer lock while processing a large database, requires unannounced temporary space, and makes first startup latency unpredictable. Permanent dual write was rejected because it preserves write amplification and creates two authorities.

### Preserve malformed legacy data as opaque canonical events

Migration attempts typed normalization first. A source row that cannot be parsed or reconciled is wrapped once as an `opaque_legacy` event containing the exact original bytes, source kind, legacy ordering identity, and a bounded structural error code. Provider/readable projectors reproduce the previous failure or fallback classification without printing raw content. Doctor reports bounded counts and event references.

Aborting every migration because of one malformed historical row was rejected because the inspected database already contains legacy provider failures. Dropping or repairing malformed rows was rejected because it changes durable user data without a defined semantic transform.

### Keep active runtime state and provider ledgers separate

`runtime_turns`, pending approval/clarification state, effect ledgers, input queues, shell output chunks, agent tables, and immutable model-input ledger tables remain dedicated stores. Where current mutable state copies transcript data, v10 state stores a stable event/window reference plus only the fields required for atomic recovery. Active sessions must pass recovery-reference validation before cutover or remain excluded until resolved.

This keeps pure transcript replay separate from mutable ownership/idempotency state and avoids turning the event log into a general key-value store.

### Gate supported cutover with parity manifests and gate fresh v10 with measured behavior

Dry-run reports source rows, estimated normalized bytes, temporary peak bytes, free-disk requirement, invalid/opaque counts, active sessions excluded, and batch progress. Final cutover requires:

- exact provider-window hashes or the same stable failure code for every session;
- exact complete readable transcript hashes;
- equivalent search match sets and legacy index mapping;
- identical lineage/fork projection and active recovery counts;
- byte-for-byte unchanged provider ledger tables; and
- no missing or multiply claimed legacy source rows.

Any attempted v9 cutover still requires exact parity and fails closed on a mismatch. The retired copied-real database is diagnostic coverage for that safety property, not a requirement to expand compatibility until it can be cut over. Release acceptance instead requires at least a 35% reduction in transcript payload bytes written by a synthetic tool-heavy turn, no unbounded fresh-v10 startup work, exact projection parity across the supported migration corpus, and no material resume latency or ready-to-resume memory regression. The benchmark records raw values so thresholds can be tightened from evidence rather than hidden by pass/fail output.

## Risks / Trade-offs

- **Semantic reconciliation merges two historically divergent formats incorrectly** -> Use deterministic source maps, event-level fixtures for every item type, per-session provider/display manifests, and abort final cutover on any valid-session mismatch.
- **Staging temporarily grows the database substantially** -> Estimate normalized and WAL headroom in dry-run, require sufficient free space, batch commits, and keep vacuum separate.
- **Legacy writes occur while staging is in progress** -> Keep v9 authoritative, record source high-water marks, and reconcile the complete tail under the final write lock.
- **Malformed or ambiguous rows block a retired database** -> Preserve exact bytes, fail closed, and leave v9 authoritative; do not add heuristic repair for sessions the owner has abandoned.
- **Tool-call grouping or image replay changes provider requests** -> Make batch identity and durable image blocks first-class event fields and compare exact provider hashes across protocols.
- **Compaction or fork boundaries shift when message indices disappear** -> Migrate legacy provider indices explicitly and validate every fork point and newest compaction boundary before cutover.
- **External-content FTS drifts from the new log** -> Maintain documented triggers, add integrity checks, and test insert/update/delete/rebuild and interrupted cutover retry.
- **Python and Node readers diverge** -> Add a shared v10 corpus and cross-runtime provider/display projection tests before changing the marker.
- **The migration implementation becomes a permanent second runtime** -> Keep staging code isolated behind maintenance contracts and schedule its removal only after the compatibility window and real migrations complete.

## Migration Plan

1. Add v10 event types, projectors, final new-database schema, legacy adapters, migration manifests, and Python compatibility behind tests; do not touch the real database.
2. Run synthetic and copied-real v9 dry-runs to measure reconciliation coverage, opaque rows, estimated final size, temporary peak size, and projection hashes. A copied-real mismatch is retained as fail-closed evidence when that database is retired.
3. Ship the new binary able to run normally on v9 while reporting transcript-normalization readiness. Back up `sessions.db` before applying.
4. Run `/session maintenance --apply-transcript-normalization` to stage bounded batches. Interruption leaves v9 authoritative and is safe to resume.
5. When staging reaches the tail, stop other mycli processes and run the final apply again. The final transaction validates manifests, rebuilds FTS, drops redundant transcript tables, and writes schema version 10 last.
6. Run doctor, `/resume`, complete transcript pagination, search, fork/recovery checks, and provider-ledger reconstruction. Run explicit vacuum only after these checks pass.
7. For an abandoned legacy database that fails parity, do not cut over: retain it as a v9 archive and initialize fresh v10 storage. No automatic deletion, repair, or vacuum is performed.
8. Retain the pre-cutover backup through the compatibility window. Rollback after successful cutover restores that backup; schema-v9 binaries must not open v10.

## Open Questions

- Should the first implementation retain a read-only `legacy_source_map` after cutover for one release, or export the manifest and drop all staging metadata immediately? Default: retain only bounded hashes/counts for one compatibility window, never raw duplicate payloads.
- Should opaque legacy events remain searchable by their wrapped raw bytes? Default: preserve the previous match set during migration, then expose a doctor warning so a later explicit repair policy can decide their long-term treatment.
