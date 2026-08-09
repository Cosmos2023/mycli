## Context

The Node runtime already has immutable instruction snapshots, tool-set snapshots, model-context events, exact logical request blobs, and persist-before-dispatch manifests. The missing layer is an ordered provider-input history. `model-input-pipeline.ts` currently recomputes the effective context and inserts it between prior conversation and the current user message on every turn. The same context therefore moves to a later array position as conversation grows.

Python mycli avoids this by persisting a provider timeline and appending only the unsynchronized conversation tail and changed context. Codex uses the same semantic model at a lower level: an oldest-to-newest `ResponseItem` history, a durable turn-context baseline, append-only context diffs, and explicit replacement history only at context-window boundaries.

The Node implementation must retain its stronger guarantees: every model-visible value is durable before dispatch, source-of-truth records are append-only, exact historical requests are reconstructable, tool call/result batches remain valid, and legacy sessions remain readable.

## Goals / Non-Goals

**Goals:**

- Preserve the complete prior provider input as an exact prefix during ordinary turns and tool loops.
- Append context updates or tombstones at the turn boundary immediately before the new user input.
- Make compaction, source reset, and legacy adoption explicit provider-input window boundaries.
- Separate provider configuration compatibility from the hash of growing timeline content.
- Preserve exact reconstruction, atomic persist-before-dispatch, provider authority, and tool replay invariants.
- Expose bounded structural diagnostics that explain the first prefix break without storing secrets or raw diagnostic payloads.

**Non-Goals:**

- Guarantee a provider-specific cache-hit percentage, TTL, or routing decision.
- Enable `previous_response_id` on transports that do not support it.
- Rewrite historical conversation, context, manifest, or transcript records.
- Change memory opt-in, compaction policy, tool output limits, or TUI transcript rendering.

## Decisions

### 1. Persist a provider-input timeline index

Add immutable `provider_input_timeline_events` ordered by SQLite sequence. Each event belongs to one session and one provider-input window and has one of four kinds: `window_boundary`, `conversation_item`, `context_update`, or `context_tombstone`. Model-visible events carry the complete canonical provider item plus its content hash; context events also reference the existing `model_context_events` row.

This deliberately does not replace `history_items`, `model_context_events`, or exact request blobs. It is the ordered model-input index needed to replay those facts without reclassification. A mutable cursor may cache the latest window but is never authoritative.

Alternative considered: derive the next request from the latest full request blob. That cannot reliably distinguish conversation items from previously injected context or detect source edits because current canonical items have no durable identity in the runtime API.

### 2. Project by strict source extension

For the current window, the projector compares previously synchronized conversation items with the provider-normalized canonical conversation by exact stable JSON. If the old source is a prefix, only the unsynchronized tail is appended. Changed context events are inserted immediately before the current user item when that item is in the unsynchronized tail; otherwise they are appended after the tail. Tool projection normalization runs before comparison so context cannot split an open tool-call/result batch.

If the source is not a prefix, the projector appends a new boundary and bootstraps that window from the current bounded contract and conversation. It never edits old events.

### 3. Treat context versions as chronological facts

Unchanged context does not produce a timeline event. Changed context appends a complete replacement item with a supersession reference. Removed context appends a bounded model-visible inactive marker and tombstone metadata. The prior item remains in the earlier prefix; the later event is authoritative by chronology.

Base instructions remain in the protocol's stable top-level instructions/system field. Dynamic developer fragments are no longer prepended on every request. They become chronological context items with developer authority. Providers with no developer role use their existing explicit compatibility mapping at the same timeline position. For DeepSeek this means a system-role item at that position, not merging the update back into the leading base system message.

### 4. Separate compatibility and growth hashes

The request signature contains only provider-visible semantic configuration: provider, protocol, model, base instruction snapshot, ordered tool-set snapshot, reasoning/output options, cache-hint capability, and other stable wire configuration. It excludes conversation and context timeline hashes.

Each manifest additionally records:

- `requestConfigurationSha256` for semantic configuration compatibility.
- `bootstrapPrefixSha256` for the immutable window bootstrap prefix.
- `timelineSha256` for the complete ordered current-window timeline.
- `commonPrefixItemCount` for the exact adjacent logical-request common prefix.
- `timelineWindowId` and ordered `timelineEventIds`.

Continuation remains a separate optimization: it requires an unchanged request signature, the same supported history boundary, and strict extension of prior input plus output. Prompt caching never depends on continuation support.

### 5. Make request commit atomic

Instruction/tool snapshots, model-context events, provider timeline events, the v2 request manifest, exact logical request, and the `prepared` lifecycle event are committed in one existing store write transaction. A failure at any point rolls back the complete provider step and prevents dispatch.

### 6. Use explicit windows for replacement history

The first timeline request creates a `bootstrap` boundary. Existing sessions with manifests but no timeline create `legacy_bootstrap`. Compaction creates `compaction`; an incompatible source edit creates `source_reset`. Forked sessions bootstrap their own window while retaining normal session lineage. Resume replays the latest window from immutable events.

## Risks / Trade-offs

- [Risk] Timeline events duplicate bounded canonical item payloads already present elsewhere. -> Keep them content-addressed through the existing blob store and use timeline rows as ordered references.
- [Risk] Dynamic developer messages in the middle of Chat history may be unsupported by a provider. -> Keep provider-specific role fallback explicit and cover each registry lane with wire-level tests; providers may map the role but must not move the item.
- [Risk] Legacy source normalization can differ from the historical request. -> Start a `legacy_bootstrap` window rather than pretending a strict prefix exists.
- [Risk] Context updates accumulate. -> Preserve append-only semantics until an explicit compaction window replaces active history.
- [Risk] A stable structural prefix can still miss a remote cache. -> Treat exact-prefix assertions as acceptance; report provider cache telemetry separately.

## Migration Plan

1. Add the new table, immutable triggers, v2 manifest parsing, and legacy readers without changing request behavior.
2. Add projector tests and storage round-trip/rollback tests.
3. Switch the durable runtime request path to timeline projection and remove dynamic developer prepending.
4. Add provider wire, resume, tool-loop, and compaction regressions plus bounded diagnostics.
5. Keep old manifests readable. Rollback may stop writing v2 events, but it must not delete them; sessions that already adopted the timeline remain exportable and can be resumed again after re-enabling the feature.

## Open Questions

None. Provider cache telemetry is observational and is not an implementation gate.
