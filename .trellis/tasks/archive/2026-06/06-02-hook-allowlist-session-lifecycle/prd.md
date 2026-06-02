# Hook Allowlist And Session Lifecycle

## Research

The configured hook foundation can discover and execute repo/user hooks, but
it still lacks the safety gate required by the goal: high-risk configured hooks
must be explicitly allowed before execution. It also accepts `session_start`
and `session_end` hook points in config but runtime does not fire those points.

Hermes-agent uses consent records for shell hooks and has session lifecycle
hook points. This slice implements the mycli foundation equivalent without
copying Hermes code or building a full plugin system.

## Requirements

- Add an explicit allowlist file under the user mycli home.
- Configured hooks are high-risk by default and must be allowlisted before
  running.
- A hook allowlist entry must be stable and diagnostic-friendly:
  source, hook id, hook point, command digest, and optional approved timestamp.
- Non-allowlisted configured hooks must not execute; they map to an `error`
  summary and allow the parent operation to continue.
- `/hooks` and doctor must surface allowlist status for configured hooks.
- Runtime must fire `session_start` after configured hooks are registered and
  `session_end` through an explicit runtime/service close path.
- Session lifecycle hook execution must emit safe `hook_execution` trace rows.
- Tests and smoke must cover allowlisted and non-allowlisted hook behavior,
  plus `session_start` / `session_end` execution.

## Config / Allowlist MVP

- User allowlist path: `<home>/.mycli/hook-allowlist.json`
- JSON shape:

```json
{
  "allowed": [
    {
      "source": "repo",
      "hook_id": "configured-deny-write",
      "hook_point": "pre_tool_use",
      "command_digest": "sha256:..."
    }
  ]
}
```

- No interactive approval UI in this slice.
- Users/tests can add entries directly; a future `mycli hooks approve/revoke`
  command can manage the same file.

## Acceptance

- Unit tests cover digest generation, allowlist parse, allow/missing/mismatch,
  and malformed allowlist diagnostics.
- Configured hook tests prove non-allowlisted hooks do not execute.
- Tool execution tests prove allowlisted configured hooks still affect tools.
- Runtime/service tests prove `session_start` and `session_end` hooks execute.
- Doctor tests prove allowlist status and malformed allowlist are surfaced.
- Provider-free smoke covers allowlist, `/hooks`, doctor, trace,
  `session_start`, and `session_end`.
- `ruff`, `mypy`, focused tests, hook smoke, and full Python tests pass.
