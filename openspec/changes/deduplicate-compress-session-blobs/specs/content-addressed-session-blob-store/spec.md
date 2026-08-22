## ADDED Requirements

### Requirement: Session content blobs are immutable, deterministic, and bounded
The system SHALL store eligible content under a SHA-256 identity of its uncompressed bytes, SHALL
select an allowlisted deterministic standard-library codec, and SHALL verify codec, declared sizes,
decompressed bytes, and digest before returning content.

#### Scenario: Repeated compressible content is stored once
- **WHEN** multiple transcript or model-input payloads reference identical eligible UTF-8 bytes
- **THEN** one immutable content row is stored and every owner records a durable reference to it

#### Scenario: Incompressible content uses identity storage
- **WHEN** eligible bytes do not meet the documented minimum compression saving
- **THEN** the same content identity is stored with the identity codec without changing semantic bytes

#### Scenario: Corrupt or oversized compressed content is rejected
- **WHEN** a blob has an unknown codec, invalid declared size, excessive expansion, invalid UTF-8, or a digest mismatch
- **THEN** hydration fails with a bounded persistence error and does not expose stored bytes or identities

### Requirement: Transcript events externalize large values without changing semantics
Schema v11 SHALL keep typed transcript events authoritative while replacing eligible stored strings
with relational blob references that hydrate to the exact original event before any provider,
readable, search, compaction, lineage, recovery, or artifact projection.

#### Scenario: Tool and image payloads round-trip exactly
- **WHEN** user images, assistant tool arguments, tool output, context, or provider state exceed the externalization threshold
- **THEN** their hydrated typed event and every existing projection are byte-for-byte equivalent to the inline schema-v10 event

#### Scenario: Repeated compaction content deduplicates across checkpoints
- **WHEN** hundreds of compaction events retain overlapping replacement strings
- **THEN** repeated strings reference the same content identities while resume still uses only the newest replacement plus its suffix

#### Scenario: Reference markers cannot collide with semantic JSON
- **WHEN** user or tool metadata contains an object resembling an internal blob marker
- **THEN** it remains ordinary semantic data because hydration is driven only by validated relational JSON Pointer references

#### Scenario: Event and reference writes are atomic
- **WHEN** content insertion, event insertion, reference insertion, mutable turn state, or search indexing fails
- **THEN** the complete semantic action rolls back without a partial event, dangling reference, or visible FTS row

### Requirement: Search does not retain a second plaintext payload copy
Schema v11 SHALL index the canonical hydrated searchable payload in a contentless FTS projection and
SHALL reconstruct bounded results from the authoritative event and content references.

#### Scenario: Search match sets remain equivalent
- **WHEN** the same corpus is stored in inline schema v10 and blob-backed schema v11
- **THEN** workspace filtering, punctuation matching, legacy message indices, lineage visibility, and matching result sets are equivalent

#### Scenario: Search snippets hydrate canonical text
- **WHEN** a query matches terms from an externalized value
- **THEN** the result snippet is produced from the hydrated search document and remains within the existing bound

#### Scenario: FTS synchronization is transactional
- **WHEN** an eligible event is appended, removed by an allowed maintenance path, or rebuilt during migration
- **THEN** its contentless FTS row is inserted or deleted in the same transaction and integrity diagnostics report no drift

### Requirement: Model-input blob identities and reconstruction remain stable
Schema v11 SHALL store immutable model-input JSON through compressed content references while
preserving existing blob ids, snapshot ids, request signatures, logical hashes, manifest chains,
timeline prefixes, lifecycle state, and exact request reconstruction.

#### Scenario: Existing manifest reconstructs from compressed content
- **WHEN** a schema-v10 model-input blob is migrated to a schema-v11 content reference
- **THEN** reconstruction returns the exact original request and all existing identity/hash validation passes

#### Scenario: Duplicate model-input content reuses storage
- **WHEN** snapshots, context events, timeline events, or manifests contain identical stable JSON
- **THEN** their immutable ownership rows retain their identities while the encoded bytes are stored once

#### Scenario: A content collision rolls back provider commit
- **WHEN** an existing content identity has different codec metadata or uncompressed bytes
- **THEN** the provider-step transaction fails before dispatch and no manifest or prepared lifecycle row is partially committed

