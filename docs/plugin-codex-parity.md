# Plugin Behavior Compared With Codex

Comparison source: the local `codex-main` source snapshot inspected on 2026-09-11. The downloaded
snapshot has no Git revision metadata. This describes inspected code, not a claim about every Codex
release. The package subset supported by mycli is documented below.

## Architecture

Codex plugins are bundles described by `.codex-plugin/plugin.json`. They contribute skills, MCP
servers, apps, and hooks through the existing capability systems. Relevant source files are
`codex-rs/core-plugins/src/manifest.rs` and `codex-rs/core-plugins/src/loader.rs`. Plugin-provided MCP tools
use the MCP client and connection manager, including their server/tool error context.

mycli loads Codex-style bundles through its existing skill, MCP and configured-hook systems.
It also retains process-isolated Plugin API v2: `plugin.yaml`, compiled ESM, and validated
tool/hook/command registrations over JSON-lines. These are separate authoring formats.

## TUI Entry Points

The inspected Codex TUI has separate `/mcp`, `/plugins`, `/skills`, and `/hooks` commands, with no
public `/tools` directory (`codex-rs/tui/src/slash_command.rs` and `chatwidget/slash_dispatch.rs`).
mycli uses those separate domain entries too. `/mcp [verbose]` inspects server state and tools;
`/plugins` lists packages, with capability details on Enter. MCP resources and plugin commands are
not plugin packages and do not appear as separate plugin rows.

mycli retains `/tools [list|sets]` as a search-only diagnostic inventory of actual callable tools.
The old `/tools plugins`, `/tools hooks`, and `/tools extensions` forms return replacement hints.
Codex's plugin browser also has marketplace tabs and installation/enablement actions
(`chatwidget/plugins.rs`). mycli currently performs those operations through `mycli plugins` CLI
commands; its TUI supports inspection, not the full Codex marketplace browser.

## Install And Manage

Install a local directory or a Git repository containing a plugin:

```sh
mycli plugins add ./my-plugin
mycli plugins add owner/repository --ref stable
mycli plugins list
mycli plugins inspect my-plugin --json
mycli plugins disable my-plugin
mycli plugins enable my-plugin
mycli plugins update my-plugin
mycli plugins remove my-plugin
```

Or register a local/Git marketplace and select a package:

```sh
mycli plugins marketplace add ./personal-marketplace
mycli plugins marketplace add owner/plugin-marketplace
mycli plugins marketplace list
mycli plugins list --available --marketplace personal
mycli plugins add my-plugin@personal
mycli plugins marketplace upgrade personal
mycli plugins update my-plugin@personal
mycli plugins marketplace remove personal
```

`list --marketplace personal` filters installed/discovered packages. Add `--available` to include
uninstalled marketplace entries. Marketplace upgrade refreshes the catalog; plugin update is
explicit. Removing a marketplace retains its installed packages. Updates from that marketplace
require registering it again. Every management command supports `--json` and needs no model call.
Git sources support HTTPS, SSH, `owner/repository`, `#ref`, and `--ref`. Credential-bearing URLs,
local Git transports and arbitrary Git transport helpers are rejected; use SSH authentication for
private repositories. Git execution disables user Git config, templates and hooks. It does not run
package install scripts or download submodules; dependencies must already be available.

Package changes apply when a new runtime session starts. In-session `/plugins` shows plugin
state, `/skills` lists namespaced skills, and MCP tools enter the shared integration catalog with direct/deferred exposure and session discovery reuse.

## Package Format

