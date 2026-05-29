# Session Storage Layout Hardening

## Context

`~/.mycli/sessions` currently mixes legacy session JSON, trace JSONL, smoke-test artifacts, snapshots, and other runtime outputs. This makes the directory hard to inspect and causes trace files to grow with full tool/result payloads that do not need to live in the trace stream.

Hermes keeps a more regular home layout: state is centralized, logs live under `logs/`, session lifecycle data is DB-first, and oversized tool outputs are represented by previews plus references instead of dumping full content into every runtime surface.

## Goal

Make mycli's session-adjacent storage more regular without breaking existing sessions or the append-only/prefix-cache behavior.

After the trace layout fix, extend the same session-storage hardening track toward the Hermes-inspired DB-first model:

- harden `~/.mycli/sessions.db` writes for concurrent local runtimes
- make schema evolution explicit
- implement session lineage resume semantics
- add explicit local session-message search without automatic recall injection

## Non-Goals

- Do not migrate, delete, or rewrite existing files in `~/.mycli/sessions`.
- Do not move the existing `~/.mycli/sessions.db`.
- Do not change stable prompt text, model-visible tool schemas, tool ordering, or provider transcript replay.
- Do not introduce new dependencies.
- Do not add automatic recall, prompt injection, or model-visible search results in this increment.
- Do not add Hermes-style gateway handoff or `session_key -> session_id` routing in this increment.

## Requirements

1. Add a central storage layout helper for mycli home paths.
2. Write new trace JSONL files under `~/.mycli/traces/{session_id}-trace.jsonl` instead of `~/.mycli/sessions`.
3. Preserve backward-compatible trace reads from legacy `~/.mycli/sessions/{session_id}-trace.jsonl`.
4. Reject invalid trace session IDs that would create placeholder/path-like files such as `<session>-trace.jsonl`.
5. Keep trace payloads bounded and local-only:
   - redact or summarize nested `raw_payload.content`
   - redact or summarize `transcript_content`
   - preserve small diagnostic fields needed by `/trace`
6. Add regression tests for the new trace location, legacy reads, invalid session IDs, and payload sanitization.
7. Harden `SQLiteSessionStore` writes:
   - enable WAL by default
   - fall back to `journal_mode=DELETE` when WAL is unsupported by the filesystem
   - wrap writes in `BEGIN IMMEDIATE`
   - protect writes with a process-local lock
   - retry locked/busy writes with bounded jitter
   - checkpoint WAL periodically with `PRAGMA wal_checkpoint(PASSIVE)`
8. Add a schema-version anchor for future DB migrations without rewriting existing session rows.
9. Implement session lineage/root-to-tip resume:
   - preserve existing `Conversation.parent_id` / `conversation_trees.parent_id` semantics
   - add a store/service query that walks from a root or ancestor session to the active descendant tip
   - add a root-to-tip load path that returns ancestor messages before descendant messages
   - guard against cycles and missing parents
   - deduplicate repeated boundary user messages when replaying a lineage chain
10. Add explicit local session-message search:
    - maintain a SQLite FTS index over persisted `conversation_messages`
    - backfill existing message rows when opening an older DB
    - expose search through an explicit `/search <query>` command only
    - scope results to the current workspace root
    - return bounded snippets with session id, message index, and role
    - keep search results out of provider transcript replay unless a future feature explicitly requests it

## Cache-Safety Contract

This change may alter only local filesystem trace layout, trace payload content, and local session DB query/index surfaces. It must not alter provider-facing transcript messages, request-shape hashing inputs, stable system instructions, or tool spec definitions.

## Acceptance Criteria

- `TraceService.append("demo", ...)` creates `.mycli/traces/demo-trace.jsonl`.
- `TraceService.load("demo")` reads new trace files and falls back to legacy session trace files.
- Appending a turn-item trace containing nested full file content does not write that full content to trace JSONL.
- Appending with `<session>` raises a clear error and does not create `<session>-trace.jsonl`.
- `SQLiteSessionStore` uses WAL where supported and retries transient locked writes.
- Existing session DBs gain a `schema_version` table without losing messages.
- Resuming an ancestor session can resolve to the current descendant tip.
- Loading a conversation lineage preserves ordered ancestor context without duplicate boundary user messages.
- `/search <query>` returns workspace-scoped session message matches with bounded snippets.
- Empty `/search` reports usage instead of querying or injecting anything into model context.
- Focused tests pass, then lint/type-check for touched Python files pass.
