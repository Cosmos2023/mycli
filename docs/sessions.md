# Session Discovery And Recovery

mycli stores canonical session state in `~/.mycli/sessions.db`. The interactive TUI and the
provider-free `mycli session` commands use the same backend session service, ordering, filters,
metadata, and ownership rules. Listing or previewing a session never starts a provider request.

## Discover Sessions

Use the TUI `/resume` command to open the searchable session selector. Each row prioritizes the
session title or id, last activity, model and reasoning effort, collaboration mode, permission
profile, lifecycle status, owner lock, fork relation, and working directory.

The equivalent provider-free commands are:

```bash
mycli session list
mycli session list --last
mycli session list --all
mycli session list --workspace /path/to/project
mycli session list --search release --model gpt-5.6-sol
mycli session list --mode plan --permission full-access
mycli session list --status interrupted --limit 50
mycli session list --json
```

Results are ordered by most recent activity and then stable session id. By default, archived and
deleted sessions are hidden. `--all` includes both. Supported status filters are `active`,
`archived`, `deleted`, `waiting_approval`, `waiting_clarification`, and `interrupted`.

## Resume And Repair

Start the interactive UI on a known session with:

```bash
mycli session resume <session-id>
```

`/resume <session-id>` performs the same transition from an existing TUI. Before switching, mycli
builds a provider-free, non-mutating repair preview from the saved workspace, model, credential
reference, permission profile, metadata version, pending state, and owner lease.

When the session is ready, resume is immediate. Recoverable blockers open a keyboard-only selector:

- `unarchive` restores an archived session before resuming it.
- `fork_with_current_settings` creates a child using the current workspace, model, credential
  reference, and permission profile. The source transcript and preferences remain unchanged.
- `takeover_stale_owner` confirms replacement of a lease whose process is no longer running. The
  coordinator performs the replacement atomically when it acquires the session.

An active owner cannot be displaced. Missing or incompatible session state without a safe repair
remains blocked with one actionable diagnostic. Press Esc in the repair selector to cancel without
changing the source session.

Activating a stored session in a new runtime interrupts unfinished turns and clears old approval
and question waits. It preserves committed tool results, never reruns tools, and cannot restore
background process handles. The resumed TUI rebuilds history from canonical transcript events and
shows each interruption notice once. Reconnecting a client to a backend that is still running
retains that backend's valid requests and processes; it does not perform cold recovery.

During one TUI run, switching sessions keeps unsent drafts and folded paste bodies separately
in memory. Enter and the follow-up shortcut send the expanded message. Unsent drafts are not
written to local files or included in transcript and training exports. Reopening mycli starts
with an empty composer, including when resuming an existing session.

## Manage Sessions

These operations are provider-free:

```bash
mycli session fork <session-id> [new-session-id]
mycli session rename <session-id> "Release investigation"
mycli session archive <session-id>
mycli session unarchive <session-id>
mycli session delete <session-id> --force
mycli session export <session-id>
mycli session export <session-id> --json
```

A unique title may be used anywhere a session id is accepted. Ambiguous titles fail without
choosing a session. Archive is reversible. Delete is a logical tombstone, is hidden by default,
and requires `--force`; it does not rewrite raw storage or silently remove descendants. Active or
stale-owned sessions cannot be renamed, archived, or deleted through management commands.

Ordinary export returns bounded user and assistant text plus sanitized session metadata. It excludes API
keys, auth-store records, encrypted reasoning, provider bodies, tool arguments and output, and raw
SQLite rows.

## Training Data Export

Export the complete conversation into a **new** local JSONL file:

```bash
mycli session export <session-id> --training --output ./conversation.jsonl
```

In the TUI, export the current session:

```text
/export
```

No arguments are needed. The file is saved in the current workspace with a unique name such as
`session-2026-09-15T10-30-00-000Z-a1b2c3d4.jsonl`. The TUI displays its full path and message,
tool, reasoning, and image counts. Each export creates a new file.

