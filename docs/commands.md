# Slash Command Reference

The Node runtime owns one canonical registry for parsing, discovery, dispatch, and errors. The TUI
palette normally shows the common subset; hidden commands below remain supported and test-covered.

| Command | Arguments | TUI behavior | During turn | Aliases |
| --- | --- | --- | --- | --- |
| `/model` | optional `[model] [--thinking-effort level]` | picker when bare; backend when inline | yes | - |
| `/plan` | none | backend | no | - |
| `/mode` | optional `[default\|plan]` | backend | no | - |
| `/permissions` | optional `[allow\|revoke\|clear]` | overlay when bare; backend when inline | yes | `/tools permissions` |
| `/sandbox` | optional `[read-only\|workspace-write\|danger-full-access\|next]` | backend | no | - |
| `/settings` | none | opens settings | yes | - |
| `/new` | none | starts a fresh local transcript | no | - |
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
| `/agents` | optional `[list\|inspect profile-id]` | overlay | yes | - |
| `/tasks` | optional `[agents\|kill-agents]` | task view when bare; backend when inline | yes | `/jobs`, `/jobs subagents`, `/jobs kill-subagents`, `/subagents`, `/agents runs`, `/agents kill` |
| `/ps` | none | backend | yes | `/tasks bashes`, `/bashes`, `/jobs bashes` |
| `/stop` | none | backend | yes | - |
| `/changes` | none | backend | yes | - |
| `/undo` | none | backend | yes | `/changes undo` |
| `/trace` | optional `[export\|logs]` | overlay | yes | `/trace-jsonl`, `/logs` |
| `/details` | none | toggles compact tool details | yes | - |
| `/view` | optional `[default\|verbose\|focus]` | changes tool visibility | yes | - |
| `/hotkeys` | none | opens keyboard help | yes | - |
| `/copy` | none | copies the last assistant response | yes | - |
| `/clear` | none | clears the local transcript view | no | - |
| `/login` | none | opens provider setup | yes | - |
| `/trust` | none | opens workspace trust | yes | - |
| `/help` | none | opens the command palette | yes | - |
| `/quit` | none | exits mycli | yes | - |
| `/session search` | optional `[query]` | backend | yes | `/search` |
| `/session maintenance` | optional `[--apply-empty\|--apply-orphans\|--apply-vacuum]` | backend | yes | `/session-maintenance` |

Prefix aliases can inject a canonical subcommand. For example, `/logs` resolves to
`/trace logs`, `/trace-jsonl` resolves to `/trace export`, and `/subagents` resolves to
`/tasks agents`.

## Error Contract

- Unknown commands return `unknown_command` locally.
- A command used on the wrong surface returns `unavailable_surface`.
- A command blocked by an active turn returns `unavailable_while_running`.
- Missing required arguments, extra arguments for a no-argument command, and invalid subactions
  return bounded usage errors.
- Failed slash commands never become ordinary provider-visible user messages.
- Plugin commands are additive. They cannot replace a built-in canonical name or alias.

The executable source of truth is
`apps/mycli/src/node-runtime/node-slash-command-registry.ts`. Its serialized matrix and checksum
are frozen by the M8 capability audit tests.
