# Codex Alignment P15c Sandbox Policy Enforcement

## Goal

Extend the P15b shell enforcement kernel into a minimal effect-profile-driven
sandbox policy gate. Runtime policy should deny tool calls whose declared
filesystem, shell/process, or network effects violate the active
`SandboxProfile`, before execpolicy or approval logic can allow them.

## What I Already Know

- P15a exposes a bounded runtime environment contract to the model as dynamic
  context.
- P15b enforces shell execution options for `Bash` / `run_shell`: workspace cwd,
  sanitized env, timeout caps, output metadata, and redacted shell trace fields.
- `ToolExecutionService` already resolves a `ToolEffectProfile` before policy
  checks.
- `RuntimePolicyGate.decide()` currently receives the tool call and exposure,
  but not the effect profile.
- Tool effect profiles already classify filesystem, network, and process lanes.

## Requirements

- Add a minimal sandbox denial layer to `RuntimePolicyGate`.
- Deny filesystem write/unknown effects when `SandboxProfile.filesystem` is
  `read_only`.
- Deny shell/process effects for `Bash` / `run_shell` when
  `SandboxProfile.shell` is `disabled`.
- Deny network effects when `SandboxProfile.network` is `disabled`.
- Evaluate sandbox denial before execpolicy, contributed-tool allow, or
  approval service evaluation.
- Keep P14 execpolicy allow/deny/ask behavior intact when sandbox permits the
  call.
- Keep P15b shell execution options and redaction behavior intact.
- Emit bounded `runtime_policy_decision` trace rows with sandbox policy,
  reason code, effect summary, argument keys/count, and no raw argument values.
- Ensure denied-by-sandbox does not execute the tool.
- Ensure doctor can summarize sandbox-denied runtime policy rows through
  existing bounded runtime policy diagnostics.

## Non-goals

- No OS-level sandbox backend such as chroot, container, seccomp, or seatbelt.
- No network firewall implementation.
- No provider API calls.
- No provider request-shape changes.
- No compact/rehydration implementation changes.
- No new third-party dependencies.
- No broad productization of sandbox configuration UI.

## Acceptance Criteria

- Unit tests prove `filesystem=read_only` blocks write/unknown filesystem effect
  tools before execution.
- Unit tests prove `shell=disabled` blocks `Bash` even if execpolicy would allow
  it.
- Unit tests prove `network=disabled` blocks network effect tools before
  execution.
- Unit tests prove sandbox-denied trace payloads expose bounded effect metadata
  and do not expose raw command, raw args, stdout/stderr, or secrets.
- Existing P14 execpolicy allow/deny/ask tests keep passing.
- Existing P15b shell runtime enforcement tests keep passing.
- Doctor/runtime policy diagnostics summarize sandbox denials without raw
  payloads.
- `uv run ruff check src tests evaluation` passes.
- `uv run mypy src/mycli` passes.
- `uv run pytest -q` passes.
- Context/provider-cache smoke does not regress.
- Compact/rehydration implementation files remain untouched.

## Technical Notes

- Primary implementation files:
  - `src/mycli/application/runtime/tools/runtime_policy.py`
  - `src/mycli/application/runtime/tools/tool_execution_service.py`
  - `src/mycli/domain/runtime/execution_policy.py`
- Existing effect model:
  - `src/mycli/tools/base.py` defines `ToolEffectProfile`.
  - `ToolRouter.effect_profile(...)` resolves registry/contributed tool effects.
- See `research/current-sandbox-policy-shape.md`.