**One session produces one JSONL row.** The row has `schema_version: 3`, `source.session_id`,
`messages`, and `tools`. Messages contain the stored system prompt once, context instructions,
user messages, intermediate assistant text and plaintext reasoning, tool calls and results, and
final answers. Each actual message is included once in conversation order, including failed or
interrupted work. Genuine repeated user/assistant messages remain separate occurrences.

```json
{
  "schema_version": 3,
  "source": { "session_id": "session-1" },
  "messages": [
    { "role": "system", "content": "Stored instructions" },
    { "role": "user", "content": "Read src/app.ts" },
    { "role": "assistant", "content": "Reading the file.",
      "reasoning": [{ "kind": "thinking", "text": "Stored plaintext thought" }],
      "tool_calls": [{ "id": "call_1", "type": "function",
        "function": { "name": "Read", "arguments": "{\"file_path\":\"src/app.ts\"}" } }] },
    { "role": "tool", "tool_call_id": "call_1", "content": "Stored file contents" },
    { "role": "assistant", "content": "The entry point is…" }
  ],
  "tools": [{ "type": "function", "function": {
    "name": "Read", "description": "Read a file.",
    "parameters": { "type": "object", "properties": { "file_path": { "type": "string" } } }
  } }]
}
```

The exporter reads the original transcript, including messages from before compaction, and stored
prompt/context data. It reads the first request only to recover initial instructions and an
inherited fork prefix; it does not export request snapshots or repeat cumulative conversation
history for each model step. Compaction replacement tails and UI status events are not appended
to the conversation. Stored context updates are inserted once; unchanged hints are not repeated.
`tools` contains distinct stored function definitions, not repeated copies for every request.
Definitions that changed during the session retain their distinct versions.

Plaintext thinking uses `reasoning: [{kind: "thinking", text: "…"}]`; returned reasoning summaries
use `kind: "summary"`. Encrypted blocks, replay signatures and opaque provider transport state are
not plaintext reasoning. User/tool images keep `images` with `mediaType`, base64 `data` and optional
`detail`. Images occur with their original messages, and their bytes bypass text redaction.
Calls use session-local ids (`call_1`, etc.), with results referring to the same ids even when a
provider reuses its native ids across turns. Failed tool results have `is_error: true`. Incomplete
calls and invalid stored arguments are preserved for subsequent curation, not silently filtered.

The JSONL is streamed as one row to an owner-only temporary file and published atomically.
No existing output or symlink is overwritten. The parent directory must exist; relative paths
resolve from the current workspace. Cancellation/failure removes the temporary file. No model
call, training job or upload occurs. An empty session produces one row with empty messages/tools.

The CLI's `--json` prints the report. `/export` shows message, tool-call/result, reasoning-block
and image counts, plus credential redactions and any unavailable legacy/context data. Export runs
while the session is idle and holds session control until completion. Exiting cancels it.

Known credentials become `[REDACTED]`; known workspace/home paths become `[WORKSPACE]`/`[HOME]`.
Tool schema property names and multiline formatting remain intact. Review code, personal data,
images and unrecognized secrets before sharing or training. This is a provider-neutral conversation
format; adapt it to the training framework. No automatic sample filtering or target weighting is
applied. The former `--samples-only`, `--include-tool-errors` and `--max-sample-bytes` options have
been removed.

Export does not add text truncation. Tool output may already have been capped at 8,000 characters
before storage. Historical per-token streaming chunks/timings were not persisted and cannot be
recreated. Ordinary `session export` without `--training` remains a bounded readable-text export.

## Readable Session Files

`~/.mycli/sessions/<session-id>/session.json` is a readable diagnostic snapshot, refreshed at
terminal turn boundaries and when a stored session is prepared. It does not update on every token.
Existing files are enriched on their next refresh; the JSON schema version remains `2`.

