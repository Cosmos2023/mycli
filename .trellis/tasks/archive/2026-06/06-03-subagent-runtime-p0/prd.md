# Subagent Runtime P0

## Problem

`mycli` has a subagent runtime foundation, but profiles are hard-coded and there is no provider-free management surface or local profile config. The P0 goal is to allow one bounded, local subagent profile to be discovered, diagnosed, exposed through the unified tool path, invoked once, and returned as a normal `ToolResult`.

## Scope

In scope:

- User and repo subagent profile discovery from TOML files.
- Provider-free `mycli subagents list|inspect`.
- Doctor diagnostics for counts, parse issues, unknown tool references, and high-risk tool exposure.
- Runtime invocation of configured profiles through existing Task/subagent tool paths.
- Manifest metadata for subagent contributed tools.
- Provider-free smoke for profile discovery and single sync invocation.

Out of scope:

- Multi-agent/swarm orchestration.
- Remote agents.
- ACP productization.
- Hosted agent registry or marketplace.
- Copying Hermes-agent code.

## Requirements

### Profile Discovery

- Discover built-in profiles plus TOML profiles from:
  - `~/.mycli/subagents/*.toml`
  - `.mycli/subagents/*.toml`
- Repo profiles override user and built-in profiles with the same id.
- Disabled profiles are discoverable in diagnostics/CLI but not executable/exposed.
- Malformed profiles produce bounded diagnostics and do not crash CLI/doctor/runtime.
- Profile fields:
  - `id` or filename stem
  - `name` optional display name
  - `description`
  - `instruction` or `system_prompt`
  - `allowed_tools`
  - `denied_tools`
  - `model` optional
  - `enabled`
  - optional `[budget]` fields matching `SubAgentBudget`

### Invocation

- Existing `Task` tool and `subagent.<profile>` contributed tools can invoke enabled configured profiles.
- Unknown, disabled, or malformed profiles return failed `ToolResult` or failed `SubAgentResult`.
- Result includes status, summary/report, child session id, tool call count, and error when present.
- Long reports remain truncated by existing report limit behavior.

### Safety

- Default/high-risk tools (`Bash`, `Write`, `Edit`, `Patch`) are not exposed unless explicitly allowed by profile.
- Denied tools always win.
- Diagnostics warn on unknown tools and high-risk allowed tools.
- Manifest exposes subagent `source`, `risk_level`, and `approval_policy`.

### CLI / Doctor

- Add provider-free:
  - `mycli subagents list [--json]`
  - `mycli subagents inspect <id> [--json]`
- CLI must not require API key or model provider startup.
- Doctor reports configured/built-in profile count, enabled/disabled count, issues, and safe detail.
- Output must not print raw long prompts or secrets.

### Tests / Smoke

- Unit tests cover discovery, disabled/malformed profiles, allowed/denied tool scope, unknown tool diagnostics, CLI human/JSON, doctor diagnostics, configured profile invocation, and manifest metadata.
- Provider-free smoke creates a temp profile, verifies list/inspect, invokes via service/tool with fake child loop, and verifies disabled/failure diagnostics.
- Compatibility smoke for MCP/plugin/hook must still pass.

## Acceptance

- Focused subagent tests pass.
- `uv run python evaluation/subagent_smoke.py` passes.
- `uv run python evaluation/mcp_smoke.py` passes.
- `uv run python evaluation/plugin_runtime_smoke.py` passes.
- `uv run python evaluation/hook_management_smoke.py` passes.
- `uv run ruff check src tests evaluation/subagent_smoke.py evaluation/mcp_smoke.py` passes.
- `uv run mypy src/mycli` passes.
- `uv run pytest tests/unit tests/integration -q` passes.
