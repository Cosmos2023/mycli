## 1. Baseline And Content Codec

- [x] 1.1 Add a read-only schema-v10 blob analyzer that reports eligible inline bytes, unique content bytes, estimated identity/deflate bytes, duplicate reference bytes, per-source counts, and migration headroom without content or ids.
- [x] 1.2 Add unit tests for deterministic SHA-256 identities, identity/deflate selection, compression savings threshold, empty/boundary/32-MiB inputs, unknown codecs, size mismatch, digest mismatch, truncated data, and excessive expansion.
- [x] 1.3 Implement the typed immutable content-blob codec with Node standard-library raw DEFLATE, bounded verification, and sanitized storage errors.
- [x] 1.4 Add unit tests for deterministic recursive string extraction, RFC 6901 escaping, arrays, marker-like semantic objects, duplicate values, hydration caching, missing/duplicate/conflicting paths, invalid UTF-8, and exact stable-JSON round trips.
- [x] 1.5 Implement the shared transcript payload externalizer/hydrator and typed reference contracts without leaking storage markers above `@mycli/storage`.

## 2. Schema V11 And Blob Repository

- [x] 2.1 Add schema-v11 tests for content blobs, transcript/model-input references, foreign keys, immutability, indexed reachability, contentless-delete FTS, schema marker, and rejection by v9/v10-only readers.
- [x] 2.2 Implement final new-database schema v11, `createV11SessionDatabase`, and bounded runtime dispatch for v9, inline v10, and blob-backed v11 without routine startup scans.
- [x] 2.3 Add repository tests for insert/reuse/collision, batch load ordering, reference ownership, cache scope, orphan reporting/collection, transaction rollback, and cross-process concurrent insertion.
- [x] 2.4 Implement the SQLite content-blob repository behind typed put/load/loadMany/reference/metrics/collect APIs and reuse the existing write-transaction boundary.

## 3. Blob-Backed Transcript And Search

- [x] 3.1 Add transcript-store tests proving large user/image, assistant, multi-call arguments, tool result, context, display, lifecycle, rollback, compaction, and opaque payloads hydrate exactly while small fields remain inline.
- [x] 3.2 Route schema-v11 event append and every event read/window/source/lineage path through atomic blob persistence and bounded hydration while preserving provider indices and event identities.
- [x] 3.3 Run shared provider/readable contracts against v10/v11 and add hundreds-of-compactions, fork, rollback, pending-tool, recovery-reference, pagination, and artifact parity coverage.
- [x] 3.4 Add contentless FTS tests for insert/delete/rebuild, rank, punctuation, workspace and lineage filtering, externalized matches, bounded snippets, corruption, and exact v10/v11 matching sets.
- [x] 3.5 Implement transactional contentless FTS population from canonical hydrated JSON and update event search/doctor integrity paths without storing plaintext search content.

## 4. Compressed Model-Input Ledger

- [x] 4.1 Add ledger tests for compressed instruction/tool/context/timeline/manifest/request blobs, stable existing ids and hashes, prefix reconstruction, duplicate reuse, corruption, failpoint rollback, and old-manifest reconstruction after later appends.
- [x] 4.2 Implement schema-v11 model-input content references and transparent verified reconstruction while preserving every immutable ownership row and provider-step transaction contract.
- [x] 4.3 Add app/runtime integration proving a Worker tool turn commits a blob-backed provider request, restarts through in-process reconstruction, and continues without changed request items or duplicate effects.

## 5. Explicit V10-To-V11 Migration

- [x] 5.1 Add a read-only migration dry-run with event/model-input coverage, estimated unique raw/stored bytes, FTS rebuild work, batches, active writer state, temporary peak/free-space requirements, and bounded diagnostics.
- [x] 5.2 Add deterministic staging/source-map tests for bounded batches, idempotency, interruption, retry, duplicate reuse, new tail writes, source hash conflict, and staging cleanup while v10 remains authoritative.
- [x] 5.3 Implement resumable v10 event/model-input staging with deterministic content/reference identities and committed batch progress.
- [x] 5.4 Add final-cutover tests for tail reconciliation, exact provider/readable/search/lineage/recovery/provider-ledger manifests, marker-last installation, and source/reference/FTS validation.
- [x] 5.5 Implement atomic schema-v11 cutover that rewrites only storage representations, installs contentless FTS, preserves sequence/identity rows, and leaves v10 authoritative on failure.
- [x] 5.6 Add failpoints for every cutover stage plus busy writer, second process, low disk, invalid staged blob/reference, rollback shape, and clean retry coverage.

## 6. Diagnostics And Maintenance

- [x] 6.1 Extend read-only storage doctor for v10 staging and v11 codec/count/hash/reference/typed-event/FTS/orphan integrity with content-safe diagnostics.
- [x] 6.2 Extend typed session maintenance reports and explicit orphan collection with raw/stored/deduplicated/logical/freelist byte metrics and idempotency tests.

## 7. Commands, Documentation, And Runtime Composition

- [x] 7.1 Expose `/session maintenance --apply-content-blobs` and explicit blob garbage collection through gateway/backend composition with bounded progress/results and command-registry tests.
- [x] 7.2 Update storage/runtime/migration/backup/rollback/headroom/FTS/orphan/vacuum/older-reader rejection documentation and keep fresh-v11 behavior distinct from explicit v10 conversion.
- [x] 7.3 Update smoke runners, fixtures, package scripts, generated contracts if required, and runtime-created database tests to use version-aware store composition.

## 8. Verification And Measured Acceptance

- [x] 8.1 Run focused codec, storage, transcript, search, compaction, recovery, ledger, runtime, gateway, doctor, migration, cross-process, and corruption suites for v10 and v11.
- [x] 8.2 Extend the long-history benchmark with paired v10/v11 tool-heavy and 500-compaction profiles recording raw/stored/unique/reference bytes, database size, startup, resume, pagination, provider turn, peak/idle memory, migration time, temporary peak, GC, and vacuum.
- [x] 8.3 Enforce at least 35% tool-heavy transcript-plus-ledger payload-byte reduction, at least 30% vacuumed 500-compaction physical reduction, exact supported semantic/search/ledger parity, bounded migration headroom, and no material startup/resume memory or latency regression.
- [x] 8.4 Run full workspace build, lint, typecheck, Node tests, local cross-platform-equivalent packaging checks, `git diff --check`, and strict OpenSpec validation before proposing any schema-v10 cutover.
- [x] 8.5 Cover fresh schema-v11 TUI bootstrap so the current virtual session loads as an empty writable transcript without being persisted, while missing resume targets still fail closed.
