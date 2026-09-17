# Command Reference

For domain-constrained Shell networking, platform support, and managed policy configuration, see
[Network Policy](network-policy.md).

## Provider Failures And Recovery

Temporary upstream failures (including `upstream request failed`) and disconnected response streams
retry within the configured `request.request_max_retries` and `request.stream_max_retries` limits.
An HTTP 200 response can still fail while streaming. Both retry paths honor the upstream Retry-After
delay; pi-ai does not run additional hidden retries.

The TUI shows `Reconnecting... n/max` with a safe upstream reason while retrying. Esc interrupts the
retry wait. Recovery clears this temporary status; exhaustion produces one durable error with the
last safe reason, also visible after `/resume`. Only the failed model step is retried, not tools that
already executed. Authentication, permission, quota, context-limit, and invalid-request errors do not
enter the ordinary retry loop. Context-limit handling may instead trigger the existing compaction path.

Local Worker request-size limits use the same compaction recovery path and identify the local
execution limit in the error detail. Repeating the same long input cannot resolve that limit;
when automatic compaction cannot reduce it, use `/compact` or reduce attached input. Provider
RPC permits up to 32 MiB, independently of the model's token window.

`/trace export` retains bounded per-attempt classification and retry evidence. Credentials, raw error
bodies, local exception stacks, and model output are excluded. Existing historical errors whose
upstream detail was not captured cannot reconstruct that missing detail retroactively.

## Noninteractive Coding Commands

See [Gateway API](gateway.md) for app-server connection, protocol, and shutdown behavior.

| Command | Purpose | Execution behavior |
| --- | --- | --- |
| `mycli app-server [--session id] [--model model] [--profile name]` | Serve the agent protocol | JSON-RPC over stdio, with the same supervised backend and approval policies |
| `mycli exec [options] [prompt|-]` | Execute one coding task | Uses the supervised runtime without a TTY; accepts stdin, JSONL events, and validated output files |
| `mycli review [--uncommitted\|--base ref\|--commit ref] [instructions]` | Review Git changes | Uses a read-only agent and returns validated findings; empty changes are provider-free |

```bash
mycli exec "Fix the failing parser test"
mycli exec --json - < task.txt
mycli exec --output-schema result.schema.json -o result.json "Inspect the repository"
mycli exec --session <id> "Continue the task"
mycli review --uncommitted
mycli review --base main --json
mycli review --commit HEAD -o findings.json
```

Both commands accept `--model`, `--profile`/`-p`, `--json`, `--timeout <seconds>`
(default 600, maximum 86400), and `--output-last-message`/`-o`. Exec also accepts
`--session` and `--output-schema`. Use `--` before a prompt that starts with a
dash. With no prompt or with `-`, exec reads up to 1 MiB from non-TTY stdin.
There is no interactive fallback. The configured provider and credentials must
already be available, and the workspace must already be trusted through mycli's
interactive trust selector. These commands do not grant or persist trust.

Plain stdout contains the final answer or review; diagnostics use stderr. With
`--json`, every stdout line is a JSON object with `version: 1` and a `type`:
`session.started`, `turn.started`, `message.delta`, `tool.started`,
`tool.completed`, `interaction.required`, or the terminal `exec.result`.
The result includes `status`, `exit_code`, optional `code`, session/turn ids,
`final_message`, provider-reported `usage`, and validated `structured_output`
when a schema is active. Streamed deltas are provisional; only a completed
`exec.result` confirms successful validation. Tool argument previews, question
bodies, and approval command text are excluded from the event projection.

Exit codes are `0` for completion, `1` for execution/validation failure, `2` for
invalid input, `3` for required interaction, `124` for timeout, `130` for SIGINT,
and `143` for SIGTERM. An approval, clarification, or pending session recovery
returns `3`. Restarting with the reported session restores history and interrupts the previous
unanswered turn; a new prompt starts new work. Decisions are never answered automatically by the
headless client. Normal configured runtime
permissions still apply to exec and can authorize workspace edits.

`--output-schema` accepts a local JSON Schema (draft-07, up to 64 KiB). Mycli adds
format guidance to the prompt and validates the final JSON with Ajv; this is not
provider-native constrained decoding. Async schemas, unresolved references, and
unsupported formats are rejected. Failed validation never replaces an output
file. Final files are written atomically with private permissions, up to 4 MiB.

