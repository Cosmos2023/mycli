# Hook Config Execution Foundation

## Research

Hermes-agent supports shell hooks from config with list/test/revoke/doctor
surfaces, plus plugin lifecycle hooks. mycli now has an internal `HookManager`,
safe execution summaries, `/hooks`, doctor visibility, and provider-free smoke.
The remaining foundation gap is configured local hook execution: repo/user
definitions must be discoverable, validated, executed safely, and diagnosed
without becoming a full plugin system.

This slice uses Hermes only as a semantic reference. It does not copy Hermes
code and does not implement plugin marketplace, MCP/ACP integration, or
subagent hook orchestration.

## Requirements

- Discover hook definitions from repo and user config files.
- Each configured hook declares hook point, command/script, enabled flag,
  timeout, working directory policy, environment policy, and optional matcher.
- Config parse failures are diagnosable and never silent.
- External hook execution maps to `allow`, `deny`, `modify`, or `error`.
- Hook execution defaults to a minimal, redacted environment and bounded
  stdout/stderr/error summaries.
- Hook failures do not break session, turn, or tool state unless a hook returns
  `deny`.
- Tool pre/post hook execution can be affected by configured hooks.
- `/hooks` shows built-in and configured hook registrations with safe state.
- Doctor checks hook config, executable/script availability, timeout bounds,
  and unsafe environment policy.
- Runtime trace records safe configured hook execution diagnostics without raw
  tool args, file contents, headers, secrets, or full command output.
- Provider-free smoke covers configured hook execution, `/hooks`, doctor, and
  trace.

## Config MVP

- Repo config path: `<workspace>/.mycli/hooks.json`
- User config path: `<home>/.mycli/hooks.json`
- JSON shape:

```json
{
  "hooks": [
    {
      "id": "deny-write",
      "hook_point": "pre_tool_use",
      "command": ["python3", "/path/to/hook.py"],
      "enabled": true,
      "timeout_seconds": 2.0,
      "working_directory": "workspace",
      "env_policy": "minimal",
      "matcher": {"tool_name": "Write"}
    }
  ]
}
```

- Hook stdin is a bounded JSON payload with hook point, tool name, session id,
  and metadata keys. It must not include raw tool arguments or file contents in
  this slice.
- Hook stdout may contain a JSON object:
  - `{"action":"allow","message":"..."}`
  - `{"action":"deny","message":"..."}`
  - `{"action":"modify","message":"...","modified_args":{...}}`
- Non-JSON stdout or non-zero exit maps to `error`, not provider-visible text.

## Acceptance

- Unit tests cover config discovery, invalid config diagnostics, matcher,
  allow/deny/modify/error/timeout/redaction.
- Tool execution tests prove configured pre/post hooks affect local tools and
  appear in safe trace diagnostics.
- Doctor tests prove hook config and unsafe policy diagnostics are surfaced.
- `/hooks` tests prove configured hooks are visible.
- Provider-free smoke creates a temporary configured hook and verifies
  execution, slash output, doctor, and trace.
- `ruff`, `mypy`, focused tests, hook smoke, and full Python tests pass.
