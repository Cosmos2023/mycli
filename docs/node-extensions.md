# Node Extensions

The M8 Node-only runtime discovers skills, MCP servers, Plugin API v2 workers, and configured hooks
before a turn. Management and doctor commands use the same discovery services,
but do not construct a provider or start the interactive runtime.

## Discovery And Precedence

| Capability | User path | Repository path | Precedence |
| --- | --- | --- | --- |
| Hooks | `~/.mycli/hooks.json` | `<workspace>/.mycli/hooks.json` | Both sources load; hook ids must be unique within each file |
| MCP | `~/.mycli/mcp_servers.toml` | `<workspace>/.mycli/mcp_servers.toml` | Repository server ids replace user ids |
| Plugins | `~/.mycli/plugins/<id>/` | `<workspace>/.mycli/plugins/<id>/` | User plugin ids replace repository ids; disabled wins |
| Skills | `~/.mycli/skills/` | `<workspace>/.agents/skills/`, then `<workspace>/.mycli/skills/` | Later sources replace earlier skill names |

Repository paths are excluded from discovery while workspace trust is `unknown` or `untrusted`.
This includes repository hooks, MCP servers, plugins, skills, plugin enablement in project
`config.toml`, and project execution rules. User-scoped integrations remain available. After
granting trust in an already-running session, restart mycli once so startup discovery can include
the newly trusted repository sources.

Every parser bounds file size, item count, names, and diagnostic output. A malformed entry remains
visible as a diagnostic and does not prevent unrelated entries from loading.

## Deferred Tool Discovery

MCP and plugin adapters start with the runtime and remain routable, but their provider schemas are
not included in the initial request. The stable `tool_search` built-in searches their bounded name,
description, source, and origin metadata. A successful result activates at most 16 matching routes
for later provider steps in the same turn.

Activation metadata is appended atomically with the `tool_search` result before any selected schema
enters a provider request. Approval or process restart reconstructs the current turn's exposure from
SQLite and the current allowed catalog; missing or stale routes are ignored. Activations do not
carry into the next user turn, and actual MCP/plugin execution still follows its normal approval,
hook, timeout, sandbox, and cancellation policy.

## Management Commands

These commands work without a TTY and before backend/provider/TUI startup:

```bash
mycli doctor
mycli doctor --json
mycli hooks list --json
mycli hooks inspect <identity> --json
mycli hooks approve <identity>
mycli hooks revoke <identity>
mycli plugins list --json
mycli plugins inspect <plugin-id> --json
mycli plugins run <plugin-id> <command> --json-args '{"enabled":true}' --json
mycli mcp list --json
mycli mcp inspect <server-id> --json
```

Human and JSON output are rendered from the same typed response. Management output omits hook
commands, environment values, plugin output, credentials, headers, and provider
payloads.

## Configured Hooks

Hooks use a JSON file with a bounded argv array or a shell command string. The argv form is easier
to audit and is preferred:

```json
{
  "hooks": [
    {
      "id": "check-write",
      "hook_point": "pre_tool_use",
      "command": ["node", "scripts/check-write.mjs"],
      "matcher": {"tool_name": "Write"},
      "timeout_seconds": 3,
      "working_directory": "workspace",
      "env_policy": "minimal",
      "enabled": true
    }
  ]
}
```

Supported points are `pre_tool_use`, `post_tool_use`, `user_prompt_submit`, `stop`,
`pre_compact`, `session_start`, and `session_end`. A configured hook does not run until its current
command digest is approved. Changing the command invalidates approval. `inherit_safe`, disabled
hooks, missing approval, and digest mismatch appear as doctor warnings; malformed configuration is
a failed check.

Hooks run through the normal sandbox/process-tree controller with a timeout of at most 30 seconds,
bounded stdin/stdout/stderr, and a selected safe environment. Diagnostics never contain command
arguments, hook payloads, output bodies, or environment values.

## MCP

MCP configuration supports `stdio`, `http`, and `streamable_http`. New remote integrations should
use Streamable HTTP.

```toml
[servers.files]
transport = "stdio"
command = "node"
args = ["dist/server.js"]
timeout_seconds = 10
enabled = true

[servers.catalog]
transport = "streamable_http"
url = "https://mcp.example.invalid/api"
headers = { Authorization = "${MCP_AUTHORIZATION}" }
timeout_seconds = 20
```

