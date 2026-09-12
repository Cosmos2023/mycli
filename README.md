# mycli

[![npm version](https://img.shields.io/npm/v/%40cosmos2023%2Fmycli)](https://www.npmjs.com/package/@cosmos2023/mycli)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19.0-339933)](https://nodejs.org/)

A terminal coding agent for your repositories and everyday work.

mycli reads files, investigates bugs, edits code, runs commands, and helps you work through tasks
with the model provider you choose. It combines an interactive terminal UI with persistent
sessions, explicit permissions, and extensible skills, MCP servers, hooks, and plugins.

Built with Node.js and TypeScript for macOS, Linux, and Windows. Sessions and configuration stay
on your machine; model requests and external tool calls go to the providers you configure.

[Quick Start](#quick-start) |
[Installation](#installation) |
[Features](#features) |
[Usage](#usage) |
[Configuration](#configuration) |
[Extensions](#extensions) |
[Documentation](#documentation)

## Quick Start

You need **Node.js 22.19.0 or newer**, npm, a terminal, and access to a model provider through an
API key or supported OAuth login. Node 24 is also supported.

```bash
npm install -g @cosmos2023/mycli
cd /path/to/your/project
mycli setup
mycli
```

Setup lets you choose a provider, model, endpoint, and credential. API-key entry is masked.
On your first interactive launch, review the workspace trust and permission choices. The optional
connection check sends one test request; skipping it leaves setup usable offline.

Then describe a task in the composer:

```text
Find the cause of the failing tests, fix it, and run the relevant checks.
```

Other starting points:

```text
Explain how authentication works in this repository.
Review the current diff for correctness and missing tests.
Summarize the errors in logs/app.log and suggest what to investigate next.
```

Use `/model` to change models, `/permissions` to review execution permissions, and `/help` for
commands and keyboard shortcuts.

## Installation

### npm

```bash
npm install -g @cosmos2023/mycli
mycli --version
```

Update an existing installation with:

```bash
npm install -g @cosmos2023/mycli@latest
```

`mycli update check` checks for a release and shows installation guidance; it does not install it.

### From Source

```bash
git clone https://github.com/Cosmos2023/mycli.git
cd mycli
npm ci
npm run build
npm run mycli -- setup
npm run mycli
```

`npm run mycli` uses the compiled production entry. After changing source, rebuild or use
`npm run dev` to run it through `tsx`. Pass CLI arguments after `--`, for example
`npm run mycli -- --session demo`.

This README describes the current source tree. npm installs the latest published release;
use a source checkout for changes that have not been released.

### Platform Requirements

The CLI uses native dependencies for SQLite, terminal processes, and image decoding. When a
prebuilt binary is unavailable, installation needs the usual
[node-gyp build prerequisites](https://github.com/nodejs/node-gyp#installation).
Keep npm optional dependencies enabled for packaged ripgrep and image support.

| Platform | Restricted Shell execution |
| --- | --- |
| macOS | Uses the system `/usr/bin/sandbox-exec` |
| Linux | Requires Bubblewrap (`bwrap`) and working user namespaces |
| Windows | Uses the packaged Windows sandbox helper; `mycli sandbox setup` previews setup |

Run `mycli sandbox status` to inspect readiness. See the
[sandbox and network guide](docs/network-policy.md) for setup and policy details.

## Features

- **Repository work:** read source and text files, search with ripgrep, apply edits and patches,
  inspect changes, and run your project's checks.
- **Model choice:** switch providers, models, and supported reasoning levels without leaving the TUI.
  Compatible API endpoints and provider-specific model catalogs are configurable.
- **Interactive terminal:** streamed responses, rendered diffs, grouped read/search activity, tool
  details, approval dialogs, and searchable command and settings menus.
- **Persistent work:** save, resume, search, and fork sessions; steer an active turn or queue a
  follow-up; inspect context usage and compact long conversations.
- **Shell workflows:** run foreground or background commands, interact with their terminals, and
  inspect or stop background work.
- **Images and the web:** attach images or inspect local images with capable models, fetch web
  pages, and use hosted web search on supported Responses routes.
- **Extensibility:** load repository guidance and skills, connect MCP servers, install plugin
  bundles, and configure lifecycle hooks.
- **Delegation:** independent agent threads with their own durable state, coordination, and
  completion delivery.
- **Automation:** execute a task or review changes without a TTY, emit JSONL events, validate
  structured answers, or connect through the app-server protocol.
- **Execution controls:** workspace trust, permission profiles, command approvals, process
  sandboxing, and optional managed policy bounds.
- **Optional memory:** retain useful context across tasks when enabled. Memory is off by default.

## Usage

### Interactive Work

Start in the directory you want mycli to work on:

```bash
mycli
mycli --session demo
mycli --model gpt-5.5
mycli --profile work
```

`--session` opens or creates the named session. `--model` overrides model selection, and
`--profile` (or `-p`) applies a configuration profile for this launch.

While a turn runs, submitting another message steers the active work when possible. Tab queues
the draft as a follow-up. The TUI keeps tool activity, background terminals, and pending decisions
separate from the conversation.

Common commands:

| Command | Purpose |
| --- | --- |
| `/model` | Select a provider, model, and reasoning level |
| `/plan [task]` | Enter Plan mode; optionally start planning a task |
| `/permissions` | Review or change execution permissions |
| `/settings` | Change appearance and navigate runtime settings |
| `/new` | Start a new session |
| `/resume` | Browse and resume saved sessions |
| `/fork` | Branch a saved session |
| `/status`, `/usage`, `/context` | Inspect runtime state, token usage, and context |
| `/compact` | Compact the current model context |
| `/diff`, `/review` | Inspect Git changes or start a read-only code review |
| `/changes`, `/undo` | Inspect session file history or undo a recoverable change |
| `/rename [title]`, `/clear` | Rename the conversation or start a fresh session and clear the terminal |
| `/init` | Create repository guidance in AGENTS.md, preserving an existing file |
| `/agents`, `/ps` | Inspect background agents and terminals |
| `/mcp`, `/plugins`, `/skills`, `/hooks` | Browse each integration separately |
| `/help`, `/quit` | Open help or exit |

The default menu emphasizes common commands. Diagnostic entries such as `/tools`, `/resources`,
and `/trace` remain available through search. See the [full command reference](docs/commands.md)
for arguments, turn availability, and retired-command replacements.

Default shortcuts:

| Key | Action |
| --- | --- |
| `Ctrl+P` | Search commands and settings |
| `Ctrl+O` | Expand or collapse tool details |
| `Ctrl+T` | Open the transcript viewer |
| `Shift+Tab` | Cycle Default and Plan mode while idle |
| `Tab` | Queue a follow-up while a turn runs |
| `Esc` | Go back in a selector or interrupt active work |
| `Ctrl+A` in an approval | Inspect the complete command or permission request |

Selectors own their keys while open. Keybindings and terminal accessibility options are
configurable; see [terminal controls](docs/terminal-accessibility.md).

### Sessions And Background Work

Sessions retain messages, tool results, model settings, and usage locally. Browse them with
`/resume`, or manage them from an ordinary shell:

```bash
mycli session list --last
mycli session list --all --json
mycli session resume <session-id>
mycli session fork <session-id> investigation
mycli session export <session-id> --json
```

Resuming in a new runtime preserves completed work and interrupts the old unfinished turn. It does
not replay old tool calls, restore unanswered approvals, or revive background processes.
Reconnecting to a backend that is still running retains that backend's current requests and
processes. See [session management](docs/sessions.md) for recovery and repair behavior.

Within a running session, `/ps` lists background terminals and `/ps stop-all` stops them.
`/agents` opens the agent view.

### Noninteractive Tasks And Reviews

`exec` runs a task without an interactive terminal. `review` runs a read-only review of Git changes:

```bash
mycli exec "Explain the main modules in this repository"
mycli exec --json - < task.txt
mycli exec --output-schema result.schema.json -o result.json "Inspect the repository"
mycli review --uncommitted
mycli review --base main --json
mycli review --commit HEAD -o findings.json
```

Configure credentials and workspace trust through the interactive flow first. Both commands keep
normal execution policy; if approval or user input is required, they report it and exit with code
`3`. They do not open an interactive approval dialog. Use `--timeout <seconds>` to bound execution.

`--json` emits versioned JSONL events, including the final result. `--output-schema` validates the
final JSON answer before writing it. `review` reports findings without editing files or running
tests. See [noninteractive commands](docs/commands.md#noninteractive-coding-commands).

Applications can use `mycli app-server` for JSON-RPC over stdio or import the published backend
and gateway package APIs. See the [gateway API](docs/gateway.md).

## Providers And Models

Built-in product routes include OpenAI, Codex, Anthropic, DeepSeek, Qwen/DashScope, OpenRouter,
Groq, Together, Moonshot AI, NVIDIA, and Cerebras. Additional providers and model metadata come
from the pinned pi-ai directory; compatible endpoints can be declared explicitly.

The Qwen Token Plan routes `qwen-token-plan`, `qwen-token-plan-cn`, and
`qwen-token-plan-individual` are also available. They have separate endpoints and credentials
from the ordinary `qwen` DashScope route and retain experimental support status.

Open `/model` to browse the current provider's models. Use `[` and `]` to switch activated
providers, or Esc to open the provider list. Enter applies a session selection; Tab opens reasoning
and scope options. Routes show `ready` or `login required` based on their credential reference.
`/model <name>` searches only the active provider.

For supported native providers, `mycli login --oauth --provider <provider-id>` starts the
provider's OAuth flow. API-key setup, OAuth availability, custom routes, endpoint overrides,
image support, and model policies are described in [provider support](docs/providers.md).

Hosted `web_search` depends on the selected Responses model and endpoint. When enabled, its
activity appears in the transcript. `web_fetch` retrieves a known public URL under local execution
policy. A provider supporting ordinary tool calls does not necessarily support hosted search.

## Configuration

Use `mycli setup` for the first provider and credential, `/model` for model selection, and
`/settings` for interactive preferences. Common configuration commands work without a model call:

```bash
mycli config validate
mycli config show
mycli config get model.name
mycli config set tui.theme light
mycli config set tui.reduced_motion true
mycli config set memory.enabled true
mycli config unset memory.enabled
mycli config path
```

`config set` and `config unset` update supported scalar settings in the user file. Structured
tables and custom model catalogs are edited in their files. `config validate --strict` also fails
on warnings. Credentials are never printed by `config show`.

### Configuration Files

| Path | Purpose |
| --- | --- |
| `~/.mycli/config.toml` | User defaults for models, requests, runtime, memory, Shell, and TUI |
| `~/.mycli/auth.json` | Stored API keys and supported OAuth credentials |
| `~/.mycli/models.json` | Provider activation, custom endpoints, and model metadata or subsets |
| `~/.mycli/<name>.config.toml` | Profile selected with `mycli --profile <name>` |
| `<workspace>/.mycli/config.toml` | Trusted repository configuration |
| `~/.mycli/managed_config.toml` | Optional administrator bounds on execution permissions |
| `~/.mycli/sessions.db` | Authoritative session and transcript storage |
| `~/.mycli/sessions/` | Readable session projections and retained task output |
| `~/.mycli/plugin-registry.json`, `~/.mycli/plugin-cache/` | Plugin installations, marketplaces, and package snapshots |

Example `~/.mycli/config.toml`:

```toml
tui_reduced_motion = false

[model]
provider = "openai"
protocol = "responses"
name = "gpt-5.5"
api_base_url = "https://api.openai.com/v1"
auth_ref = "openai"

[reasoning]
enabled = true
effort = "medium"

[request]
request_max_retries = 4
stream_max_retries = 5
cache_retention = "short"

[memory]
enabled = false
```

CLI setting names can differ from TOML paths: `config set tui.reduced_motion false` writes the
top-level `tui_reduced_motion` field. Use `config set` or the commented reference when changing settings.

The `auth_ref` names a stored credential; it is not the API key. Prefer the masked setup/login
flow. Automation can pass an already-provided key through stdin without putting it in argv:

```bash
printf '%s\n' "$MYCLI_API_KEY" | \
  mycli setup --non-interactive --provider openai --with-api-key --json
```

Session/CLI overrides take precedence over environment variables, trusted repository config,
the selected profile, user config, system defaults, and built-in defaults. Managed execution
policy imposes separate upper bounds. Repository configuration and instructions only participate
after the workspace is trusted.

Environment overrides include `MYCLI_API_KEY`, `MYCLI_PROVIDER`, `MYCLI_MODEL`,
`MYCLI_PROTOCOL`, and `MYCLI_BASE_URL`. The complete keys, defaults, and examples are in the
[configuration reference](docs/reference/configuration.md) and
[commented TOML example](docs/reference/config.example.toml).
For older configurations, start with `mycli config migrate --dry-run`; see
[configuration migration](docs/commands.md#configuration-management).

### Repository Instructions

Place an `AGENTS.md` in your repository to describe project conventions, test commands, and
constraints. mycli loads applicable guidance from the workspace root through the current directory,
with more local guidance taking precedence. `.mycli.md` is also supported.

Guidance provides context, not execution permissions. See
[workspace guidance](docs/commands.md#workspace-guidance) for aliases and fallback rules.

## Extensions

Tools, MCP, skills, hooks, and plugins serve different purposes:

| Capability | Purpose | TUI entry |
| --- | --- | --- |
| Tools | Actions the model can call, such as reading a file or running a Shell command | `/tools [list\|sets]` |
| MCP | External servers contributing tools and resources | `/mcp [verbose]` |
| Skills | Reusable task instructions | `/skills` |
| Hooks | Commands associated with runtime lifecycle events | `/hooks` |
| Plugins | Packages contributing skills, MCP servers, hooks, or Plugin API v2 capabilities | `/plugins` |

Inspection supports filtering and keyboard navigation. Enter opens details and Esc goes back.
Inspecting a package or tool does not invoke it. MCP servers retain their own loading, disabled,
failed, and cached states; they are not listed as plugin packages.

The model can select relevant MCP and plugin tools from the task context. Small catalogs are
provided directly; larger catalogs use `tool_search`, and later turns can reuse discovered tools
whose definitions still match the current allowed catalog. Execution follows approval and sandbox
policy. MCP resources and templates use `list_mcp_resources`, `list_mcp_resource_templates`, and
`read_mcp_resource`. See [extension operations](docs/node-extensions.md) for exposure and retention limits.

### Skills

Add a reusable skill at `.agents/skills/repository-review/SKILL.md`:

```markdown
---
name: repository-review
description: Review repository changes for correctness and risk.
---

Inspect the diff, identify behavioral regressions, and report findings with file references.
```

User skills live under `~/.mycli/skills/`. Trusted repositories can also use `.mycli/skills/`.
Open `/skills` to search the catalog, insert a selected `$skill` into your draft, or enable/disable skills.
Selections retain their source identity through queued input and session recovery. Changes to skill files
and availability are picked up for subsequent turns. You can also ask the agent to use the skill
for the relevant task.

### MCP Servers

Configure user servers in `~/.mycli/mcp_servers.toml`, or repository servers in
`.mycli/mcp_servers.toml`:

```toml
[servers.local]
transport = "stdio"
command = "node"
args = ["/absolute/path/to/mcp-server.js"]
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 60

[servers.docs]
transport = "streamable_http"
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "MCP_TOKEN"
startup_timeout_sec = 20
tool_timeout_sec = 60
default_tools_approval_mode = "auto"
```

Replace the example command or endpoint with your server and set any referenced environment
variables. Repository servers load only in trusted workspaces. You can also manage user configuration
without starting the server:

```bash
mycli mcp add docs --url https://mcp.example.com/mcp
mycli mcp add local -- node /absolute/path/to/mcp-server.js
mycli mcp remove docs
mycli mcp approvals
mycli mcp revoke docs
mycli mcp login docs
mycli mcp logout docs
```

Stdio MCP servers run as ordinary local subprocesses with the current user's filesystem and network
access by default, independently of the Shell permission preset. Explicit server sandbox settings
and managed filesystem/network restrictions still apply. Server/tool approval modes, tool allow/deny lists, separate
startup/call timeouts, and required-server readiness are configurable. Interactive approvals can
allow one call, the session, or remember authorization for the unchanged server/tool definition.

`mycli mcp list` and
`mycli mcp inspect <server-id>` verify discovery and may start or contact enabled servers.
Use `/mcp verbose` in the TUI to inspect the current catalog. See
the [OAuth and server question guide](docs/node-extensions.md#oauth-authentication) for browser
authorization, typed MCP forms and URL requests. Supported providers load discovered tool schemas
at their history position through pi-ai; other providers retain ordinary function calling. See
[MCP configuration](docs/node-extensions.md#mcp) for transports, resource pagination, and recovery.

### Plugins And Marketplaces

Install a local bundle or a Git repository:

```bash
mycli plugins add ./my-plugin
mycli plugins add owner/repository --ref stable
mycli plugins list
mycli plugins inspect my-plugin --json
mycli plugins disable my-plugin
mycli plugins enable my-plugin
mycli plugins update my-plugin
mycli plugins remove my-plugin
```

Or register a marketplace whose manifest names it `personal`:

```bash
mycli plugins marketplace add ./personal-marketplace
mycli plugins list --available --marketplace personal
mycli plugins add my-plugin@personal
```

Codex-style bundles use `.codex-plugin/plugin.json` or `.claude-plugin/plugin.json` and can
contribute skills, MCP servers, and supported command hooks. Plugin API v2 uses `plugin.yaml`
and compiled ESM for process-hosted tools, hooks, and commands.

Package changes apply before the next turn or an idle catalog inspection. Active turns, including
approval waits, keep their original tools and connections until they finish. Each session refreshes
independently; a waiting child does not block its parent's updates. `/plugins` opens a searchable
browser with All Plugins, Installed, and marketplace tabs. Enter opens capabilities and actions;
Space toggles enablement when the search is empty. Install, update, uninstall, and marketplace
management are available inside the TUI. Ctrl+N installs from a local/Git source, Ctrl+R refreshes,
and Esc goes back or cancels pending work. Plugin MCP servers use the same login commands, with
readable selectors:

```bash
mycli mcp inspect my-plugin/server-name
mycli mcp login my-plugin/server-name
mycli mcp logout my-plugin/server-name
```

OpenAI-hosted Apps and prompt/agent hook types are not supported. See
[plugin installation and compatibility](docs/plugin-codex-parity.md) for package formats,
marketplaces, and the supported Codex subset.

### Hooks

User and repository hooks live in `~/.mycli/hooks.json` and `.mycli/hooks.json`.
`/hooks` groups them by event and shows the command, source, availability and trust. Enable/disable
a hook separately from trusting its exact command; changes apply to subsequent turns. Plugin hooks
show their plugin ownership and inherit the enabled plugin’s trust.
Use `mycli hooks list` to find their identities, `mycli hooks inspect <identity>` to inspect them,
and `mycli hooks approve <identity>` to authorize the current configured command.
Changing that command requires approval again.

Installing or enabling a plugin authorizes its declared hooks. Hooks still run under the workspace
sandbox. See [hook configuration](docs/node-extensions.md#configured-hooks) before enabling them.

## Permissions And Data

`/permissions` selects a Read-only, Workspace, or Full Access profile. Shell approval dialogs show
the proposed command and available reason, with `Ctrl+A` for full details. The default Workspace
profile enables Shell and web-tool networking while restricting writes to the workspace. Read-only
starts offline; managed network and domain restrictions apply to every profile.

Restricted Shell execution requires the platform sandbox. Missing isolation produces an error
instead of silently running unrestricted. Administrators can restrict readable paths, writable
paths, network access, and allowed domains through managed policy.

Conversation history, tool results, attachments, and credentials are stored locally. Relevant
content is sent to the selected model provider or external integration when used. Review provider
and integration policies for sensitive work, and keep secrets out of repository configuration.

See [execution policy](docs/network-policy.md), [session storage](docs/sessions.md), and
[diagnostics](docs/diagnostics-and-updates.md) for boundaries and retained data.

## Troubleshooting

Start with `mycli doctor` and `mycli config validate`.

| Problem | First checks |
| --- | --- |
| `mycli` is not found | Check that the npm global executable directory is on `PATH` |
| Native dependency installation fails | Check Node version and the platform's node-gyp prerequisites |
| Credentials are missing or rejected | Run `mycli login status`, then `mycli setup` or `/login` |
| A model is missing from `/model` | Check the selected provider, route activation, and `models.json` policy |
| Shell reports sandbox initialization failure | Run `mycli sandbox status` and review the platform setup |
| Text, colors, or input look wrong | Check `/settings`, `NO_COLOR`, and terminal accessibility settings |
| An MCP server or plugin is unavailable | Inspect `/mcp` or `/plugins`, then run `mycli doctor` |
| A saved session cannot resume | Use `/resume` and review its repair preview |

For startup timing, `MYCLI_STARTUP_PROFILE=1 mycli` writes a local report at
`~/.mycli/logs/startup-profile.json`. `mycli doctor --support-bundle` produces bounded,
redacted diagnostic data. Review what you share when
[reporting an issue](https://github.com/Cosmos2023/mycli/issues).

More help: [troubleshooting](docs/troubleshooting.md) and
[upgrading or rolling back](docs/upgrading.md). Back up `~/.mycli` before migrations or a
version downgrade; older versions may not understand newer session storage.

## Development

This is an npm workspace. Start with the [source installation](#from-source) above.

```text
backend/
  apps/mycli/       CLI, runtime composition, management, and gateway
  packages/        Core, contracts, runtime, providers, tools, storage, and integrations
tui/mycli-shell/    Terminal UI and gateway client
native/            Platform helper source
npm/ripgrep/       Platform-specific ripgrep packages
tests/fixtures/    Shared regression data
scripts/           Build, test, release, and smoke tooling
docs/              User guides and architecture
```

Run the repository checks:

```bash
npm run contracts:check
npm run lint
npm run test:ci
npm run typecheck
npm run smoke:m8
npm run smoke:package
```

`test:ci` builds the workspaces and runs the unit, contract, integration, platform, and release
test suites. `npm run test:list` shows their distribution. The packed smoke installs the npm
artifact and exercises its production entry points. CI is configured for Node 22.19.0 and Node 24
on Linux, macOS, and Windows.

For contributions, read [AGENTS.md](AGENTS.md), keep changes focused, add coverage for behavior
changes, and update the relevant documentation. See [testing](docs/testing.md),
[architecture](docs/architecture.md), and [release preparation](docs/releasing.md).

## Documentation

| Guide | Topics |
| --- | --- |
| [Commands](docs/commands.md) | CLI, slash commands, headless execution, and completion |
| [Providers](docs/providers.md) | Models, credentials, reasoning, and compatible endpoints |
| [Configuration](docs/reference/configuration.md) | Supported settings, defaults, and overrides |
| [Terminal UI](docs/terminal-accessibility.md) | Appearance, keymaps, input, approvals, and accessibility |
| [Sessions](docs/sessions.md) | History, resume, repair, fork, and export |
| [Extensions](docs/node-extensions.md) | Skills, MCP, resources, hooks, and tool discovery |
| [Plugins](docs/plugin-codex-parity.md) | Installation, marketplaces, formats, and compatibility |
| [Agent Threads](docs/node-agent-runtime.md) | Delegation, coordination, permissions, and recovery |
| [Gateway API](docs/gateway.md) | App-server and embedding integrations |
| [Troubleshooting](docs/troubleshooting.md) | Runtime, provider, terminal, and sandbox issues |

[Browse all documentation](docs/README.md).
