# mycli

`mycli` is a local-first terminal coding agent implemented on Node.js. It combines model
conversation, structured tool calls, file mutation, persistent shells, sessions, compaction,
memory, MCP, skills, plugins, hooks, and subagents behind one terminal UI.

The npm CLI is the only maintained product runtime. The repository does not ship a second runtime,
fallback process, or language-specific compatibility writer.

## Requirements

- Node.js `>=22.19.0`; Node 24 is supported and used by the release matrix.
- npm.
- An API key for OpenAI Responses, OpenAI-compatible Chat Completions, or Anthropic Messages.
- A real TTY for the interactive UI. Provider-free management commands also work without a TTY.

Persistent PTY support uses the pinned `node-pty@1.2.0-beta.15`. If npm cannot use a prebuilt
binary, the host needs the normal `node-gyp` compiler prerequisites. These are install-time build
requirements, not mycli runtime dependencies.

## Repository Layout

- `backend/apps/mycli/`: Node CLI composition, management commands, backend, and gateway.
- `backend/packages/`: Node domain, runtime, storage, providers, integrations, tools, config, and contracts.
- `tui/mycli-shell/`: terminal UI and gateway client.
- `npm/ripgrep/<target>/`: release-only optional native packages, kept outside npm workspaces.
- `native/`: platform helper source; `scripts/`: Node build, release, benchmark, and smoke automation.
- `tests/fixtures/`: checksum-protected language-neutral regression corpora consumed by Node tests.
- `docs/`: user, migration, architecture, and parity documentation.

## Install And Run

From this source checkout:

```bash
npm ci
npm run build
npm run mycli
```

`npm run mycli` runs the compiled production entry for the fastest startup. After changing
TypeScript source, run `npm run build` again or use `npm run dev` to execute the current source
directly through `tsx`.

For local startup diagnosis, run `MYCLI_STARTUP_PROFILE=1 npm run mycli`. The latest report is
written to `~/.mycli/logs/startup-profile.json` with stage names and elapsed milliseconds only.
Profiling is disabled by default and never enters the session transcript or provider context.

On first use, configure a provider through the setup wizard:

```bash
npm run mycli -- setup
```

`@mycli/tools` declares six OS/CPU-specific ripgrep packages as optional dependencies. npm installs
only the package compatible with the current machine, and the CLI prepends its ripgrep 15.1.0
directory to `PATH` at startup. Source checkouts and older packages use the setup-prepared fallback
under `~/.mycli/vendor/ripgrep/<platform>-<architecture>/`; system `PATH` remains the final fallback.
Every downloaded archive is SHA-256 verified. A setup download failure is reported without
discarding provider configuration that was already saved.

Common startup forms:

```bash
npm run mycli
npm run mycli -- --session demo
npm run mycli -- --model gpt-5.5
```

`--runtime-backend` and `MYCLI_RUNTIME_BACKEND` are retired. Passing the old flag is a usage error;
startup always uses the Node runtime. The former Python console script and wheel are no longer
shipped, so existing users must install and launch the npm CLI shown above.

## Configuration

Setup writes user state under `~/.mycli`:

- `config.toml`: provider, model, runtime, context, memory, shell, and TUI settings.
- `managed_config.toml`: optional execution-policy upper bounds loaded independently of user and
  project configuration.
- `auth.json`: API keys referenced by `auth_ref`.
- `models.json`: the provider-grouped model catalog used by `/model`, including reasoning and
  context/output capabilities. Legacy flat catalogs remain readable.
- `sessions.db`: durable session, turn, queue, approval, clarification, shell, and trace state.
- `sessions/<session-id>/`: readable projections derived from SQLite: schema-v2 `session.json`,
  append-only `events.jsonl`, retained background output under `tasks/`, and subagent snapshots
  under `subagents/`.
- `logs/`: bounded redacted operational diagnostics.
- `vendor/ripgrep/`: the verified user-level `rg` fallback prepared by setup when needed.

Effective runtime configuration uses this precedence, from highest to lowest: session/CLI
overrides, environment variables, trusted project config at `<workspace>/.mycli/config.toml`, user
config at `~/.mycli/config.toml`, legacy user config at `~/.config/mycli/config.toml`, and built-in
defaults. Project configuration is not read until the canonical workspace has a persisted `trusted`
decision. Credentials belong in `auth.json` or the environment, never in project configuration.

Configuration validation is value-free: `mycli doctor` reports the owning layer and dotted key path
for unknown keys or tables, and reports parser-provided line and column numbers for invalid TOML.
Unknown entries are warnings and are ignored by the runtime. Invalid known values and credential
fields inside configuration tables are errors. A legacy root-level `api_key` in user configuration
remains readable with a migration warning; move it to `~/.mycli/auth.json` and remove it from TOML.
Diagnostic output never includes the configured value, TOML source text, an exception stack, or an
absolute configuration path.

Use the provider-free configuration commands to check configuration before starting an agent:

```bash
mycli config validate
mycli config show
mycli config show --json
```

