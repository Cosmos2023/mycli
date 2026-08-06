# mycli

`mycli` is a local-first terminal coding agent implemented on Node.js. It combines model
conversation, structured tool calls, file mutation, persistent shells, sessions, compaction,
memory, MCP, skills, plugins, hooks, and subagents behind one terminal UI.

The npm CLI production runtime is Node-only. The Python implementation, package, and tests remain
available as an independently launched reference runtime; the Node CLI never falls back to it.

## Requirements

- Node.js `>=22.19.0`; Node 24 is supported and used by the release matrix.
- npm.
- An API key for OpenAI Responses, OpenAI-compatible Chat Completions, or Anthropic Messages.
- A real TTY for the interactive UI. Provider-free management commands also work without a TTY.
- Python 3.13 and `uv` only when developing or launching the retained Python reference runtime.

Persistent PTY support uses the pinned `node-pty@1.2.0-beta.15`. If npm cannot use a prebuilt
binary, the host needs the normal `node-gyp` compiler prerequisites. These are install-time build
requirements, not mycli runtime dependencies.

## Install And Run

From this source checkout:

```bash
npm ci
npm run build
npm run mycli
```

On first use, configure a provider through the setup wizard:

```bash
npm run mycli -- setup
```

Common startup forms:

```bash
npm run mycli
npm run mycli -- --session demo
npm run mycli -- --model gpt-5.5
```

`--runtime-backend`, `MYCLI_RUNTIME_BACKEND`, and the Python sidecar are retired. Passing the old
flag is a usage error instead of silently selecting another runtime.

The retained Python implementation is launched independently, between sessions rather than as an
npm backend fallback:

```bash
uv sync --dev
uv run mycli
```

## Configuration

Setup writes user state under `~/.mycli`:

- `config.toml`: provider, model, runtime, context, memory, shell, and TUI settings.
- `auth.json`: API keys referenced by `auth_ref`.
- `models.json`: the model catalog used by `/model`.
- `sessions.db`: durable session, turn, queue, approval, clarification, shell, and trace state.
- `logs/`: bounded redacted operational diagnostics.

Example provider configuration:

```toml
[model]
provider = "openai"
protocol = "responses"
name = "gpt-5.5"
api_base_url = "https://api.openai.com/v1"
auth_ref = "openai-primary"

[request]
request_max_retries = 4
stream_max_retries = 5
prompt_cache_key_enabled = true

[reasoning]
enabled = true
effort = "medium"

[runtime]
collaboration_mode = "default"
sandbox_mode = "workspace-write"

[memory]
enabled = true
```

Environment overrides take precedence over files:

```bash
export MYCLI_API_KEY="your-api-key"
export MYCLI_PROVIDER="openai"
export MYCLI_PROTOCOL="responses"
export MYCLI_MODEL="gpt-5.5"
export MYCLI_BASE_URL="https://api.openai.com/v1"
```

Do not put credentials in project config, logs, plugin manifests, prompts, or bug reports.

## Runtime Capabilities

- Streamed text and reasoning with bounded retries, cancellation, and explicit terminal states.
- Durable SQLite sessions, resume/fork/search, follow-up queues, idempotent turn submission, and
  restart recovery.
- Immediate, exactly-once live user-message projection that matches resumed transcript identity.
- Approval and clarification suspension that survives restart and resumes the owning turn once.
- Structured context compaction, memory extraction, context diagnostics, and usage accounting.
- `Read`, `Edit`, `Patch`, `Write`, `AskUserQuestion`, `Shell`, and `WriteStdin`, with hidden
  compatibility routes for shell polling and control.
- Persistent PTY/ConPTY shells, background jobs, `/ps`, `/stop`, output cursors, interruption, and
  owner-scoped cleanup.
- Skills, stdio/remote MCP, configured hooks, compiled ESM Plugin API v2, and foreground/background
  subagents.
