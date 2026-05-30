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
- Additive schema changes should preserve existing session rows and be covered by
  a regression test that initializes a legacy DB shape, opens it through
  `SQLiteSessionStore`, and verifies existing messages still load.
- FTS tables and triggers are schema objects too: opening a legacy DB must create
  them and backfill existing `conversation_messages` rows without rewriting or
  deleting the original messages.
- Do not move or rewrite `~/.mycli/sessions.db` as part of storage layout work.

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
- Treating a runtime `Conversation` without `parent_id` and `fork_point` as a
  request to clear persisted lineage. Ordinary turn execution, compaction, and
  transcript rebuilds may save plain conversation objects; `SessionService` must
  preserve existing `conversation_trees` metadata unless a fork/rewind path
  explicitly supplies new lineage values.
- Adding diagnostic/search/recall data directly to provider transcript replay.
  Session DB enhancements must stay local unless a caller explicitly asks to load
  or replay that data.
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
