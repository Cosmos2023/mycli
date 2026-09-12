# Plugin Behavior Compared With Codex

Comparison source: the local `codex-main` source snapshot inspected on 2026-09-12. The downloaded
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

Package changes apply before the next turn or an idle `/plugins`, `/mcp`, `/skills`, `/hooks`,
or `/tools` inspection. Existing active or suspended turns keep their original integration content;
each session refreshes independently, so a waiting child does not block its parent. A changed
configuration completes MCP discovery before a new run captures its tools. Unchanged turns reuse the existing clients.
In-session `/plugins` shows package state, `/skills` lists namespaced skills, and MCP tools enter
the session integration catalog with direct/deferred exposure and session discovery reuse.

Plugin MCP servers use the common management and OAuth flow:

```sh
mycli mcp list
mycli mcp inspect my-plugin/docs
mycli mcp login my-plugin/docs
mycli mcp logout my-plugin/docs
mycli mcp revoke my-plugin/docs
```

Use `my-plugin@personal/docs` for a marketplace-qualified plugin. The readable selector and
opaque internal server ID refer to the same effective configuration. `/mcp` identifies the owning
plugin; `/plugins` shows its MCP selectors. Exact standalone server-ID overrides take precedence.
Login/logout do not start plugin workers, hooks or unrelated MCP connections. Open an idle `/mcp`
or start the next turn after login to rerun discovery. Logout removes saved credentials, without
revoking remote tokens or reversing in-flight requests.

Credentials remain usable across package-cache updates when plugin identity/source, declared
server name, endpoint, headers and OAuth settings are unchanged. Tool approvals include the package
snapshot and schema, so an update cannot reuse an old approval for changed content. Auth status
`not_logged_in` reports the absence of saved credentials; anonymous servers can still be usable.

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
`cwd`, and `tool_timeout_sec`, in addition to mycli's normal MCP fields. OAuth `clientId` is normalized
to `client_id`. Mycli also accepts `callbackPort` as `callback_port`, retaining per-server callback
configuration; the inspected Codex implementation uses its global callback setting instead.
Canonical keys take precedence when both spellings are present. Missing environment values
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
packages activate on the next safe refresh. Replacements publish tools, skills, hooks, commands and
resources together, then retire and close the previous clients/hosts. A required-MCP or composition
failure preserves the previous content and blocks that refresh until configuration is corrected.
Concurrent preparation/inspection requests share the serialized replacement; shutdown cancels
pending discovery and prevents late publication. Explicit workspace trust changes retain their
existing immediate trust-gating behavior.

## Applied Behaviors

| Concern | Inspected Codex behavior | mycli behavior |
| --- | --- | --- |
| Capability discovery | Only enabled, error-free plugins contribute active capabilities; descriptions are normalized and bounded | Disabled/invalid plugins contribute no registrations; plugin descriptions are bounded in deferred tool discovery |
| Failure isolation | Plugin loading and plugin MCP configuration retain per-plugin/per-server errors | A failed plugin does not abort other plugin loading or corrupt their calls |
| Concurrent lifecycle | Plugin loading is serialized, rechecks cache, and publishes only for the current cache generation | New callers share one replacement process; retired/closed content cannot publish stale state |
| Diagnosis | Plugin load errors and MCP invocation errors retain their owning plugin/server context | Existing canonical integration errors retain plugin, operation, phase, timeout, exit/signal, and one prior failure |
| Status | Configured enablement is separate from successful activation | The plugin catalog tracks actual process state separately from configured enablement |
| MCP authentication | Login/logout resolve the combined standalone and plugin MCP configuration | Common configured-server discovery serves runtime, list/inspect, login/logout and approval revocation |
| Package activation | Effective plugin changes clear caches and queue MCP refresh before subsequent turns | Package/config/auth changes refresh each session independently before catalog capture or idle inspection |

Codex loading/cache evidence is in `codex-rs/core-plugins/src/manager.rs` (`plugins_for_config` and
cache-generation checks). Per-server MCP configuration errors are in
`codex-rs/codex-mcp/src/plugin_config.rs`; calls use `codex-rs/codex-mcp/src/connection_manager.rs`.
OAuth management uses `core/src/mcp.rs::McpManager::configured_servers` and `cli/src/mcp_cmd.rs`.
Activation evidence is in `app-server/src/request_processors/plugins.rs::on_effective_plugins_changed`,
`app-server/src/mcp_refresh.rs`, `core/src/session/handlers.rs`, and `core/src/session/mcp.rs`.
Both inspected implementations own MCP connections per session and apply refresh at a safe boundary.
The local Codex source snapshot has no verified release revision; this is source-level comparison.

Mycli reuses a session's live runtime when switching away and back. Merely inspecting history starts
no plugin process or MCP connection. A session's pending turn retains its original tools, Skill,
hooks and resource service; other sessions may adopt a package update immediately. Agent scheduling
remains backend-owned, and closing one child does not close sibling or parent integration clients.

Children inherit captured configuration with separate clients. Their durable authority contains only
configuration/tool fingerprints, never MCP credentials. If an unloaded child is reloaded after its
configuration changed, integrations remain unavailable under the old authority; spawn a fresh child
from the updated parent to use them. Legacy children without fingerprints keep their built-in tools.
Hosted Apps, marketplace TUI, OS keychain storage and package cache GC remain separate work.

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

Validated on macOS with Node 24 on 2026-09-12: the production build, lint, typecheck,
contract/config drift and error-emitter inventory checks pass. The complete CI suite passes
all 431 files in 222.6 seconds: 343 unit, 29 contract, 50 integration, 8 platform and 1 release.

Regression coverage uses temporary homes, loopback OAuth/MCP servers, deterministic providers and
local plugin processes. It covers qualified login/logout, configuration precedence and redaction,
credential reuse across immutable updates, approval invalidation, catalog refresh, active/suspended
run retention, concurrent refresh, failed/cancelled preparation and shutdown. A real SDK/gateway
journey updates a plugin during approval and executes both old and new versions in the same backend.

Remote Git authentication, OpenAI-hosted Apps and real provider cache hits are outside this
verification. Remote marketplace/account synchronization, full marketplace TUI, OS keychain
storage and automatic package snapshot GC remain unsupported.
