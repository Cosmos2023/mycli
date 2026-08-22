## Context

The model-input ledger already persists immutable instruction snapshots, tool-set snapshots,
context events, provider-input timeline events, V2 manifests, and provider-step lifecycle events.
Each V2 manifest repeats the complete ordered timeline-event id list and provider-visible reference
list for one step. Schema v11 also stores the complete projected `ProviderRequest` as
`logical_request_blob_id`, so both the manifest and request grow with the complete history prefix.

The inspected four-session root-plus-three-subagent workload committed 208 provider steps. Its
complete logical requests represented 46.2 MiB of raw JSON and 11.8 MiB after DEFLATE, accounting
for most of a 20.9 MiB database. Only ten of 1,405 content blobs were referenced more than once
because every growing request snapshot had a distinct hash.

The data flow after this change is:

```text
instruction snapshot + tool snapshot + append-only timeline events
  -> compact immutable V3 manifest with window + prefix count/hash + request hash
  -> deterministic ProviderRequest projection
  -> exact hash validation
  -> provider dispatch or crash recovery
```

## Goals / Non-Goals

**Goals:**

- Store each provider-visible timeline item once and represent each provider step as a constant-size
  manifest over a timeline prefix.
- Reconstruct byte-equivalent logical requests for ordinary dispatch, Worker acknowledgement,
  unconfirmed-step recovery, restart, compaction, and continuation reset.
- Keep atomic prepared-step commit and fail closed on missing, reordered, cross-session, corrupt,
  or hash-mismatched references.
- Make fresh schema-v12 provider-ledger growth proportional to new events and compact manifests,
  not repeated complete history prefixes.

**Non-Goals:**

- Migrating, rewriting, or preserving an existing schema-v11 database.
- Adding a compatibility runtime for v11 logical request blobs.
- Changing provider HTTP payloads, Responses continuation behavior, tool replay, transcript
  retention, or content-blob compression.
- Adding automatic retention, garbage collection, checkpoint, or vacuum behavior.

## Decisions

### Reconstruct requests through the shared core projector

`SQLiteModelInputLedger` will load and validate the manifest's instruction snapshot, tool-set
snapshot, and exact V3 timeline prefix. The model-visible `ProviderInputTimelineEvent.item` values
are projected with the existing `@mycli/core` `projectProviderRequest` function and the manifest's
provider configuration. Reusing the same projector prevents storage from growing an independent
request-shaping implementation.

Reconstructing from generic transcript history was rejected because compaction and provider-native
items follow the provider timeline rather than the complete readable transcript. Storing per-step
JSON patches was rejected because the existing stable event identities and prefix manifest already
provide a typed delta representation.

### Use compact V3 prefix manifests

V3 removes V2 `orderedItems` and `timelineEventIds`. It stores `timelineWindowId`,
`timelineEventCount`, `timelinePrefixSha256`, and `timelineSha256` instead. Reconstruction selects
the first `timelineEventCount` rows in the named immutable window, verifies the prefix identity/hash
and projected timeline hash, and then projects the request. Later appends cannot change the selected
prefix because timeline rows are append-only.

Keeping complete event-id or reference arrays was rejected because those arrays repeat the stable
prefix on every provider step and remain quadratic even after the full request blob is removed.

### Retain a request hash, not a request blob

Schema v12 removes `logical_request_blob_id` from `provider_request_manifests` and keeps
`logical_request_sha256`. Commit normalizes the supplied request, computes this hash, validates it
against snapshots and manifest references, writes the manifest and lifecycle row atomically, then
reconstructs and verifies the same hash before returning success. Recovery repeats reconstruction
and hash validation without any full-request storage row.

The hash remains a separate relational column so doctor and recovery can detect projection drift or
corruption without trusting manifest JSON. Embedding the full request in the manifest was rejected
because it recreates the same write amplification.

### Require V3 manifests in schema v12

Only V3 manifests carry the compact timeline window, prefix count, and prefix hash required by this
storage model. Fresh-v12 commit therefore rejects V1/V2 manifests. Existing v1/v2 fixtures may remain available through
explicit test constructors, but production runtime dispatch does not open those schema versions.

### Make schema v12 fresh-only and fail closed

An empty database creates schema v12 directly. Runtime inspection accepts marker 12 and rejects
markers 10 and 11 with bounded expected/actual diagnostics; it does not stage, cut over, or mutate
them. The user archives the current database and starts fresh. Retaining a dual v11/v12 ledger path
was rejected because it preserves the full-request ownership model and its compatibility surface.

### Measure physical and logical growth

Acceptance uses a tool-heavy root-plus-subagent fixture with many provider steps. It asserts exact
request reconstruction and provider parity, zero logical-request content references, and database
growth that excludes repeated full request JSON. File-size results are measured after controlled
checkpoint/vacuum only in tests; normal runtime does neither automatically.

## Risks / Trade-offs

- **Projector drift changes recovery bytes** -> Use the shared core projector and compare every
  reconstructed request hash before commit returns or recovery dispatches.
- **A later timeline append changes an older request** -> Select exactly the manifest prefix length
  and validate ordered event identities before projection.
- **Compaction mixes timeline windows** -> Require the manifest's named window and reject references
  outside its exact prefix.
- **Crash recovery loses a provider request** -> Persist snapshots, events, manifest hash, and the
  `prepared` lifecycle row in one transaction; reconstruct only after the prepared row exists.
- **Fresh-only rollout loses current sessions** -> Fail closed on v11 and require an explicit manual
  archive; never mutate or delete the old database.

## Migration Plan

1. Build and validate schema v12 against temporary fresh databases.
2. Stop mycli before replacing the active database.
3. Archive `sessions.db`, `sessions.db-wal`, and `sessions.db-shm` together.
4. Start mycli and let it create a fresh schema-v12 database.
5. Roll back by restoring the archived v11 file set with a v11-capable binary; no in-place rollback
   or conversion is provided.

## Open Questions

None. The user explicitly chose fresh-only storage and no v11 migration.
