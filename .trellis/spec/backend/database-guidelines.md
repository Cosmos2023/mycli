# Database Guidelines

## Error Context Format Fence

Runtime stores now write format 15 (including the format-14 error contract). The v12/v13 upgrade preserves transcript
bytes and uses the existing transactional migration boundary. Enriched failures
are gated by `store.errorContextVersion === 1`; pre-14 writers reject them.
The same occurrence must survive tool results, completed effects, provider
attempts, terminalization and its lifecycle outbox. Provider-visible conversation
content must not acquire diagnostic metadata. See `error-handling.md` and
`docs/errors.md` for rollback requirements and uncommitted-storage diagnostics.

> Database patterns and conventions for this project.

---

## Overview

<!--
Document your project's database conventions here.

Questions to answer:
- What ORM/query library do you use?
- How are migrations managed?
- What are the naming conventions for tables/columns?
- How do you handle transactions?
-->

(To be filled by the team)

---

## Query Patterns

- Constructors that open SQLite own the connection even when initialization fails. Close the
  opened connection before propagating a schema or migration failure; no caller receives an
  object it could close. The failed-migration regression immediately renames the database on
  Windows to prove the handle is released, then verifies rollback and successful retry.
- SQLite fixtures close primary, reopened and inspection connections in per-test hooks before
  deleting their directories. `test/fixtures/directory-cleanup.ts` queues test-owned directories
  for the enclosing file's final hook; runtime and app SQLite fixtures reuse this test-only helper.
  Cleanup failures remain test failures; do not use retries
  to conceal an open database or delete leftover directories from unrelated test runs.

- `SQLiteSessionStore` is the canonical store for local session runtime state under
  `~/.mycli/sessions.db`.
- Writes must go through the store's write-transaction helper rather than opening
  ad hoc write connections. The helper owns `BEGIN IMMEDIATE`, process-local
  locking, locked/busy retry with jitter, and periodic passive WAL checkpoints.
- Root runtime ownership uses the operational `session_runtime_leases` table. It intentionally has
  no `sessions` foreign key because a fresh virtual session must be owned before its first durable
  turn. Acquire and stale-PID takeover run under `BEGIN IMMEDIATE`; release always matches
  `session_id` plus `owner_id`, and repository close removes only the current owner's leases. A
  backend retains leases for every root runtime loaded during its lifetime because inactive-session
  background resources can still write. Fork and agent-child targets acquire this lease in the same
  transaction that creates or reserves them; a live `agent_runtime_leases` row prevents a root
  runtime from acquiring that child concurrently. Repository startup removes root leases whose PID
  is no longer live. Empty-session and orphan cleanup compute live root/agent runtime ids inside the
  cleanup write transaction and skip them, including leased virtual sessions without a `sessions`
  row.
- Read-only queries may use a short-lived connection and should return typed
  domain payloads rather than exposing SQLite rows outside the infrastructure
  layer.
- Session lineage queries must respect `conversation_trees.parent_id` and
  `fork_point`; do not concatenate parent and child transcripts blindly because
  forked child conversations include the parent prefix.
- Resume target ids must exist before lineage traversal. Treat a row in
  `sessions`, `conversation_trees`, or `conversation_messages` as valid resume
  evidence so legacy message-only sessions still work; a completely missing id
  must raise a clear error instead of returning an empty conversation.
- When resuming an ancestor with multiple child branches, automatic root-to-tip
  resolution chooses one child at each step by `sessions.last_active_at DESC`,
  then `sessions.updated_at DESC`, then `conversation_trees.session_id DESC`.
  This deterministic tie-breaker is part of the resume contract until an
  explicit branch picker exists.
- A child `fork_point` is bounded by both the child conversation and the parent
  conversation segment it references. Doctor/session integrity checks must fail
  if `fork_point` is negative, exceeds child message count, or exceeds parent
  message count when `parent_id` is set.
- Pending approval recovery is a DB integrity concern: a persisted
  `pending_decision` must have either valid explicit `suspended_turn` state,
  a waiting-approval `turn_record` with `user_message`, or a waiting-approval
  rollout plus matching user history item. Doctor reports missing evidence
  read-only instead of clearing state.
- Pending clarification recovery is also a DB integrity concern: a
  `suspended_turn` with `pending_clarification` must have a non-blank explicit
  `user_message`, a waiting-clarification `turn_record` with `user_message`, or
  a waiting-clarification rollout plus matching user history item. Doctor
  reports missing evidence read-only instead of clearing suspended state.
- Cold session activation calls `interruptSessionForResume(sessionId)` only after acquiring
  the session runtime lease. In one write transaction, validate recovery references, interrupt
  unfinished turns, close pending tool calls, and clear approval/clarification continuation
  state. Opening storage, inspecting history, or attaching to an existing live backend must
  not invoke this transition. Repeated activation must not duplicate interruption records.
- Recovery preserves committed tool results, including a crash between approval-result commit
  and continuation cleanup. A matching completed effect checkpoint permits the continuation
  to reference its already-completed canonical call. An unknown claimed effect closes all
  remaining calls in its turn; reuse completed sibling results and never execute tools during
  recovery. Cover these crash boundaries and transaction rollback in storage regression tests.
- Session maintenance "empty session" detection must treat runtime state as
  durable session content. A session is empty only when it has no
  `conversation_messages`, no `session_summaries`, no `history_items`, no
  `turn_rollouts`, and no `session_state` rows. Runtime-only sessions must not
  appear as cleanup candidates.
- Session message search is an explicit local query path only. Use
  `SessionStore.search_messages(query, workspace_root=..., limit=...)` for
  user-triggered lookup such as `/search <query>`; do not run it automatically as
  recall or inject results into provider-visible transcript replay.
- Search responses must be bounded domain payloads (`SessionSearchResult`) with
  `session_id`, `message_index`, `role`, and a short `snippet`. Do not return raw
  SQLite rows or unbounded message JSON to CLI/TUI callers.
- Resumable session state and regenerable `session.json`/subagent artifacts use dedicated recent-row
  APIs: 2,000 raw history rows, 2,000 rollout rows, and at most 500 projected items. If the history
  boundary splits the earliest turn, omit that incomplete turn from the snapshot projection.
- `transcript.load` is a separate complete-history projection. Rebuild all filtered user-visible
  items from canonical `history_items`/`turn_rollouts`, exclude `compaction_boundary` replacements
  and other model-only rows, and use the opaque versioned `before` cursor plus an item `limit` of at
  most 500 for bounded page delivery without making old turns unreachable. Read history by
  descending `sequence_no`, load rollouts only for page turn ids, and keep every complete turn on
  one page even when that makes an exceptional page exceed its requested projected-item target.
  On the first page only, a session with no canonical `history_items` rows falls back to the existing
  legacy `conversation_messages` projection; never mix that fallback into a canonical cursor chain.
- Provider reconstruction is a third projection. After repeated compactions it loads only the
  latest valid replacement plus canonical conversation rows after that boundary. Never reuse the
  bounded artifact snapshot or the complete UI transcript as provider input; prompt-cache keys,
  model-input manifests, and Responses continuation follow the effective provider window.

---

## Scenario: Delayed Interruption Display Order

### Scope And Entry Points

- Trigger: recovery appends interruption records after newer user inputs, or a late Shell
  lifecycle snapshot is persisted after subsequent turns.
- `projectTranscript(historyItems, turnRollouts, options): readonly TranscriptItem[]` owns
  interruption placement after merging tool calls, results, and Shell snapshots.
- `SQLiteTranscriptEventRepository.loadReadableTranscriptPage(sessionId, options)` returns
  `TranscriptReadablePage` with ordered `items` and an exclusive `nextBeforeSequence` cursor.

### Contracts

- Identify interruption notices by `turnInterruptedNoticeId(turnId)` or
  `metadata.event_kind === "turn_interrupted"`. Associate them by turn identity; repeated
  user text and recovery timestamps are not ordering keys.
- Place one terminal notice immediately after the last visible item belonging to its turn,
  after tool result merging. Apply this to both persisted and synthesized notices before
  slicing projected items. Preserve unanchored notices and ordinary warning positions.
- Readable pagination must keep overlapping turn intervals together, even when intervening
  events belong to other turns. A delayed record extends its group back to the earliest
  event of its originating turn. Legacy call-scoped Shell activity also extends the group
  back to its originating assistant tool call. Carry pending groups across raw event windows.
- Use the same grouping rule for inherited fork history, with session-scoped identity
  lookups. An exceptional complete group may exceed the requested item limit. Its cursor
  advances past every event needed to build that group, without dropping older groups.
- These are read projection rules. Preserve append-only event sequence, provider input
  order, and database rows; no schema migration or transcript rewrite is required.
- Cache originating turn/call lookups within a page load. Use the existing turn index for
  turn boundaries, and resolve legacy call-scoped Shell references only when needed.

### Cases And Verification

- Three equal-text inputs followed by delayed recovery display as
  `user 1, interrupted 1, user 2, interrupted 2, user 3, interrupted 3`.
- A late Shell snapshot updates its original tool row. It does not create a detached tool
  result between newer inputs and their interruption notices.
- Cover persisted/synthesized and duplicate notices, ordinary warnings, and unchanged raw
  history in projector tests. Verify complete history, recent history, paginated history,
  inherited forks, and groups crossing the 2,000-event raw window.
- Exercise gateway serialization, TUI page reducers, and headless terminal rendering at
  narrow and wide terminal widths. Keep provider projection regression coverage passing.

---

## Migrations

- `SQLiteSessionStore.SCHEMA_VERSION` is the schema anchor for future migration
  work.
- `mycli doctor` must validate `schema_version` and required search FTS objects
  read-only. It reports missing/stale objects as diagnostics and must not repair
  them by opening `SQLiteSessionStore` from the doctor path.
