# Current State: Doctor Session Schema Search Diagnostics

## Finding

`SQLiteSessionStore` owns the canonical session database at
`~/.mycli/sessions.db`. It records `SCHEMA_VERSION = 2` and creates the local
message search objects:

- `conversation_messages_fts`
- `conversation_messages_fts_insert`
- `conversation_messages_fts_delete`
- `conversation_messages_fts_update`

The store backfills these objects when opened normally, but `mycli doctor` is
read-only and should not open the store through a writer just to repair the DB.

Current doctor coverage validates required core tables, foreign keys, orphan
rows, lineage integrity, fork points, and critical recovery payloads. It does
not currently report stale/missing `schema_version` rows or missing/corrupt FTS
search objects.

## Risk

If a legacy or manually modified `sessions.db` is missing search objects,
runtime search can fail or silently degrade while doctor still reports
`sessions_db=ok`. If `schema_version` is missing or stale, future migrations
have no actionable diagnostic signal.

## Desired State

Doctor should remain read-only but fail `sessions_db` with bounded, actionable
messages when:

- `schema_version` is missing or does not match the current
  `SQLiteSessionStore.SCHEMA_VERSION`.
- FTS search table/triggers required by session message search are missing.

Healthy DBs should continue reporting `sessions_db=ok`.
