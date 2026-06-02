# Hook Management CLI

## Goal

Implement the minimum productized hook management loop for configured local hooks:
users can list, inspect, approve, and revoke configured hook consent without
editing `<home>/.mycli/hook-allowlist.json` manually.

This is not a plugin marketplace and does not change the allowlist file format.

## Scope

- Add `mycli hooks list`, `mycli hooks inspect`, `mycli hooks approve`, and
  `mycli hooks revoke`.
- Support human-readable output and `--json` for every hooks subcommand.
- Reuse `HookConfigRegistry`, `HookAllowlist`, and `command_digest`.
- Manage only configured hooks. Built-in hooks are shown only through existing
  `/hooks` and doctor behavior, not through approve/revoke.
- Preserve existing doctor and `/hooks` behavior.

## Hook identity

The CLI target id is:

```text
<source>:<hook_id>:<hook_point>
```

Examples:

```text
repo:format-check:pre_tool_use
user:session-log:session_start
```

The identity is explicit enough to avoid ambiguity between repo/user hook config
and between hooks with the same id on different hook points.

## Output contract

`list` and `inspect` must expose these fields:

- `source`
- `hook_id`
- `hook_point`
- `identity`
- `enabled`
- `timeout_seconds`
- `working_directory`
- `env_policy`
- `command_digest`
- `allowlist_status`
- `allowlist_reason`
- `config_path`
- `config_issues`
- `allowlist_issues`

Human output must avoid printing full command strings. JSON output must be
machine-readable and deterministic.

## Command behavior

- `mycli hooks list [--json]`
  - exits `0` even when config issues exist; issues are visible in output.
- `mycli hooks inspect <identity> [--json]`
  - exits `0` when the configured hook exists.
  - exits `1` when not found or config cannot be parsed into that hook.
- `mycli hooks approve <identity> [--json]`
  - writes or updates the matching allowlist entry.
  - exits `0` when approved.
  - exits `1` when the target is not found or allowlist cannot be written.
- `mycli hooks revoke <identity> [--json]`
  - removes the matching allowlist entry if present.
  - exits `0` when revoked or already absent, but JSON should indicate whether
    an entry was removed.
  - exits `1` when the target is not found or allowlist cannot be written.

## Acceptance criteria

- Unit tests cover list, inspect, approve, revoke, JSON output, malformed hook
  config, and digest mismatch.
- Provider-free smoke covers approve -> configured hook executes, revoke -> the
  same configured hook no longer executes.
- `ruff`, `mypy`, focused tests, hook management smoke, and full Python tests
  pass.
- Trellis task is archived and the feature branch is committed.
