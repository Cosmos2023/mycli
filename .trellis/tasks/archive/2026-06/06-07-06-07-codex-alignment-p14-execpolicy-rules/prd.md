# Codex Alignment P14 Runtime ExecPolicy Rules

## Problem

P9-P13 established the runtime policy gate, lifecycle diagnostics, skill
context stabilization, resume/fork continuity, and runtime dry-run surfaces.
The remaining gap is that command-specific policy is still mostly embedded in
`SafetyPolicy` heuristics. Codex-style runtime enforcement needs a local,
typed execpolicy rules layer that can allow, deny, or ask before shell commands
execute.

## Goal

Implement a minimal Codex-style execpolicy rules layer for `Bash` / `run_shell`
calls. Rules must participate in `RuntimePolicyGate` decisions before tool
execution and must be observable through bounded trace, doctor, and dry-run
diagnostics.

## Scope

- Add typed execpolicy rule model supporting:
  - `prefix_rule(pattern=[...], decision="allow")`
  - `prefix_rule(pattern=[...], decision="deny")`
  - `prefix_rule(pattern=[...], decision="ask")`
- Add a local parser/loader for user and project rules.
- Support user and project rule sources, with project rules overriding user
  rules when multiple rules match.
- Preserve a session/CLI override extension point without requiring a CLI
  product surface in P14.
- Apply execpolicy only to `Bash` / `run_shell` for this phase.
- Integrate with `RuntimePolicyGate` so rules can produce `allowed`, `denied`,
  or `needs_approval`.
- Keep existing `SafetyPolicy` behavior for commands that do not match a rule.
- Add bounded diagnostics:
  - rule source
  - decision
  - pattern hash
  - pattern length / argument count
  - no raw command, no raw arguments, no secrets
- Update doctor, dry-run, and specs to document the redaction boundary.
- Do not touch compact or rehydration implementation.

## Non-goals

- No OS-level sandbox backend.
- No environment isolation policy.
- No complete Codex rules language.
- No rule UI/TUI management surface.
- No rules for non-shell tools in this phase.
- No real provider API calls.
- No compact/rehydration changes.

## Acceptance

- Execpolicy parser/loader unit tests pass.
- Bash prefix `allow`, `deny`, and `ask` tests pass.
- `RuntimePolicyGate` uses execpolicy decisions before execution.
- Unmatched commands keep existing P9-P13 safety behavior.
- Trace, doctor, and dry-run expose only bounded rule summaries.
- Raw command text, raw arguments, secrets, and full provider payloads are not
  emitted in P14 diagnostics.
- Context, subagent, MCP, plugin, hook, and provider cache policy smokes do not
  regress.
- `uv run ruff check src tests evaluation` passes.
- `uv run mypy src/mycli` passes.
- `uv run pytest -q` passes.
- Trellis task is archived and journaled.