- Additive schema changes should preserve existing session rows and be covered by
  a regression test that initializes a legacy DB shape, opens it through
  `SQLiteSessionStore`, and verifies existing messages still load.
- The schema-v8 transcript projection indexes `idx_history_items_session_sequence`,
  `idx_turn_rollouts_session_sequence`, `idx_turn_rollouts_session_turn_sequence`, and
  `idx_session_summaries_session_sequence` support bounded tail, page-rollout, and recent-summary
  projection. Opening a current database checks only these four named indexes and creates them
  transactionally when missing without rewriting the current marker. This narrow compatibility
  exception must not replay table DDL, FTS backfills, or the schema-version write.
- Schema v9 uses an external-content `conversation_messages_fts` projection over
  `conversation_messages.payload_json` and removes the unused `history_items_fts` projection.
  Opening a supported legacy DB must rebuild the conversation index transactionally without
  rewriting or deleting canonical messages. Current-version startup must not rebuild it.
- Do not move or rewrite `~/.mycli/sessions.db` as part of storage layout work.

## Scenario: Version-Gated SQLite Initialization

### 1. Scope / Trigger

- Trigger: changing `SQLiteSessionStore` construction, schema SQL, FTS backfill, or
  `SCHEMA_VERSION` migration behavior.

### 2. Signatures

- Schema anchor: `SCHEMA_VERSION` in `backend/packages/storage/src/schema.ts`.
- Migration entry: `SQLiteSessionStore.#initialize()`.
- Durable commit marker: the single integer row in `schema_version`.

### 3. Contracts

- Read `schema_version` before acquiring a migration write lock. If it equals the current
  `SCHEMA_VERSION`, perform only the bounded transcript-index presence check, then return without
  replaying table DDL, FTS backfills, or a version-row rewrite.
- A missing version table or supported older version enters the additive migration inside the
  store's `BEGIN IMMEDIATE` transaction.
- After acquiring the migration write lock, read and validate the version again. A concurrent mycli
  instance may have completed migration while this instance was waiting; the second instance must
  then take the current-version fast path inside the transaction.
- The version row is written only after all schema objects, ownership columns, and FTS backfills
  complete. Transaction rollback must prevent a current version from being observable with a
  partially applied migration.
- Current-version corruption is a doctor/integrity failure, not an implicit startup repair. Do not
  make every normal startup scan or rebuild current schema objects to mask external corruption.

### 4. Validation & Error Matrix

| Stored version | Required behavior |
| --- | --- |
| No version table or row | Initialize the complete current schema transactionally |
| Supported v2-v8 | Run additive migration and preserve existing rows |
| Current version | Open without schema write, DDL replay, or FTS backfill scan |
| Current version missing a transcript projection index | Create only the four compatibility indexes without rewriting the version marker |
| Unsupported numeric version | Fail with bounded expected/actual version diagnostics |
| Invalid non-numeric version | Fail with a bounded null actual version |
| Concurrent migration completes first | Recheck under lock and skip duplicate migration |

### 5. Good/Base/Bad Cases

- Good: reopening a large v9 database with all four transcript projection indexes performs bounded metadata reads
  and immediately continues to
  runtime recovery.
- Base: a new empty path creates v9 and writes its commit marker once.
- Bad: execute every `CREATE ... IF NOT EXISTS`, rebuild conversation FTS, and delete/reinsert the v8
  marker on every CLI startup.

### 6. Tests Required

- Assert a current database reopens even when a test trigger rejects deletion of its version row.
- Keep new-database schema-shape coverage for all required tables, indexes, and immutable triggers.
- Keep explicit v2 through v8 migration fixtures and verify preserved data plus current output.
- Keep a current-v9 compatibility fixture that removes transcript projection indexes, rejects
  version-row deletion, and verifies the indexes are restored without rebuilding FTS.
- Keep unsupported and malformed version failures bounded and free of database payloads.
- Profile a representative populated database when changing initialization so migration work cannot
  silently return to the routine startup path.

### 7. Wrong vs Correct

#### Wrong

```typescript
this.#write(() => {
  this.#database.exec(ALL_SCHEMA_SQL);
  this.#database.exec(BACKFILL_SEARCH_SQL);
  this.#rewriteSchemaVersion();
});
```

#### Correct

```typescript
const version = this.#schemaVersion();
this.#assertSupportedSchemaVersion(version);
if (version === SCHEMA_VERSION) return;

this.#write(() => {
  const lockedVersion = this.#schemaVersion();
  if (lockedVersion === SCHEMA_VERSION) return;
  this.#migrateToCurrentVersion();
});
```

## Scenario: Append-Only Provider Timeline Prefix Reconstruction

### 1. Scope / Trigger

- Trigger: changing `SQLiteModelInputLedger.commitProviderStep()`,
  `reconstructProviderStep()`, V2 provider manifests, timeline window append behavior, or
  Worker-to-in-process rollback reads.

### 2. Signatures

- Commit: `ModelInputLedgerStore.commitProviderStep(input) -> CommittedProviderStep`.
- Reconstruct: `ModelInputLedgerStore.reconstructProviderStep(requestId) -> CommittedProviderStep`.
- V2 manifest fields: `timelineWindowId`, ordered `timelineEventIds`, `orderedItems`,
  `commonPrefixItemCount`, and `previousManifestId`.

### 3. Contracts

- A V2 manifest is an immutable snapshot of the provider-visible timeline at one provider step.
  Its `timelineEventIds` are the complete ordered window prefix visible at commit time.
- Later provider steps may append durable events to the same `timelineWindowId`. Those later rows do
  not mutate or invalidate an earlier manifest.
- Reconstruction loads the current durable window, selects the first
  `manifest.timelineEventIds.length` rows, and requires exact ordered identity equality with the
  manifest. The model-visible rows in that same prefix must exactly equal the manifest's ordered
  `provider_timeline_event` references.
- Content hashes, snapshot references, logical request blobs, prepared lifecycle state, and every
  manifest row remain immutable and are still independently validated.

### 4. Validation & Error Matrix

| Durable state | Required behavior |
| --- | --- |
| Window exactly equals manifest prefix | Reconstruct the committed request |
| Same window has valid later appended rows | Reconstruct the old request from its prefix |
| A row inside the manifest prefix is missing, reordered, or replaced | Fail with `persistence_error` |
| Manifest references omit or reorder a model-visible prefix row | Fail with `persistence_error` |
| Later rows belong to another window | Ignore them for this manifest; validate its named window only |

### 5. Good/Base/Bad Cases

- Good: Worker step 1 and step 2 append to one window; after restart, the in-process adapter can
  reconstruct both requests and continue from step 2.
- Base: a one-step window exactly matches its only manifest.
- Bad: compare an old manifest with every row currently in the window and report corruption merely
  because a later step appended canonical events.

### 6. Tests Required

- Commit two provider steps into the same window, close/reopen SQLite, reconstruct the second and
  then the first request, and assert exact request equality for both.
- App integration must complete a Worker tool turn, restart without the Worker gate, read the old
  manifest chain, and complete another turn without duplicate tool effects.
- Existing corruption tests must continue rejecting missing, reordered, hash-mismatched, and
  incomplete-prefix references.

### 7. Wrong vs Correct

#### Wrong

```typescript
assertDeepEqual(allCurrentWindowEventIds, oldManifest.timelineEventIds);
```

#### Correct

```typescript
const committedPrefix = allCurrentWindowEventIds.slice(0, oldManifest.timelineEventIds.length);
assertDeepEqual(committedPrefix, oldManifest.timelineEventIds);
```

## Scenario: Readable Node Session Artifact Projection

### 1. Scope / Trigger

- Trigger: changing Node session snapshots, background task output, subagent lifecycle persistence,
  or restart repair beneath `~/.mycli/sessions/<session-id>/`.

### 2. Signatures

- Canonical store: `SQLiteSessionStore` at `~/.mycli/sessions.db`.
- Artifact store: `SessionArtifactStore.appendEvent`, `writeTaskOutput`, and
  `writeSubagentSnapshot`.
- Snapshot store: `TranscriptSnapshotStore.write` and `loadOrRebuild` with schema version 2.
- Recent snapshot window: `SQLiteTranscriptEventRepository.loadReadableTranscriptSnapshot` returns
  bounded `items` plus `coverage`; `loadRecentReadableTranscript` delegates to the same projection.
- Paths: `events.jsonl`, `tasks/<safe-task-id>/output.txt`, and
  `subagents/subagent-<first-16-sha256-chars>.json` under the parent session directory.

### 3. Contracts

- SQLite is authoritative for provider replay, task status, recovery, and index reconstruction.
- JSON/JSONL files are private, bounded, readable projections and never replace canonical rows.
- Schema-v2 snapshots optionally include `session`, `last_request`, and `coverage`. Session metadata
  retains thread/title/lineage/compaction status; request summaries retain provider/model and context
  snapshot references only. Never serialize provider configuration wholesale, native transport,
  request bodies, credentials, or encrypted reasoning into these additions.
- Coverage describes at most 2,000 raw events after partial-turn removal and 500 projected items.
  Report raw event boundaries, omitted items in the window, and whether older events exist; do not
  scan full ordinary-session history to count omissions. `history_truncated` covers omitted history,
  while `truncated_items` counts retained truncated previews. Empty windows use null boundaries and
  may still indicate omitted history. Absent coverage in legacy files means unknown coverage.
- `message_count` remains the provider conversation item count, not the readable item count.
  `last_request.model_input_event_count` is available for manifest v2/v3 timeline events and is not
  a token estimate. The last request can precede the current selected model.