| Field | Meaning |
| --- | --- |
| `session_id`, `cwd`, `created_at`, `updated_at` | Session identity, workspace, and stored timestamps. |
| `state` | Snapshot interaction state, such as `idle`, `waiting_approval`, or `interrupted`. |
| `message_count` | Provider conversation item count. This is not the number of visible transcript rows. |
| `session` | Thread id, stored lifecycle status, compaction count (`summary_count`), and optional title, parent/fork relation, and last turn status. |
| `last_request` | Last recorded request's provider, protocol, model, reasoning effort, request/turn/step ids, timestamp, and instruction/tool-set snapshot references. Absent before the first request. |
| `coverage` | Bounds and omissions for the readable history projected from SQLite events. |
| `transcript` | User/assistant text, readable reasoning summaries, merged tool calls/results, and visible lifecycle notices. |
| `subagents`, `links.events` | Child-session artifact index and the auxiliary `events.jsonl` path. |

`last_request` describes the last recorded request, even if `/model` has since selected another
model. `model_input_event_count`, when present, is that request's provider-visible timeline event
count, not a token count or the length of `transcript`. Snapshot ids identify the corresponding
records in SQLite; prompt text, tool schemas, credentials, provider bodies, and encrypted reasoning
are not copied into this file. Producing the snapshot requires no model call.

The snapshot uses at most **2,000 recent raw events** and keeps the last **500 projected items**.
If the raw window cuts through a turn, that partial earliest turn is omitted. Tool calls and results
are merged, and internal context events are hidden, so event counts and visible item counts differ.

- `coverage.included_events` and `first_event_sequence` / `last_event_sequence` describe the raw
  window after partial-turn removal, before the 500-item cap. Empty windows use `null` sequences.
- `coverage.included_items` is the actual length of `transcript`.
- `coverage.omitted_items_in_window` counts projected items removed by the 500-item cap.
- `coverage.has_older_events` signals additional history outside the raw window.
- `coverage.history_truncated` is true when either bound omitted history. It can be true even when
  `transcript` is empty, for example when one turn alone exceeds the raw event window.
- `coverage.truncated_items` counts retained items whose content was shortened. Long text, output,
  commands, selected input fields, and diffs retain a head/tail preview capped at **8,000 characters**,
  an omission marker, and `truncated` / `omitted_chars`. For an item with multiple shortened fields,
  `omitted_chars` reports the largest individual omission, not their sum.

Tools retain selected input fields under `metadata.input`: Read's file and offset/limit, Shell's
working directory and PTY setting, tool discovery queries, and file/image targets. Legacy Grep,
Glob, and LS records retain supported search conditions. For example:

```json
{
  "id": "turn-1:tool-call:read-1",
  "turn_id": "turn-1",
  "type": "tool",
  "tool_name": "Read",
  "call_id": "read-1",
  "command": "src/app.ts",
  "status": "completed",
  "output": "...readable file preview...",
  "metadata": {
    "input": { "file_path": "src/app.ts", "offset": 10, "limit": 20 },
    "success": true,
    "actualStartLine": 10,
    "actualEndLine": 29
  }
}
```

Arbitrary MCP arguments, environment values, mutation input bodies, and private rationale are
excluded. The file can still contain private conversation text, commands, and readable output.
It is written atomically with owner-only permissions. Old v2 files without the new optional fields
remain readable; absent `coverage` means the coverage is unknown, not that the file is complete.

This file is not a complete backup. SQLite remains authoritative for full history and provider
replay. If SQLite is unavailable, a valid v2 file supports read-only viewing; it cannot reconstruct
model context or resume execution. `events.jsonl` contains auxiliary artifact events and is also
not a complete canonical transcript.

## Session-Scoped Settings

An established session pins provider, protocol, model, endpoint identity, credential reference,
reasoning effort, collaboration mode, and permission profile. Those values survive process restart
without changing user defaults. A fresh or legacy session without a pinned value uses the current
default for that value. The working directory remains owned by the canonical session record rather
than the preference payload.

Use `/status` to inspect the active session lifecycle, lock, recovery state, effective permissions,
and sandbox readiness. Session summaries expose only `owned`, `active`, `stale`, or `unlocked` lock
states; they do not expose raw process identifiers.
