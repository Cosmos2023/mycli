# Hermes Context Management Reference

## Source Files Inspected

- `hermes-agent/website/docs/developer-guide/prompt-assembly.md`
- `hermes-agent/website/docs/developer-guide/context-compression-and-caching.md`
- `hermes-agent/website/docs/developer-guide/session-storage.md`
- `hermes-agent/agent/prompt_builder.py`
- `hermes-agent/agent/system_prompt.py`
- `hermes-agent/agent/context_engine.py`
- `hermes-agent/agent/context_compressor.py`
- `hermes-agent/agent/memory_manager.py`
- `hermes-agent/agent/prompt_caching.py`
- `hermes-agent/gateway/run.py`

## Patterns To Mirror Semantically

Hermes separates stable prompt prefix from dynamic turn overlays. Stable
sections include identity, static tool guidance, frozen memory/user snapshots,
skills index, and project context files. Ephemeral API-call additions and
per-turn recalls are intentionally kept out of the stable system prompt so
provider prompt caches stay effective.

Hermes context files are loaded by priority: `.hermes.md`/`HERMES.md` up to git
root, then cwd-local `AGENTS.md`, then `CLAUDE.md`, then `.cursorrules` and
`.cursor/rules/*.mdc`. Content is prompt-injection scanned and truncated before
injection. `SOUL.md` is loaded separately for identity to avoid duplication.

Hermes memory has two lanes: frozen prompt snapshots and per-turn recalled
memory. Per-turn recalled memory is wrapped in a `<memory-context>` fence with a
system note that it is not new user input. Streaming output is scrubbed so
internal memory context does not leak to the UI.

Hermes compression has two layers: gateway session hygiene at about 85% of the
model context window and the in-agent compressor at the configured threshold
normally around 50%. The compressor prunes old tool results, protects head/tail
messages, avoids splitting tool-call/result groups, summarizes the middle, and
updates compression/session state.

Hermes persists session lineage and searchable transcript data in SQLite. The
session schema tracks richer provider metadata than mycli currently needs, but
the relevant P1 pattern is that compression and resume preserve lineage and
summary continuity instead of treating summaries as one-off transient messages.

## mycli Current-State Notes

- `TurnContextAssembler` already builds ordered sections for base, workspace,
  environment, conversation, compaction rehydration, memory, plan, runtime
  reminders, skill catalog, tool exposure, and user request.
- `ContextManager` can rebuild provider replay messages from structured
  history and preserves tool-call/result grouping.
- `CompactionPipeline` already has tool-result budgeting, context window
  analysis, cache zones, and LLM summarization.
- `SQLiteSessionStore` already has sessions, conversation messages, history
  items, session state, session summaries, conversation trees, WAL, FTS, and
  maintenance helpers.
- `DoctorService` already has a mature pattern for read-only bounded
  diagnostics.

## P1 Implementation Implications

- Add a local context file loader under services rather than embedding file
  scanning in CLI or application runtime.
- Extend domain context section metadata with cache class information rather
  than deriving it from section names in downstream callers.
- Add fences at rendering boundaries so memory/project/session summaries are
  clearly reference data and not current user instructions.
- Persist compaction summaries through existing `session_summaries` storage and
  ensure rehydration does not duplicate identical summaries.
- Expose context diagnostics through doctor and trace using bounded metadata,
  not raw prompt text.
