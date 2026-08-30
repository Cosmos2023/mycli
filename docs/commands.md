# Slash Command Reference

The Node runtime owns one canonical registry for parsing, discovery, dispatch, and errors. The TUI
palette normally shows the common subset; hidden commands below remain supported and test-covered.

| Command | Arguments | TUI behavior | During turn | Aliases |
| --- | --- | --- | --- | --- |
| `/model` | optional `[model] [--thinking-effort level]` | `~/.mycli/models.json` picker when bare; validated session-scoped selection when inline | yes | - |
| `/plan` | none | backend | no | - |
| `/mode` | optional `[default\|plan]` | backend | no | - |
| `/permissions` | optional `[allow\|revoke\|clear]` | overlay when bare; backend when inline | yes | `/tools permissions` |
| `/sandbox` | optional `[read-only\|workspace-write\|danger-full-access\|next]` | backend | no | - |
| `/settings` | none | opens settings | yes | - |
| `/new` | none | creates and switches to a fresh backend session | no | - |
| `/resume` | optional `[session-id]` | picker when bare; backend when inline | no | `/session`, `/session list`, `/sessions`, `/session resume` |
| `/fork` | optional `[source] [new-session] [message-index]` | backend | no | `/session fork` |
| `/status` | none | backend | yes | `/session show` |
| `/usage` | none | backend | yes | `/status usage` |
| `/context` | none | backend | yes | `/status context` |
| `/compact` | none | backend | no | - |
| `/stats` | none | backend | yes | `/status stats` |
| `/skills` | none | overlay | yes | `/skill`, `/tools skills` |
| `/tools` | optional `[list\|sets\|hooks\|extensions\|plugins]` | overlay | yes | `/hooks`, `/toolsets`, `/extensions`, `/plugin` |
| `/resources` | none | opens resources | yes | - |
| `/memory` | optional `[list\|path\|search\|add\|forget]` | overlay | yes | - |
| `/agents` | optional `[child-session-id\|kill <child-session-id>\|kill-all]` | agent view when bare; backend when inline | yes | `/tasks`, `/jobs`, `/jobs subagents`, `/jobs kill-subagents`, `/subagents`, `/agents runs`, `/agents kill` |
| `/ps` | optional `[stop-all]` | lists or stops background terminals | yes | `/tasks bashes`, `/bashes`, `/jobs bashes` |
| `/stop` | none | legacy alias that stops all background terminals | yes | - |
| `/changes` | none | backend | yes | - |
| `/undo` | none | backend | yes | `/changes undo` |
| `/trace` | optional `[export\|logs]` | overlay | yes | `/trace-jsonl`, `/logs` |
| `/details` | none | toggles compact tool details | yes | - |
| `/view` | optional `[default\|verbose\|focus]` | changes transcript density; tools remain visible | yes | - |
| `/hotkeys` | none | opens keyboard help | yes | - |
| `/copy` | none | copies the last assistant response | yes | - |
| `/clear` | none | clears the local transcript view | no | - |
| `/login` | none | opens masked provider credential setup | yes | - |
| `/trust` | none | opens workspace trust | yes | - |
| `/help` | none | opens unified shortcut and command help | yes | - |
| `/quit` | none | exits mycli | yes | - |
| `/session search` | optional `[query]` | backend | yes | `/search` |
| `/session maintenance` | optional `[--apply-empty\|--apply-payloads\|--apply-orphans\|--apply-vacuum\|--apply-transcript-normalization\|--apply-content-blobs\|--apply-content-blob-gc]` | backend | no | `/session-maintenance` |

When the TUI is idle, `Shift+Tab` cycles between Default and Plan mode. The footer shows the
shortcut while Plan mode is active and the terminal has enough room; overlays, selectors, and
running turns keep ownership of the key.

Prefix aliases can inject a canonical subcommand. For example, `/logs` resolves to
`/trace logs`, `/trace-jsonl` resolves to `/trace export`, and `/subagents` resolves to
`/agents`.

`/session maintenance` is a dry-run report. `--apply-payloads` compacts eligible legacy terminal
rollouts and removes inactive legacy continuation snapshots without deleting canonical transcript,
compact, summary, or active recovery records. The reported payload bytes become reusable SQLite
space; run the separate `--apply-vacuum` action only when physical file shrinkage is required.