`config validate` exits `0` for valid configuration, including unknown-key and migration warnings,
and exits `1` for fatal syntax or value errors. `config show` lists effective non-secret settings,
their winning layer, and lower-priority overridden layers. It reports only `present` or `missing`
for the API key and never prints credential values, raw TOML, environment values, or absolute
configuration paths. Project configuration remains disabled until the workspace is trusted.

`sessions.db` is authoritative. The Node runtime repairs derivable session files during session
preparation; deleting or corrupting a projection does not make it a provider-recovery source.

Example provider configuration:

```toml
[model]
provider = "openai"
protocol = "responses"
name = "gpt-5.5"
api_base_url = "https://api.openai.com/v1"
auth_ref = "openai-primary"
supports_images = true

[request]
request_max_retries = 4
stream_max_retries = 5
prompt_cache_key_enabled = true

[reasoning]
enabled = true
effort = "medium"

[memory]
enabled = false

[features]
request_permissions_tool = false
```

`request_max_retries` controls connection/request retries before the first provider event.
`stream_max_retries` controls recovery of an incomplete provider stream; any partial assistant
output from the failed attempt is discarded before the replacement stream is displayed.

Hosted web search is enabled by default for the `openai` and `codex` profiles when they use the
Responses protocol. It is disabled by default for compatible, Qwen, DeepSeek, and Anthropic
profiles; model names are not used to guess support. A custom Responses endpoint can opt in at the
provider level, and an individual model can override that choice in `~/.mycli/models.json`:

```json
{
  "version": 2,
  "providers": {
    "compatible": {
      "protocol": "responses",
      "base_url": "https://provider.example/v1",
      "auth_ref": "compatible",
      "capabilities": { "web_search": true },
      "models": {
        "search-model": {},
        "offline-model": {
          "capabilities": { "web_search": false }
        }
      }
    }
  }
}
```

`capabilities.web_search = true` is valid only with `protocol = "responses"`. Hosted search runs
inside the provider without a local tool approval. mycli persists a bounded provider-native call
for continuation replay and a readable search activity for `/resume`, but not fetched page bodies
or raw search results.

Memory is disabled by default so normal turns never incur memory selection,
extraction, consolidation, or injected-context token usage. Set
`[memory].enabled = true` or `MYCLI_MEMORY_ENABLED=true` to opt in.

The experimental `request_permissions` model tool is disabled by default. Enable it with
`[features].request_permissions_tool = true` or `MYCLI_REQUEST_PERMISSIONS_TOOL=true`. Normal
Shell and file operations continue to request approval at their own execution boundary when this
feature is disabled.

Environment overrides take precedence over files:

```bash
export MYCLI_API_KEY="your-api-key"
export MYCLI_PROVIDER="openai"
export MYCLI_PROTOCOL="responses"
export MYCLI_MODEL="gpt-5.5"
export MYCLI_BASE_URL="https://api.openai.com/v1"
```

Do not put credentials in project config, logs, plugin manifests, prompts, or bug reports.

OpenAI, Codex, Qwen, Anthropic, and compatible profiles enable image input by default. DeepSeek
keeps it disabled because its current profile is text-only. Override a compatible endpoint with
`[model].supports_images` or `MYCLI_SUPPORTS_IMAGES`. The Node TUI accepts PNG, JPEG, GIF, and WebP
attachments, up to 16 files, 10 MB per file, and 15 MB total per submitted input. Canonical image
data is retained in SQLite so a resumed provider turn does not depend on the original local file.

## Runtime Capabilities

- Streamed text and reasoning with bounded retries, cancellation, and explicit terminal states.
- Durable SQLite sessions, resume/fork/search, follow-up queues, idempotent turn submission, and
  restart recovery.
- Immediate, exactly-once live user-message projection that matches resumed transcript identity.
- Local image attachments across initial, steering, and follow-up input, with provider-specific
  Chat Completions, Responses, and Anthropic serialization.
- Approval and clarification suspension that survives restart and resumes the owning turn once.
- Structured context compaction, memory extraction, context diagnostics, and usage accounting.
- `Read`, `Edit`, `Patch`, `Write`, `AskUserQuestion`, `Shell`, `WriteStdin`, `web_fetch`, and
  `tool_search`, with hidden compatibility routes for shell polling and control.
- `Edit`, `Patch`, and `Write` keep the active turn filesystem policy by default. In a restricted
  turn, `danger-full-access` is accepted only as a justified, one-time retry of the same operation
  after workspace confinement returned `workspace_escape`, and still requires user approval.
- `web_fetch` retrieves only bounded public HTTP(S) text under a network-enabled execution policy;
  it blocks private/local targets, enforces managed exact/wildcard domain constraints across every
  redirect, and fences returned content as untrusted external data.
- Responses `web_search` is provider-hosted and intended for discovering current external sources;
  `web_fetch` remains the local tool for retrieving a known URL under mycli's execution policy.
- MCP and plugin schemas are discovered through `tool_search` and become visible only after the
  search result is durably persisted for the current turn. Their adapters, approvals, and sandbox
  policy remain active throughout.
- Persistent PTY/ConPTY shells, background jobs, `/ps`, `/stop`, output cursors, interruption, and
  owner-scoped cleanup.