```text
my-plugin/
  .codex-plugin/plugin.json
  skills/review/SKILL.md
  .mcp.json
  hooks/hooks.json
```

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Repository review helpers",
  "skills": "./skills",
  "mcpServers": "./.mcp.json",
  "hooks": "./hooks/hooks.json"
}
```

`.claude-plugin/plugin.json` is an alternate manifest location. Omitted component fields discover
`skills/`, `.mcp.json`, `hooks/hooks.json` and `.app.json`. Declared paths must start with `./`, stay
inside the real package root, and exist. Skills accept one path or an array; MCP accepts a JSON
path or inline server map; hooks accept JSON paths, inline maps, or arrays of those values. Invalid
declared files fail installation before replacing the old package. Malformed individual MCP/hook
entries produce bounded issues while valid entries remain available; the bundle appears `partial`.

Plugin skills use `my-plugin:review` or `my-plugin@personal:review`, including activation, durable
context and transcript display. Skill instructions carry their package root and source file so
relative references can be resolved. MCP server ids are stable and isolated per plugin. Server
descriptions retain plugin provenance. MCP JSON supports `mcpServers`, root substitutions
`${CODEX_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}`, `env_vars`, `http_headers`, `bearer_token_env_var`,
`cwd`, and `tool_timeout_sec`, in addition to mycli's normal MCP fields. Missing environment values
produce configuration issues; values are not printed in management diagnostics.

Command hooks support the existing `PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`
and `Stop` groups. They receive `CODEX_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` in their environment;
quote these variables in shell commands. Enabling/installing a plugin authorizes its declared
hooks, which still run under the existing workspace sandbox. Prompt/agent hook types and other
Codex hook events are not implemented. OpenAI-hosted Apps cannot execute in mycli: an Apps
declaration produces `plugin_apps_unavailable` while other components remain usable.

## Marketplace Format

The default manifest is `.agents/plugins/marketplace.json`; `.agents/plugins/api_marketplace.json`
and `.claude-plugin/marketplace.json` are also recognized.

```json
{
  "name": "personal",
  "plugins": [{ "name": "my-plugin", "source": "./plugins/my-plugin" }]
}
```

Sources may also be objects: `{ "source": "local", "path": "./plugins/my-plugin" }`,
`{ "source": "url", "url": "https://example.com/repo.git", "ref": "stable" }`, or
`{ "source": "git-subdir", "url": "https://example.com/repo.git", "path": "plugins/my-plugin" }`.
Git entries optionally pin a 40-character commit `sha`. A marketplace entry with
`policy.installation = "NOT_AVAILABLE"` remains visible but cannot be installed.

## Storage And Activation

The private `~/.mycli/plugin-registry.json` tracks installations and marketplace sources; immutable
snapshots live under `~/.mycli/plugin-cache/`. Installation copies and validates files without
executing plugin code. Staging is bounded to 10,000 entries / 128 MiB, rejects escaping symlinks,
cycles and special files, and omits `.git`. Registry updates are locked and atomic; a failed or
cancelled update leaves the prior installation intact. Concurrent installs cannot overwrite each
other silently. The first successful install enables the package unless configuration disables it.

Enable/disable updates the user `[plugins] enabled/disabled` configuration atomically and preserves
other settings, including legacy user config on first write. Repository `disabled` still wins.
Unmanaged directory plugins stay opt-in, and untrusted repository configuration contributes no
plugins. Installed user packages are independent of repository trust.

Updates and removal retain previous snapshots because active sessions may still read package
files. Automatic snapshot garbage collection is not implemented, so repeated updates consume
additional disk space. The registry, not the presence of a cache directory, determines which
packages activate on the next session.

## Applied Behaviors

| Concern | Inspected Codex behavior | mycli behavior |
| --- | --- | --- |
| Capability discovery | Only enabled, error-free plugins contribute active capabilities; descriptions are normalized and bounded | Disabled/invalid plugins contribute no registrations; plugin descriptions are bounded in deferred tool discovery |
| Failure isolation | Plugin loading and plugin MCP configuration retain per-plugin/per-server errors | A failed plugin does not abort other plugin loading or corrupt their calls |
| Concurrent lifecycle | Plugin loading is serialized, rechecks cache, and publishes only for the current cache generation | New callers share one replacement process; retired/closed content cannot publish stale state |
| Diagnosis | Plugin load errors and MCP invocation errors retain their owning plugin/server context | Existing canonical integration errors retain plugin, operation, phase, timeout, exit/signal, and one prior failure |
| Status | Configured enablement is separate from successful activation | The plugin catalog tracks actual process state separately from configured enablement |

Codex loading/cache evidence is in `codex-rs/core-plugins/src/manager.rs` (`plugins_for_config` and
cache-generation checks). Per-server MCP configuration errors are in
`codex-rs/codex-mcp/src/plugin_config.rs`; calls use `codex-rs/codex-mcp/src/connection_manager.rs`.

## mycli Process Recovery

Process replacement is specific to mycli's ESM host. It is not presented as Codex's plugin protocol.
A crash, call timeout, or cancellation terminates the old host. A subsequent new invocation may
replace it once, sharing initialization with concurrent callers and validating the full original
registration set. Closing or cancelling the last waiter stops initialization and further dispatch.

An already-dispatched call is never automatically replayed. Its result remains unknown with
possible effects. Replacement startup failure means the new call did not start. Protocol corruption
and registration mismatch require correction and runtime reload. Normal handler errors leave a
healthy process usable. This differs from mycli's MCP session-expiry recovery, where a typed
session-bearing POST 404 confirms rejection before one bounded replay is allowed.

## Verification

Validated on macOS with Node 24 on 2026-09-11:

- Production workspace build, lint, typecheck, contract/config drift and error-emitter inventory
  checks pass.
- Unit/contract suites: 360 test files pass. The subsequent maximum-length qualified skill fix
  passes 50 focused core/storage tests covering persistence and provider request projection.
- Integration/platform/release suites: 51 files pass with the two previously recorded M7 cases
  excluded, as documented in `openspec/changes/formalize-error-system/verification.md`.
- Package tests exercise local marketplace lifecycle, rollback, concurrent installation,
  cancellation, path isolation, real MCP calls, command hooks, activation and CLI routing.
  Bash/zsh nested completion behavior is executed; all four shell scripts pass catalog coverage.
- The existing pi-ai module-loading assertion failed once and passed both its isolated rerun and
  the repeated integration suite. No provider code was changed for this task.
- Packed CLI smoke reaches M8 but fails its visible-command count assertion: expected 36, actual
  35. Running the M8 smoke directly confirms `session_ready=true` with 35 commands. This release
  gate remains unresolved; plugin verification is not a claim that the entire release gate passes.

Remote Git authentication and OpenAI-hosted Apps were not exercised against live services.
