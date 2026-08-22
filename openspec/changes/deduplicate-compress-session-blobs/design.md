## Context

Schema v10 makes `transcript_events` the canonical transcript authority, but its complete semantic
envelope is stored as inline JSON. Large strings therefore recur in compaction replacements and can
also recur across tool, context, image, and provider-state payloads. `model_input_blobs` already uses
the stable JSON SHA-256 as an immutable identity, but retains the full JSON as uncompressed text.
The 500-compaction benchmark consequently remains tens of MiB after v10 normalization.

The storage package must preserve exact provider, readable, search, lineage, recovery, and immutable
model-input projections. Node owns schema-v11 reads and writes; the retained Python reader remains
capped at schema v10 and rejects marker 11. Routine startup cannot scan or rewrite an existing
database, no third-party codec is justified, and the retired real v9 database is outside this
migration scope. Schema v11 therefore starts from supported schema v10 storage and new databases.

The cross-layer data flow is:

```text
typed semantic payload
  -> validate
  -> externalize eligible strings / compress unique bytes
  -> SQLite event + reference rows + contentless FTS terms
  -> bounded load / verify / decompress / hydrate
  -> existing typed projectors and provider adapters
```

Compression and reference encoding belong entirely to `@mycli/storage`. Runtime, gateway, TUI, and
provider layers continue to exchange the existing typed semantic objects.

## Goals / Non-Goals

**Goals:**

- Store each unique large UTF-8 value once across transcript events and compressible model-input
  payloads.
- Preserve byte-for-byte semantic JSON after hydration and keep all current projections, hashes,
  ordering, compaction, fork, recovery, and request reconstruction behavior.
- Make Node decompression bounded, hash-verified, deterministic, and standard-library only.
- Keep search match sets and bounded snippets without a second plaintext copy of searchable
  payloads.
- Provide resumable v10 staging, short atomic v11 cutover, read-only diagnostics, explicit orphan
  collection, and separate vacuum.
- Measure logical, physical, latency, and memory effects on tool-heavy and 500-compaction profiles.

**Non-Goals:**

- Migrating or repairing the retired real v9 database.
- Age-, count-, or size-based session retention, provider-ledger retention, or automatic session
  deletion.
- Compressing shell chunk tables, trace files, task artifacts, or arbitrary runtime state in this
  phase.
- Changing provider wire payloads, transcript RPC shapes, prompt hashes, or compaction semantics.
- Automatically vacuuming or running a full blob-integrity scan during normal startup.
- Encrypting content at rest or introducing a third-party compression dependency.
- Adding Python schema-v11 decompression, reference hydration, projections, or shared-corpus parity;
  Python remains a fail-closed schema-v10 reader.

## Decisions

### Add a shared immutable content store in schema v11

`session_content_blobs` stores `blob_id`, `codec`, declared raw/stored byte counts, a BLOB payload,
and first-created time. `blob_id` is `sha256:<lowercase hex>` over the uncompressed bytes. Codecs are
`identity-v1` and deterministic raw DEFLATE (`deflate-raw-v1`, level 6). Values smaller than 1,024
UTF-8 bytes remain inline. Eligible values use DEFLATE only when it saves at least 64 bytes after
storage overhead; incompressible values still receive content addressing with `identity-v1`.

Every read enforces the codec allowlist, a 32 MiB declared-raw bound, exact decompressed byte count,
UTF-8 validity where required, and the SHA-256 digest. Blob rows are immutable. Deletion is allowed
only when no durable reference row points to the blob, enabling explicit garbage collection.

Using gzip was rejected because its wrapper metadata complicates deterministic stored bytes. Brotli
or Zstandard was rejected because raw DEFLATE already provides the required standard-library savings
without adding another codec and compatibility surface. SQLite page-level compression was rejected
because it is not available in the bundled cross-platform runtime and would not deduplicate repeated
compaction content.

### Externalize large transcript strings through reference rows

The encoder walks the already validated semantic payload in deterministic object-key/array order.
Each string at least 1,024 UTF-8 bytes is replaced by `null` in the stored envelope and recorded in
`transcript_event_blob_refs(sequence_no, json_pointer, blob_id)`. JSON Pointer paths use RFC 6901
escaping. Hydration starts from the stored envelope, applies the sorted reference rows, and only
then calls `parseTranscriptEventEnvelope`.

Reference rows, rather than magic JSON objects, prevent legitimate user/tool metadata from being
mistaken for a blob marker. Foreign keys prove that every reference resolves and cascade reference
cleanup with its owning event. Doctor additionally verifies that each path exists, targets the
expected placeholder, appears once, and produces a valid typed event after hydration.

Externalizing whole event objects was rejected because small identity/order fields would be hidden
behind decompression and exact duplicate events are uncommon. Leaf-string extraction captures the
dominant tool output, arguments, images, context, provider state, summaries, and compaction
replacement text while allowing repeated values to deduplicate across otherwise different events.

### Reuse compressed content for immutable model-input blobs

The existing `model_input_blobs.blob_id` remains the SHA-256 identity used by snapshots, context
events, timeline events, and manifests. In v11 its `payload_json` contains only a bounded storage
marker, while `model_input_blob_refs(blob_id, content_blob_id)` references the compressed stable JSON
bytes. Reconstruction verifies both the content-store digest and the existing `modelInputBlob`
identity before returning a typed value.

Keeping the existing identity table avoids rewriting every provider-ledger foreign key and preserves
manifest/request hashes. A separate reference row provides relational integrity that a JSON marker
alone cannot provide. Existing v10 payloads stay authoritative until final cutover.

