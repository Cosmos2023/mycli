## 1. Canonical Event Contract And Baseline

- [x] 1.1 Add typed transcript-event envelopes, event-kind schemas, stable identity/order rules, and unit tests for user input, images, assistant output, multi-call tool batches, tool results, context, display activity, lifecycle, rollback, compaction, and opaque legacy events.
- [x] 1.2 Add a read-only v9 analyzer that reports table/payload bytes, duplicate large-content bytes, per-turn write amplification, legacy shape counts, invalid projection counts, and required migration headroom without printing session content or ids.
- [x] 1.3 Freeze provider-window, complete-readable-transcript, search-match, lineage, recovery-state, and provider-ledger manifests for synthetic v9 fixtures and a copied real database.

## 2. Normalized Schema And Repository

- [x] 2.1 Add schema-v10 tests for the final `transcript_events` table, append-only constraints, provider/compaction indexes, event identity uniqueness, external-content FTS, trigger synchronization, and rejection by v9-only readers.
- [x] 2.2 Implement the final schema-v10 new-database path and a typed transcript-event repository behind the storage interfaces, without changing the existing v9 read/write path.
- [x] 2.3 Add bounded event windows, reverse latest-compaction lookup, per-turn event loading, source-reference loading, and event append APIs with explicit types and sanitized persistence errors.

## 3. Deterministic Projections

- [x] 3.1 Add a shared provider-projection contract suite covering Responses, chat completions, images, assistant text plus multi-call batches, tool results, context items, provider state, terminal tool repair, and opaque legacy failure parity.
- [x] 3.2 Implement provider input reconstruction from transcript events and route schema-v10 `loadConversationItems`, tool activation, pending-tool, and context reads through it.
- [x] 3.3 Add readable-projection tests for reasoning, plans, approvals, clarifications, shell activity, tool merging, hidden events, pagination, recent snapshots, malformed compatibility rows, and complete history across compactions.
- [x] 3.4 Implement complete/recent/paged readable transcript and artifact projection from transcript events while preserving current RPC and snapshot shapes.
- [x] 3.5 Implement event-backed session search with external-content FTS and tests for workspace filtering, punctuation, bounded snippets, insert/update/delete synchronization, legacy index mapping, and matching-result equivalence.

## 4. Single-Write Runtime Path

- [x] 4.1 Add store tests proving reserve, assistant output, multi-call tools, tool results, context items, completion, failure, and interruption append one canonical event per semantic action and do not write legacy transcript rows in schema v10.
- [x] 4.2 Implement schema-v10 turn-store writes for user input, durable images, assistant/tool/context events, terminal lifecycle markers, and recovery-generated tool results.
- [x] 4.3 Route reasoning, plans, approval/clarification activity, shell state, baseline updates, and other display-only persistence through typed canonical events with explicit model-visibility metadata.
- [x] 4.4 Update runtime, gateway, artifact, and subagent composition to consume the normalized store without changing provider requests, transcript RPCs, live event ordering, or task output behavior.

## 5. Compaction, Fork, And Recovery Boundaries

- [x] 5.1 Add tests with hundreds of compactions proving indexed newest-checkpoint lookup, latest replacement plus suffix provider input, complete readable history, bounded resume memory, and no stacking of older replacements.
- [x] 5.2 Implement compaction events, event-referenced compact checkpoint state, summary projection, rollback markers, and removal of duplicate replacement payloads from mutable state.
- [x] 5.3 Add and implement event-boundary fork/lineage migration and runtime behavior that preserves complete shareable turns, tool lifecycles, parent prefixes, deterministic branch selection, and legacy fork-point compatibility.
- [x] 5.4 Add recovery tests and reference validation for active turns, pending approval, pending clarification, continuation state, effect checkpoints, queued input, and restart interruption on schema v10.

## 6. Resumable V9 Staging And Atomic Cutover