Review defaults to staged, unstaged, and nonignored untracked changes, including
unborn repositories. `--base` compares the merge base with committed HEAD;
`--commit` compares that commit with its first parent (or an empty tree for an
initial commit). Targets are mutually exclusive. Context is limited to 256 KiB
and 300 paths; excessive changes fail explicitly. Binary content is marked as a
limitation. Review disables hooks, plugins, MCP, skills, and subagents before
discovery, and exposes only the local `Read` tool. Historical reads use the
selected Git revision rather than current working-tree files. Review does not
run tests or change files; `-o` is an explicit output-file write.

Findings contain `severity` (`P0` through `P3`), `title`, `body` with evidence and
impact, and `location` (`path`, `start_line`, `end_line`). Locations must refer to
a changed path and a range present in the supplied diff, with at most ten lines.
The output schema is built in. Exit `0` means review completed, even when
findings exist; automation should inspect `structured_output.findings`.

See [coding-evaluation.md](coding-evaluation.md) for the fixed task corpus and
opt-in model evaluation runner.

### Workspace Guidance

In a trusted workspace, mycli loads guidance from the Git/workspace root through
every directory to its current working directory. Each directory contributes
`AGENTS.md` (or `agents.md`) followed by `.mycli.md` (or `MYCLI.md`). Both formats
can contribute; more local guidance takes precedence within its directory scope.
The first existing alias is used and canonical paths are deduplicated. Starting
from a nested directory still inherits the repository's parent guidance.

If no primary file exists, mycli falls back to `CLAUDE.md`/`claude.md`, then
`.cursorrules`, searching cwd before workspace root. Layers share a 24,000 Unicode
character budget with visible truncation. Blocked instruction-hijack/control
content and symlinks outside the search boundary are excluded without suppressing
other valid layers. Instruction files are reference context, not permission grants.

## Provider-Free CLI Commands

These commands run without starting a model turn or making a model-provider request. They remain
available in non-interactive shells where noted. `login --oauth` contacts the provider's authentication
service and requires a terminal. `update check` may contact the npm registry, and
`setup` may prepare the packaged ripgrep helper, but neither sends content to a model provider.

| Command | Purpose | Execution behavior |
| --- | --- | --- |
| `mycli setup` | Configure one provider, model, endpoint, and credential reference | Uses a TUI on a terminal and a plain prompt otherwise; cancellation writes nothing |
| `mycli login status [--json]` | Inspect the selected provider's credential source | Reads only local configuration, environment metadata, and the credential store; never contacts the provider |
| `mycli logout [--json]` | Remove one stored API key or OAuth grant | Preserves unrelated credential references and cannot remove an environment-provided credential |
| `mycli config <action> [arguments]` | Validate, inspect, locate, migrate, or update configuration | Supports `validate`, `show`, `get`, `set`, `unset`, `path`, and `migrate`; every action accepts `--json` |
| `mycli doctor [--json] [--verbose] [--fix [--confirm <plan-id>] \| --support-bundle]` | Inspect health, preview/apply safe repairs, or export bounded support data | Provider-free; default and repair preview are read-only, while apply is bound to the displayed plan id |
| `mycli update [action]` | Read cached update state, refresh it explicitly, or dismiss one exact version | Only `check` contacts the npm registry; it never installs a package |
| `mycli sandbox status\|setup\|reset\|repair\|uninstall [--confirm] [--json]` | Inspect, recover, or remove platform sandbox state | Status is read-only; all other actions preview by default and execute only with `--confirm` |
| `mycli hooks <action> [identity]` | List, inspect, approve, or revoke configured hooks | Operates on local hook metadata and supports `--json` |
| `mycli plugins <action> [arguments]` | Install, manage, inspect, or run plugins; manage marketplaces | Package operations use local or Git sources; declared commands and JSON arguments are validated before execution |
| `mycli mcp <action> [server-id]` | List or inspect configured MCP servers | May start or contact enabled servers to verify discovery; never starts a model turn |
| `mycli session <action> [arguments]` | List, resume, fork, rename, archive, restore, delete, or export sessions | Management actions are provider-free; `session resume <id>` enters the interactive TUI |
| `mycli completion <bash\|zsh\|fish\|powershell>` | Generate completion for one supported shell | Writes a static script to stdout without loading management services, a provider, the backend, or the TUI |

