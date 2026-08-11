# Codex-style shell safety and sandbox escalation

## Goal

Align Node mycli's Shell safety classification and approval experience with
Codex: routine unknown commands should run inside the active restricted sandbox
without a pre-approval prompt, while dangerous commands and explicit requests
to leave the sandbox remain durably approval-gated.

## Requirements

- Keep the existing POSIX safe-command baseline and synchronize Codex's unsafe
  Git global/subcommand options.
- Preserve intentional precision for read-only `git branch --list <pattern>`
  and workspace-confined `git -C`; outside-workspace escalation remains gated.
- Expand Windows PowerShell/CMD safe aliases and dangerous-operation detection
  from the current Codex source without trusting nested side-effecting syntax.
- Classify plain Shell segments as safe, dangerous, or unknown after explicit
  exec-policy rules. Unknown non-dangerous commands run in the active sandbox.
- Dangerous or unparseable/complex commands retain one-time approval in
  restricted profiles. Explicit `ask` and `deny` rules remain authoritative.
- Add optional provider-visible
  `sandbox_permissions="use_default"|"require_escalated"` to `Shell` only.
  Legacy `Bash` remains unchanged.
- A restricted call requesting `require_escalated` must suspend for approval
  unless an exact session/persistent allow rule already authorizes it.
- The Shell adapter must never trust the model field alone. Runtime passes an
  internal authorization bit after policy auto-allow or durable user approval;
  without it, the adapter rejects escalation.
- Approved escalation runs the exact persisted call with a full-access process
  profile. Approval recovery derives authorization from the fingerprinted,
  persisted call and must not require new mutable state.
- Full Access keeps routine calls prompt-free while malformed calls and
  explicit `ask`/`deny` rules remain fail-closed.

## Acceptance Criteria

- [ ] `ls`, `wc -l`, `git status`, and the shared POSIX safelist remain direct.
- [ ] Codex Git unsafe options are not classified safe; intentional mycli
      read-only exceptions are covered explicitly.
- [ ] PowerShell/CMD parity fixtures cover safe aliases, nested mutation, force
      deletion, and URL/GUI launch cases.
- [ ] Workspace mode auto-allows an unknown non-dangerous command and executes
      it with the existing restricted profile.
- [ ] Dangerous and complex commands still request approval in workspace mode.
- [ ] `require_escalated` requests approval, survives restart/recovery, and
      executes once with host/full-access isolation only after approval.
- [ ] Direct router/adapter execution cannot forge escalation without the
      runtime authorization bit.
- [ ] Matching allow/session rules can authorize future exact-prefix
      escalations; `ask` and `deny` rules cannot be bypassed.
- [ ] Full Access remains prompt-free for valid calls and never weakens
      explicit restrictive rules.
- [ ] Lint, all-workspace typecheck, tools, runtime, app, provider, and TUI
      regression tests pass.

## Definition of Done

- Unit tests cover classifiers, approval decisions, schema validation, and
  adapter defense in depth.
- Runtime tests cover normal execution, durable approval continuation, and
  escalation authorization forwarding.
- A backend code-spec records the three-way safety model and escalation
  contract.
- Existing concurrency, TUI, Worker Pool, and Python changes remain untouched.

## Technical Approach

1. Extend `shell-command-policy.ts` with shared dangerous classification and
   Codex-aligned option/Windows cases.
2. Extend `SHELL_TOOL_DEFINITION` and manifest metadata with the optional
   sandbox-permission enum.
3. Make `ApprovalPolicy` distinguish ordinary sandbox execution from an
   approved override, returning an internal authorization marker.
4. Thread the marker through normal runtime execution and approval continuation
   into `ToolExecutionOptions`.
5. Require both the provider request and runtime authorization in `ShellTool`
   before selecting a full-access process profile.
6. Add regression tests and a dedicated backend shell-execution policy spec.

## Decision (ADR-lite)

**Context**: The current safelist is close to Codex, but mycli prompts before
running every unmatched Shell command. It also lacks a distinct request to
leave the sandbox, so approval and sandbox escalation are conflated.

**Decision**: Adopt a sandbox-first three-way classifier and an explicit
provider request plus host-owned authorization bit. Preserve mycli's ordered,
durable approval continuation rather than copying Codex's Rust internals.

**Consequences**: Routine commands such as tests and scripts stop generating
approval noise, while host execution becomes an explicit, replay-safe security
boundary. The Shell provider schema changes, so provider/cache and replay tests
must cover the new optional field.

## Out of Scope

- Changing Python mycli.
- Automatically retrying a failed sandbox command with escalation.
- Network-only escalation independent of process/filesystem escalation.
- Parallel Shell execution.
- Copying Codex's Tokio task, exec-policy storage format, or complete policy
  mode enum.
- Displaying raw commands or model-provided free-form justification in approval
  persistence or TUI payloads.

## Technical Notes

- Safety classifier: `backend/packages/tools/src/shell-command-policy.ts`.
- Approval policy: `backend/packages/tools/src/approval-policy.ts`.
- Shell schema/adapter: `backend/packages/tools/src/shell-manifest.ts` and
  `shell-tool.ts`.
- Runtime authorization boundaries:
  `backend/packages/runtime/src/node-turn-runtime.ts` and
  `approval-continuation-coordinator.ts`.
- Research: `research/codex-shell-safety.md`.