- Terminal turn snapshots append one complete `conversation.saved` JSONL row after SQLite commit.
- Assistant text emitted alongside a tool-call batch is one transcript message before that batch.
  Persist it once as an `assistant_message`; tool-call history rows keep empty display text and
  retain only their structured call identity and arguments. Never copy the same assistant preamble
  into every sibling tool row.
- Readable transcript projection may repair legacy Node tool rows that contain the duplicated
  preamble by emitting one assistant item and clearing only the projected tool text. This is a
  read-time compatibility repair: it must not rewrite SQLite history or canonical conversation
  rows. Safe tool targets such as a validated Skill name may be allowlisted into snapshot metadata.
  Built-in tool `metadata.input` retains only explicit fields by tool name (Read file/range, Shell
  cwd/tty, discovery query, file/image targets, and legacy search conditions); arbitrary arguments,
  environment values, mutation input bodies, and private rationale remain excluded. Project and
  sanitize through the same allowlist so degraded loading preserves these details.
- Long text, output, commands, selected input fields, and diffs use bounded head/tail previews.
  Truncation flags survive call/result/Shell merging and repeated snapshot sanitization; item
  `omitted_chars` is the maximum individual omission rather than a sum across fields.
- Live subagent updates atomically replace the subagent JSON, refresh the parent snapshot index,
  and append `subagent.updated`; restart repair does not invent historical event rows.
- Terminal subagent notifications include `<output-file>` only after the child-session task output
  exists. Background Shell output uses the shell id as its safe task id.
- Backend artifact operations are serialized and drained before SQLite closes. Auxiliary artifact
  failures do not roll back committed SQLite state.

### 4. Validation & Error Matrix

- Blank, `.`, path-like, traversal-like, NUL-bearing, or angle-placeholder identity -> reject
  before filesystem mutation.
- Malformed optional `subagents`, `links.events`, `session`, `last_request`, or `coverage` snapshot
  metadata -> reject the snapshot. Coverage counts must agree with the sanitized transcript.
- SQLite available with a stale valid snapshot -> return and rewrite the canonical SQLite
  projection.
- Atomic task/subagent write fails before rename -> preserve the old target and remove the temp.
- Derivable artifact missing on writable session preparation -> rebuild it from durable rows.
- SQLite unavailable with a valid schema-v2 snapshot -> bounded read-only degraded history only.

### 5. Good/Base/Bad Cases

- Good: a completed background child produces a readable output file, deterministic snapshot,
  indexed parent snapshot, live event row, and notification path.
- Base: a session without tasks has `session.json`, `events.jsonl` after a terminal turn, and an
  empty bounded subagent index.
- Bad: recover provider context from `session.json`, parse `events.jsonl` as canonical history, or
  close SQLite while queued artifact work is still running.

### 6. Tests Required

- Storage unit tests assert paths, private modes, deterministic hashes, JSONL rows, traversal
  rejection, atomic cleanup, enriched degraded loading, and stale-snapshot repair.
- Coverage regressions include empty and hidden-only windows, item/raw limits, inherited history,
  incomplete earliest turns, old manifest/v2 compatibility, and long command/input/diff round trips.
- Storage projection tests assert a non-empty assistant tool preamble appears exactly once before
  sibling tools, new tool rows contain no duplicated preamble, and legacy rows project the same
  visible order without mutating durable history.
- Runtime tests assert background Shell output projection, foreground exclusion, lifecycle order,
  and contained projection failure.
- Backend integration tests assert parent/child events, task output, subagent JSON/index,
  `<output-file>`, close draining, and restart reconstruction after deleting derived files.

### 7. Wrong vs Correct

#### Wrong

```typescript
const history = JSON.parse(await readFile("session.json", "utf8"));
store.restoreConversation(history.transcript);
```

#### Correct

```typescript
const canonical = canonicalSnapshot(store, overview, false, false, false);
await artifactQueue.run(() => transcriptSnapshots.write(canonical));
```

## Scenario: Repeated Compaction Resume Projections

### 1. Scope / Trigger

- Trigger: changing `commitCompaction`, `loadConversationItems`, readable transcript projection,
  `transcript.load`, session preparation, or transcript snapshot generation.

### 2. Signatures

- Provider window: `SQLiteSessionStore.loadConversationItems(sessionId)`.
- Complete display history: `projectReadableSessionTranscript(store, sessionId)`.
- Bounded prepared/artifact history: `projectRecentSessionTranscript(store, sessionId)`.
- Gateway page: `transcript.load({session_id, before?, limit?}) -> {items, next_before}`.

### 3. Contracts

- Local summaries use the normal transcript text storage path without a separate summary-length
  ceiling. The compact checkpoint's replacement-message schema must accept text beyond the legacy
  65,536-character suspended-message bound. Large summaries remain complete after reopening.
- Every successful compact appends one immutable `compaction_boundary`; raw `history_items`,
  `turn_rollouts`, and `conversation_messages` remain append-only.
- Provider reconstruction selects the newest valid boundary by `sequence_no DESC`, installs its
  `replacement_messages`, and appends only conversation rows at or after its
  `source_message_count`. Older boundary replacements must not be stacked into model input.
- Complete display reconstruction reads all canonical history and rollouts, filters model-only
  rows including `compaction_boundary`, and preserves visible turns on both sides of every compact.
- Writable session preparation and regenerable artifacts retain only the recent 2,000 raw rows and
  500 projected items. This bounded snapshot is not the complete transcript and is never provider
  input.
- `transcript.load` uses complete display reconstruction for current and inactive writable
  sessions. `before` and `limit` bound response pages without making older visible items
  unreachable. Only a SQLite-unavailable read-only session may fall back to its bounded snapshot.
- Shell display activity may use its `call_id` as the durable `turn_id`. Readable pagination must
  join an adjacent call-scoped lifecycle row to its originating tool call/result by `call_id` before
  projecting the page. Otherwise resume can split one Shell execution into duplicate cards and
  expose provider-only result framing such as chunk identifiers as user-visible command text.

### 4. Validation & Error Matrix

| Durable/request state | Required behavior |
| --- | --- |
| Multiple valid completed boundaries | Use only the newest replacement for provider input; retain every visible display turn |
| Boundary source count exceeds canonical conversation length | Fail with bounded `persistence_error` |
| Boundary replacement is malformed or exceeds 4,096 messages | Fail with bounded `persistence_error` |
| `before` names a current projected item | Return items strictly before it and a further cursor when available |
| `before` is missing or stale | Return the newest requested page; do not mutate history |
| SQLite unavailable with valid schema-v2 artifact | Return bounded read-only display history and reject turn submission |

### 5. Good/Base/Bad Cases

- Good: after three compactions, `/resume` prepares 500 recent items, the provider receives the
  third replacement plus its suffix, and transcript pages can still reach turn one.
- Base: an uncompacted short session produces the same visible and provider ordering as before.
- Bad: pass the bounded prepared transcript into the provider, or append every boundary replacement
  to the next request.

### 6. Tests Required

- Storage test with at least two completed boundaries must assert exact latest-window provider
  messages and complete filtered visible messages.
- Projection test must assert boundary summaries/replacements are absent from display output.
- Gateway tests must fetch more than 500 items across `next_before`, for both current and inactive
  writable sessions.
- Projection tests must place Shell display activity under its call id, keep the surrounding tool
  call/result under the owning turn id, and prove paged output equals complete output without
  provider-only Shell result framing.
- Long-history benchmark must seed multiple boundaries and fail on a new compaction request,
  pre-boundary provider content, missing oldest/latest transcript items, visible boundary markers,
  or incorrect retained tool lifecycle counts.

### 7. Wrong vs Correct

#### Wrong

```typescript
const transcript = projectRecentSessionTranscript(store, sessionId).items;
runtime.bootstrap(transcript);
```

#### Correct

```typescript
const providerWindow = store.loadConversationItems(sessionId);
const transcriptPage = paginate(projectReadableSessionTranscript(store, sessionId).items, request);
```

---

## Scenario: Normalized Transcript Event Store

### 1. Scope / Trigger

- Trigger: changing schema-v10 transcript writes, provider/readable/search projections, or the
  `transcript_events_fts` synchronization protocol.
- Schema v9 remains the default runtime store until normalization cutover passes its migration and
  parity gates; schema v10 initialization must remain explicit.

### 2. Signatures

- New database: `createV10SessionDatabase(options) -> void`.
- Canonical repository: `SQLiteTranscriptEventRepository`.
- Runtime composition: `openRuntimeSessionStore(options) -> SQLiteSessionStore |
  SQLiteTranscriptEventRepository`.
- Runtime writes: `reserveTurn`, `appendAssistantToolCalls`, `appendToolResult`,
  `appendContextItem`, `appendDisplayActivity`, `completeTurn`, and `failTurn`.
- Read projections: `loadConversationItems`, `loadReadableTranscript`,
  `loadRecentReadableTranscript`, `loadReadableTranscriptPage`, and `searchMessages`.
- Search compatibility maps `transcript_events.provider_index` to
  `SessionSearchResult.messageIndex`.

### 3. Contracts

- One semantic user, assistant, tool batch, tool result, context, display, or lifecycle action
  appends one typed event inside the same `BEGIN IMMEDIATE` transaction as mutable turn state.
- Full tool output and tool arguments occur once in canonical event payloads. Provider, readable,
  artifact, and search views are projections and do not become transcript authorities.
- Display activity is always `model_visible = 0`; callers cannot override it. Provider-visible
  events receive a session-local monotonic `provider_index`.
- Search uses external-content FTS over `transcript_events.payload_json`, filters to model-visible
  searchable event kinds, preserves workspace filtering, and returns snippets of at most 160
  characters.
- An FTS update uses one trigger whose body deletes old terms before inserting new terms. SQLite
  does not define the relative execution order of separate triggers for the same event.