- [x] 6.1 Add migration fixtures covering v2-v9, Node and Python payload shapes, conversation-only/history-only sessions, multi-call tools, images, repeated compaction, forks, active recovery, malformed JSON, opaque valid JSON, and the known copied-real projection failures.
- [x] 6.2 Implement read-only normalization dry-run reporting for source coverage, estimated normalized bytes, temporary peak/free-space requirements, opaque rows, excluded active sessions, batch progress, and logical versus physical savings.
- [x] 6.3 Implement deterministic staging/source-map tables and bounded reconciliation batches that merge matching legacy conversation/history/rollout/summary sources while leaving schema v9 authoritative.
- [x] 6.4 Add interruption, retry, idempotency, new-tail-write, second-process, busy-lock, low-disk, and source-hash-conflict tests for staging.
- [x] 6.5 Implement final `BEGIN IMMEDIATE` tail reconciliation and manifest validation, then atomically install schema v10, rebuild event FTS, migrate lineage/recovery references, remove redundant transcript tables, and write the version marker last.
- [x] 6.6 Add failpoints for every final-cutover stage and prove rollback leaves the v9 marker, legacy projections, active recovery, and a clean retry path intact.

## 7. Compatibility, Diagnostics, And Commands

- [x] 7.1 Update the Python SQLite compatibility reader and shared corpus tests for schema v10 session listing, provider history, readable history, compaction, lineage, opaque rows, and bounded unsupported-version errors.
- [x] 7.2 Update storage doctor for v9 staging and v10 final shapes, event/FTS integrity, migration manifests, opaque counts, active recovery references, missing legacy objects after cutover, and strict read-only behavior.
- [x] 7.3 Expose `/session maintenance --apply-transcript-normalization` with bounded progress/results through gateway/backend composition, keep the default report read-only, and update command registry fixtures and completion tests.
- [x] 7.4 Update storage, runtime, command, migration, backup, rollback, temporary-space, compatibility-window, and separate-vacuum documentation.

## 8. Verification And Measured Acceptance

- [x] 8.1 Run focused storage, runtime, compaction, recovery, readable transcript, search, artifact, gateway, doctor, Python parity, and cross-process regression suites for both v9 legacy mode and v10 normalized mode.
- [x] 8.2 Extend the long-history benchmark with v9/v10 heavy and 500-compaction profiles, recording startup, resume, full transcript pagination, provider turn latency, peak/idle memory, database bytes, and transcript rows/payload bytes written per turn.
- [x] 8.3 Run normalization against copied real storage, record staging time, peak temporary bytes, opaque/error counts and bounded parity failure, prove rollback/source immutability, and record the owner's decision to retire rather than migrate the abandoned legacy sessions.
- [x] 8.4 Enforce the supported-scope acceptance gates: at least 35% synthetic tool-heavy transcript write-byte reduction, zero projection mismatches in the supported migration corpus, bounded fresh-v10 startup/resume latency and ready-to-resume memory, and fail-closed behavior for the retired copied-real database. The copied-real 15% post-vacuum target and unchanged abandoned recovery count are not release gates because no cutover of that database is proposed.
- [x] 8.5 Run full workspace build, lint, typecheck, Node tests, Python tests, cross-platform CI, `git diff --check`, and strict OpenSpec validation before any real-database cutover is proposed.

  On 2026-08-14 the complete local macOS equivalent gate passed under Node 22.19.0, Node 24.14.1,
  and Python 3.13.12, including build, contracts, lint, typecheck, full Node tests, M8 tests/smoke,
  packed CLI validation for ten workspaces and six platform packages, 2,500 passing Python tests
  with 30 skips, Ruff, mypy, `git diff --check`, and strict OpenSpec validation. The project owner
  explicitly waived paid hosted Linux/Windows/macOS runners and accepted this local gate. This
  records a waiver rather than remote-runner evidence. No real-database cutover is proposed: the
  copied legacy database is retained on v9 and new storage uses the fresh-v10 path.
