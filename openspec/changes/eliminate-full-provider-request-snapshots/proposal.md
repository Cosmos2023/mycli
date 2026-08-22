## Why

Schema v11 appends the provider-visible timeline but also stores one complete logical provider
request for every provider step. Tool-heavy root and subagent loops therefore retain repeatedly
growing history prefixes and make a four-session workload grow `sessions.db` to about 21 MiB after
only 208 provider steps.

## What Changes

- Reconstruct every committed provider request deterministically from its immutable instruction and
  tool snapshots, provider configuration, compact manifest high-water, and append-only timeline.
- Stop writing full logical request blobs and retain only the request hash/signature needed to
  validate reconstruction and dispatch identity.
- Replace V2 manifests that repeat complete event-id/reference prefixes with compact V3 manifests
  containing only a timeline window, prefix event count, prefix hash, and request hash.
- Compute common-prefix metadata from timeline prefixes without loading a previous full request.
- Add fresh-only schema v12 without `logical_request_blob_id` ownership or reference rows.
- **BREAKING**: do not implement v11-to-v12 migration or compatibility dispatch. Existing v11
  databases fail closed and must be archived before a fresh v12 database is created.
- Preserve atomic provider-step commit, crash recovery, Worker/in-process parity, compaction window
  boundaries, continuation behavior, and exact provider request hashes.

## Capabilities

### New Capabilities

- `append-only-provider-request-ledger`: Manifest-and-timeline request reconstruction, hash-only
  provider-step ownership, fresh schema-v12 storage, and bounded growth acceptance.

### Modified Capabilities

None.

## Impact

- Changes provider request construction in `@mycli/runtime` and reconstruction in
  `@mycli/storage`.
- Replaces fresh schema-v11 creation with schema v12 and updates runtime dispatch, doctor,
  maintenance, fixtures, benchmarks, and generated expectations.
- Removes the dominant full-request content-blob write while retaining transcript payload blobs,
  model-input snapshots, timeline events, manifests, and lifecycle events.
- Adds no dependency and no Python schema-v12 support.