- Workspace trust, read-only/workspace/full-access permission profiles, command allowances, and
  fail-closed process sandboxing.

`LS`, `Glob`, and `Grep` are intentionally retired. `Read` owns bounded file, directory, glob, and
search discovery so the provider sees one canonical read-only tool contract.

## Commands

The interactive UI exposes a frozen Node-owned registry of 36 built-in slash commands. The main
families are:

- Model and control: `/model`, `/plan`, `/mode`, `/permissions`, `/sandbox`.
- Sessions and runtime: `/new`, `/resume`, `/fork`, `/status`, `/usage`, `/context`, `/compact`,
  `/stats`.
- Extensions and resources: `/skills`, `/tools`, `/resources`, `/agents`, `/tasks`.
- Memory and changes: `/memory`, `/changes`, `/undo`, `/trace`.
- Shell and UI: `/ps`, `/stop`, `/details`, `/view`, `/hotkeys`, `/copy`, `/clear`.
- Account and exit: `/login`, `/trust`, `/help`, `/quit`.
- Maintenance: `/session search`, `/session maintenance`.

Aliases, argument policies, running-turn availability, and TUI/backend ownership are documented in
[docs/commands.md](docs/commands.md). Unknown or malformed slash commands fail locally and are
never sent to the model as ordinary user input.

Provider-free management commands:

```bash
npm run mycli -- doctor --json
npm run mycli -- hooks list --json
npm run mycli -- plugins list --json
npm run mycli -- mcp list --json
npm run mycli -- subagents list --json
```

Invalid usage exits `2`, a failed operation exits `1`, and setup cancellation exits `130`.

## Extensions

- [Node extension operations](docs/node-extensions.md)
- [Plugin API v2](docs/plugin-api-v2.md)
- [Python plugin migration](docs/migration/python-plugins-to-v2.md)

Plugin source must be compiled ESM. Legacy Python plugins are detected as
`migration_required`; mycli never imports or executes them.

## Safety

Workspace trust and permission state are persisted outside the workspace. Restricted process
profiles require the platform sandbox:

- macOS: `/usr/bin/sandbox-exec`.
- Linux: Bubblewrap (`bwrap`).
- Windows: the packaged `mycli-windows-sandbox.exe` helper.

Missing isolation fails with `sandbox_unavailable`; mycli does not downgrade to an unrestricted
process. Diagnostics exclude API keys, headers, prompts, provider payloads, raw tool output,
commands, and private file contents.

## Development

```bash
npm ci
npm run contracts:check
npm run lint
npm test
npm run typecheck
npm run test:m8
npm run smoke:m8
npm run smoke:package
uv run pytest -q
uv run ruff check .
uv run mypy src/mycli
```

The packed smoke installs all local workspace tarballs, exercises the compiled CLI and native PTY,
runs provider-free management commands, and fails if the npm artifact imports, starts, invokes, or
probes for Python. CI runs the Node gate on Node 22.19 and Node 24 across Linux, macOS, and Windows,
plus a Python 3.13 reference gate. A credential-gated Responses smoke runs only after the offline
Node gates pass.

Canonical contracts live under `packages/contracts/schemas`; generated TypeScript is checked for
drift. The final M8 capability inventory is in
[docs/parity/node-runtime-m8-capability-audit.md](docs/parity/node-runtime-m8-capability-audit.md).

## Troubleshooting And Rollback

Run `mycli doctor` first, then use [docs/troubleshooting.md](docs/troubleshooting.md) for TTY,
provider, native PTY, sandbox, session, extension, and recovery failures.

M8 rollback means installing the previous release. There is no backend switch in the current
build. Before rolling back, finish or interrupt the active turn, resolve pending input, stop owned
background shells, and back up `~/.mycli`. Do not run old and new runtimes concurrently against the
same active session database.

See [docs/node-runtime-rollout.md](docs/node-runtime-rollout.md) for the release and rollback
contract and [docs/architecture.md](docs/architecture.md) for package ownership.
