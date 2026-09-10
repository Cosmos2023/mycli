## V9 Projection Baseline

Captured on 2026-08-14 from a temporary SQLite online backup of the post-phase-one
`sessions.db`. The source database was opened read-only. The temporary backup was
deleted after manifest generation. No session ids, workspace paths, transcript
content, tool payloads, or provider payloads are recorded here.

### Synthetic Fixture

- Manifest version: 1
- Frozen manifest SHA-256: `b5828dd11cbb84cd40db62079eb79637825fa557e24eba8dfa02e20947328a70`
- Coverage: provider window, complete readable transcript, search documents and
  legacy message-index mapping, lineage, recovery state, and provider ledger
- The exact hash is enforced by `backend/packages/storage/test/migrations/v9/v9-projection-manifest.test.ts`.

### Copied Real Storage

- Sessions: 251
- Full manifest SHA-256: `c243a3ccd32ebcb7b26f451470570a11b3734713c568b92d298a961631976299`
- Provider windows: 248 valid, 3 stable `persistence_error` results
- Complete readable transcripts: 251 valid
- Search document projections: 248 valid, 3 matching provider parse failures
- Lineage projections: 251 valid
- Recovery-state projections: 251 valid
- Provider-ledger rows: 3,151
- Provider-ledger SHA-256: `f166a9aec857f7fdd5ed420d542b4567117a0c93b07558230e1a08524cea2e3c`

The three provider/search failures existed before normalization work and match the
read-only v9 analyzer. A v10 cutover must reproduce the same bounded error class for
those sessions rather than deleting or repairing their source bytes implicitly.

### Copied Real Storage Staging

Captured on 2026-08-14 by `benchmark_transcript_normalization.mjs` with 500-row
batches. The benchmark used a temporary SQLite online backup and deleted it after
the run. The source database size, modification time, and inode were unchanged.

- Source database: 163,684,352 bytes
- Source rows: 25,529; source payload: 98,282,148 bytes
- Completed staging batches: 49 of 49
- Selected inactive source rows: 24,338
- Staged canonical events: 15,439
- Staging time: 7,876.4 ms
- Estimated temporary peak: 154,377,019 bytes
- Measured copied-storage peak: 257,306,624 bytes
- Measured additional temporary bytes: 93,622,272 bytes
- Opaque source rows: 319
- Existing projection errors: provider 3, search 3, readable/lineage/recovery 0
- Active recovery sessions: 18, excluding 1,191 source rows from cutover

The copied-real run stopped with `blocked_active_sessions` before cutover, as
required. It did not delete or rewrite recovery state, install schema v10, or run
vacuum.

A second read-only-source run later on 2026-08-14 reproduced the same blocker:
18 active recovery sessions, 1,191 excluded source rows, 49 of 49 staging
batches, 15,439 staged events, and unchanged source size/mtime. That temporary
copy staged in 7,988.31 ms and reached the same 257,306,624-byte storage peak.
The repeated expected process exit was 2.

### Active Recovery Blocker Classification

A read-only aggregate inspection on 2026-08-14 found that the 18 excluded
sessions are structurally valid recovery state, not ordinary orphaned turns:

- 7 sessions have an `in_progress` turn together with continuation state; none
  is a turn-only orphan eligible for automatic restart interruption.
- 10 additional sessions have pending/suspended recovery state without an
  `in_progress` turn.
- `pending_decision` and `suspended_turn` each contain 17 rows; 16 sessions have
  both rows, and all inspected recovery payloads are valid JSON objects.
- 7 `node_effect_checkpoint` rows are valid JSON objects and overlap the active
  recovery set.
- The read-only storage doctor reports `schema_version=9 integrity=ok
  staging=none`.

The normal store intentionally skips automatic interruption for turns with
continuation state. Clearing these rows merely to permit migration would discard
pending approval/effect semantics. The project owner later classified these
sessions as abandoned and retired the copied database from the supported cutover
scope; production data was not changed.

### Retired Copied-Real Cutover Evidence

On 2026-08-14 a second temporary copy was used to test the cutover path after
quiescing only the abandoned recovery state inside that copy. Seven in-progress
turns were marked interrupted and 41 recovery-state rows were removed in the
temporary copy, reducing the active-recovery count from 18 to zero. The source
database remained unchanged.

