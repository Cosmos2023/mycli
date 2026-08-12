# Database Guidelines

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

- `SQLiteSessionStore` is the canonical store for local session runtime state under
  `~/.mycli/sessions.db`.
- Writes must go through the store's write-transaction helper rather than opening
  ad hoc write connections. The helper owns `BEGIN IMMEDIATE`, process-local
  locking, locked/busy retry with jitter, and periodic passive WAL checkpoints.
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
- FTS tables and triggers are schema objects too: opening a legacy DB must create
  them and backfill existing `conversation_messages` rows without rewriting or
  deleting the original messages.
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
  `SCHEMA_VERSION`, return without replaying schema DDL, FTS backfills, or a version-row rewrite.
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
| Supported v2-v6 | Run additive migration and preserve existing rows |
| Current version | Open without schema write, DDL replay, or FTS backfill scan |
| Unsupported numeric version | Fail with bounded expected/actual version diagnostics |
| Invalid non-numeric version | Fail with a bounded null actual version |
| Concurrent migration completes first | Recheck under lock and skip duplicate migration |

### 5. Good/Base/Bad Cases

- Good: reopening a large v7 database performs bounded version reads and immediately continues to
  runtime recovery.
- Base: a new empty path creates v7 and writes its commit marker once.
- Bad: execute every `CREATE ... IF NOT EXISTS`, scan both FTS tables, and delete/reinsert the v7
  marker on every CLI startup.

### 6. Tests Required

- Assert a current database reopens even when a test trigger rejects deletion of its version row.
- Keep new-database schema-shape coverage for all required tables, indexes, and immutable triggers.
- Keep explicit v2, v3, v4, v5, and v6 migration fixtures and verify preserved data plus v7 output.
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

## Scenario: Readable Node Session Artifact Projection

### 1. Scope / Trigger

- Trigger: changing Node session snapshots, background task output, subagent lifecycle persistence,
  or restart repair beneath `~/.mycli/sessions/<session-id>/`.

### 2. Signatures

- Canonical store: `SQLiteSessionStore` at `~/.mycli/sessions.db`.
- Artifact store: `SessionArtifactStore.appendEvent`, `writeTaskOutput`, and
  `writeSubagentSnapshot`.
- Snapshot store: `TranscriptSnapshotStore.write` and `loadOrRebuild` with schema version 2.
- Paths: `events.jsonl`, `tasks/<safe-task-id>/output.txt`, and
  `subagents/subagent-<first-16-sha256-chars>.json` under the parent session directory.

### 3. Contracts

- SQLite is authoritative for provider replay, task status, recovery, and index reconstruction.
- JSON/JSONL files are private, bounded, readable projections and never replace canonical rows.
- Terminal turn snapshots append one complete `conversation.saved` JSONL row after SQLite commit.
- Assistant text emitted alongside a tool-call batch is one transcript message before that batch.
  Persist it once as an `assistant_message`; tool-call history rows keep empty display text and
  retain only their structured call identity and arguments. Never copy the same assistant preamble
  into every sibling tool row.
- Readable transcript projection may repair legacy Node tool rows that contain the duplicated
  preamble by emitting one assistant item and clearing only the projected tool text. This is a
  read-time compatibility repair: it must not rewrite SQLite history or canonical conversation
  rows. Safe tool targets such as a validated Skill name may be allowlisted into snapshot metadata;
  raw arguments and private rationale remain excluded.
- Live subagent updates atomically replace the subagent JSON, refresh the parent snapshot index,
  and append `subagent.updated`; restart repair does not invent historical event rows.
- Terminal subagent notifications include `<output-file>` only after the child-session task output
  exists. Background Shell output uses the shell id as its safe task id.
- Backend artifact operations are serialized and drained before SQLite closes. Auxiliary artifact
  failures do not roll back committed SQLite state.

### 4. Validation & Error Matrix

- Blank, `.`, path-like, traversal-like, NUL-bearing, or angle-placeholder identity -> reject
  before filesystem mutation.
- Malformed optional `subagents` or `links.events` snapshot metadata -> reject the snapshot.
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

---

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

```python
messages.extend(store.search_messages(user_text))
```

#### Correct

```python
matches = store.search_messages(query, workspace_root=workspace_root, limit=10)
return tuple(format_match(match) for match in matches)
```

## Scenario: Read-only Session Maintenance Report

### 1. Scope / Trigger

- Trigger: adding session cleanup, prune, vacuum, or long-running storage maintenance diagnostics.
- The first step for maintenance must be a read-only report; destructive cleanup requires a separate PRD and tests.

### 2. Signatures

- Store:
  `SessionStore.session_maintenance_report(workspace_root: Path | None = None, candidate_limit: int = 5) -> SessionMaintenanceReport`
- Domain payload:
  `SessionMaintenanceReport(workspace_session_count, empty_session_count, empty_session_candidates, empty_session_candidates_omitted, db_size_bytes, page_count, freelist_count, page_size, dry_run=True)`
- Candidate payload:
  `SessionMaintenanceCandidate(session_id, last_active_at, status)`
- CLI slash command: `/session-maintenance`
- Explicit cleanup commands:
  - `/session-maintenance --apply-empty`
  - `/session-maintenance --apply-orphans`
  - `/session-maintenance --apply-vacuum`

### 3. Contracts

