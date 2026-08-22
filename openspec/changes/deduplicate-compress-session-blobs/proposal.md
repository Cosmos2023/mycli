## Why

Schema v10 removes transcript dual writes, but large strings remain inline in event payloads and
immutable model-input blobs remain uncompressed. Repeated compaction replacements, tool arguments,
tool output, images, context, and provider state can therefore retain the same bytes many times and
make long-running databases grow faster than their semantic history.

## What Changes

- Add an immutable, content-addressed session blob store with deterministic standard-library
  compression, raw/stored byte accounting, hash verification, and reference integrity.
- Externalize eligible large transcript payload values while keeping typed events authoritative;
  provider, readable, search, compaction, fork, recovery, and artifact projections hydrate the
  original semantic payload transparently.
- Store new model-input ledger payloads through the compressed content store while preserving the
  existing immutable blob identities, manifest hashes, reconstruction behavior, and append-only
  timeline contracts.
- Replace full-payload FTS dependence with a contentless token index populated from the hydrated
  canonical payload, so full searchable text is not persisted a second time.
- Add explicit, resumable schema-v10-to-v11 staging and atomic cutover. Normal startup remains
  bounded, schema v10 stays authoritative until parity validation succeeds, and vacuum remains a
  separate operator action.
- Add read-only diagnostics and explicit maintenance for compression estimates, deduplication,
  reference integrity, orphan collection, logical savings, and physical post-vacuum savings.
- Keep schema v11 Node-owned. The retained Python reader remains capped at schema v10 and rejects
  marker 11 before any write; Python v11 hydration and shared-corpus parity are outside this change.

## Capabilities

### New Capabilities

- `content-addressed-session-blob-store`: Deterministic compression, field-level blob references,
  transparent hydration, integrity validation, garbage collection, migration, and measured storage
  acceptance for canonical transcript and model-input payloads.

### Modified Capabilities

None.

## Impact

- Adds schema v11 storage objects and migration code in `backend/packages/storage` and changes the
  v10 runtime-store dispatch boundary.
- Changes transcript event persistence/search indexing and model-input blob persistence without
  changing their typed application interfaces or provider request hashes.
- Updates storage doctor, `/session maintenance`, Node gateway/backend composition, older-reader
  rejection documentation, fixtures, and long-history/storage benchmarks.
- Uses only Node and SQLite standard capabilities; no third-party compression dependency or
  provider API change is introduced.
- Does not rewrite the retired real v9 database and does not add age/count retention policy.
