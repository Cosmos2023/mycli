# Phase 4 Permission And Sandbox Status

## Goal

Make mycli's effective safety boundary understandable before execution by unifying permission
preset, sandbox readiness, policy source, and managed restrictions across the TUI and management
surfaces. Preserve fail-closed behavior and turn unavailable isolation into an actionable readiness
state rather than a raw helper failure.

## What I Already Know

- The approved configuration and UX roadmap identifies permission and sandbox productization as
  Phase 4, immediately after startup credential readiness.
- mycli already has permission presets, workspace trust, execution policy persistence, approval
  flows, platform sandbox adapters, `/permissions`, `/status`, and doctor collectors.
- The workspace contains unrelated Windows helper, documentation, shell-policy spec, and CI edits
  from another workstream; this task must not modify, stage, commit, or revert them.
- The user requested inline implementation without subagents.

## Requirements

- Explain workspace trust, permission profile, sandbox availability, approval behavior, and managed
  restrictions as distinct concepts.
- Derive all displayed state from one canonical backend projection with stable, bounded values.
- Keep `/permissions`, `/status`, and relevant bootstrap/gateway state consistent.
- Report unavailable or incomplete sandbox setup before restricted execution when the platform can
  determine readiness without side effects.
- Add provider-free `mycli sandbox status [--json]` backed by the same readiness classifier used by
  doctor; it must not start the interactive backend, TUI, provider, or elevated setup.
- Use the runtime `ExecutionPolicySnapshot` as the authoritative effective-policy source; do not
  introduce a second merge or policy engine.
- Preserve existing permission selection, approval, full-access, session resume, and managed-policy
  behavior.
- Never expose raw helper output, local secrets, prompts, tool arguments, or unbounded paths.

## Acceptance Criteria

- [x] The three permission presets have stable labels and plain-language filesystem, network, and
  approval effects derived from canonical policy data.
- [x] `/permissions` and `/status` agree on the effective profile, sandbox mode, network policy,
  approval behavior, source/scope, and managed restriction state.
- [x] Sandbox readiness distinguishes supported/ready, supported/incomplete, unavailable, and
  not-required states without performing setup.
- [x] `mycli sandbox status`, doctor, bootstrap, permission updates, and `/status` use the same
  bounded readiness vocabulary and never start setup.
- [x] Managed restrictions cannot be bypassed by a TUI selection or a persisted session profile.
- [x] Readiness and policy failures are actionable, deduplicated, redacted, and free of raw native
  helper errors.
- [x] Focused unit, integration, and TUI tests plus lint, typecheck, contracts, and relevant package
  checks pass.

## Implementation Summary

- Added a shared, bounded sandbox-readiness classifier and reused it from sandbox execution,
  doctor, gateway bootstrap/status, and the provider-free `mycli sandbox status [--json]` command.
- Projected selected permission preset and effective runtime policy separately from the canonical
  `ExecutionPolicySnapshot`, including policy source, managed constraints, grants, and readiness.
- Updated the TUI reducer and permission selector to render the canonical effects without local
  fallback policy semantics, and documented the resulting gateway contract and user workflow.
- Verified the implementation with lint, strict type-checking, contract drift checks, the full npm
  workspace test suite, the compiled sandbox-status command, and `git diff --check`.

## Definition Of Done

- The canonical projection and consuming surfaces are covered by provider-free tests.
- User-facing behavior and executable Trellis contracts are documented.
- The implementation is committed, archived, and journaled without unrelated worktree changes.

## Out Of Scope

- Rewriting native Windows sandbox helper code or the cross-platform CI workflow in this slice.
- Automatically running elevated setup, reset, or repair actions.
- Redesigning workspace trust, the approval protocol, or shell execution semantics.
- Phase 5 unified settings center, Phase 6 session recovery, or general error/update work.

## Technical Notes

- Plan source: `.omx/plans/mycli-configuration-and-ux-optimization-plan.md`, Phase 4.
- Likely areas: execution policy contracts/config, Node backend/gateway bootstrap and status routes,
  permission selector/status TUI, doctor sandbox collector, and platform readiness adapters.
- Implementation mode is inline; no implementation, research, or check subagent may be started.

## Research References

- [`research/permission-sandbox-status.md`](research/permission-sandbox-status.md) - current mycli
  gaps, local Codex comparison, implementation alternatives, and the selected boundary.

## Technical Approach

1. Add one tools-layer sandbox readiness contract with injectable platform probes and a bounded,
   side-effect-free Windows handshake path.
2. Cache readiness during Node backend startup and expose it alongside the selected profile and the
   runtime execution-policy snapshot through one gateway projection.
3. Reuse the projection in bootstrap/status/permission RPCs and slash-command output.
4. Extend the TUI permission state and selector without duplicating policy descriptions.
5. Add provider-free `mycli sandbox status`, align doctor with the classifier, then cover gateway,
   CLI, runtime-state, selector, and cross-platform edge cases.

## Decision (ADR-lite)

**Context**: mycli already enforces effective policy in the runtime, but its user surfaces repeat
the nominal selected profile and cannot explain managed constraints or sandbox readiness. A full
setup/reset implementation would overlap active Windows native work.

**Decision**: Enrich the existing gateway permission projection from `ExecutionPolicySnapshot` and
a shared read-only readiness classifier. Keep setup/reset and native mutations out of this slice.

**Consequences**: Current surfaces gain a consistent, truthful safety summary without changing
execution semantics. The later Windows recovery flow can consume the readiness contract, but this
task will not repair an incomplete sandbox.

## Expansion Sweep

- Future: readiness can gain structured setup/retry/reset actions and feed the Phase 5 settings
  center without changing its state vocabulary.
- Related: bootstrap, status events, permission selector, slash commands, doctor, and CLI output are
  kept consistent in this slice.
- Failure cases: unsupported/missing helpers, malformed or timed-out Windows handshakes, managed
  constraints, untrusted workspaces, and stale nominal profile labels fail closed and remain redacted.