The same read-only report shows transcript-normalization status, bounded staging progress, opaque
row counts, excluded active sessions, estimated temporary peak bytes, and available disk space.
Production startup is fresh-only on schema v12. It creates v12 for a missing or empty database and
rejects schema v9, v10, or v11 with expected/actual version diagnostics before opening a writable
connection. There is no automatic or manual in-place v11-to-v12 migration.

To switch an existing installation, stop every mycli process and archive `~/.mycli/sessions.db`
together with adjacent `sessions.db-wal` and `sessions.db-shm` files as one set. Move that complete
set out of the active location, then start mycli to create a fresh v12 database. Rollback requires a
v11-capable binary and restoration of the complete archived set; sessions are not converted.

Schema v12 stores transcript leaves and immutable model-input records in verified content blobs and
keeps search terms in a contentless FTS index. Provider steps store a compact V3 manifest and request
hash; the complete provider request is reconstructed from instruction/tool snapshots and the exact
append-only timeline prefix, so no per-step full-request blob or repeated event-id array is written.
On v12, the transcript-normalization and content-blob apply commands report `already_normalized` and
`already_blob_backed` without changing storage.

`--apply-content-blob-gc` explicitly deletes only blobs unreachable from both transcript and
model-input reference tables. It reports deleted raw/stored bytes and reusable freelist bytes, is
idempotent, and never runs `VACUUM`. Run doctor plus representative resume, pagination, search, and
provider-ledger checks before the separate `--apply-vacuum` action is used for physical shrinkage.

`/model` uses the user-owned `~/.mycli/models.json` catalog. The Node runtime bootstraps it when it
is missing, validates provider/protocol, endpoint,
`auth_ref`, and reasoning-effort compatibility on selection. The TUI then asks whether to use the
selection for the current session or make it the user default. `Use for this session` is the safe
default and survives resume without changing `~/.mycli/config.toml` or new sessions. `Make user
default` atomically updates the user configuration and applies the same selection to the active
session. Inline `/model <name>` requests remain session-scoped. Catalog payloads sent to the TUI
never include credentials or `auth_ref`.

The current catalog format groups models by provider so one endpoint and credential reference are
shared without repetition:

```json
{
  "version": 2,
  "providers": {
    "openai": {
      "protocol": "responses",
      "base_url": "https://api.openai.com/v1",
      "auth_ref": "openai",
      "options": { "store": false },
      "models": {
        "gpt-5.6-sol": {
          "name": "GPT-5.6 Sol",
          "limits": {
            "context_window_tokens": 1050000,
            "max_output_tokens": 128000
          },
          "reasoning": {
            "default": "low",
            "efforts": ["low", "medium", "high", "xhigh", "max", "ultra"]
          }
        }
      }
    }
  }
}
```

`context_window_tokens` is the total model window and `max_output_tokens` is the provider output
ceiling. Without an explicit `max_prompt_tokens`, mycli uses their difference as the prompt budget.
An explicit prompt budget remains a lower operator cap and is clamped to the model limit. Legacy
catalogs with a top-level `models` array remain readable. API keys belong only in
`~/.mycli/auth.json`; catalog `options` are validated request settings, not credential storage.

At interactive startup, mycli checks the active provider/model credential locally after workspace
trust and opens the same `/login` flow when it is missing. `MYCLI_API_KEY` takes precedence over a
stored key; a stored key is resolved through the active `auth_ref`. The backend repeats the check
before accepting a turn, so deleting a credential while the TUI is open restores the unsent draft
and reopens login instead of creating a failed turn. Successful recovery keeps the draft in the
composer and never resends it automatically.

## Error Contract

- Direct `command.run` calls with unknown commands return `unknown_command` locally. Interactive
  input routes only registry-known names as commands, so root absolute paths such as `/tmp` remain
  ordinary user input.
- A command used on the wrong surface returns `unavailable_surface`.
- A command blocked by an active turn returns `unavailable_during_turn`.
- Missing required arguments, extra arguments for a no-argument command, and invalid subactions
  return bounded usage errors.
- Failed slash commands never become ordinary provider-visible user messages.
- Plugin commands are additive. They cannot replace a built-in canonical name or alias.

The executable source of truth is
`backend/apps/mycli/src/node-runtime/node-slash-command-registry.ts`. Its serialized matrix and checksum
are frozen by the M8 capability audit tests.