- Backend composition, smoke runners, and integration tests that open a runtime-created database
  use `openRuntimeSessionStore`. Direct `new SQLiteSessionStore(...)` construction is reserved for
  explicit v2-v9 fixtures and tests that assert a v9-only reader rejects marker 10. This prevents a
  direct-created v10 database from being reopened through the legacy version gate.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Runtime composition opens an empty database or marker 10 | Select `SQLiteTranscriptEventRepository` |
| Runtime composition opens marker 2 through 9 | Select `SQLiteSessionStore` and preserve the legacy path |
| v9 reader opens marker 10 | Reject with bounded expected/actual version diagnostics and no writes |
| Missing/corrupt marker on non-empty DB | Refuse v10 initialization without creating transcript objects |
| Duplicate event or provider identity | Roll back the enclosing semantic action |
| Display activity requests model visibility | Impossible through the typed API; persisted value is always false |
| Tool result is out of call order or exceeds the output bound | Reject and append no partial event |
| FTS update changes searchable content or visibility | Delete old terms, then insert eligible new terms in one trigger |
| Search query is blank | Return an empty frozen result without querying FTS |

### 5. Good/Base/Bad Cases

- Good: a tool-heavy turn writes one user event, one multi-call batch, one event per result, one
  assistant event, and one terminal lifecycle event while provider replay remains unchanged.
- Base: a display-only reasoning or baseline event is readable according to its projection policy
  and never enters provider input or search.
- Base: a smoke test reopens a backend-created database through `openRuntimeSessionStore` and reads
  its projections without assuming whether the backend initialized v9 or v10.
- Bad: write the same assistant/tool payload to conversation, history, rollout, and event tables.
- Bad: use `new SQLiteSessionStore(...)` to inspect a backend-created database; new databases are
  v10, so the v9-only reader must reject them.
- Bad: use two `AFTER UPDATE` triggers and assume the old-term trigger runs before the new-term
  trigger; rank queries may fail with `SQLITE_CORRUPT_VTAB` even when a simple match count passes.

### 6. Tests Required

- Assert v10 has no legacy transcript tables and stores each semantic payload once.
- Run the shared provider contract suite against v9 and v10 projections.
- Cover complete/recent/paged readable history across hidden events and repeated compaction.
- Compare v9/v10 search match sets for workspace filters, punctuation, snippets, and legacy indices.
- Exercise FTS insert, update, delete, rank ordering, and model-invisible exclusion.
- Run a real `NodeTurnRuntime` turn on the normalized store and assert provider request items, live
  event ordering, and terminal event types.
- Reopen backend-created v10 databases in app integration and smoke tests through
  `openRuntimeSessionStore`; separately assert direct `SQLiteSessionStore` construction rejects the
  same marker without mutating the database.

### 7. Wrong vs Correct

#### Wrong

```sql
CREATE TRIGGER transcript_events_fts_update_insert AFTER UPDATE ON transcript_events BEGIN
  INSERT INTO transcript_events_fts(rowid, payload_json) VALUES (new.sequence_no, new.payload_json);
END;
CREATE TRIGGER transcript_events_fts_update_delete AFTER UPDATE ON transcript_events BEGIN
  INSERT INTO transcript_events_fts(transcript_events_fts, rowid, payload_json)
  VALUES ('delete', old.sequence_no, old.payload_json);
END;
```

#### Correct

```sql
CREATE TRIGGER transcript_events_fts_update AFTER UPDATE ON transcript_events BEGIN
  INSERT INTO transcript_events_fts(transcript_events_fts, rowid, payload_json)
  SELECT 'delete', old.sequence_no, old.payload_json WHERE old.model_visible = 1;
  INSERT INTO transcript_events_fts(rowid, payload_json)
  SELECT new.sequence_no, new.payload_json WHERE new.model_visible = 1;
END;
```

Runtime-created database checks follow the same version-dispatch boundary:

```typescript
// Wrong: the legacy reader must reject a backend-created marker-10 database.
const store = new SQLiteSessionStore({ dbPath });

// Correct: runtime composition dispatches marker 2-9 to the legacy store and marker 10 to the
// canonical event repository.
const store = openRuntimeSessionStore({ dbPath });
```

## Scenario: Read-Only V9/V10 Storage Doctor

### 1. Scope / Trigger

- Trigger: changing `collectStorageChecks`, schema-v9 normalization staging, schema-v10 event/FTS
  objects, cutover manifests, or transcript-referenced recovery state.

### 2. Signatures

- Entry point: `collectStorageChecks(options) -> Promise<readonly DoctorCheck[]>`.
- Session check: `sessions_db` with bounded `message` and optional bounded `detail` fields.
- Supported markers: legacy `SCHEMA_VERSION = 9` and normalized `SCHEMA_V10_VERSION = 10`.
- V9 staging is the all-or-none set of `transcript_normalization_events`, `..._batches`,
  `..._source_map`, `..._merge_keys`, and `..._source_conflicts`.

### 3. Contracts

- Open every doctor SQLite connection with `{ readOnly: true }`, then enable
  `PRAGMA query_only = ON`. Doctor never instantiates a write-path store, repairs schema, rebuilds
  FTS, advances a marker, runs normalization, cleans rows, or vacuums.
- Read the single version marker before selecting transcript objects. V9 requires legacy transcript
  and external-content conversation FTS objects; staging is optional, but any staging table requires
  all five tables with their exact ordered columns and valid version/hash/reference rows.
- V10 requires the event table, external-content event FTS, synchronization and append-only
  triggers, projection indexes, and event-boundary lineage index. Legacy transcript or staging
  objects remaining after cutover are corruption diagnostics.
- Validate v10 FTS eligibility against the read-only `transcript_events_fts_docsize` row set. Do not
  invoke an FTS `integrity-check` control command because it enters the virtual table write path.
- A direct-created v10 database may omit `transcript_normalization_manifest`. A migrated v10
  database must have exactly one structurally valid manifest when the table exists.
- Compaction, suspension, eligible Responses continuation, effect checkpoint, lineage, and active
  turn references must resolve to the expected canonical event type and identity.
- Output exposes only bounded counts and allowlisted issue codes. Never include session ids, event
  ids, filesystem paths, source identities, raw opaque payloads, or transcript content.

### 4. Validation & Error Matrix

| Stored state | Required behavior |
| --- | --- |
| Marker 9 without staging | OK with `staging=none` |
| Marker 9 with complete staging | Report bounded event/mapped/opaque counts |
| Marker 9 with partial tables, wrong columns, conflicts, or invalid mappings | Fail with bounded staging issue counts |
| Direct-created marker 10 without manifest | Validate final objects and report `manifest=none` |
| Migrated marker 10 with one valid manifest | Validate final objects and report `manifest=valid` |
| Missing or extra FTS document row | Fail with `invalid_event_fts=<count>` without rebuilding |
| Legacy or staging object remains at marker 10 | Fail with bounded object count and at most 12 names |
| Recovery reference is absent from canonical events | Fail with `invalid_recovery_references=<count>` |
| Marker other than 9 or 10 | Fail with bounded expected/actual diagnostics |

### 5. Good/Base/Bad Cases

- Good: doctor reads a migrated v10 database, validates its manifest and recovery references, reports
  opaque counts, and leaves the database modification time unchanged.
- Base: doctor reads an unstaged v9 database and reports `staging=none`.
- Bad: open `SQLiteSessionStore`, run the normalization cutover, rebuild FTS, print a corrupt event,
  or treat logical normalization as physical vacuum savings from the doctor path.

### 6. Tests Required

- Cover healthy v9 with no staging and with complete staging, including bounded opaque/progress
  counts; reject partial staging.
- Cover direct-created v10, opaque searchable events, FTS row-set drift, post-cutover legacy/staging
  residue, and valid/corrupt manifests produced by the real cutover API.
- Cover missing compaction, suspension, continuation, effect, lineage, and active-turn event
  references without exposing fixture identities or payload text.
- Assert database `mtimeMs` is unchanged after healthy v9, healthy v10, and manifest inspection.

### 7. Wrong vs Correct

#### Wrong

```typescript
const store = new SQLiteSessionStore({ dbPath });
database.prepare("INSERT INTO transcript_events_fts(transcript_events_fts) VALUES ('rebuild')").run();
```

#### Correct

```typescript
const database = new DatabaseSync(dbPath, { readOnly: true });
database.exec("PRAGMA query_only = ON");
const indexedRows = database.prepare(
  "SELECT COUNT(*) FROM transcript_events_fts_docsize",
).get();
```

## Scenario: Explicit Resumable Transcript Normalization

### 1. Scope / Trigger

- Trigger: changing the v9 normalization report, staging command, final cutover composition,
  backup/rollback guidance, or post-cutover vacuum behavior.
- Normalization is an explicit destructive maintenance workflow. Ordinary v9 startup and the
  default maintenance report never start it.

### 2. Signatures

- Read-only report: `transcriptNormalizationReport(dbPath) -> JsonObject`.
- Bounded apply preparation: `prepareTranscriptNormalization(dbPath) ->
  TranscriptNormalizationPreparation`.
- Final apply: `cutoverTranscriptNormalization(dbPath, preparation) -> JsonObject`.
- CLI: `/session maintenance --apply-transcript-normalization`.

### 3. Contracts

- The report uses a read-only, `query_only` connection and exposes only bounded counts, bytes,
  booleans, schema version, and allowlisted status values.
- One explicit apply stages at most one bounded batch and leaves schema marker 9 plus legacy tables
  authoritative. Interruption and retry must not duplicate or skip source rows.
- A staging result that first reports `ready_for_cutover` does not cut over. A later explicit apply
  rechecks readiness, closes every live v9 store/resource, then enters final cutover.