`mycli session export <id> --training --output <new-file.jsonl>` exports one complete conversation
with stored instructions, messages, plaintext reasoning, tool calls/results and images. Use `--json`
for its report. See [conversation export format](sessions.md#training-data-export).

`mycli login --oauth [--provider <id>] [--auth-ref <ref>]` uses a supported native provider's
pi-ai OAuth flow. Credentials are stored privately, secret input is hidden, and cancellation
stores no late grant. `login status` and `logout` use the selected credential reference for both
API-key and OAuth credentials; native environment discovery remains available after logout.

The canonical CLI catalog owns the command names, actions, options, help summaries, and fixed-value
candidates above. The UX contract gate checks the catalog against parser recognition, root
`mycli --help`, this table, and all four generated completion scripts.

`mycli login --with-api-key` accepts the API key only from non-TTY stdin. Optional
`--provider <id>` and `--auth-ref <ref>` select its destination; no supported command accepts a
secret value in argv. `mycli setup --non-interactive --provider <id> --with-api-key` uses the same
stdin-only boundary and requires explicit provider options, so an incomplete invocation exits with
an actionable usage error instead of starting the TUI.

### Shell Completion

Load completion for the current shell session with one of these commands:

```bash
source <(mycli completion bash)
```

```zsh
autoload -Uz compinit && compinit
source <(mycli completion zsh)
```

```fish
mycli completion fish | source
```

```powershell
mycli completion powershell | Out-String | Invoke-Expression
```

Add the matching command to the shell startup file to enable it for future sessions. Generated
scripts contain only the static command catalog; generation works with piped stdout and does not
read credentials, start a model provider, or emit terminal control sequences.

Doctor repair and support operations are explicit management commands:

```bash
mycli doctor --fix [--json]
mycli doctor --fix --confirm <plan-id> [--json]
mycli doctor --support-bundle [--json]
```

The first form only returns the exact value-free actions and effects it would apply. Confirmation
must carry that plan id; concurrent configuration changes fail with `version_conflict` before any
new plan is applied. The current repair normalizes/imports canonical user configuration through the
existing migration backup transaction. It never edits credentials, elevates privileges, installs
packages, or contacts a provider. Support export writes a mode-`0600` JSON file below the private
`~/.mycli/support/` directory. The bundle contains allowlisted runtime versions, diagnostic rows,
configuration layer metadata, and aggregate readiness only; it excludes prompts, commands, tool
content, provider bodies, raw logs, stacks, credentials, session ids, and unnecessary absolute paths.

Sandbox recovery is also provider-free and non-interactive:

```bash
mycli sandbox status [--json]
mycli sandbox setup [--json]
mycli sandbox setup --confirm [--json]
mycli sandbox reset [--json]
mycli sandbox reset --confirm [--json]
mycli sandbox repair [--confirm] [--json]
mycli sandbox uninstall [--confirm] [--json]
```

The unconfirmed setup/reset/repair/uninstall forms return the exact privilege and bounded effects they would use but
perform no mutation. On Windows, confirmed setup may open UAC and verifies the helper handshake
after elevation. Canceling UAC becomes `operation_canceled` without exposing helper output. A
confirmed reset requires no active sandbox helpers, cleans recorded filesystem ACLs, and removes
mycli's credential and setup-marker state; it preserves the restricted accounts and firewall/WFP
restrictions so a later setup can rebuild safely. Repair stops sandbox processes, cleans recorded
ACLs, rebuilds setup, and verifies readiness. Uninstall also removes owned accounts, their profiles,
network rules, recorded WFP grants, and known state files. See [Windows maintenance](windows.md).
On macOS and Linux,
mycli reports missing system dependencies and manual package-manager guidance instead of installing
them. Human and JSON output are projections of the same typed response.

### Configuration Management

Configuration management is provider-free and works without a TTY. `config validate` treats
unknown and deprecated settings as warnings; `config validate --strict` returns exit code `1` when
any warning remains. Fatal syntax, credential-placement, and known-value errors return `1` in both
modes. Diagnostics contain only bounded layer, key, and source-position metadata.

```bash
mycli config path [user|project|profile|system|legacy_user] [--json]
mycli config path profile --profile <name> [--json]
mycli config show [--json]
mycli config get <key> [--json]
mycli config set <key> <value> [--json]
mycli config unset <key> [--json]
```

`path` defaults to the user file and marks only that scope writable. `show` and `get` report the
effective value plus its winning and overridden layers. `set` and `unset` accept only canonical
allowlisted scalar settings and atomically update the base user file; profile, project, system, and
legacy-user files remain read-only through these commands.

Use migration as a version-bound transaction:

```bash
mycli config migrate --dry-run [--json]
mycli config migrate --apply --expected-version <version> [--json]
mycli config migrate --rollback <backup-id> [--json]
```

The preview is value-free and performs no write. Apply rechecks the preview version under the
user-config lock, validates the final effective stack, creates a private backup, and performs at
most one atomic replacement. Rollback succeeds only while the applied user version is still
current, restores exact prior bytes or prior file absence, and never touches credential storage.
The legacy file remains a read-only migration source. A version conflict requires a new preview.

The canonical setting list and commented TOML example are generated in
[`reference/configuration.md`](reference/configuration.md) and
[`reference/config.example.toml`](reference/config.example.toml).

## Slash Command Reference

The Node runtime owns one canonical registry for parsing, discovery, dispatch, and errors. It exposes
38 supported commands, each with one canonical name. The TUI palette normally shows the common
subset; search-only commands below remain supported and test-covered.
`Ctrl+P` starts with common commands that are available in the current runtime. Typing a query also
searches descriptions, settings terminology, and current setting values; matching search-only commands
are shown, and unavailable commands show their reason and cannot execute. Retired names never appear
in the palette, help, or autocomplete.
Availability updates while the palette is open. Extension changes refresh command discovery and
autocomplete; opening `/resume` refreshes the session list. Registered names and multiword commands
accept spaces, tabs, or line breaks as separators. Retired names remain reserved for local rejection
with a replacement hint; they cannot execute or become model input. Unregistered absolute paths
remain chat input.

`/clear` starts a fresh backend session and then clears the terminal view and scrollback. Saved
messages remain available through `/resume`. A failed transition preserves the previous conversation.
`/view` changes local display settings without writing user configuration; its selection survives
gateway updates and settings reloads.
Changing the view in `/settings` replaces that local selection; explicitly saving a user default
also clears the temporary override so the saved choice takes effect.

| Command | Arguments | TUI behavior | During turn | Discovery |
| --- | --- | --- | --- | --- |
| `/model` | optional `[model] [--thinking-effort level]` | provider/model picker when bare; validated session-scoped selection when inline | yes | common |
| `/goal` | optional `[objective\|pause\|resume\|edit <objective>\|budget <tokens\|off>\|clear]` | controls a durable session goal; `--tokens <n> <objective>` sets an explicit creation budget | yes | common |
| `/plan` | optional `[task]` | enters Plan mode; an inline task starts a turn with its attachments | no | common |
| `/mode` | optional `[default\|plan]` | backend | no | search-only |
| `/permissions` | optional `[allow\|revoke\|clear]` | overlay when bare; backend when inline | yes | common |
| `/sandbox` | optional `[read-only\|workspace-write\|danger-full-access\|next]` | backend | no | search-only |
| `/settings` | none | opens the categorized settings center | yes | common |
| `/new` | none | creates and switches to a fresh backend session | no | common |
| `/resume` | optional `[session-id]` | picker when bare; backend when inline | no | common |
| `/fork` | optional `[source] [new-session] [message-index]` | backend | no | common |
| `/export` | none required | exports the complete current conversation to an automatically named JSONL file in the workspace; displays the file path and message/tool/reasoning/image counts | no | common |
| `/status` | none | backend | yes | common |
| `/update` | optional `[check\|dismiss <version>]` | cached status, explicit registry check, or exact-version dismissal | yes | common |
| `/usage` | none | backend | yes | common |
| `/context` | none | backend | yes | search-only |
| `/compact` | none | backend | no | common |
| `/stats` | none | backend | yes | search-only |
| `/skills` | none | skill invocation and persistent enable/disable picker | yes | common |
| `/mcp` | optional `[verbose]` | server connections and tools; verbose adds transport and resources | yes | common |
| `/plugins` | none | plugin and marketplace browser, capabilities, installation and management | yes | common |
| `/hooks` | none | event groups, commands, enablement and trust | yes | common |
| `/tools` | optional `[list\|sets]` | actual tool inventory | yes | search-only |
| `/resources` | none | opens resources | yes | search-only |
| `/memory` | optional `[list\|path\|search\|add\|forget]` | overlay | yes | search-only |
| `/agents` | optional `[child-session-id\|kill <child-session-id>\|kill-all]` | agent view when bare; backend when inline | yes | common |
| `/ps` | optional `[stop-all]` | lists or stops background terminals | yes | common |
| `/diff` | none | scrollable staged, unstaged and untracked Git diff | yes | common |
| `/review` | none | read-only review of uncommitted changes, a base branch, a commit, or custom instructions | no | common |
| `/rename` | optional `[title]` | edits the current session title | no | common |
| `/init` | none | asks the agent to create AGENTS.md only when it does not exist | no | common |
| `/changes` | none | session file history | yes | common |
| `/undo` | none | backend | yes | search-only |
| `/trace` | optional `[export\|logs]` | overlay | yes | search-only |
| `/details` | none | toggles compact tool details | yes | search-only |
| `/view` | optional `[default\|verbose\|focus]` | changes transcript density; tools remain visible | yes | search-only |
| `/hotkeys` | none | opens keyboard help | yes | search-only |
| `/copy` | none | copies the last assistant response | yes | search-only |
| `/clear` | none | creates a fresh session, then clears the terminal | no | search-only |
| `/login` | none | opens masked provider credential setup | yes | search-only |
| `/trust` | none | opens workspace trust | yes | search-only |
| `/help` | none | opens unified shortcut and command help | yes | common |
| `/quit` | none | exits mycli | yes | common |
| `/session search` | optional `[query]` | backend | yes | search-only |
| `/session maintenance` | optional `[--apply-empty\|--apply-payloads\|--apply-orphans\|--apply-vacuum\|--apply-transcript-normalization\|--apply-content-blobs\|--apply-content-blob-gc]` | backend | no | search-only |

When the TUI is idle, `Shift+Tab` cycles between Default and Plan mode. The footer displays a
`plan` badge while Plan mode is active; overlays, selectors, and running turns keep ownership
of the key. `/help` lists the active shortcuts.

The composer keeps work summaries above the input and session context below it. The first
footer row shows mode, model, reasoning and context usage; the second shows workspace, branch
and session. In `/settings`, Statusbar `full` shows both rows, `compact` keeps the first, and
`off` hides the footer. Goal state, queued input, background work and pending decisions remain
visible. `/goal`, `/ps` and `/agents` open the corresponding details.

Approval, permission, workspace-trust, clarification, plan-confirmation, and session-repair
views share a bottom decision panel. Arrow keys or `j`/`k` navigate; Enter confirms the highlighted
option. Numbered options also accept their displayed number. Approval numbers remain stable:
`1` allows once, `2` rejects, `3` allows for the session, and `4` saves an always-allow rule,
when the corresponding option is available. Disabled permission profiles cannot be selected.

Long commands retain their line breaks, and permission requests retain every supplied path.
When the terminal cannot fit all details or options, `Ctrl+A` opens the full text. Arrow keys,
`j`/`k`, Page Up/Down, and Home/End scroll that view; Esc or `Ctrl+A` returns to the decision.
Confirmation and number keys do not submit a decision while inspecting the full text. In the
decision view, Esc rejects an approval, interrupts a clarification, or goes back in other flows.
Navigation and confirmation hints reflect configured keybindings.

Permission and trust saves remain pending until the backend responds. Repeated confirmations
are ignored while saving; failures appear in the same panel and allow retry. Full Access retains
its separate confirmation step.

Loading a historical session into a new runtime interrupts its unfinished turn, removes old
approval/question waits, and preserves completed tool results. It does not execute old commands or
restore process handles. Reconnecting a client to a backend that is still running retains its
current requests and processes. Browsing history does not cancel work.

Bare `/resume` opens the shared session selector. The selector displays model, effort, mode,
permission, lifecycle, owner lock, fork relation, and cwd without per-row storage scans. Selecting
a blocked session first opens a provider-free repair preview; Enter applies only the selected repair
at the previewed metadata revision, while Esc cancels without changing the source. Direct
`/resume <session-id>` uses the same backend transition. See [sessions.md](sessions.md) for the
provider-free management commands and recovery matrix.

`/skills` offers **List skills** and **Enable/Disable Skills**. The invocation picker searches the
complete discovered catalog and inserts `$name` into the draft, retaining the selected file's identity
and content revision. Removing the mention removes its selection. Queued input, restored drafts and
session recovery retain these references; disabled or changed selections are rejected before a model
request. Enablement overrides are saved under `~/.mycli/integration-enablement.json` and apply to
subsequent turns. Catalog refresh reads configuration and skill files without starting extension hosts.

`/hooks` groups configured and plugin-provided hooks by event. Enter shows the command and source.
Availability and command trust are separate: enabling an untrusted configured hook does not authorize
execution. Trust requires reviewing the command and explicitly confirming it; a changed command
invalidates the preview. Plugin handlers are marked as trusted through their enabled plugin.
Ctrl+R refreshes skill/hook catalogs; Ctrl+A inspects full details. Closing a selector or switching
sessions discards late results. Active turns retain their captured integration settings.

`/diff` reads Git state with external diff drivers disabled. It keeps staged and unstaged changes
separate, includes untracked text, and labels binary files and symlinks. The view is bounded to 256 KiB;
very large Git contexts produce a visible load failure. Arrow keys/Page Up/Page Down scroll; Ctrl+R
refreshes. `/changes` continues to show file history recorded by this session.

`/review` uses the existing supervised runtime with only `Read` exposed, including no native web
search. Branch and commit reviews pin file reads to the selected revision. Custom review accepts a
focus and a bounded repository file listing, including clean repositories. The review runtime is
released when the turn ends, so later ordinary turns use their normal tools. Review preparation can
be cancelled. `/resume` supports an on-demand conversation preview with Ctrl+P; it does not resume
the selected session until Enter. `/rename` changes only the current conversation's title.

The `/mcp` and diagnostic `/tools` inspection lists support filtering and item details. Enter opens
the selected item's description; Esc returns to the list, then closes it. Capped results report how
many rows were loaded.

MCP servers, plugin packages, and callable tools have separate inventories. `/mcp` includes servers
that are loading, disabled, failed, or serving cached discovery, including servers without resources.
Enter shows their tools; `/mcp verbose` also includes transport, timeout, and resource names, without
dumping environment values, headers, or command arguments. `/plugins` browses installed and available
packages; Enter shows declared skills, MCP servers, hooks, tools, commands, issues, and management actions. A plugin's
MCP servers still appear under `/mcp`, and its loaded tools appear in the diagnostic `/tools` inventory.
Opening these views does not invoke a tool, plugin command, or model turn. In `/plugins`, Left/Right
selects All Plugins, Installed, or a marketplace; typing searches the current list. Space toggles
enablement when the search is empty. Enter opens install/update/uninstall actions. Ctrl+N opens
local/Git source installation; the Add Marketplace tab registers a source. A named marketplace's
Manage marketplace row refreshes or removes it. Removal requires confirmation and retains installed
packages. Ctrl+R reloads and Ctrl+A inspects complete details. Esc goes back or closes; closing during
an operation cancels pending work. The composer draft survives closing the browser.
The equivalent `mycli plugins` CLI remains available; see [Plugin Compatibility](plugin-codex-parity.md).

### Retired Names

These historical spellings return `invalid_arguments` with a replacement hint. They perform no
action, including while a turn is running. Arguments are not echoed in the diagnostic or forwarded
to a model or plugin. Plugin commands such as `/plugin:<id>:<command>` remain supported.

| Retired names | Use instead |
| --- | --- |
| `/session`, `/session list`, `/sessions`, `/session resume` | `/resume` |
| `/session fork` | `/fork` |
| `/session show` | `/status` |
| `/status usage` | `/usage` |
| `/status context` | `/context` |
| `/status stats` | `/stats` |
| `/tools permissions` | `/permissions` |
| `/skill`, `/tools skills` | `/skills` |
| `/tools hooks` | `/hooks` |
| `/toolsets` | `/tools sets` |
| `/extensions`, `/tools extensions` | `/tools` |
| `/plugin`, `/tools plugins` | `/plugins` |
| `/tasks`, `/jobs`, `/tasks agents`, `/jobs subagents`, `/subagents`, `/agents runs`, `/agents agents` | `/agents` |
| `/tasks agents kill`, `/jobs subagents kill` | `/agents kill` |
| `/tasks kill-agents`, `/jobs kill-subagents`, `/agents kill-agents` | `/agents kill-all` |
| `/tasks bashes`, `/bashes`, `/jobs bashes` | `/ps` |
| `/stop` | `/ps stop-all` |
| `/changes undo` | `/undo` |
| `/trace-jsonl` | `/trace export` |
| `/logs` | `/trace logs` |
| `/search` | `/session search` |
| `/session-maintenance` | `/session maintenance` |

`/session search` and `/session maintenance` are current multiword commands and remain available.
Search-only discovery is a presentation choice, not a retirement flag.

## Settings Center

`/settings` searches and navigates seven runtime-projected categories: model/reasoning,
providers/credentials, permissions/sandbox, appearance/accessibility, sessions/context,
integrations, and updates/diagnostics. Action rows open the same model, login, permission, trust,
session, resource, and diagnostic flows used by their slash commands. Esc returns one selector
level at a time and preserves the composer draft.

Appearance changes show `old -> new` before applying. `Use for this session` updates the active TUI
without writing configuration. `Make user default` uses the atomic user-config writer and rolls the
active value back if persistence fails. The settings center displays each effective value and its
source/scope; managed or unavailable rows stay locked with a bounded explanation.

`/update` reads cached npm status and prints manual package-manager guidance; it never runs an
installer or requests elevated permissions. `/update check` is the only interactive form that
contacts the registry. `/update dismiss <version>` suppresses that exact advertised version while
leaving later releases eligible for a future startup notice.

Every appearance setting is also available through the provider-free config CLI:

```bash
mycli config get tui.theme
mycli config set tui.theme light
mycli config set tui.hide_thinking false
mycli config unset tui.statusbar_mode
```

The allowlisted keys are `tui.statusbar_mode`, `tui.view_mode`, `tui.theme`,
`tui.hide_thinking`, `tui.tool_details_default`, `tui.hardware_cursor`,
`tui.clear_on_shrink`, `tui.terminal_progress`, `tui.terminal_notifications`, `tui.subagent_density`, `tui.color_mode`,
`tui.reduced_motion`, `tui.glyph_mode`, and `tui.high_contrast`. These commands do not accept
arbitrary TOML paths.

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

`/model` combines the pinned pi-ai catalog with the user-owned `~/.mycli/models.json` declarations.
The Node runtime does not create that file during discovery when it is missing, and validates provider/protocol, endpoint,
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
- Plugin commands are additive. They cannot replace a built-in name or reclaim a retired route.

The executable source of truth is
`backend/apps/mycli/src/node-runtime/node-slash-command-registry.ts`. Its serialized matrix and checksum
are frozen by the M8 capability audit tests.

### Operation feedback

`/compact` shows progress immediately and accepts Esc or Ctrl+C to cancel. Cancellation leaves
existing context intact and is reported separately from a compaction failure. Automatic compaction
uses its own timer; ordinary Working timing resumes afterward. Model selection confirms both the
selected model and its scope, and approval choices remain visible in the live conversation view.

Local compaction follows the Codex handoff flow: it keeps the original message roles and base
instructions, appends a concise checkpoint request as the last user message, and supplies no tools.
It uses the selected model's current reasoning effort and normal generation limits. Completed
summaries have no separate 4096-token cap and are not shortened by another model request.

If the input exceeds the model context window, the summary request drops the oldest items and
paired tool results until it can complete or no history remains to remove. Each changed input uses
the configured request/stream retry budgets. Cancellation, ownership loss and the estimated
remaining Goal budget are checked before dispatch; each attempt's reported usage is counted.

The replacement window contains recent user-message text followed by the handoff summary. User
text has a default 20,000-token retention budget (`context.compaction_tail_max_tokens`); the boundary
message is shortened with an explicit marker. Pre-turn compaction appends fresh incoming input
after this replacement. Other prior assistant/tool output and images are represented by the summary.
Current instructions and runtime context are supplied again on the next normal provider request.
The readable transcript is preserved. Failures and cancellation keep the original window and the
previous completed checkpoint, with specific failures visible after reopening the session.

The old full-turn retention, summary-size/economics, savings-ratio and file-rehydration settings
remain accepted for config compatibility but no longer control local compaction. Local compaction
does not reread workspace files or reject a completed summary based on estimated savings.

MCP startup and Hook execution report progress and failures in the main interface. Use `/mcp`
or `/hooks` for details. `/settings` includes **Terminal notifications**, enabled by default for
unfocused terminals that support OSC 9. Set `tui_terminal_notifications = false` to disable them.
After a gateway disconnect, use the printed `mycli session resume <id>` command to reopen the session.