- The quiesced v9 copy was 163,512,320 bytes after explicit vacuum.
- The latest cutover compatibility regression suite passed all 22 cases,
  including 16 rollback/retry failpoints; storage typecheck and focused
  `git diff --check` also passed.
- Full copied-real staging completed, but the staging manifest found 11 provider
  projection mismatches caused by ambiguous repeated legacy identities. The first
  bounded mismatch ordinal was 14; no session ids or transcript content were
  emitted.
- Cutover failed at `cutover_after_source_validation` with the bounded
  `persistence_error` classification. Its transaction rolled back, schema v9
  remained authoritative, and no post-cutover vacuum ran.

On 2026-08-14 the project owner explicitly decided that these historical broken
or ambiguous sessions will not be resumed and are not worth additional heuristic
compatibility work. The supported product path is therefore:

- keep the old database as an untouched v9 archive or explicitly remove unwanted
  sessions outside normalization;
- initialize new storage directly with schema v10;
- retain exact manifest validation for any supported v9 cutover; and
- fail closed rather than merge, delete, or guess at ambiguous legacy events.

This is a product-scope decision, not evidence of a successful copied-real
cutover. The previous copied-real 15% physical-reduction target and unchanged
abandoned-recovery target are retired because that database will not be cut over.

### Synthetic Acceptance Evidence

Captured on 2026-08-14 on macOS arm64 with Node 24.14.1. These isolated fixture
results exercise the implemented gates but do not replace copied-real or
cross-platform acceptance evidence.

- The paired 600-turn `heavy` fixtures measured 70.8 MB for v9 and 35.9 MB for
  vacuumed v10. The measured post-resume turn wrote 1,644 transcript payload
  bytes on v9 and 462 bytes on v10, a 71.9% reduction against the 35% gate.
- `heavy` backend-ready time was 58.5/63.8 ms for v9/v10, resume was 57.7/69.2
  ms, complete transcript paging was 82.7/118.7 ms, and provider turn time was
  734.3/711.7 ms. Ready-to-resume RSS growth was 48.8/50.9 MB.
- The paired 500-compaction `compact_stress` fixtures measured 78.1 MB for v9
  and 43.6 MB for vacuumed v10. Resume was 73.8/78.9 ms, complete transcript
  paging was 91.8/123.5 ms, and provider turn time was 874.2/912.4 ms.
- Both 500-compaction provider requests used only the newest replacement and 20
  retained turns, excluded the oldest summary and turn zero, and retired the
  idle Worker. Complete readable history remained reachable through seven
  bounded transcript pages.
- Peak RSS after explicitly loading all pages and running the provider turn was
  585.3/708.9 MB for `heavy` and 574.9/727.1 MB for `compact_stress`. This
  higher v10 end-to-end peak remains an open acceptance signal; it is not
  classified as a resume-memory improvement.

The synthetic write-byte reduction passes its 35% threshold. Supported fixtures
retain exact v9/v10 projection parity. Ready-to-resume RSS growth differed by
about 2.1 MB in the heavy profile, and resume remained bounded at 69.2 ms for the
heavy profile and 78.9 ms after 500 compactions. The higher peak after explicitly
loading every transcript page remains recorded as a full-history pagination cost,
not a resume-memory regression. Under the retired-legacy scope above, tasks 8.3
and 8.4 are complete without proposing a copied-real cutover.

### Local Quality Gates

The final local verification pass on 2026-08-14 produced these results:

- Node build, contracts, lint, typecheck, and the complete workspace test suite passed.
  One worker-recovery timing case failed on the first concurrent run, then passed
  alone, in the complete app package, and in a subsequent complete workspace run.
- Python Ruff and mypy passed. After synchronizing the separate worker-pool
  tool-inventory and package-script fixtures, the complete Pytest suite reported
  2,500 passed and 30 skipped.
- `git diff --check` passed.
- `openspec validate normalize-session-transcript-storage --strict` passed.

The actual hosted Linux/macOS/Windows matrix did not run for this dirty worktree. On 2026-08-14 the
project owner explicitly waived paid hosted runners and accepted the complete local macOS equivalent
gate recorded above. Task 8.5 is complete under that waiver; this is not evidence that remote runners
executed. Tasks 8.3 and 8.4 use the separately documented retired-legacy scope and do not authorize a
cutover of the copied real database.