- Final cutover reconciles the v9 tail under `BEGIN IMMEDIATE`, validates manifests and recovery
  references, installs v10 objects, removes legacy/staging transcript objects, and writes marker 10
  last. Any failure rolls back to a usable v9 state.
- Active recovery sessions block cutover without deleting state. Another mycli process must not hold
  a connection during the final apply.
- Operators must stop all mycli processes and preserve `sessions.db`, `sessions.db-wal`, and
  `sessions.db-shm` as one pre-cutover backup set. Restore that complete set with all processes
  stopped to roll back; later turns are outside that backup.
- The report's required free bytes include staging and WAL headroom. Logical savings and freelist
  bytes do not satisfy that temporary-space requirement unless the filesystem actually has the
  reported free space.
- Normalization reports logical/freelist savings only. Physical shrinkage requires the separate
  explicit vacuum action after restart, doctor, resume, transcript, search, and recovery checks.
- During the compatibility window, Node tooling opens v9 and v10, while v9-only binaries reject
  marker 10 without mutation.

### 4. Validation & Error Matrix

| State | Required behavior |
| --- | --- |
| Default report on v9 | Read-only readiness/progress result; database mtime unchanged |
| Apply with remaining sources | Commit one bounded staging batch; marker remains 9 |
| Batch reaches the tail | Return `ready_for_cutover` in staging phase; do not cut over |
| Next explicit apply with no active recovery | Close v9 resources, cut over atomically, require backend restart |
| Active recovery remains | Return `blocked_active_sessions`; preserve marker and recovery state |
| Insufficient filesystem space | Refuse staging/cutover with bounded storage diagnostics |
| Final validation or transaction failure | Roll back to marker 9 and permit clean retry |
| Apply on marker 10 | Return `already_normalized`; do not rewrite schema or vacuum |

### 5. Good/Base/Bad Cases

- Good: an operator backs up stopped storage, runs several bounded batches, explicitly confirms the
  final pass, restarts, validates v10, and vacuums separately.
- Base: an interrupted staging run is resumed while ordinary v9 sessions remain readable.
- Bad: cut over on the same call that first completes staging, copy only `sessions.db` while WAL
  writers are active, keep a stale v9 store open after marker 10, or claim logical savings reduced
  physical file bytes.

### 6. Tests Required

- Assert default report and v10 already-normalized report preserve database `mtimeMs`.
- Cover multi-batch progress, interruption, retry, tail writes, lock contention, low disk, conflicts,
  active recovery exclusion, final failpoints, and v9 rollback.
- Gateway/backend integration must prove the staging-ready response precedes a second explicit
  cutover request, the cutover response is delivered, and the backend then exits.
- Run doctor and v9/v10 provider/readable/search/recovery parity suites before permitting vacuum or
  real-database cutover.

## Naming Conventions

- Session tables use plural table names such as `sessions`,
  `conversation_messages`, `conversation_trees`, `history_items`, and
  `session_state`.
- Session identifiers are stored as `session_id`; lineage uses `parent_id` and
  `fork_point` to match the `Conversation` domain model.
- Session search indexes use names that make the source table explicit, such as
  `conversation_messages_fts`, plus insert/delete/update triggers with the same
  prefix.

---

## Common Mistakes

- Treating `conversation_trees.parent_id` as enough to replay history. For forked
  conversations, use `fork_point` to include only the ancestor segment that the
  child actually forked from.
- Counting child and parent messages in one unaggregated join when validating
  fork points. That multiplies rows and can hide corrupted parent fork points.
  Aggregate message counts per `session_id` first, then join those counts to
  `conversation_trees`.
- Treating a runtime `Conversation` without `parent_id` and `fork_point` as a
  request to clear persisted lineage. Ordinary turn execution, compaction, and
  transcript rebuilds may save plain conversation objects; `SessionService` must
  preserve existing `conversation_trees` metadata unless a fork/rewind path
  explicitly supplies new lineage values.
- Adding diagnostic/search/recall data directly to provider transcript replay.
  Session DB enhancements must stay local unless a caller explicitly asks to load
  or replay that data.
- Letting `/resume missing-id` create or return an empty conversation. Empty
  saved sessions have a `sessions` row; a missing id has no persisted resume
  evidence and should fail clearly.
- Letting FTS query syntax leak through user input. Quote or otherwise sanitize
  tokens before passing a user query to SQLite `MATCH`, and cover punctuation or
  quoted-token cases with regression tests.

---

## Scenario: Explicit Session Message Search

### 1. Scope / Trigger

- Trigger: adding local search over persisted session messages changes the DB
  schema and crosses storage, service, CLI, and TUI layers.

### 2. Signatures

- DB: `conversation_messages_fts(session_id UNINDEXED, message_index UNINDEXED, content)`
- Store: `search_messages(query: str, *, workspace_root: Path | None = None, limit: int = 20) -> tuple[SessionSearchResult, ...]`
- CLI: `/search <query>`

### 3. Contracts

- Query is user-triggered and local-only.
- Results are scoped by `workspace_root` when provided.
- Results include bounded snippets and must not mutate conversation state.
- Search output is never appended to provider-facing messages automatically.

### 4. Validation & Error Matrix

- Empty query -> return usage text from the service layer.
- No matches -> return `no matches`.
- Punctuation or quotes in query -> escape/sanitize tokens before SQLite `MATCH`.
- Legacy DB without FTS objects -> create/backfill on store initialization.

### 5. Good/Base/Bad Cases

- Good: `/search checkpoint` returns `session#message_index role: snippet`.
- Base: a legacy DB with `conversation_messages` opens and becomes searchable.
- Bad: search runs automatically before each model request or changes prompt
  prefix-cache inputs.

### 6. Tests Required

- Store test for inserted messages being searchable.
- Store test for legacy row backfill.
- Store test for bounded snippets.
- Store test for quoted or punctuation-bearing query tokens.
- Service/CLI/TUI tests for `/search <query>` routing and completion.

### 7. Wrong vs Correct

#### Wrong

```typescript
messages.push(...store.searchMessages(userText));
```

#### Correct

```typescript
const matches = store.searchMessages({ query, workspaceRoot, limit: 10 });
return matches.map(formatMatch);
```

## Scenario: Read-only Session Maintenance Report

### 1. Scope / Trigger

- Trigger: adding session cleanup, prune, vacuum, or long-running storage maintenance diagnostics.
- The default maintenance action must remain a read-only report; every mutation requires a separate
  explicit action and focused recovery-safety tests.

### 2. Signatures

- Store:
  `SessionStore.session_maintenance_report(workspace_root: Path | None = None, candidate_limit: int = 5) -> SessionMaintenanceReport`
- Domain payload:
  `SessionMaintenanceReport(workspace_session_count, empty_session_count, empty_session_candidates,
  empty_session_candidates_omitted, compactable_rollout_count, compactable_rollout_bytes,
  removable_state_count, removable_state_bytes, estimated_payload_bytes_reclaimable,
  db_size_bytes, page_count, freelist_count, page_size, dry_run=True)`
- Candidate payload:
  `SessionMaintenanceCandidate(session_id, last_active_at, status)`
- CLI slash command: `/session maintenance`
- Explicit cleanup commands:
  - `/session maintenance --apply-empty`
  - `/session maintenance --apply-payloads`
  - `/session maintenance --apply-orphans`
  - `/session maintenance --apply-vacuum`

### 3. Contracts

- The report is read-only: no deletion, no `VACUUM`, no repair, and no automatic pruning.
- Session counts are scoped by `workspace_root` when provided.
- Empty sessions have no conversation messages, summaries, history items, turn rollouts, or session
  state. Runtime-only sessions are durable and are not empty candidates. An otherwise-empty session
  held by a live root or agent runtime lease is runtime-owned and must also be excluded.
- Legacy payload metrics count only recognized terminal rollout/state payloads from inactive
  sessions. Sessions with an in-progress runtime turn, pending decision, or suspended turn are
  excluded.
- SQLite page counters come from `PRAGMA page_count`, `PRAGMA freelist_count`, and `PRAGMA page_size`.
- Output lines are bounded `key=value` fields suitable for CLI/TUI display and smoke tests.

### 4. Validation & Error Matrix

- No sessions for workspace -> counts are zero; storage counters still report DB shape.
- Sessions in other workspaces -> excluded from `workspace_session_count` and `empty_session_count`.
- Session has messages -> not empty.
- Session has only summaries -> not empty.
- Session has only rollout or state recovery data -> not empty.
- Malformed or unrecognized legacy payload -> excluded from payload cleanup metrics.
- Empty candidates are ordered by oldest `last_active_at`, then `session_id`.
- Empty candidate details are bounded by `candidate_limit`; omitted count is `empty_session_count - len(empty_session_candidates)`.
- A stale owner PID does not permanently hide an empty session; startup lease reconciliation makes
  it eligible again, while a live owner remains excluded throughout the cleanup transaction.

### 5. Good/Base/Bad Cases

- Good: `/session maintenance` reports `dry_run=true`, workspace counts, empty counts, bounded empty candidates, and SQLite page counters.
- Base: A fresh DB reports zero workspace sessions without mutating data beyond normal store initialization.
- Bad: Running `VACUUM`, deleting rows, or repairing orphaned state from the maintenance report path.
- Bad: Cleaning orphan child rows from the default dry-run command. Orphan
  cleanup requires the explicit `--apply-orphans` form.

### 6. Tests Required

- Store test for workspace-scoped total and empty-session counts.
- Store test for bounded, workspace-scoped empty candidate details and omitted count.
- Store test for rollout/state payload metrics, active-session exclusion, and malformed payloads.
- Two-repository store test proving live leases are preserved while stale and unowned empty sessions
  remain reclaimable.
- Service/application test for formatted `key=value` lines.
- CLI/TUI completion or command-routing tests for `/session maintenance`.

### 7. Wrong vs Correct