Environment placeholders resolve by name. Values are passed only to the MCP client and are never
returned by list, inspect, doctor, or runtime diagnostics. MCP tool ids use
`mcp:<server>:<tool>`. Use `tool_search` to activate a matching MCP schema for the current turn; an
MCP tool still requires one-time approval before execution.

`mcp list`, `mcp inspect`, and doctor may connect to enabled servers to verify discovery. They use
the same timeout, sandbox, cancellation, and cleanup path as runtime startup and close every client
before returning.

## Skills

A skill is either `<root>/<name>.md` or `<root>/<name>/SKILL.md` with TOML or YAML frontmatter:

```markdown
---
name: repository-review
description: Review repository changes for correctness and risk.
trigger_hints: [review, regression]
workspace_dependencies: [.git]
guardrails: [Do not modify files.]
---

Inspect the requested change and report findings before summaries.
```

The default provider schema contains one stable `Skill` tool. Individual skill files do not add
provider tools. A successful invocation appends bounded, fenced instructions to the durable
transcript. Management/doctor output exposes counts and issue categories, never the skill body.

## Subagents

Subagents are prompt-driven. The parent supplies `task_name`, `message`, and optional `fork_turns`;
there are no profile files or profile-specific prompts, models, tools, or budgets. The child inherits
the parent's resolved provider/model, execution policy, and exposed tools. Runtime budgets remain
optional, and omitting them does not introduce a hidden turn or tool-call ceiling.

Every child is an independent durable Node thread with immutable identity, canonical path, frozen
least-authority execution policy, provider state, queue, cancellation boundary, and session
artifacts. Parent ownership gates routing, interruption, recovery, and shutdown cleanup.

The provider-visible coordination tools are `spawn_agent`, `send_message`, `followup_task`,
`wait_agent`, `interrupt_agent`, and `list_agents`. `spawn_agent` is the only child-spawn entry
point. `Task`, legacy `SendMessage`, and `SubagentOutput` routes are not registered or exported.

Terminal reports enter the durable parent mailbox automatically and idempotently. Each child also
owns `session.json`, `events.jsonl`, task output, subagent projections, transcript state, and usage
projection beneath its own session identity. Parent task/subagent files remain readable indexes;
SQLite is authoritative and repairs derivable files. Provider-only mailbox payloads are never
rendered as user-authored transcript rows.

Use `wait_agent` only when the caller has no independent work left. It subscribes to mailbox,
lifecycle, user-steering, cancellation, and timeout activity without polling or creating a process.
`WriteStdin` remains solely the transport for an existing persistent Shell session. The complete
agent configuration, permission, artifact, recovery, and TUI contract is documented in
[node-agent-runtime.md](node-agent-runtime.md).

## Plugins

Node plugins use the process-isolated Plugin API v2. Production entries must be compiled `.js` or
`.mjs`; raw TypeScript and Python source are not executed. See [plugin-api-v2.md](plugin-api-v2.md)
for the author contract and [migration/python-plugins-to-v2.md](migration/python-plugins-to-v2.md)
for Python migration.

Plugin tools use stable ids `plugin:<plugin-id>:<tool-name>`, are activated for a turn through
`tool_search`, and require one-time approval. Plugin commands are provider-free. Plugin hooks join
the normal ordered hook pipeline. The worker receives only a minimal environment plus explicitly
declared names, and every invocation is bounded by protocol size, timeout, outstanding-request, and
output limits.

## Doctor And Troubleshooting

`mycli doctor` runs collectors independently and sequentially. One exception becomes one failed
check and later collectors still run. Warnings exit `0`; any failed check exits `1`.

The report covers config/auth presence, read-only SQLite/storage, logs/traces/redaction, package and
gateway contracts, the built-in tool manifest, sandbox/process support, every extension source, and
Python-plugin migration state. It never calls a model provider. SQLite opens read-only and doctor
does not create, migrate, repair, delete, or vacuum local state.

Common remediation:

- `config=failed`: fix TOML syntax or provider/protocol compatibility, then rerun doctor.
- `sessions_db=failed`: preserve the file and inspect schema/recovery diagnostics; doctor will not
  repair it.
- `process_sandbox=failed`: install the platform sandbox prerequisite documented in
  [node-runtime-rollout.md](node-runtime-rollout.md).
- `hooks=warning`: inspect and approve the current hook identity/digest.
- `plugins=failed`: build the declared ESM entry and verify manifest declarations match runtime
  registrations.
- `plugin_migration=warning`: migrate Python plugins; Node never imports them.
- `mcp=failed`: verify transport availability and referenced environment names, without putting
  credential values in configuration or command output.