### Use a contentless FTS5 index populated from hydrated canonical JSON

Schema v11 replaces the external-content table with FTS5 `content=''` and
`contentless_delete=1`. The event write transaction computes the same canonical semantic payload
JSON before externalization and inserts its terms under the event `sequence_no`. Search continues to
join the rowid to `transcript_events`, hydrates the typed event, applies lineage/workspace visibility,
and builds the existing bounded snippet from the search projector.

The FTS table stores tokens but cannot return canonical content. That is intentional: SQLite remains
the index, while transcript events plus referenced blobs remain the only source for text. Insert,
delete, rebuild, migration, rank, punctuation, and matching-set tests cover synchronization. The
bundled SQLite 3.53 runtime supports `contentless_delete`.

Retaining inline searchable text was rejected because tool output would remain the largest duplicate.
Registering a process-specific SQL decompression function was rejected because read-only doctor and
SQLite inspection paths must validate the database without custom connection functions.

### Keep blob writes inside the owning transaction

For a new semantic action, the repository validates and encodes first, then within its existing
`BEGIN IMMEDIATE` transaction inserts missing immutable blobs, the event, reference rows, and FTS
terms before committing mutable turn state. A hash collision, compression failure, reference error,
or FTS failure rolls back the complete action. `INSERT ... ON CONFLICT DO NOTHING` is followed by
exact metadata/content verification so a conflicting row never passes silently.

The blob codec and tree externalizer are shared by transcript and model-input repositories. Runtime
and provider code never receives stored payload markers, codecs, or blob ids.

### Make v10-to-v11 conversion explicit, resumable, and fail closed

`/session maintenance --apply-content-blobs` creates deterministic staging rows and processes bounded
transcript/model-input batches while schema v10 remains authoritative. Staging records source hashes,
encoded payloads, reference paths, content ids, progress, raw bytes, stored bytes, and estimated
headroom. Ordinary v10 writes continue; later batches consume the tail.

Final cutover acquires `BEGIN IMMEDIATE`, rechecks the version, reconciles the tail, validates source
coverage and exact provider/readable/search/lineage/recovery/provider-ledger manifests, installs the
blob/reference tables, replaces FTS, rewrites only storage representations, and writes marker 11
last. Every stage has a rollback/retry failpoint. A failure leaves v10 semantic rows and marker
authoritative; staged data is safe to resume or explicitly discard.

New empty databases create v11 directly. Runtime dispatch reads v9 with the legacy store, v10 with
the inline event repository, and v11 with blob hydration. Automatic startup migration was rejected
because compression is proportional to database size and can require significant WAL/headroom.

### Report savings and collect only proven orphans explicitly

Read-only maintenance and doctor report blob count, reference count, raw/stored unique bytes,
compression ratio, deduplicated reference bytes, inline eligible bytes, orphan count/bytes, invalid
codec/count/hash/reference counts, migration progress, and required temporary space without content,
paths, ids, or hashes. Explicit orphan collection deletes only content rows absent from both
transcript and model-input reference tables and reports logical bytes. Physical shrinkage is reported
only by the existing explicit vacuum action.

Reference-count columns were rejected because they are mutable counters that can drift after rollback
or cross-process failure. Reachability is computed from the indexed reference tables when reporting
or collecting.

## Risks / Trade-offs

- **Hydration increases CPU and allocations on resume** -> Keep small strings inline, load only the
  newest compaction window/suffix, batch blob reads, cache duplicate blobs within one repository
  operation, and benchmark latency/RSS.
- **A corrupt compressed value expands unexpectedly** -> Enforce declared/raw bounds before and
  during decompression, verify exact size and SHA-256, and expose only bounded structural errors.
- **FTS terms drift from hydrated payloads** -> Populate index and refs in the same transaction,
  add semantic rebuild/integrity checks, and validate exact search match sets across v10/v11.
- **Staging temporarily grows the database** -> Report headroom, batch commits, reuse blobs by hash,
  reconcile only the tail under the final lock, and keep vacuum separate.
- **Reference paths become a second schema** -> Use one shared encoder/hydrator with RFC 6901 tests,
  validate typed events after hydration, and never expose paths above storage.
- **Compression saves disk but hurts incompressible images** -> Select identity deterministically
  when DEFLATE misses the minimum saving; deduplication still applies.
- **Model-input reconstruction hashes change** -> Preserve existing `blob_id` semantics and compare
  complete ledger manifests before marker 11 is written.

## Migration Plan

1. Add the codec, externalizer/hydrator, analyzer, and corruption tests without changing schema v10.
2. Add final schema-v11 new-database objects, contentless FTS, transcript/model-input repository
   integration, and shared Node v10/v11 corpus tests.
3. Add v10 dry-run, bounded staging, tail reconciliation, manifest validation, failpoints, and atomic
   cutover behind the explicit maintenance command.
4. Run supported synthetic v10 migrations, doctor, provider/readable/search/recovery/ledger parity,
   interruption/retry, cross-process, low-disk, and orphan-collection tests.
5. Benchmark tool-heavy and 500-compaction v10/v11 databases before and after explicit vacuum.
6. Keep a v10 backup through the compatibility window. Rollback after successful cutover restores
   that backup; schema-v10-only binaries reject marker 11.

## Open Questions

- Whether a later phase should apply the same content store to shell chunks and task artifacts;
  default for this change is no because their retention and access patterns differ.
- Whether provider-ledger retention should eventually make old `model_input_blobs` collectible;
  default for this change is no, so existing immutable ledger retention remains unchanged.