#### Wrong

```typescript
store.pruneEmptySessions({ workspaceRoot });
store.vacuum();
```

#### Correct

```typescript
const report = store.sessionMaintenanceReport({ workspaceRoot });
return formatReport(report);
```

#### Wrong

```typescript
const candidates = this.#emptySessionCandidates(workspaceRoot);
this.#write(() => {
	this.#database.prepare("DELETE FROM sessions WHERE session_id IN (...)").run(...candidates);
});
```

#### Correct

```typescript
this.#write(() => {
	const candidates = this.#emptySessionCandidates(workspaceRoot);
	this.#database.prepare("DELETE FROM sessions WHERE session_id IN (...)").run(...candidates);
});
```

## Scenario: Explicit Legacy Session Payload Cleanup

### 1. Scope / Trigger

- Trigger: reclaiming obsolete legacy rollout events and terminal continuation snapshots after an
  explicit user request.
- This action removes historical runtime payloads but must preserve canonical transcript, provider
  replay, compact boundaries, summaries, and active recovery.

### 2. Signatures

- Store: `SessionStore.cleanupLegacySessionPayloads(options) -> SessionPayloadCleanupResult`.
- CLI slash command: `/session maintenance --apply-payloads`.

### 3. Contracts

- The default maintenance report never invokes cleanup.
- Each cleanup call processes a bounded number of rollout and state rows in one write transaction.
- Only terminal rollout statuses are eligible. Preserve every top-level rollout field and replace
  `events` with either an empty array or one minimal `approval_resolution` marker needed for
  readable-transcript deduplication.
- Delete only inactive terminal `turn_record` and unused legacy `provider_timeline` rows.
- Exclude every session with an in-progress runtime turn, pending decision, or suspended turn.
- Never mutate conversation messages, history items, summaries, compact checkpoints/boundaries,
  Responses continuation state, model-input ledger rows, or active approval/clarification state.
- Repeated cleanup is idempotent. Removed payload bytes are logical savings; physical file shrinkage
  remains the separate explicit vacuum action.

### 4. Tests Required

- Dry-run and apply tests cover candidate counts, bytes, conservative eligibility, and bounded work.
- Readable transcript and provider input hashes remain identical before and after cleanup.
- Approval-marker suppression, inactive state deletion, malformed JSON skipping, and idempotency are
  covered explicitly.

## Scenario: Explicit Session Orphan Cleanup

### 1. Scope / Trigger

- Trigger: adding cleanup for legacy/corrupt child rows whose `session_id` no
  longer exists in `sessions`.
- This is a destructive maintenance action and must stay behind an explicit
  slash-command flag.

### 2. Signatures

- Store:
  `SessionStore.apply_session_maintenance_orphan_cleanup() -> SessionOrphanCleanupResult`
- Internal ownership queries:
  `SQLiteTranscriptEventRepository.#liveRuntimeSessionIds() -> readonly string[]` and the shared
  repository write transaction.
- Domain payload:
  `SessionOrphanCleanupResult(deleted_rows_by_table, total_deleted_rows, dry_run=False)`
- CLI slash command: `/session maintenance --apply-orphans`

### 3. Contracts

- Default `/session maintenance` remains read-only.
- Orphan cleanup may delete rows only from known session child tables.
- Orphan cleanup must not delete rows from `sessions`.
- Orphan cleanup must not repair missing lineage parents or run `VACUUM`.
- Orphan cleanup must skip child rows whose missing parent session id is held by a live root or agent
  runtime lease. The lease read and child-row deletion belong to the same write transaction.
- Output lines are bounded `key=value` fields, including total deleted rows and
  per-table counts for tables with deletions.

### 4. Validation & Error Matrix

| Child-row parent state | Required behavior |
| --- | --- |
| Matching `sessions` row exists | Preserve the child row |
| No parent and no live runtime lease | Delete the known orphan row |
| No parent but a live root or agent lease exists | Preserve the row |
| Root lease PID is stale and was reconciled | Treat the row as an ordinary orphan |

### 5. Good/Base/Bad Cases

- Good: cleanup reads live runtime ids and deletes eligible child rows in one `BEGIN IMMEDIATE`
  transaction.
- Base: a healthy database reports zero deleted orphan rows.
- Bad: select orphan ids, commit, then delete them in a later transaction after another runtime may
  have acquired the session.

### 6. Tests Required

- Store test proving orphan rows in multiple child tables are deleted while
  valid sessions and valid child rows remain.
- Store test proving empty sessions are not deleted by orphan cleanup.
- Two-repository test proving a live leased virtual session keeps its child state while an unowned
  orphan is deleted.
- Service/CLI/gateway tests for `/session maintenance --apply-orphans`.

### 7. Wrong vs Correct

#### Wrong

```sql
DELETE FROM session_state
WHERE session_id NOT IN (SELECT session_id FROM sessions);
```

#### Correct

```sql
DELETE FROM session_state
WHERE session_id NOT IN (SELECT session_id FROM sessions)
  AND session_id NOT IN (<live runtime session ids>);
```

## Scenario: Explicit Session Vacuum

### 1. Scope / Trigger

- Trigger: reclaiming free SQLite pages after explicit user request.
- This is a destructive/high-impact maintenance action because SQLite rewrites
  the database file, so it must stay behind an explicit slash-command flag.

### 2. Signatures

- Store:
  `SessionStore.apply_session_maintenance_vacuum() -> SessionVacuumResult`
- Domain payload:
  `SessionVacuumResult(before_db_size_bytes, after_db_size_bytes, before_page_count, after_page_count, before_freelist_count, after_freelist_count, page_size, dry_run=False)`
- CLI slash command: `/session maintenance --apply-vacuum`

### 3. Contracts

- Default `/session maintenance` remains read-only.
- Doctor must not run `VACUUM`.
- Empty-session cleanup and orphan cleanup must not run `VACUUM`.
- Vacuum must not delete sessions, delete child rows, repair orphan rows, or
  repair lineage parent references.
- Output lines are bounded `key=value` fields with before/after size and page
  counters so the maintenance action is diagnosable.

### 4. Tests Required

- Store test proving explicit vacuum returns before/after database metrics while
  preserving sessions and messages.
- Store test proving empty/orphan cleanup paths do not execute `VACUUM`.
- Service/CLI/gateway completion tests for `/session maintenance --apply-vacuum`.

## Scenario: Doctor Session Maintenance Readiness

### 1. Scope / Trigger

- Trigger: adding doctor checks for session cleanup readiness or long-running SQLite storage health.
- This check is advisory and must only run after the main `sessions_db` structural integrity check succeeds.

### 2. Signatures

- Doctor check name: `session_maintenance`
- Output fields: `workspace_sessions=<int> empty_sessions=<int> freelist_pages=<int>`
- Remediation: warning messages should point to `/session maintenance`.

### 3. Contracts

- Missing DB -> keep the existing `sessions_db=warning`; do not emit `session_maintenance`.
- Invalid DB -> keep `sessions_db=failed`; do not emit `session_maintenance`.
- Valid DB -> emit `session_maintenance=ok` or `warning`.
- Warning is appropriate for non-corrupt cleanup candidates such as empty workspace sessions or free SQLite pages.
- The check opens SQLite read-only through doctor's existing read connection and must not instantiate the write-path `SQLiteSessionStore`.

### 4. Validation & Error Matrix

- Empty workspace sessions > 0 -> warning with `/session maintenance`.
- `PRAGMA freelist_count` > 0 -> warning with `/session maintenance`.
- Both counts are zero -> ok.
- Sessions from other workspaces -> excluded from workspace counts.

### 5. Good/Base/Bad Cases

- Good: doctor reports `session_maintenance: workspace_sessions=2 empty_sessions=1 ...; inspect with /session maintenance`.
- Base: fresh valid DB reports `workspace_sessions=0 empty_sessions=0 freelist_pages=0`.
- Bad: doctor repairs, deletes, vacuums, or creates session storage while checking.

### 6. Tests Required

- Doctor test for the OK path on a valid DB.
- Doctor test for warning on empty workspace session candidates.
- Doctor test proving missing/invalid DB does not emit `session_maintenance`.

### 7. Wrong vs Correct

#### Wrong

```typescript
const store = new SQLiteSessionStore({ dbPath: path });
store.sessionMaintenanceReport({ workspaceRoot });
```

#### Correct

```typescript
const database = openReadOnlyDatabase(path);
const check = sessionDatabaseMaintenanceCheck(database, workspaceRoot);
```

## Scenario: Schema-V11 Content Blobs And Explicit Maintenance

### 1. Scope / Trigger

- Trigger: changing schema v11, transcript/model-input blob storage, v10 staging/cutover, storage
  Doctor integrity, or content-blob reports/GC.

### 2. Signatures

- New-database marker: `SCHEMA_V11_VERSION = 11`; Node creates fresh databases with
  `createV11SessionDatabase` through `openRuntimeSessionStore`.
- Tables: `session_content_blobs`, `transcript_event_blob_refs`, and `model_input_blob_refs`.
- Read-only report: `analyzeV10ContentBlobMigration({ dbPath })` and
  `SessionStore.sessionMaintenanceReport().contentBlobs` on v11 only.
- Explicit apply: `stageV10ContentBlobMigrationBatch`, then
  `applyV10ContentBlobMigrationCutover` on a later confirmed invocation.
- Explicit GC: `SQLiteTranscriptEventRepository.collectSessionContentBlobOrphans()`.
- CLI: `/session maintenance --apply-content-blobs` and
  `/session maintenance --apply-content-blob-gc`.

### 3. Contracts

- Fresh empty databases create v11 directly. Existing v10 remains inline and authoritative until
  the explicit bounded staging workflow validates parity and writes marker 11 last.