- The report is read-only: no deletion, no `VACUUM`, no repair, and no automatic pruning.
- Session counts are scoped by `workspace_root` when provided.
- Empty sessions are sessions with no `conversation_messages` and no `session_summaries`.
- SQLite page counters come from `PRAGMA page_count`, `PRAGMA freelist_count`, and `PRAGMA page_size`.
- Output lines are bounded `key=value` fields suitable for CLI/TUI display and smoke tests.

### 4. Validation & Error Matrix

- No sessions for workspace -> counts are zero; storage counters still report DB shape.
- Sessions in other workspaces -> excluded from `workspace_session_count` and `empty_session_count`.
- Session has messages -> not empty.
- Session has only summaries -> not empty.
- Empty candidates are ordered by oldest `last_active_at`, then `session_id`.
- Empty candidate details are bounded by `candidate_limit`; omitted count is `empty_session_count - len(empty_session_candidates)`.

### 5. Good/Base/Bad Cases

- Good: `/session-maintenance` reports `dry_run=true`, workspace counts, empty counts, bounded empty candidates, and SQLite page counters.
- Base: A fresh DB reports zero workspace sessions without mutating data beyond normal store initialization.
- Bad: Running `VACUUM`, deleting rows, or repairing orphaned state from the maintenance report path.
- Bad: Cleaning orphan child rows from the default dry-run command. Orphan
  cleanup requires the explicit `--apply-orphans` form.

### 6. Tests Required

- Store test for workspace-scoped total and empty-session counts.
- Store test for bounded, workspace-scoped empty candidate details and omitted count.
- Service/application test for formatted `key=value` lines.
- CLI/TUI completion or command-routing tests for `/session-maintenance`.

### 7. Wrong vs Correct

#### Wrong

```python
store.prune_empty_sessions(workspace_root=workspace_root)
store.vacuum()
```

#### Correct

```python
report = store.session_maintenance_report(workspace_root=workspace_root)
return tuple(format_report_field(report))
```

## Scenario: Explicit Session Orphan Cleanup

### 1. Scope / Trigger

- Trigger: adding cleanup for legacy/corrupt child rows whose `session_id` no
  longer exists in `sessions`.
- This is a destructive maintenance action and must stay behind an explicit
  slash-command flag.

### 2. Signatures

- Store:
  `SessionStore.apply_session_maintenance_orphan_cleanup() -> SessionOrphanCleanupResult`
- Domain payload:
  `SessionOrphanCleanupResult(deleted_rows_by_table, total_deleted_rows, dry_run=False)`
- CLI slash command: `/session-maintenance --apply-orphans`

### 3. Contracts

- Default `/session-maintenance` remains read-only.
- Orphan cleanup may delete rows only from known session child tables.
- Orphan cleanup must not delete rows from `sessions`.
- Orphan cleanup must not repair missing lineage parents or run `VACUUM`.
- Output lines are bounded `key=value` fields, including total deleted rows and
  per-table counts for tables with deletions.

### 4. Tests Required

- Store test proving orphan rows in multiple child tables are deleted while
  valid sessions and valid child rows remain.
- Store test proving empty sessions are not deleted by orphan cleanup.
- Service/CLI/gateway tests for `/session-maintenance --apply-orphans`.

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
- CLI slash command: `/session-maintenance --apply-vacuum`

### 3. Contracts

- Default `/session-maintenance` remains read-only.
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
- Service/CLI/gateway completion tests for `/session-maintenance --apply-vacuum`.

## Scenario: Doctor Session Maintenance Readiness

### 1. Scope / Trigger

- Trigger: adding doctor checks for session cleanup readiness or long-running SQLite storage health.
- This check is advisory and must only run after the main `sessions_db` structural integrity check succeeds.

### 2. Signatures

- Doctor check name: `session_maintenance`
- Output fields: `workspace_sessions=<int> empty_sessions=<int> freelist_pages=<int>`
- Remediation: warning messages should point to `/session-maintenance`.

### 3. Contracts

- Missing DB -> keep the existing `sessions_db=warning`; do not emit `session_maintenance`.
- Invalid DB -> keep `sessions_db=failed`; do not emit `session_maintenance`.
- Valid DB -> emit `session_maintenance=ok` or `warning`.
- Warning is appropriate for non-corrupt cleanup candidates such as empty workspace sessions or free SQLite pages.
- The check opens SQLite read-only through doctor's existing read connection and must not instantiate the write-path `SQLiteSessionStore`.

### 4. Validation & Error Matrix

- Empty workspace sessions > 0 -> warning with `/session-maintenance`.
- `PRAGMA freelist_count` > 0 -> warning with `/session-maintenance`.
- Both counts are zero -> ok.
- Sessions from other workspaces -> excluded from workspace counts.

### 5. Good/Base/Bad Cases

- Good: doctor reports `session_maintenance: workspace_sessions=2 empty_sessions=1 ...; inspect with /session-maintenance`.
- Base: fresh valid DB reports `workspace_sessions=0 empty_sessions=0 freelist_pages=0`.
- Bad: doctor repairs, deletes, vacuums, or creates session storage while checking.

### 6. Tests Required

- Doctor test for the OK path on a valid DB.
- Doctor test for warning on empty workspace session candidates.
- Doctor test proving missing/invalid DB does not emit `session_maintenance`.

### 7. Wrong vs Correct

#### Wrong

```python
store = SQLiteSessionStore(path)
store.session_maintenance_report(workspace_root=workspace_root)
```

#### Correct

```python
with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as connection:
    check = _session_db_maintenance_check(connection, workspace_root=workspace_root)
```