### Requirement: Schema-v10 blob migration is explicit, resumable, and atomic
The system SHALL convert supported schema-v10 storage only through an explicit maintenance action,
SHALL keep v10 authoritative during bounded staging, and SHALL write schema marker 11 last after exact
semantic and ledger parity validation.

#### Scenario: Normal startup does not compress existing storage
- **WHEN** mycli opens a populated schema-v10 database without the explicit content-blob action
- **THEN** startup performs bounded version dispatch, keeps inline payloads authoritative, and does not scan, compress, or rewrite them

#### Scenario: Interrupted staging resumes safely
- **WHEN** content staging stops between batches or another v10 writer appends a durable tail
- **THEN** a later run reuses verified content identities, processes unmapped sources and the tail, and does not duplicate or skip semantic bytes

#### Scenario: Final cutover validates every projection
- **WHEN** staging reaches the durable tail under the final write lock
- **THEN** provider, readable, search, lineage, recovery, and provider-ledger manifests match before content references, contentless FTS, and marker 11 become authoritative

#### Scenario: Failed cutover remains schema v10
- **WHEN** a failpoint, source hash conflict, reference error, FTS error, parity mismatch, busy writer, or low-space condition occurs
- **THEN** cutover rolls back to the complete inline schema-v10 state and remains cleanly retryable

### Requirement: Blob maintenance is observable, private, and explicit
Doctor and session maintenance SHALL report bounded structural compression, deduplication,
reference, orphan, migration, and headroom metrics without content or identities, and SHALL mutate
content only through explicit apply operations.

#### Scenario: Dry-run reports logical savings
- **WHEN** maintenance analyzes inline or blob-backed storage
- **THEN** it reports eligible bytes, unique raw/stored bytes, compression savings, deduplicated reference bytes, orphan bytes, and required migration headroom without modifying the database

#### Scenario: Doctor detects structural corruption read-only
- **WHEN** codec metadata, sizes, hashes, JSON Pointer references, ownership rows, or FTS rowids are inconsistent
- **THEN** doctor reports bounded counts and stable error classes without repairing rows or printing content, paths, hashes, or session ids

#### Scenario: Orphan collection does not delete reachable content
- **WHEN** explicit blob garbage collection runs
- **THEN** it deletes only rows unreachable from both transcript and model-input reference tables and reports logical bytes reclaimed

#### Scenario: Physical shrinkage requires vacuum
- **WHEN** orphan content or staging rows are deleted
- **THEN** maintenance reports reusable free pages and does not claim a smaller database file until explicit vacuum completes

### Requirement: Schema v11 is Node-owned and older readers fail closed
Node SHALL own schema-v11 reads and writes. Readers supporting at most schema v10, including the
retained Python reader, SHALL reject marker 11 before mutation and SHALL NOT recreate inline storage.

#### Scenario: Python rejects a Node schema-v11 session
- **WHEN** the retained Python reader opens a schema-v11 database
- **THEN** it returns bounded expected/actual version diagnostics and performs no writes, hydration, migration, or schema repair

### Requirement: Phase-three savings meet measured acceptance gates
The implementation SHALL be accepted only after supported v10/v11 fixtures demonstrate exact
semantic parity, bounded runtime behavior, and documented logical and physical storage reduction.

#### Scenario: Tool-heavy write storage is reduced
- **WHEN** equivalent tool-heavy turns are persisted in schema v10 and schema v11
- **THEN** v11 stores at least 35 percent fewer transcript plus model-input payload bytes while reconstructing identical provider requests

#### Scenario: Repeated-compaction physical size is reduced
- **WHEN** equivalent 500-compaction databases are explicitly vacuumed after all validation
- **THEN** schema v11 is at least 30 percent smaller than vacuumed schema v10 with equivalent provider and complete readable projections

#### Scenario: Resume remains bounded
- **WHEN** heavy and 500-compaction sessions are resumed and paged
- **THEN** startup, resume latency, ready-to-resume memory, full transcript pagination, and provider-turn measurements remain bounded and any material regression blocks completion