- Blob ids are `sha256:<lowercase hex>` over raw bytes. Codecs are `identity-v1` or deterministic
  `deflate-raw-v1`; reads validate codec, declared raw/stored sizes, a 32 MiB raw bound, payload
  length, decompressed size, UTF-8, and digest before returning content.
- Transcript storage replaces eligible large string leaves with `null` plus unique RFC 6901
  reference rows. Every read hydrates references before `parseTranscriptEventEnvelope`; marker-like
  semantic JSON is never interpreted as storage metadata.
- Model-input owner ids and ledger references remain unchanged. The v11 owner payload is the fixed
  storage marker and exactly one relational row points to verified content.
- V11 search is FTS5 `content=''` with `contentless_delete=1`. Canonical hydrated JSON supplies
  terms during transactional insert/rebuild; result text comes from hydrated events.
- Default maintenance and Doctor use read-only/query-only connections and expose counts/bytes plus
  stable issue classes only. They never print content, paths, blob ids/hashes, session ids, or JSON
  Pointer values and never stage, repair, collect, rebuild, or vacuum.
- Explicit GC deletes only content unreachable from both reference tables in one write transaction.
  Its raw/stored byte result is logical; `freelist_count * page_size` is reusable space. Only the
  separate explicit vacuum action may report physical shrinkage.
- Schema v11 is Node-owned; do not add a second compatibility reader or writer.

### 4. Validation & Error Matrix

| State | Required behavior |
| --- | --- |
| New or zero-byte database | Create complete v11 directly; do not run v10 migration |
| V10 normal startup | Open inline event store; do not scan, stage, compress, or rewrite |
| Partial/wrong v10 staging schema | Doctor/apply fail with bounded staging issue classes |
| First batch reaches tail | Return `ready_for_cutover` in staging phase; marker remains 10 |
| Later apply with active recovery | Return `blocked_active_sessions`; preserve v10 |
| Later apply after resources close | Reconcile tail, validate parity, write marker 11 last |
| Codec/size/hash/reference/typed-event/FTS corruption | Fail read/Doctor with bounded diagnostics |
| GC on v9/v10 | Return not-blob-backed or bounded version failure; delete nothing |
| Repeated GC on v11 | Return zero deletion after the first pass; preserve reachable blobs |

### 5. Good/Base/Bad Cases

- Good: stop all processes, back up DB/WAL/SHM, stage bounded v10 batches, explicitly confirm the
  later cutover, restart on v11, run Doctor/resume/search/ledger checks, then GC and vacuum separately.
- Base: a fresh v11 database reports zero blob/reference/orphan metrics without migration work.
- Bad: compress on startup, store searchable plaintext beside blob content, use mutable reference
  counters, hydrate above storage, auto-GC, vacuum during cutover, or add a second schema reader.

### 6. Tests Required

- Codec/externalizer tests cover deterministic bytes, thresholds, RFC 6901, corruption, and exact
  stable-JSON round trips.
- V10 staging/cutover tests cover batches, interruption, tail writes, source conflicts, low space,
  active recovery, failpoints, cross-process locking, marker-last rollback, and semantic manifests.
- Doctor tests cover healthy/partial staging plus v11 codec/count/hash/reference/typed-event/FTS and
  orphan diagnostics, redaction, `mtimeMs`, and no automatic deletion.
- Maintenance tests cover v9/v10 absence versus v11 metrics, raw/stored/logical/deduplicated and
  freelist bytes, reachable preservation, repeated GC idempotency, and separate vacuum behavior.
- Backend/gateway tests cover action routing, first-ready versus later-cutover responses, response
  delivery before shutdown, v11 reopen, and GC without backend shutdown.

### 7. Wrong vs Correct

#### Wrong

```typescript
const store = openRuntimeSessionStore({ dbPath });
store.contentBlobs.collectOrphans();
database.exec("VACUUM");
```

#### Correct

```typescript
const report = store.sessionMaintenanceReport();
if (explicitAction === "content_blob_gc" && report.contentBlobs
	&& "collectSessionContentBlobOrphans" in store) {
	return store.collectSessionContentBlobOrphans();
}
```

## Scenario: Versioned Session Preference State

### 1. Scope / Trigger

- Trigger: changing session-scoped provider/model/mode persistence, session state validation, or
  fork behavior.

### 2. Signatures

- State row: `session_state(session_id, state_key='session_preferences', payload_json, updated_at)`.
- Payload v1: `{state_version, provider, protocol, model, api_base_url, auth_ref,
  reasoning_effort, collaboration_mode, permission_profile?}`.
- Store APIs: `loadState`, `saveState`, and both `forkSession` implementations.

### 3. Contracts

- Session preferences use the existing versioned `session_state` boundary and require no SQLite
  schema migration. `sessions.workspace_root` separately owns the session workdir.
- Writes serialize one complete v1 object. Reads validate the object at the Node runtime boundary
  before any field influences provider or gateway state.
- `api_base_url` and `auth_ref` are endpoint identity, not credentials. API keys, auth records,
  request headers, and environment secrets must not enter this payload.
- `permission_profile` is optional for backward compatibility and, when present, must be exactly
  `read-only`, `workspace`, or `full-access`.
- Fork performs one transactional copy of the source `session_preferences` row when present. It must
  not bulk-copy other `session_state` rows because queue, approval, continuation, and recovery state
  belong to the source execution.
- Missing state is a supported legacy/fresh-session case. Malformed or unsupported state is not
  equivalent to missing state and must fail closed.

### 4. Validation & Error Matrix

| Stored state | Required behavior |
| --- | --- |
| No row | Return `undefined`; runtime applies its default-config fallback |
| Valid v1 object | Return the complete typed preference |
| Invalid JSON/non-object/version/field/URL/provider pair/permission profile | Surface `session_state_invalid` |
| Fork source has a preference | Copy it byte-equivalently into the target transaction |
| Fork source has other runtime state | Leave that state only on the source |

### 5. Good/Base/Bad Cases

- Good: a fork inherits model identity, mode, and permission while starting with empty
  queue/continuation state.
- Base: an old session has no row and resumes through the runtime fallback.
- Bad: add model columns to `sessions` while retaining a competing JSON state authority.
- Bad: `INSERT ... SELECT` every state key during fork or place a raw API key in `payload_json`.

### 6. Tests Required

- Both legacy conversation and normalized transcript repositories copy only the preference row on
  fork and leave `input_queue` absent on the target.
- Runtime integration persists two distinct model/effort/mode/permission payloads, restarts, and
  verifies exact recovery.
- Corruption tests cover invalid versions, identities, provider/protocol pairs, efforts, modes, and
  credential-bearing or non-HTTP(S) URLs.
- Serialized-payload assertions search for fixture secrets and require no match.

### 7. Wrong vs Correct

#### Wrong

```sql
INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
SELECT ?, state_key, payload_json, ? FROM session_state WHERE session_id = ?;
```

#### Correct

```sql
INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
SELECT ?, state_key, payload_json, ?
FROM session_state
WHERE session_id = ? AND state_key = 'session_preferences';
```

## Scenario: Versioned Session Metadata And Operational Summary

### 1. Scope / Trigger

- Trigger: changing session list filters, title/archive/delete metadata, session summary fields,
  owner lease inspection, pending-state discovery, or management mutations.

### 2. Signatures

- Metadata row: `session_state(session_id, state_key='session_metadata', payload_json, updated_at)`.
- Payload v1: `{state_version: 1, revision, title?, archived, deleted}`.
- Reads: `listSessions(query)`, `loadSession(sessionId)`,
  `loadStates(sessionIds, keys)`, and `loadSessionMetadata(sessionId)`.
- Mutation: `updateSessionMetadata({sessionId, expectedRevision, title?, archived?, deleted?})`.
- Summary states: lease `unlocked | owned | active | stale`; pending
  `none | approval | clarification | interrupted`.

### 3. Contracts

- Metadata is an additive versioned state row; it does not require a schema version bump or add a
  competing sessions-table authority. Missing metadata means revision `0`, no title, and active
  visibility.
- Every metadata mutation runs in the store write transaction, compares `expectedRevision`, writes
  the complete next payload, increments the revision once, and touches the existing session.
- List filtering for workspace, title/id/cwd search, archive visibility, and delete visibility is
  bounded and deterministic. Ordering remains `last_active_at DESC, session_id DESC`.
- One batched operational-state query projects metadata, root/agent lease, pending decision,
  suspended turn, and latest turn status for all listed rows. Callers must not perform per-row state
  scans or receive raw SQLite rows and owner process ids.
- A root lease owned by this store is `owned`; another live root or agent owner is `active`; a dead
  owner remains `stale` until explicit atomic acquisition replaces it. Preview and management reads
  never delete the lease.
- Pending precedence is approval, clarification, interrupted, then none. Summary flags contain no
  approval question, tool arguments/output, provider payload, or transcript text.
- Delete is a logical tombstone. Archive is independently reversible. Canonical transcript and
  lineage rows remain unchanged.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Missing metadata row | Return the revision-0 active default |
| Malformed or unsupported metadata | Preserve the row; expose bounded metadata issue and fail direct metadata load |
| Stale expected revision | Throw `SessionMetadataConflictError`; change nothing |
| Missing session on mutation | Fail without creating metadata |
| Invalid/oversized title, search, ids, keys, limit, or offset | Reject before query/write with bounded diagnostics |
| Another live owner exists | Project `active`; do not expose or replace its pid/owner id |
| Dead owner exists | Project `stale`; replace only inside explicit lease acquisition |
| Pending approval and interrupted turn both exist | Project `approval` once |

### 5. Good/Base/Bad Cases

- Good: list 100 sessions with one overview query and one batched operational query, then render the
  same ordered rows in CLI and TUI.
