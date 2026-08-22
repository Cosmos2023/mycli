## Real Database Copy Benchmark

Date: 2026-08-14

The benchmark used `better-sqlite3` backup to create a consistent temporary copy of the real
`sessions.db`. All migration, payload cleanup, and vacuum operations ran only against that copy.
The copy and the temporary benchmark driver were deleted afterward. No session ids, search terms,
conversation text, or provider payloads were emitted.

### Source

- Schema version: 8
- Sessions: 251
- Copied main database size: 320,565,248 bytes (305.71 MiB)

### Migration And Report

- v8 to v9 store initialization: 434.11 ms
- Maintenance dry-run: 1,021.89 ms
- Compactable rollouts: 898 rows / 90,369,470 bytes
- Removable legacy state: 177 rows / 16,345,819 bytes
- Estimated logical payload savings: 106,715,289 bytes (101.77 MiB)

### Payload Cleanup

- Cleanup duration: 1,781.07 ms
- Batches required at the default 1,000-row limits: 1
- Compacted rollouts: 898
- Deleted state rows: 177
- Actual logical payload bytes removed: 106,715,289
- Immediate repeated cleanup: zero rows and zero bytes removed

### Equivalence

- Pre/post migration search row hashes matched for five non-empty fixed queries and 500 bounded
  results, with zero search errors.
- Provider-window hashes matched before and after payload cleanup across all 251 sessions and 9,649
  successfully projected items. Three sessions had pre-existing provider projection errors on both
  sides and therefore remained errors rather than being silently normalized.
- Complete readable-transcript hashes matched across all 251 sessions and 8,924 projected items,
  with zero projection errors.
- Search hashes still matched after payload cleanup and after vacuum.
- Row counts matched for canonical conversation messages, history items, summaries, model-input
  blobs, and provider request manifests before cleanup, after cleanup, and after vacuum.

### Physical Reclamation

- Vacuum duration: 1,149.33 ms
- Main database before vacuum: 320,565,248 bytes
- Main database after vacuum: 163,684,352 bytes (156.10 MiB)
- Physical bytes reclaimed: 156,880,896 bytes (149.61 MiB, 48.94%)
- Freelist pages: 37,743 before vacuum, 0 after vacuum

These are single-machine measurements, not a latency distribution. They establish that the first
phase materially reduces the copied database while preserving the tested resume, transcript,
search, and provider-ledger contracts.
