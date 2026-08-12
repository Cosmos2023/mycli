# Slash Command Reference

The Node runtime owns one canonical registry for parsing, discovery, dispatch, and errors. The TUI
palette normally shows the common subset; hidden commands below remain supported and test-covered.

| Command | Arguments | TUI behavior | During turn | Aliases |
| --- | --- | --- | --- | --- |
| `/model` | optional `[model] [--thinking-effort level]` | `~/.mycli/models.json` picker when bare; validated backend selection when inline | yes | - |
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
| `/login` | none | opens provider setup | yes | - |
| `/trust` | none | opens workspace trust | yes | - |
| `/help` | none | opens unified shortcut and command help | yes | - |
| `/quit` | none | exits mycli | yes | - |
| `/session search` | optional `[query]` | backend | yes | `/search` |
| `/session maintenance` | optional `[--apply-empty\|--apply-orphans\|--apply-vacuum]` | backend | yes | `/session-maintenance` |

Prefix aliases can inject a canonical subcommand. For example, `/logs` resolves to
`/trace logs`, `/trace-jsonl` resolves to `/trace export`, and `/subagents` resolves to
`/agents`.

`/model` uses the same user-owned catalog in the Python and Node runtimes. The Node runtime
bootstraps `~/.mycli/models.json` when it is missing, validates provider/protocol, endpoint,
`auth_ref`, and reasoning-effort compatibility on selection, and persists successful selections
to `~/.mycli/config.toml`. Catalog payloads sent to the TUI never include credentials or `auth_ref`.

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