- Good: preview a stale owner without mutation, confirm takeover, and let coordinator acquisition
  atomically replace the lease.
- Base: a pre-feature session has no metadata and appears active with revision zero.
- Bad: delete stale leases during list/preview, physically delete transcript rows for
  `session delete`, or query `session_state` once per displayed row.

### 6. Tests Required

- Storage tests cover metadata defaults, CAS/no-op behavior, title/archive/delete visibility,
  bounded search, malformed payloads, and stable ordering.
- Two-store lease tests cover owned/active/stale projection, no pid exposure, retained stale state,
  atomic takeover, and conditional release.
- Summary tests cover approval, clarification, interrupted precedence and batched `loadStates`.
- App management and gateway/TUI tests assert identical filtered ordering and complete summary
  fields without provider startup.

### 7. Wrong vs Correct

#### Wrong

```ts
for (const session of sessions) {
	session.metadata = store.loadState(session.id, "session_metadata");
	session.lease = inspectAndDeleteStaleLease(session.id);
}
```

#### Correct

```ts
const sessions = store.listSessions(query);
const state = store.loadStates(sessions.map((item) => item.sessionId), ["session_preferences"]);
// listSessions already projects metadata, lease, and pending state in one bounded batch.
```

## Scenario: Transactional Turn And Agent Lifecycle Terminalization

### 1. Scope / Trigger

- Trigger: changing root-turn completion/failure/recovery, terminal runtime-event projection,
  subagent spawn/follow-up/terminal transitions, or the relationship between `runtime_turns`,
  `transcript_events`, `subagent_tasks`, and `agent_threads`.

### 2. Signatures

- Root terminal repository:
  `TurnTerminalizationStore.terminalize(input) -> StoredTurnTerminalization` and
  `TurnTerminalizationStore.load(sessionId, clientTurnId) -> StoredTurnTerminalization | undefined`.
- Root result: `StoredTurnTerminalization { kind, turn, outbox }`, where `outbox` is the exact
  persisted `turn_lifecycle` event.
- Agent repository: `AgentLifecycleStore.reserve`, `activate`, `startFollowUp`, `completeRun`,
  `failRun`, `interruptRun`, and `failSpawn`.
- Agent result: `AgentLifecycleTransition { task, thread }` containing the records reloaded after
  the transaction commits.

### 3. Contracts

- Completing a root turn writes its assistant output, optional duration display, terminal
  `turn_lifecycle` outbox, `runtime_turns` state, and session activity timestamp in one repository
  write transaction. Failure and interruption similarly include every pending synthetic tool
  result plus their display/context rows.
- The live runtime projects a normal `turn_completed`, `turn_failed`, or `turn_interrupted` event
  from the committed `{ turn, outbox }` result. It must not reconstruct success, usage, failure
  detail, or terminal kind from pre-commit inputs.
- `turn_lifecycle` is the durable terminal outbox; do not add a parallel delivery table while
  transcript replay already provides crash recovery. Its event id is deterministic from the turn
  identity and terminal phase.
- Process-restart and targeted runtime-owner interruption retain their distinct, fixed persisted
  reasons. General caller-supplied failure text still passes through canonical error sanitization.
- A subagent task and its thread/spawn edge transition in one write transaction for reservation,
  activation, follow-up activation, completion, failure, interruption, and runtime-creation
  failure. Supervisor state and lifecycle events consume only the returned committed pair.
- A queued task may move directly to `interrupted`, but its compare-and-update predicate must match
  the actual current status. Never permit the domain transition while leaving an SQL predicate
  hard-coded to `running`.
- `completeTurn()` and `failTurn()` remain compatibility adapters over the terminal repository.
  Live runtime code uses `turnTerminalizations`; live supervisor code uses `agentLifecycle`.
- These repository boundaries reuse schema v12 and the existing `turn_lifecycle` event. They do
  not require a schema-version change.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Any root terminal write or session touch fails | Roll back transcript, outbox, turn state, and timestamp together |
| Terminal turn has no matching lifecycle outbox | `load()` fails with `persistence_error`; do not synthesize committed truth |
| Provider-step executor rejects after reservation | Persist a failed turn before publishing its normal terminal event |
| Any paired agent write fails | Roll back both task and thread/spawn-edge state |
| Queued child is interrupted before activation | Commit both task and thread as `interrupted` |
| Projection or artifact work fails after commit | Preserve canonical SQLite state; auxiliary work cannot rewrite it |

### 5. Good/Base/Bad Cases

- Good: a Worker provider-step rejection commits one failed turn and one outbox event, then the
  runtime projects the exact committed failure.
- Good: a follow-up activation fault leaves no follow-up task and keeps the prior child idle.
- Base: compatibility callers receive the same `RuntimeTurnRecord` from `completeTurn()` while the
  repository also retains an outbox available through `load()`.
- Bad: mark a task running, transition its thread in a later transaction, and compensate after the
  process can crash between those writes.
- Bad: emit a terminal runtime event from request-local inputs and only afterwards try to persist
  the corresponding terminal state.

### 6. Tests Required

- Storage failpoint tests throw after assistant/tool/display/outbox or task writes and assert that
  no partial row or state transition survives.
- Storage success tests reload the exact lifecycle outbox and assert the committed turn, event
  phase, usage/error fields, recovery reason, and session timestamp agree.
- Agent lifecycle tests cover reservation, activation, follow-up, every terminal result, queued
  interruption, runtime-creation failure, and rollback of both task and thread/spawn edge.
- Runtime tests make the provider-step executor reject and assert durable terminal state precedes
  the projected failure. Projection tests use conflicting input values to prove committed records
  are authoritative.
- The complete repository test suite, lint, type-check, contract drift, and `git diff --check` must
  pass because this boundary spans storage, runtime, integrations, and app composition.

### 7. Wrong vs Correct

#### Wrong

```typescript
const task = taskStore.complete(input);
const thread = threadStore.transition({ threadId: input.childSessionId, status: "idle" });
emitCompleted(task, thread);
```

#### Correct

```typescript
const terminal = agentLifecycle.completeRun(input);
emitCompleted(terminal.task, terminal.thread);

const committed = turnTerminalizations.terminalize({ kind: "completed", ...input });
emit(projectCommittedTurnTerminalization(committed));
```

## Goal lifecycle storage

`session_goal` is a validated session-state snapshot. Goal mutations, cumulative
`session_goal_usage` checkpoints, and non-model-visible `display_activity/goal`
audit events commit in one transaction. Runtime opens upgrade format 12/13/14 to
15. Pre-15 writers reject goal events; do not silently write new input sources into
an old format. Creation, status controls, and usage must retain event identities.
Usage checkpoints are cumulative per provider attempt; charge positive deltas only.
Goal-bearing parent turns have stable `goal:<goal-id>:turn:<turn-id>` audit event
identities. Use their captured revision when attributing deferred child work;
do not substitute the most recent goal or confuse a tool call id with a turn id.

Current-head forks retain the current goal, while explicitly selected historical
forks use the goal snapshot before their completed-turn boundary. Assign a new goal
id and pause active execution; do not resume side effects during history inspection.
Runtime context rehydrates objective/status after compaction, independently of the
accounting update stream. See `docs/goals.md` for the public lifecycle contract.

## Training export boundary

`exportSessionTrainingData(store, options, writeChunk)` writes one schema-v3 JSONL conversation
with `source.session_id`, `messages` and distinct `tools`. Do not dump every provider request,
raw event archive or cumulative training prefix. Each actual message/attachment appears once;
preserve genuine repeated user/assistant messages rather than deduplicating by text.

Read the bounded original transcript in sequence, not the readable 2,000-item projection or the
latest compacted window. Do not append compaction replacement tails or UI status telemetry.
Failures, interruptions, rollbacks, images and unmatched calls do not filter out conversations.
Reconstruct only the first request for initial instructions and inherited fork context; subsequent
context changes and unique tool snapshots come directly from the ledger. Current config/prompts
are not historical sources. Context hints use their recorded updates and skip unchanged values.
Do not inject context between a tool batch and its results. Manual compaction ids are not turns.

Project known stored plaintext reasoning (including blob-backed content), and label reasoning
summaries separately. Never interpret encrypted blocks, signatures or redacted thinking as text.
Standalone reasoning display content already represented by an assistant block is not duplicated.
Keep typed image bytes out of text-redaction regexes. Scope normalized tool-call ids by source turn
so native ids reused across turns cannot cross-pair results. Preserve invalid arguments for curation.

Keep multiline text and tool schemas intact while masking secrets. No new truncation or implicit
sample-size filter is allowed. Stored tool output may already be capped before persistence; token
stream chunks/timings were not recorded. Do not fabricate either. Reports expose message/tool/
reasoning/image counts and fixed warnings for unavailable initial/legacy context, never raw errors.

CLI and slash share `session-training-export-options.ts` and the app's atomic file writer.
Bare `/export` exports the current session without arguments. Generate a unique
`session-<UTC timestamp>-<random suffix>.jsonl` filename in the current workspace and report its
absolute path. Keep explicit `--training --output <path>` compatibility; the CLI continues to
require both flags for conversation JSONL export (`--json` is CLI reporting). Remove the former
`--samples-only`, `--include-tool-errors` and `--max-sample-bytes` behavior; it was not the requested
conversation export. Preserve ordinary readable session export compatibility.

Stream one JSON object with escaped message strings and a single terminating newline to an
owner-only temporary file. Atomic no-overwrite publication protects existing files and symlinks;
abort/IO failure removes the partial file. Slash export owns idle session control and shutdown
drains its cancellation before closing SQLite. No provider invocation or training job occurs.
Tests cover unique message/image counts across many provider steps and compaction, source paging,
legacy/missing input, inherited prefixes, secrets, file races, cancellation and CLI/TUI parity.