- Managed Shell processes resolve `rg` from the current optional platform package, the legacy
  `@mycli/tools` vendor directory, the user vendor directory, then the inherited system `PATH`.
  The selected directory is placed first in `PATH` and exposed as `MYCLI_RIPGREP_PATH_DIR` without
  forwarding secret-like parent variables.
- Skills, stdio/remote MCP, configured hooks, compiled ESM Plugin API v2, and independently durable
  agent threads with canonical paths, automatic completion delivery, reload, and bounded waiting.
- Workspace trust, read-only/workspace/full-access permission profiles, command allowances, and
  fail-closed process sandboxing.

`LS`, `Glob`, and `Grep` are intentionally retired. `Read` owns bounded file, directory, glob, and
search discovery so the provider sees one canonical read-only tool contract.

New turns expose `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, and
`list_agents`; `spawn_agent` is the only child-spawn tool. `Task`, `SendMessage`, and
`SubagentOutput` are absent from new provider definitions. Background completion is delivered through
the durable parent mailbox without polling or a fabricated user transcript row. See
[docs/node-agent-runtime.md](docs/node-agent-runtime.md) for configuration, permissions, recovery,
artifacts, and TUI behavior.

## Commands

The interactive UI exposes a Node-owned registry of 35 built-in slash commands. The main
families are:

- Model and control: `/model`, `/plan`, `/mode`, `/permissions`, `/sandbox`.
- Sessions and runtime: `/new`, `/resume`, `/fork`, `/status`, `/usage`, `/context`, `/compact`,
  `/stats`.
- Extensions and resources: `/skills`, `/tools`, `/resources`, `/agents` (`/tasks` is a compatibility alias).
- Memory and changes: `/memory`, `/changes`, `/undo`, `/trace`.
- Shell and UI: `/ps [stop-all]`, `/details`, `/view`, `/hotkeys`, `/copy`, `/clear`.
- Account and exit: `/login`, `/trust`, `/help`, `/quit`.
- Maintenance: `/session search`, `/session maintenance`.

Aliases, argument policies, running-turn availability, and TUI/backend ownership are documented in
[docs/commands.md](docs/commands.md). Interactive input routes only registry-known names as
commands, so absolute paths such as `/tmp` remain ordinary user input. Direct `command.run` calls
with unknown names and malformed known commands fail locally.

Provider-free management commands:

```bash
npm run mycli -- config validate --json
npm run mycli -- config show --json
npm run mycli -- doctor --json
npm run mycli -- hooks list --json
npm run mycli -- plugins list --json
npm run mycli -- mcp list --json
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

An administrator may place upper bounds in `~/.mycli/managed_config.toml`:

```toml
[execution_policy]
network = "enabled"
readable_roots = ["/absolute/managed-input"]
writable_roots = ["/absolute/managed-output"]
allowed_network_domains = ["api.example.com", "*.assets.example.com"]
```

Managed roots must exist when mycli starts. User, project, session, approval, and subagent settings
cannot exceed these bounds. Exact domain entries match only that host; `*.example.com` matches
subdomains but not `example.com`. `web_fetch` enforces the list before the first request and after
every redirect. Until the Shell sandbox has a domain-filtering proxy, a domain-constrained Shell
remains offline rather than receiving unrestricted network access.

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
```

The packed smoke installs the app tarball with its nine vendored runtime workspaces, exercises the compiled CLI and native PTY,
runs provider-free management commands, and fails if the npm artifact imports, starts, invokes, or
probes for Python. It packages only the current ripgrep platform by default; release validation can
package all six platform artifacts with `npm run smoke:package -- --all-platforms`. CI runs the Node
gate on Node 22.19 and Node 24 across Linux, macOS, and Windows, plus native helper matrices. A
credential-gated Responses smoke runs only after the offline Node gates pass.

When a ripgrep download source is unavailable, `npm run smoke:package -- --app-only` still performs
the real application pack/install/runtime checks without weakening the normal release gate.

Canonical contracts live under `backend/packages/contracts/schemas`; generated TypeScript is checked for
drift. The final M8 capability inventory is in
[docs/parity/node-runtime-m8-capability-audit.md](docs/parity/node-runtime-m8-capability-audit.md).

Release preparation, npm Trusted Publishing setup, coordinated versioning, tag publication, and
partial-release recovery are documented in [docs/releasing.md](docs/releasing.md). The workspace
root remains private; users install the published CLI with `npm install -g @mycli/app`.

## Troubleshooting And Rollback

Run `mycli doctor` first, then use [docs/troubleshooting.md](docs/troubleshooting.md) for TTY,
provider, native PTY, sandbox, session, extension, and recovery failures.

M8 rollback means installing the previous release. There is no backend switch in the current
build. Before rolling back, finish or interrupt the active turn, resolve pending input, stop owned
background shells, and back up `~/.mycli`. Do not run two package versions concurrently against the
same active session database.

See [docs/node-runtime-rollout.md](docs/node-runtime-rollout.md) for the release and rollback
contract and [docs/architecture.md](docs/architecture.md) for package ownership.
