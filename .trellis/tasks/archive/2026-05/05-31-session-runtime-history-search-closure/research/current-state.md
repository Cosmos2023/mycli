# Session Runtime History Search Current State

## Context

`mycli` has SQLite-backed sessions, structured runtime history items, FTS-backed
conversation message search, session maintenance, and doctor checks for missing
conversation search objects.

## Current behavior

- `SQLiteSessionStore.search_messages()` searches `conversation_messages_fts`.
- `conversation_messages_fts` is backed by `conversation_messages`.
- Structured runtime history is stored in `history_items`, but is not indexed by
  the current search path.
- `SessionService.load_conversation()` can rebuild a conversation from
  `history_items` when legacy conversation messages are missing.
- Doctor verifies `conversation_messages_fts` and triggers, but does not verify
  a runtime history search index.

## Gap

Long-running runtime-first sessions may have durable content in `history_items`
without corresponding `conversation_messages` rows. Those sessions are
recoverable, but `/search` can miss them. Hermes-like session/state parity needs
session search to cover the durable runtime transcript source as well as legacy
conversation rows.

## Slice direction

Add a `history_items_fts` search index and include history rows in
`search_messages()` results. Add doctor schema checks for the new FTS object and
triggers. Keep output bounded and compatible with existing search formatting.
